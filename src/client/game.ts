import { Chess } from "chess.js";
import type { AbandonIn, ClockState, Color, GameResult, MoveInput, Names, Presence, ServerMsg, TimeControl } from "../shared/protocol";
import { sfx } from "./audio";
import { Engine } from "./engine";
import type { HandInput, PinchEndReason, Pos } from "./hand";
import { applyBoardMap, fitBoardMap, fitError, tiltDegrees, type BoardMap, type CalSample, type P3 } from "./calibration";
import { RoomConnection, type NetStatus } from "./net";
import { store } from "./store";
import { glyphOf, FILES, sqName } from "./pieces";
import { SQ, S, View, type Pt } from "./projection";

export type GameMode =
  | { kind: "ai"; skill: number }
  | { kind: "local" }
  | { kind: "online"; room: string; tc: string };

export interface Held { from: string; glyph: string; type: string; color: Color; targets: Set<string>; captures: Set<string> }
export interface Anim {
  to: string; glyph: string; type: string; color: Color; own: boolean; t0: number; dur: number;
  x0: number; y0: number; x1: number; y1: number;
  fx: { captured: boolean; capturedColor: Color; san: string };
}
export interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; color: string }

const other = (c: Color): Color => (c === "w" ? "b" : "w");
const PUSH_GAIN = 800;         // 手の大きさが100%変わった時に進む盤面の距離(px)。標準感度で、25%近づけると約2マス奥へ
const PUSH_DEADZONE = 0.02;    // 手の大きさの2%以内の揺れは無視(検出のぶれで駒が動かないように)
const PUSH_Y_BLEND = 0.3;      // 手の上下の動きを、奥行きの動きにどれだけ足すか

/**
 * 対局の状態と進行。入力(HandInput)・エンジン・サーバー接続をつなぎ、描画(render.ts)とUI(ui.ts)は
 * このクラスの公開フィールドを読むだけにする。
 */
export class Game {
  chess = new Chess();
  mode: GameMode = { kind: "local" };
  myColor: Color | null = "w";        // null: 観戦、またはローカル対戦(両方指せる)
  flip = false;
  held: Held | null = null;
  thinking = false;
  lastMove: { from: string; to: string } | null = null;
  anim: Anim | null = null;
  anim2: Anim | null = null;           // キャスリングのルーク(王と同時に動く)
  /** ポーンの昇格の選択待ち(選ぶまで指し手は確定しない) */
  promo: { from: string; to: string; color: Color } | null = null;
  particles: Particle[] = [];
  shake = 0;
  moveList: string[] = [];

  result: GameResult | null = null;
  resultSeq = 0;                       // 終局のたびに増える(UIがモーダルを出すきっかけ)
  names: Names = { w: null, b: null };
  present: Presence = { w: true, b: true };
  timeControl: TimeControl = { baseMs: 0, incrementMs: 0 };
  drawOffer: Color | null = null;
  rematchOffer: Color | null = null;
  netStatus: NetStatus | "none" = "none";
  roomCode = "";

  onToast?: (msg: string, ms?: number) => void;
  onDrawOffer?: () => void;

  private abandon: { v: AbandonIn; at: number } = { v: { w: null, b: null }, at: 0 };   // 切断中の側が、あと何msで負けになるか(受信時点)
  private clockBase = { w: 0, b: 0, turn: "w" as Color, running: false, at: 0 };
  private net: RoomConnection | null = null;
  private serverCount = 0;
  private playerName = "Player";
  private engine = new Engine();
  /** 奥行き操作: 掴んだあと、手を前に突き出すと駒が盤の奥へ進む(手の大きさの変化から推定) */
  depthMode = true;
  depthSense = 1;                                                        // 奥行きの感度(倍率): 低 0.6 / 標準 1 / 高 1.6
  private push: { origin: Pt; hb0: Pt; r0: number } | null = null;       // 掴んだ瞬間の、駒の元の位置・手の位置・手の大きさ
  /**
   * 実位置マッピング(四隅キャリブレーション後): 手の3次元位置を、盤の位置に直接対応させる。
   * 「手をその位置に持っていくと、そこに置ける」という、実際に盤に触れているような対応になる。
   */
  boardMap: BoardMap | null = store.get<BoardMap | null>("boardMap", null);
  mapOn = store.get<boolean>("mapOn2", false);                          // 実験機能: 位置合わせをしても、切り替えるまでは使わない
  mapInfo: { tilt: number; err: number } | null = store.get("mapInfo", null);
  cal: { step: number; samples: CalSample[] } | null = null;              // キャリブレーション中(盤の四隅と中央を、順につまんで示す)
  private turnLockUntil = 0;             // 盤を回している間は、駒を掴めないようにする
  private token = 0;                   // AI思考中に画面を離れた時、古い応答を捨てるため

