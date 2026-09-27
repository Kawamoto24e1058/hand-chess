import { DurableObject } from "cloudflare:workers";
import { Chess } from "chess.js";
import type { Env } from "./index";
import {
  DEFAULT_TC_KEY, TIME_CONTROLS,
  type ClientMsg, type ClockState, type Color, type GameResult, type MoveInput,
  type Names, type Presence, type ResultReason, type ServerMsg, type TimeControl,
} from "../shared/protocol";

const ABANDON_MS = 90_000;        // 切断されたまま戻らなければ負け
const IDLE_CLEANUP_MS = 10 * 60_000;   // 誰もいない部屋は10分で破棄
const MAX_MESSAGE_BYTES = 2048;

interface Persisted {
  moves: MoveInput[];
  sans: string[];
  names: Names;
  tokens: { w: string | null; b: string | null };
  tc: TimeControl;
  tcLocked: boolean;              // 最初の入室者が決めた持ち時間を確定済みか
  remaining: { w: number; b: number };
  turnStartedAt: number | null;   // 手番側の時計が動き始めた時刻(時計が止まっている間はnull)
  result: GameResult | null;
  drawOffer: Color | null;
  rematch: { w: boolean; b: boolean };
  disconnectedAt: { w: number | null; b: number | null };
  lastActive: number;
}

interface Attachment {
  color: Color | null;
}

const other = (c: Color): Color => (c === "w" ? "b" : "w");
const cleanName = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16) || "Player";

function freshState(tc: TimeControl): Persisted {
  return {
    moves: [], sans: [],
    names: { w: null, b: null },
    tokens: { w: null, b: null },
    tc, tcLocked: false,
    remaining: { w: tc.baseMs, b: tc.baseMs },
    turnStartedAt: null,
    result: null, drawOffer: null,
    rematch: { w: false, b: false },
    disconnectedAt: { w: null, b: null },
    lastActive: Date.now(),
  };
}

/**
 * 1つの対局部屋。サーバーが唯一の正(指し手の合法性・持ち時間・勝敗)を持つ。
 * WebSocket Hibernation APIを使うので、待機中はメモリを解放しつつ接続を維持できる。
 */