  constructor(readonly input: HandInput, public view: View) {
    input.onPinchStart = (past, now) => this.onPinchStart(past, now);
    input.onPinchEnd = (past, reason) => this.onPinchEnd(past, reason);
    this.engine.init();
  }

  // ---------- 開始・終了 ----------
  start(mode: GameMode, name: string) {
    this.destroy();
    this.mode = mode; this.playerName = name || "Player";
    this.resetBoard();
    this.myColor = mode.kind === "online" ? null : mode.kind === "ai" ? "w" : null;
    this.flip = false;
    this.names = mode.kind === "ai" ? { w: this.playerName, b: `AI (Stockfish)` } : mode.kind === "local" ? { w: "白", b: "黒" } : { w: null, b: null };
    this.present = { w: true, b: true };
    this.timeControl = { baseMs: 0, incrementMs: 0 };
    this.clockBase = { w: 0, b: 0, turn: "w", running: false, at: performance.now() };
    if (mode.kind === "online") {
      this.roomCode = mode.room; this.present = { w: false, b: false };
      this.net = new RoomConnection(mode.room, mode.tc, this.playerName, (m) => this.onServer(m), (s) => { this.netStatus = s; });
    } else { this.roomCode = ""; this.netStatus = "none"; }
  }

  destroy() {
    this.token++;
    this.net?.close(); this.net = null; this.netStatus = "none";
    this.held = null; this.input.holding = false; this.thinking = false;
  }

  private resetBoard() {
    this.chess = new Chess(); this.moveList = []; this.lastMove = null; this.anim = null; this.anim2 = null; this.promo = null; this.particles = [];
    this.held = null; this.input.holding = false; this.thinking = false;
    this.result = null; this.drawOffer = null; this.rematchOffer = null; this.serverCount = 0;
    this.turnLockUntil = 0; if (this.mode.kind === "local") this.flip = false;
  }

  // ---------- ポーンの昇格 ----------
  /** 選択カードの位置(画面座標)。左から クイーン・ルーク・ビショップ・ナイト */
  promoCards(): { piece: "q" | "r" | "b" | "n"; x: number; y: number; w: number; h: number }[] {
    const w = 120, h = 150, gap = 16, x0 = S / 2 - (4 * w + 3 * gap) / 2, y = S / 2 - h / 2;
    return (["q", "r", "b", "n"] as const).map((piece, i) => ({ piece, x: x0 + i * (w + gap), y, w, h }));
  }

  choosePromotion(piece: "q" | "r" | "b" | "n") {
    const pr = this.promo;
    if (!pr) return;
    this.promo = null;
    void this.commitMove({ from: pr.from, to: pr.to, promotion: piece }, this.cursor ?? undefined);
  }
  cancelPromotion() { this.promo = null; }

  // ---------- 実位置マッピングのキャリブレーション ----------
  /** 示してもらう場所(盤面座標): 手前左 → 手前右 → 奥右 → 奥左 → 中央 */
  calTarget(step: number): Pt {
    const t: [number, number][] = [[0.5, 7.5], [7.5, 7.5], [7.5, 0.5], [0.5, 0.5], [4, 4]];
    return { x: t[step][0] * SQ, y: t[step][1] * SQ };
  }

  startBoardCal(): string | null {
    if (this.input.source !== "hand" || !this.input.p3) return "手をカメラに映してから実行してください";
    this.held = null; this.input.holding = false;
    this.cal = { step: 0, samples: [] };
    return null;
  }
  cancelBoardCal() { this.cal = null; }

  private captureCal(p: Pos) {
    const cal = this.cal;
    if (!cal) return;
    if (!p.p3) { this.onToast?.("手が見えていません。もう一度つまんでください"); return; }
    cal.samples.push({ p: p.p3, b: this.calTarget(cal.step) });
    cal.step++; sfx.grab();
    if (cal.step < 5) return;
    this.cal = null;
    const map = fitBoardMap(cal.samples);
    if (!map) { this.onToast?.("うまく計算できませんでした。もう一度どうぞ", 4000); return; }
    const err = fitError(map, cal.samples), tilt = tiltDegrees(map);
    this.boardMap = map; this.mapOn = true; this.mapInfo = { tilt, err };
    store.set("boardMap", map); store.set("mapOn2", true); store.set("mapInfo", this.mapInfo);
    sfx.win();
    this.onToast?.(`位置合わせが完了しました(手の動く面の傾き 約${Math.round(tilt)}°、誤差 約${Math.round(err)}px)`, 5000);
  }

  // ---------- 入力 ----------
  private board(p: Pt): Pt { const b = this.view.unproject(p.x, p.y); return { x: Math.min(S, Math.max(0, b.x)), y: Math.min(S, Math.max(0, b.y)) }; }

  /** 現在のカーソル位置(盤面座標)。未入力なら null */
  get cursor(): Pt | null { return this.input.screen.x < 0 ? null : this.cursorAt(this.input.screen, this.input.depth, this.input.p3); }

  /**
   * 画面上の手の位置 s と手の大きさ r から、盤面上のカーソル位置を求める。
   * 掴む前: 指した位置に合わせる。
   * 掴んだあと(奥行き操作): 掴んだ瞬間の駒の位置を起点に、左右は手の左右の動き、前後(盤の奥行き)は手を突き出した量で動かす。
   *   手を上下に動かす動きも、少しだけ効かせる(手を上げて奥へ動かす癖でも動くように)。
   */
  cursorAt(s: Pt, r: number, p3: P3 | null): Pt {
    // 実位置マッピング: 手の3次元位置を、そのまま盤の位置に対応させる(掴む前も掴んだ後も同じ対応)
    if (this.boardMap && this.mapOn && p3 && this.input.source === "hand" && !this.cal) {
      const b = applyBoardMap(this.boardMap, p3);
      return { x: Math.min(S, Math.max(0, b.x)), y: Math.min(S, Math.max(0, b.y)) };
    }
    const hb = this.board(s), pb = this.push;
    if (!this.held || !pb || !this.depthMode || !(r > 0) || !(pb.r0 > 0)) return hb;
    let dz = Math.max(-0.8, Math.min(0.8, (r - pb.r0) / pb.r0));              // 手が大きくなった割合(近づいた=前に突き出した)
    dz = Math.sign(dz) * Math.max(0, Math.abs(dz) - PUSH_DEADZONE);           // 小さな揺れは無視
    return {
      x: Math.min(S, Math.max(0, pb.origin.x + (hb.x - pb.hb0.x))),
      y: Math.min(S, Math.max(0, pb.origin.y + PUSH_Y_BLEND * (hb.y - pb.hb0.y) - PUSH_GAIN * this.depthSense * dz)),   // 前に突き出す = 盤の奥(上)
    };
  }

  sqAt(p: Pt): string | null {
    const dc = Math.floor(p.x / SQ), dr = Math.floor(p.y / SQ);
    if (dc < 0 || dc > 7 || dr < 0 || dr > 7) return null;
    return sqName(this.flip ? 7 - dc : dc, this.flip ? 7 - dr : dr);
  }

  sqCenter(sq: string): Pt {
    const c = FILES.indexOf(sq[0]), r = 8 - +sq[1];
    return { x: ((this.flip ? 7 - c : c) + 0.5) * SQ, y: ((this.flip ? 7 - r : r) + 0.5) * SQ };
  }