export class GameRoom extends DurableObject<Env> {
  private s: Persisted = freshState(TIME_CONTROLS[DEFAULT_TC_KEY]);
  private chess = new Chess();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Persisted>("state");
      if (saved) {
        this.s = saved;
        for (const m of this.s.moves) this.chess.move(m);
      }
    });
  }

  // ---------- 接続 ----------
  async fetch(req: Request): Promise<Response> {
    if (!this.s.tcLocked) {
      const key = new URL(req.url).searchParams.get("tc") ?? DEFAULT_TC_KEY;
      const tc = TIME_CONTROLS[key] ?? TIME_CONTROLS[DEFAULT_TC_KEY];
      this.s = { ...freshState(tc), tcLocked: true };
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ color: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return;
    let msg: ClientMsg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      await this.handle(ws, msg);
    } catch (e) {
      this.send(ws, { t: "error", message: e instanceof Error ? e.message : "エラーが発生しました" });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> { await this.onDisconnect(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { await this.onDisconnect(ws); }

  private async onDisconnect(ws: WebSocket) {
    const color = (ws.deserializeAttachment() as Attachment | null)?.color;
    if (color && !this.socketsOf(color).some((w) => w !== ws)) {
      this.s.disconnectedAt[color] = Date.now();
      await this.save();
      this.broadcast({ t: "presence", present: this.presence(ws), names: this.s.names });
    }
    this.s.lastActive = Date.now();
    await this.scheduleAlarm();
  }

  // ---------- メッセージ処理 ----------
  private async handle(ws: WebSocket, msg: ClientMsg) {
    const color = (ws.deserializeAttachment() as Attachment | null)?.color ?? null;

    switch (msg.t) {
      case "ping": return this.send(ws, { t: "pong" });
      case "join": return this.join(ws, msg.name, msg.token);
    }
    if (!color) throw new Error("観戦中は操作できません");

    switch (msg.t) {
      case "move": return this.move(color, msg.move);
      case "resign":
        if (this.s.result) return;
        return this.finish({ winner: other(color), reason: "resign" });
      case "draw-offer":
        if (this.s.result || !this.bothSeated()) return;
        if (this.s.drawOffer === other(color)) return this.finish({ winner: null, reason: "agreement" });
        this.s.drawOffer = color;
        await this.save();
        return this.broadcast({ t: "draw-offer", by: color });
      case "draw-accept":
        if (this.s.result || this.s.drawOffer !== other(color)) return;
        return this.finish({ winner: null, reason: "agreement" });
      case "draw-decline":
        if (this.s.drawOffer !== other(color)) return;
        this.s.drawOffer = null;
        await this.save();
        return this.broadcast({ t: "draw-declined" });
      case "rematch":
        return this.rematch(color);
    }
  }

  private async join(ws: WebSocket, name: string, token?: string) {
    const s = this.s;
    let color: Color | null = null;
    if (token) for (const c of ["w", "b"] as const) if (s.tokens[c] === token) color = c;
    if (!color) for (const c of ["w", "b"] as const) if (!s.tokens[c]) { color = c; break; }

    let myToken = token ?? "";
    if (color) {
      if (s.tokens[color] !== token) myToken = crypto.randomUUID();
      s.tokens[color] = myToken;
      s.names[color] = cleanName(name);
      s.disconnectedAt[color] = null;
      for (const old of this.socketsOf(color)) {
        if (old !== ws) { try { old.close(4000, "別の場所から接続されました"); } catch { /* */ } }
      }
    }
    ws.serializeAttachment({ color } satisfies Attachment);
    s.lastActive = Date.now();
    await this.save();

    this.send(ws, { t: "joined", color, token: myToken, room: this.roomName() });
    this.send(ws, this.syncMsg());
    this.broadcast({ t: "presence", present: this.presence(), names: s.names }, ws);
    await this.scheduleAlarm();
  }

  private async move(color: Color, mv: MoveInput) {
    const s = this.s;
    if (s.result) throw new Error("対局は終了しています");
    if (!this.bothSeated()) throw new Error("相手の参加を待っています");
    if (this.chess.turn() !== color) throw new Error("あなたの番ではありません");

    const now = Date.now();
    const timed = s.tc.baseMs > 0;
    if (timed && s.turnStartedAt !== null) {
      const left = s.remaining[color] - (now - s.turnStartedAt);
      if (left <= 0) { s.remaining[color] = 0; return this.finish({ winner: other(color), reason: "timeout" }); }
      s.remaining[color] = left;
    }

    let played;
    try {
      played = this.chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    } catch {
      // 不正な手: 状態を再送してクライアントを正しい局面に戻す
      this.send(this.socketsOf(color)[0], this.syncMsg());
      throw new Error("その手は指せません");
    }

    s.moves.push({ from: played.from, to: played.to, promotion: played.promotion });
    s.sans.push(played.san);
    s.drawOffer = null;
    if (timed && s.turnStartedAt !== null) s.remaining[color] += s.tc.incrementMs;
    // 持ち時間は、双方が1手ずつ指してから動き出す(カメラ準備の時間を奪わない)
    s.turnStartedAt = timed && s.moves.length >= 2 ? now : null;
    s.lastActive = now;

    this.broadcast({ t: "move", move: s.moves[s.moves.length - 1], san: played.san, clock: this.clock() });

    if (this.chess.isCheckmate()) return this.finish({ winner: color, reason: "checkmate" });
    if (this.chess.isStalemate()) return this.finish({ winner: null, reason: "stalemate" });
    if (this.chess.isInsufficientMaterial()) return this.finish({ winner: null, reason: "insufficient" });
    if (this.chess.isThreefoldRepetition()) return this.finish({ winner: null, reason: "repetition" });
    if (this.chess.isDraw()) return this.finish({ winner: null, reason: "fifty" });

    await this.save();
    await this.scheduleAlarm();
  }

  private async finish(result: GameResult) {
    const s = this.s;
    // 終局時点の時計を確定させる
    if (s.tc.baseMs > 0 && s.turnStartedAt !== null) {
      const t = this.chess.turn();
      s.remaining[t] = Math.max(0, s.remaining[t] - (Date.now() - s.turnStartedAt));
    }
    s.result = result;
    s.turnStartedAt = null;
    s.drawOffer = null;
    s.rematch = { w: false, b: false };
    await this.save();
    this.broadcast({ t: "gameover", result, clock: this.clock() });
    await this.scheduleAlarm();
  }

  private async rematch(color: Color) {
    const s = this.s;
    if (!s.result) return;
    s.rematch[color] = true;
    if (!(s.rematch.w && s.rematch.b)) {
      await this.save();
      return this.broadcast({ t: "rematch-offer", by: color });
    }
    // 両者合意: 先後を入れ替えて新しい対局を始める
    const swapped = freshState(s.tc);
    swapped.tcLocked = true;
    swapped.tokens = { w: s.tokens.b, b: s.tokens.w };
    swapped.names = { w: s.names.b, b: s.names.w };
    this.s = swapped;
    this.chess = new Chess();
    await this.save();
    for (const c of ["w", "b"] as const) {
      for (const sock of this.socketsOf(c)) {
        const newColor = other(c);
        sock.serializeAttachment({ color: newColor } satisfies Attachment);
        this.send(sock, { t: "joined", color: newColor, token: this.s.tokens[newColor] ?? "", room: this.roomName() });
      }
    }
    this.broadcast(this.syncMsg());
    await this.scheduleAlarm();
  }

  // ---------- 時間切れ・切断負け・部屋の後片付け ----------
  async alarm(): Promise<void> {
    const s = this.s;
    const now = Date.now();

    if (!s.result) {
      if (s.tc.baseMs > 0 && s.turnStartedAt !== null) {
        const t = this.chess.turn();
        if (s.remaining[t] - (now - s.turnStartedAt) <= 0) {
          s.remaining[t] = 0;
          return this.finish({ winner: other(t), reason: "timeout" });
        }
      }
      if (s.moves.length > 0) {
        for (const c of ["w", "b"] as const) {
          const at = s.disconnectedAt[c];
          if (at !== null && now - at >= ABANDON_MS) return this.finish({ winner: other(c), reason: "abandoned" });
        }
      }
    }

    if (this.ctx.getWebSockets().length === 0 && now - s.lastActive >= IDLE_CLEANUP_MS) {
      await this.ctx.storage.deleteAll();
      this.s = freshState(TIME_CONTROLS[DEFAULT_TC_KEY]);
      this.chess = new Chess();
      return;
    }
    await this.scheduleAlarm();
  }

  private async scheduleAlarm() {
    const s = this.s;
    const now = Date.now();
    const times: number[] = [];
    if (!s.result) {
      if (s.tc.baseMs > 0 && s.turnStartedAt !== null) times.push(now + Math.max(0, s.remaining[this.chess.turn()] - (now - s.turnStartedAt)) + 50);
      if (s.moves.length > 0) for (const c of ["w", "b"] as const) if (s.disconnectedAt[c] !== null) times.push(s.disconnectedAt[c]! + ABANDON_MS);
    }
    times.push(s.lastActive + IDLE_CLEANUP_MS);
    await this.ctx.storage.setAlarm(Math.max(now + 100, Math.min(...times)));
  }

  // ---------- ヘルパー ----------
  private roomName(): string { return this.ctx.id.name ?? ""; }
  private bothSeated(): boolean { return !!(this.s.tokens.w && this.s.tokens.b); }
  private async save() { await this.ctx.storage.put("state", this.s); }

  private socketsOf(color: Color): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => (w.deserializeAttachment() as Attachment | null)?.color === color);
  }

  private presence(exclude?: WebSocket): Presence {
    const live = (c: Color) => this.socketsOf(c).some((w) => w !== exclude);
    return { w: live("w"), b: live("b") };
  }

  private clock(): ClockState {
    const s = this.s;
    const turn = this.chess.turn();
    const remaining = { ...s.remaining };
    const running = s.tc.baseMs > 0 && s.turnStartedAt !== null && !s.result;
    if (running) remaining[turn] = Math.max(0, remaining[turn] - (Date.now() - s.turnStartedAt!));
    return { w: remaining.w, b: remaining.b, turn, running };
  }

  private syncMsg(): ServerMsg {
    return {
      t: "sync",
      moves: this.s.moves,
      names: this.s.names,
      present: this.presence(),
      clock: this.clock(),
      timeControl: this.s.tc,
      result: this.s.result,
      drawOffer: this.s.drawOffer,
    };
  }

  private send(ws: WebSocket | undefined, msg: ServerMsg) {
    if (!ws) return;
    try { ws.send(JSON.stringify(msg)); } catch { /* 切断済み */ }
  }

  private broadcast(msg: ServerMsg, except?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(data); } catch { /* 切断済み */ }
    }
  }
}