  /** 離す位置に最も近い合法マスへ吸着する */
  snapTarget(p: Pt): string | null {
    if (!this.held) return this.sqAt(p);
    let best: string | null = null, bd = SQ * 0.7;
    for (const t of this.held.targets) {
      const c = this.sqCenter(t), d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bd) { bd = d; best = t; }
    }
    return best ?? this.sqAt(p);
  }

  private onPinchStart(past: Pos, now: Pos) {
    if (this.promo) {                                                     // 昇格の選択中: 指した(つまんだ)カードを選ぶ。外側なら取り消し
      const hit = this.promoCards().find((c) => past.x >= c.x && past.x <= c.x + c.w && past.y >= c.y && past.y <= c.y + c.h);
      if (hit) this.choosePromotion(hit.piece); else this.cancelPromotion();
      return;
    }
    if (this.cal) { this.captureCal(past); return; }                       // キャリブレーション中は、駒を掴まずに位置を記録する
    const sq = this.pickSquare(this.cursorAt(past, past.r, past.p3)) ?? this.pickSquare(this.cursorAt(now, now.r, now.p3));
    if (sq && this.tryGrab(sq)) {
      // 奥行き操作の起点: 駒の元の位置(吸着後)と、そのときの手の位置・大きさ
      this.push = this.input.source === "hand" && past.r > 0 ? { origin: this.sqCenter(sq), hb0: this.board(past), r0: past.r } : null;
    }
  }

  // ---------- 「どの駒を掴もうとしているか」の判定(表示と掴む動作で同じ関数を使う) ----------
  private movableCache = { fen: "", flag: false, set: new Set<string>() };

  /** 今の手番で動かせる駒のマス(動ける場所がある駒だけ)。自分の番でなければ空 */
  movableSquares(): Set<string> {
    const fen = this.chess.fen(), can = this.canMoveNow(this.chess.turn());
    const c = this.movableCache;
    if (c.fen === fen && c.flag === can) return c.set;
    const set = new Set<string>();
    if (can) for (const m of this.chess.moves({ verbose: true })) set.add(m.from);
    this.movableCache = { fen, flag: can, set };
    return set;
  }

  /** カーソルが指している「掴める駒」。真下の駒を優先し、少しずれていても近い駒に吸着する */
  pickSquare(p: Pt): string | null {
    if (this.held) return null;
    const movable = this.movableSquares();
    if (!movable.size) return null;
    const own = this.sqAt(p);
    if (own && movable.has(own)) return own;
    let best: string | null = null, bd = SQ * 0.62;
    for (const sq of movable) {
      const c = this.sqCenter(sq), d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bd) { bd = d; best = sq; }
    }
    return best;
  }

  /** 指している駒の情報(掴む前の表示用)。動かせない駒・相手の駒でも名前は出す */
  hoverInfo(): { sq: string; type: string; color: Color; movable: boolean } | null {
    const cur = this.cursor;
    if (this.held || !cur) return null;
    const pick = this.pickSquare(cur);
    const sq = pick ?? this.sqAt(cur);
    const p = sq ? this.chess.get(sq as never) : null;
    return sq && p ? { sq, type: p.type, color: p.color, movable: pick === sq } : null;
  }

  private onPinchEnd(past: Pos, reason: PinchEndReason) {
    if (!this.held) return;
    if (reason === "lost") { this.held = null; this.push = null; this.input.holding = false; this.onToast?.("手を見失ったので駒を戻しました"); return; }
    void this.drop(this.snapTarget(this.cursorAt(past, past.r, past.p3)));           // 離す動作で手がぶれる前の位置(遅延補正)
  }

  canMoveNow(color: Color): boolean {
    if (performance.now() < this.turnLockUntil) return false;
    if (this.cal || this.promo) return false;
    if (this.thinking || this.result || this.chess.turn() !== color || this.anim?.own) return false;
    switch (this.mode.kind) {
      case "ai": return color === "w";
      case "local": return true;
      case "online": return this.myColor === color && this.present.w && this.present.b && this.netStatus === "open";
    }
  }

  private tryGrab(sq: string | null): boolean {
    if (this.held || !sq) return false;
    const p = this.chess.get(sq as never);
    if (!p || !this.canMoveNow(p.color)) return false;
    const mv = this.chess.moves({ square: sq as never, verbose: true });
    const targets = new Set(mv.map((m) => m.to));
    if (!targets.size) return false;
    const captures = new Set(mv.filter((m) => m.captured).map((m) => m.to));
    this.held = { from: sq, glyph: glyphOf(p.type), type: p.type, color: p.color, targets, captures };
    this.input.holding = true;
    sfx.grab();
    return true;
  }

  private async drop(sq: string | null) {
    const h = this.held;
    this.held = null; this.input.holding = false;
    if (!h || !sq || !h.targets.has(sq)) return;
    // ポーンが最終段に着く手は、駒を選んでもらう(選ぶまで確定しない)
    if (h.type === "p" && (sq[1] === "8" || sq[1] === "1")) { this.promo = { from: h.from, to: sq, color: h.color }; return; }
    await this.commitMove({ from: h.from, to: sq }, this.cursor ?? undefined);
  }

  /** 指し手を確定する(オンラインなら送信、AI戦なら返事を待つ) */
  private async commitMove(mv: MoveInput, dropFrom?: Pt) {
    if (!this.applyMove(mv, dropFrom)) return;
    if (this.mode.kind === "online") { this.net?.send({ t: "move", move: mv }); return; }
    if (this.checkLocalEnd()) return;
    if (this.mode.kind === "ai") await this.aiReply();
  }

  private async aiReply() {
    if (this.mode.kind !== "ai") return;
    const token = ++this.token;
    this.thinking = true;
    const mv = await this.engine.bestMove(this.chess, this.mode.skill);
    if (token !== this.token) return;
    this.thinking = false;
    if (mv) { try { this.applyMove(mv); } catch { /* 不正手は無視 */ } }
    this.checkLocalEnd();
  }

  // ---------- 着手 ----------
  private applyMove(mv: MoveInput, dropFrom?: Pt): boolean {
    if (this.anim) this.landFx(this.anim);
    let m;
    try { m = this.chess.move(mv); } catch { return false; }
    this.lastMove = { from: m.from, to: m.to };
    this.moveList.push(m.san);
    const a = this.sqCenter(m.from), b = this.sqCenter(m.to), piece = this.chess.get(m.to as never)!;
    this.anim = {
      to: m.to, glyph: glyphOf(piece.type), type: piece.type, color: piece.color, own: !!dropFrom,
      t0: performance.now(), dur: dropFrom ? 160 : 380,
      x0: dropFrom?.x ?? a.x, y0: dropFrom?.y ?? a.y, x1: b.x, y1: b.y,
      fx: { captured: !!m.captured, capturedColor: other(m.color), san: m.san },
    };
    // キャスリング: 王と同時に、ルークも動かす
    this.anim2 = null;
    if (m.flags.includes("k") || m.flags.includes("q")) {
      const rank = m.from[1], k = m.flags.includes("k");
      const rf = (k ? "h" : "a") + rank, rt = (k ? "f" : "d") + rank;
      const ra = this.sqCenter(rf), rb = this.sqCenter(rt);
      this.anim2 = { to: rt, glyph: glyphOf("r"), type: "r", color: m.color, own: false, t0: performance.now(), dur: 380, x0: ra.x, y0: ra.y, x1: rb.x, y1: rb.y, fx: { captured: false, capturedColor: other(m.color), san: "" } };
    }
    return true;
  }

  /** 駒が着地した瞬間の演出(効果音・パーティクル・画面の揺れ) */
  landFx(a: Anim) {
    if (a.fx.captured) { sfx.capture(); this.burst(a.to, a.fx.capturedColor); } else sfx.place();
    if (a.fx.san.endsWith("+")) sfx.check();
    if (this.anim === a) { this.anim = null; this.anim2 = null; }
    // 二人対戦: 次に指す人の陣営が手前に来るように、盤を回す(描画側がなめらかに回す)
    if (this.mode.kind === "local" && !this.result) {
      const f = this.chess.turn() === "b";
      if (f !== this.flip) { this.flip = f; this.turnLockUntil = performance.now() + 900; this.input.releaseLock(); }   // 手番が変わったら、次の人の手を追従し直す
    }
  }

  private burst(sq: string, capturedColor: Color) {
    const c = this.sqCenter(sq), cols = ["#fc6", "#f96", capturedColor === "w" ? "#fff" : "#8af"];
    for (let i = 0; i < 30; i++) {
      this.particles.push({ x: c.x, y: c.y, z: SQ * 0.4, vx: (Math.random() - 0.5) * 7, vy: (Math.random() - 0.5) * 7, vz: Math.random() * 9 + 3, life: 1, color: cols[i % 3] });
    }
    this.shake = 9;
  }

  private checkLocalEnd(): boolean {
    const c = this.chess, mover = other(c.turn());
    let r: GameResult | null = null;
    if (c.isCheckmate()) r = { winner: mover, reason: "checkmate" };
    else if (c.isStalemate()) r = { winner: null, reason: "stalemate" };
    else if (c.isInsufficientMaterial()) r = { winner: null, reason: "insufficient" };
    else if (c.isThreefoldRepetition()) r = { winner: null, reason: "repetition" };
    else if (c.isDraw()) r = { winner: null, reason: "fifty" };
    if (r) this.setResult(r);
    return !!r;
  }

  private setResult(r: GameResult) {
    this.result = r; this.resultSeq++; this.held = null; this.input.holding = false; this.thinking = false; this.token++;
    if (this.mode.kind === "ai" || this.myColor) {
      if (r.winner === null) sfx.notify(); else if (r.winner === this.myColor) sfx.win(); else sfx.lose();
    } else sfx.win();
  }

  // ---------- 操作ボタン ----------
  resign() {
    if (this.result) return;
    if (this.mode.kind === "online") return this.net?.send({ t: "resign" });
    const loser = this.mode.kind === "ai" ? "w" : this.chess.turn();
    this.setResult({ winner: other(loser), reason: "resign" });
  }

  offerDraw() {
    if (this.result) return;
    if (this.mode.kind === "online") { this.net?.send({ t: "draw-offer" }); this.onToast?.("引き分けを提案しました"); }
    else if (this.mode.kind === "local") this.setResult({ winner: null, reason: "agreement" });
  }
  acceptDraw() { this.net?.send({ t: "draw-accept" }); }
  declineDraw() { this.net?.send({ t: "draw-decline" }); this.drawOffer = null; }

  rematch() {
    if (this.mode.kind === "online") { this.net?.send({ t: "rematch" }); this.onToast?.("再戦を申し込みました"); return; }
    this.token++; this.resetBoard();
  }

  // ---------- サーバーからのメッセージ ----------
  private onServer(m: ServerMsg) {
    switch (m.t) {
      case "joined":
        this.myColor = m.color; this.flip = m.color === "b";
        if (!m.color) this.onToast?.("観戦モードで入室しました");
        break;
      case "sync": {
        this.rebuild(m.moves);
        this.names = m.names; this.present = m.present; this.timeControl = m.timeControl;
        this.abandon = { v: m.abandonIn, at: performance.now() };
        this.setClock(m.clock); this.drawOffer = m.drawOffer; this.rematchOffer = null;
        const finished = m.result && !this.result;
        this.result = m.result;
        if (finished) this.resultSeq++;
        break;
      }
      case "move": {
        this.setClock(m.clock);
        if (this.moveList.length === this.serverCount) {            // 相手の手(自分の手はすでに反映済み)
          if (!this.applyMove(m.move)) { this.net?.send({ t: "join", name: this.playerName }); break; }
          this.revalidateHeld();
        }
        this.serverCount++;
        this.drawOffer = null;
        break;
      }
      case "presence": this.present = m.present; this.names = m.names; this.abandon = { v: m.abandonIn, at: performance.now() }; break;
      case "gameover": this.setClock(m.clock); this.setResult(m.result); break;
      case "draw-offer": if (m.by !== this.myColor) { this.drawOffer = m.by; sfx.notify(); this.onDrawOffer?.(); } break;
      case "draw-declined": this.drawOffer = null; this.onToast?.("引き分けの提案は断られました"); break;
      case "rematch-offer": if (m.by !== this.myColor) { this.rematchOffer = m.by; sfx.notify(); this.onToast?.("相手が再戦を申し込んでいます"); } break;
      case "error": this.onToast?.(m.message); break;
      case "pong": break;
    }
  }

  private rebuild(moves: MoveInput[]) {
    this.chess = new Chess(); this.moveList = []; this.anim = null; this.particles = []; this.held = null; this.input.holding = false;
    this.lastMove = null;
    for (const mv of moves) { const m = this.chess.move(mv); this.moveList.push(m.san); this.lastMove = { from: m.from, to: m.to }; }
    this.serverCount = moves.length;
  }

  /** 相手が動いた時、掴んでいる駒がまだ有効か確認する(取られていたら戻す) */
  private revalidateHeld() {
    if (!this.held) return;
    const p = this.chess.get(this.held.from as never);
    if (!p || p.color !== this.held.color || !this.canMoveNow(p.color)) { this.held = null; this.input.holding = false; return; }
    const mv = this.chess.moves({ square: this.held.from as never, verbose: true });
    this.held.targets = new Set(mv.map((m) => m.to));
    this.held.captures = new Set(mv.filter((m) => m.captured).map((m) => m.to));
  }

  private setClock(c: ClockState) { this.clockBase = { ...c, at: performance.now() }; }

  /** 表示用の残り時間(ms)。running中は手番側が受信時刻から減っていく。時間無制限ならnull */
  displayClock(): { w: number; b: number; turn: Color; running: boolean } | null {
    if (this.timeControl.baseMs <= 0) return null;
    const { w, b, turn, running, at } = this.clockBase;
    const d = running && !this.result ? performance.now() - at : 0;
    return { w: Math.max(0, w - (turn === "w" ? d : 0)), b: Math.max(0, b - (turn === "b" ? d : 0)), turn, running };
  }

  /** 相手が切断中なら、あと何秒戻らなければ勝ちになるか(表示用)。切断中でなければ null */
  opponentAbandonSeconds(): number | null {
    if (!this.myColor) return null;
    const ms = this.abandon.v[other(this.myColor)];
    return ms === null ? null : Math.max(0, Math.ceil((ms - (performance.now() - this.abandon.at)) / 1000));
  }

  /** 棋譜(PGN)。名前・日付・結果つき */
  pgn(): string {
    const c = new Chess();
    c.setHeader("Event", "Hand Chess"); c.setHeader("Site", "https://hand-chess.momotech.workers.dev");
    c.setHeader("Date", new Date().toISOString().slice(0, 10).replaceAll("-", "."));
    c.setHeader("White", this.names.w ?? "White"); c.setHeader("Black", this.names.b ?? "Black");
    c.setHeader("Result", !this.result ? "*" : this.result.winner === "w" ? "1-0" : this.result.winner === "b" ? "0-1" : "1/2-1/2");
    for (const san of this.moveList) { try { c.move(san); } catch { break; } }
    return c.pgn();
  }

  /** 盤面に出す1行の状態 */
  statusText(): string {
    if (this.mode.kind === "online") {
      if (this.netStatus === "connecting") return "サーバーに接続しています…";
      if (this.netStatus === "reconnecting") return "接続が切れました。再接続しています…";
      if (this.netStatus === "closed") return "切断されました(別の場所で開いた可能性があります)";
      if (!this.present.w || !this.present.b) {
        if (!this.result && this.moveList.length > 0) {
          const sec = this.opponentAbandonSeconds();
          return sec === null ? "相手が切断しました。戻るのを待っています…" : `相手が切断しました。あと${sec}秒で、あなたの勝ちになります`;
        }
        return this.names.w && this.names.b ? "相手が切断しています" : "相手の参加を待っています…";
      }
    }
    if (this.promo) return "昇格する駒を選んでください";
    if (this.result) return "";
    if (this.thinking) return "AIが考えています…";
    const check = this.chess.inCheck() ? " — チェック!" : "";
    if (this.mode.kind === "local") return `${this.chess.turn() === "w" ? "白" : "黒"}の番${check}`;
    if (!this.myColor) return `${this.chess.turn() === "w" ? "白" : "黒"}の番(観戦中)${check}`;
    return (this.chess.turn() === this.myColor ? "あなたの番" : "相手の番") + check;
  }

  get kingInCheckSquare(): string | null {
    if (!this.chess.inCheck()) return null;
    const b = this.chess.board();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = b[r][c]; if (p?.type === "k" && p.color === this.chess.turn()) return sqName(c, r); }
    return null;
  }
}
