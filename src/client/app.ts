import { randomRoomCode } from "../shared/protocol";
import { audioState } from "./audio";
import { Game, type GameMode } from "./game";
import { HandInput } from "./hand";
import { ensureIdentity, fetchLeaderboard, fetchMe, loadIdentity, renameMe, restoreFromCode, rotateSecret, transferCode, type Me } from "./identity";
import { findMatch } from "./net";
import { View } from "./projection";
import { draw, drawMoveDiagram, drawOverlay } from "./render";
import { store } from "./store";
import { PIECE_INFO, formatClock, reasonText, resultTitle } from "./text";
import { glyphOf } from "./pieces";
import type { Color } from "../shared/protocol";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const setText = (el: HTMLElement, text: string) => { if (el.textContent !== text) el.textContent = text; };
type Screen = "title" | "start" | "lobby" | "game";

const validRoom = (c: string) => /^[A-Z0-9]{4,8}$/.test(c);

export class App {
  private input = new HandInput();
  private view = new View();
  private game = new Game(this.input, this.view);
  private canvas = $<HTMLCanvasElement>("board");
  private ctx = this.canvas.getContext("2d")!;
  private screen: Screen = "title";
  private bg = $<HTMLCanvasElement>("bg3d");
  private scene: { setMode(m: "title" | "menu"): void; start(): void; stop(): void } | null = null;
  private sceneFailed = false;
  private gl: { view: View; render(g: Game, opts: { hints: boolean }): void } | null = null;      // 3D描画(使えない環境では2D描画にフォールバック)
  private glFailed = false;
  private glCanvas = $<HTMLCanvasElement>("board3d");
  private diagram = $<HTMLCanvasElement>("moveDiagram");
  private diagramCtx = this.diagram.getContext("2d")!;
  private me: Me | null = null;
  private codeShown = false;
  private rotateArmedAt = 0;
  private explain = false;
  private senseIdx = store.get("senseIdx", 1);         // 奥行きの感度(0:低 1:標準 2:高)
  private hints = store.get("hints", true);         // 動かせる駒の印
  private debug = false;
  private cancelMatch: (() => void) | null = null;
  private lastResultSeq = 0;
  private calibDismissed = false;
  private camErrorDismissed = false;
  private resignArmedAt = 0;
  private renderedMoves: string[] = [];

  constructor() {
    this.input.attachMouse(this.canvas);
    this.input.video.className = "cam-bg"; this.input.video.hidden = true;
    this.canvas.parentElement!.prepend(this.input.video);
    this.input.onNotice = (m, ms) => this.toast(m, ms);
    this.game.onToast = (m, ms) => this.toast(m, ms);

    $<HTMLInputElement>("name").value = store.get("name", "");
    $<HTMLInputElement>("useCamera").checked = store.get("useCamera", true);
    audioState.enabled = store.get("sound", true);
    this.view.target = store.get("view3d", true) ? 0.52 : 0;

    this.game.depthMode = store.get("depth2", false);      // 実験機能: 初期はOFF
    this.wireStart(); this.wireGame(); this.wireModal(); this.wireKeys();
    this.wireProfile();
    void this.refreshMe();
    this.handleInviteLink();
    this.show(this.hasInvite() ? "start" : "title");
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------- 画面遷移 ----------
  private show(s: Screen) {
    this.screen = s;
    for (const name of ["title", "start", "lobby", "game"] as const) $(`screen-${name}`).hidden = name !== s;
    void this.ensureScene();
    this.applySceneState();
    window.scrollTo(0, 0);
  }

  /** 3D背景(three.jsは重いので、最初の画面を出したあとに読み込む) */
  private async ensureScene() {
    if (this.scene || this.sceneFailed) return;
    try {
      const mod = await import("./scene3d");
      this.scene = new mod.StartScene(this.bg);
      this.applySceneState();
    } catch (e) {
      console.warn("3D背景を使えません(背景は簡易表示になります)", e);
      this.sceneFailed = true;
    }
  }

  private applySceneState() {
    const visible = this.screen === "title" || this.screen === "start";
    this.bg.classList.toggle("off", !visible);
    if (!this.scene) return;
    this.scene.setMode(this.screen === "start" ? "menu" : "title");
    if (visible) this.scene.start(); else this.scene.stop();     // 対局中はGPUを使わない
  }

  private toast(msg: string, ms = 3200) {
    const el = document.createElement("div");
    el.className = "toast"; el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  private get playerName() { return $<HTMLInputElement>("name").value.trim().slice(0, 16) || "Player"; }
  private get useCamera() { return $<HTMLInputElement>("useCamera").checked; }

  private startGame(mode: GameMode) {
    store.set("name", $<HTMLInputElement>("name").value.trim());
    store.set("useCamera", this.useCamera);
    this.calibDismissed = false; this.camErrorDismissed = false; this.explain = false;
    this.lastResultSeq = this.game.resultSeq;
    this.renderedMoves = [];
    $("modal").hidden = true;
    const idn = loadIdentity();
    this.game.auth = idn ?? undefined;                                  // レート戦で、この人の戦績として保存するための本人確認
    if (idn && this.me && this.me.profile.name !== this.playerName) void renameMe(idn, this.playerName).then(() => this.refreshMe());
    this.game.start(mode, this.playerName);
    this.show("game");
    if (this.useCamera) void this.input.startCamera(); else this.input.stopCamera();
    void this.ensureGL();
  }

  /** ゲーム画面の3D描画(three.jsは遅延読み込み)。失敗したら2D描画のまま遊べる */
  private async ensureGL() {
    if (this.gl || this.glFailed) return;
    try {
      const mod = await import("./render3d");
      const gl = new mod.GameRenderer(this.glCanvas);
      this.gl = gl;
      this.game.view = gl.view;
      this.glCanvas.hidden = false;
      this.canvas.parentElement!.classList.add("gl");
    } catch (e) {
      console.warn("3D描画を使えません(2D表示で続けます)", e);
      this.glFailed = true;
    }
  }

  private goHome() {
    this.cancelMatch?.(); this.cancelMatch = null;
    this.game.destroy(); this.input.stopCamera();
    $("modal").hidden = true;
    history.replaceState(null, "", location.pathname);
    this.handleInviteLink();
    this.show("start");
  }

  private hasInvite(): boolean {
    return validRoom(new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "");
  }

  // ---------- スタート画面 ----------
  private wireStart() {
    $("startBtn").onclick = () => this.show("start");
    $("backTitle").onclick = () => this.show("title");

    // AIの強さ(見た目はセグメント、値は非表示のselectが持つ)
    const level = $<HTMLSelectElement>("aiLevel");
    const setLevel = (v: string) => {
      level.value = v;
      document.querySelectorAll<HTMLButtonElement>("#aiSeg button").forEach((b) => {
        const on = b.dataset.v === v;
        b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on));
      });
      store.set("aiLevel", v);
    };
    setLevel(store.get("aiLevel", "9"));
    document.querySelectorAll<HTMLButtonElement>("#aiSeg button").forEach((b) => { b.onclick = () => setLevel(b.dataset.v!); });

    // オンラインのタブ(ランダム / 部屋を作る / コードで参加)
    document.querySelectorAll<HTMLButtonElement>("#onlineTabs button").forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll<HTMLButtonElement>("#onlineTabs button").forEach((x) => {
          x.classList.toggle("on", x === b); x.setAttribute("aria-selected", String(x === b));
        });
        document.querySelectorAll<HTMLElement>(".online .panel").forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
      };
    });

    // 名前から作るアバター(頭文字 + 名前ごとの色)
    const nameInput = $<HTMLInputElement>("name"), avatar = $("avatar");
    const updateAvatar = () => {
      const n = nameInput.value.trim();
      avatar.textContent = (n ? [...n][0] : "P").toUpperCase();
      let h = 0; for (const ch of n || "P") h = (h * 31 + ch.charCodeAt(0)) % 360;
      avatar.style.background = `hsl(${h} 80% 68%)`;
    };
    nameInput.addEventListener("input", updateAvatar); updateAvatar();

    $("startAI").onclick = () => this.startGame({ kind: "ai", skill: +$<HTMLSelectElement>("aiLevel").value });
    $("startLocal").onclick = () => this.startGame({ kind: "local" });
    $("createRoom").onclick = () => {
      const room = randomRoomCode();
      history.replaceState(null, "", `?room=${room}`);
      this.startGame({ kind: "online", room, tc: $<HTMLSelectElement>("tc").value });
    };
    const join = (raw: string) => {
      const room = raw.trim().toUpperCase();
      if (!validRoom(room)) return this.toast("部屋コードは英数字4〜8文字です");
      history.replaceState(null, "", `?room=${room}`);
      this.startGame({ kind: "online", room, tc: "5+3" });
    };
    $("joinRoom").onclick = () => join($<HTMLInputElement>("joinCode").value);
    $("joinCode").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") join($<HTMLInputElement>("joinCode").value); });
    $("joinInvite").onclick = () => join($("inviteCode").textContent ?? "");

    const search = async () => {
      const idn = await ensureIdentity(this.playerName);            // レート戦のため、まだ無ければ、ここでプレイヤーを登録する
      if (!idn) this.toast("ランキングに接続できないため、今回はレートなしで遊びます", 4000);
      else void this.refreshMe();
      this.show("lobby");
      const t0 = Date.now();
      $("lobbyTitle").textContent = "対戦相手を探しています…";
      $("lobbyNote").textContent = "別の人が来るとすぐに始まります。";
      $("lobbyAI").hidden = true; $("lobbyRetry").hidden = true; $("cancelMatch").hidden = false;
      const tick = window.setInterval(() => {
        const sec = Math.floor((Date.now() - t0) / 1000);
        $("lobbyElapsed").textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        if (sec >= 30) { $("lobbyNote").textContent = "なかなか相手が来ません。AIと対戦して待つこともできます。"; $("lobbyAI").hidden = false; }
      }, 500);
      $("lobbyElapsed").textContent = "0:00";
      const m = findMatch(() => { /* 待機中 */ });
      this.cancelMatch = () => { window.clearInterval(tick); m.cancel(); };
      try {
        const room = await m.promise;
        window.clearInterval(tick); this.cancelMatch = null;
        history.replaceState(null, "", `?room=${room}`);
        this.startGame({ kind: "online", room, tc: "5+3" });
      } catch (e) {
        window.clearInterval(tick); this.cancelMatch = null;
        if ((e as Error).message === "timeout") {          // 待ち時間の上限: 選択肢を出す
          $("lobbyTitle").textContent = "相手が見つかりませんでした";
          $("lobbyNote").textContent = "もう一度探すか、AIと対戦できます。";
          $("lobbyAI").hidden = false; $("lobbyRetry").hidden = false; $("cancelMatch").hidden = true;
        } else { this.toast((e as Error).message); this.show("start"); }
      }
    };
    $("startRandom").onclick = search;
    $("lobbyRetry").onclick = search;
    $("lobbyAI").onclick = () => { this.cancelMatch?.(); this.cancelMatch = null; this.startGame({ kind: "ai", skill: +$<HTMLSelectElement>("aiLevel").value }); };
    $("cancelMatch").onclick = () => { this.cancelMatch?.(); this.cancelMatch = null; this.show("start"); };
  }

  private handleInviteLink() {
    const room = new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
    const ok = validRoom(room);
    $("invite").hidden = !ok;
    if (ok) { $("inviteCode").textContent = room; $<HTMLInputElement>("joinCode").value = room; }
  }

  // ---------- 対局画面 ----------
  private wireGame() {
    $("home").onclick = () => this.goHome();
    $("resign").onclick = () => {
      const now = performance.now();
      if (now - this.resignArmedAt < 3000) { this.resignArmedAt = 0; this.game.resign(); }
      else { this.resignArmedAt = now; this.toast("もう一度押すと投了します", 3000); }
    };
    $("draw").onclick = () => this.game.offerDraw();
    $("rematch").onclick = () => this.game.rematch();
    $("drawYes").onclick = () => this.game.acceptDraw();
    $("drawNo").onclick = () => this.game.declineDraw();
    $("copyLink").onclick = async () => {
      const url = `${location.origin}/?room=${this.game.roomCode}`;
      try { await navigator.clipboard.writeText(url); this.toast("招待リンクをコピーしました"); } catch { this.toast(url, 8000); }
    };

    $("tool3d").onclick = () => { this.view.toggle3D(); store.set("view3d", this.view.target > 0); };
    $("toolSound").onclick = () => { audioState.enabled = !audioState.enabled; store.set("sound", audioState.enabled); };
    $("toolCam").onclick = () => {
      if (this.input.cameraState === "off") { this.camErrorDismissed = false; void this.input.startCamera(); } else this.input.stopCamera();
    };
    $("toolCalib").onclick = () => this.calibrate();
    $("toolPgn").onclick = () => this.copyPgn();
    const SENSE: [string, number][] = [["低", 0.6], ["標準", 1], ["高", 1.6]];
    const setSense = (i: number) => { this.senseIdx = i; this.game.depthSense = SENSE[i][1]; store.set("senseIdx", i); setText($("toolDepthSense"), `奥行きの感度: ${SENSE[i][0]}`); };
    $("toolDepthSense").onclick = () => setSense((this.senseIdx + 1) % SENSE.length);
    setSense(this.senseIdx);
    $("toolMapCal").onclick = () => {
      const err = this.game.startBoardCal();
      this.toast(err ?? "光っている位置に手を持っていき、順につまんでください(Escでやめる)", err ? 4000 : 5000);
    };
    $("toolMap").onclick = () => {
      if (!this.game.boardMap) return this.toast("先に「盤の位置合わせ(四隅)」をしてください", 3500);
      this.game.mapOn = !this.game.mapOn; store.set("mapOn2", this.game.mapOn);
    };
    $("toolDepth").onclick = () => { this.game.depthMode = !this.game.depthMode; store.set("depth2", this.game.depthMode); };
    $("toolRelock").onclick = () => { this.input.releaseLock(); this.toast("いちばん近くの手を追従し直します", 2200); };
    $("toolHints").onclick = () => { this.hints = !this.hints; store.set("hints", this.hints); };
    // 駒ガイド(6種類の名前と動き方)
    $("guideList").replaceChildren(...["k", "q", "r", "b", "n", "p"].map((t) => {
      const li = document.createElement("li"); li.dataset.type = t;
      li.innerHTML = `<span class="g">${glyphOf(t)}</span><b>${PIECE_INFO[t].name}</b><span>${PIECE_INFO[t].move}</span>`;
      return li;
    }));
    $("toolFilter").onclick = () => { this.input.useFilter = !this.input.useFilter; };
    $("toolExplain").onclick = () => { this.explain = !this.explain; };
    $("calibStart").onclick = () => this.calibrate();
    $("calibLater").onclick = () => { this.calibDismissed = true; };
  }


  // ---------- ランキング / マイページ / 引き継ぎコード ----------
  private async refreshMe() {
    const idn = loadIdentity();
    if (!idn) { this.me = null; setText($("myRating"), "ランキング"); return; }
    this.me = await fetchMe(idn);
    const p = this.me?.profile;
    setText($("myRating"), p ? `${p.rating}${p.rank ? ` (${p.rank}位)` : ""}` : "ランキング");
  }

  private wireProfile() {
    const modal = $("profileModal");
    $("openProfile").onclick = () => { modal.hidden = false; this.showProfileTab("rank"); };
    $("pfClose").onclick = () => { modal.hidden = true; };
    modal.addEventListener("pointerdown", (e) => { if (e.target === modal) modal.hidden = true; });
    document.querySelectorAll<HTMLButtonElement>("#pfTabs button").forEach((b) => { b.onclick = () => this.showProfileTab(b.dataset.tab as "rank" | "me"); });

    $("codeShow").onclick = () => { this.codeShown = !this.codeShown; this.renderCode(); };
    $("codeCopy").onclick = async () => {
      const idn = loadIdentity(); if (!idn) return;
      try { await navigator.clipboard.writeText(transferCode(idn)); this.toast("引き継ぎコードをコピーしました。安全な場所に保管してください", 4000); } catch { this.toast("コピーできませんでした。「表示」から手動でコピーしてください", 4000); }
    };
    $("restoreBtn").onclick = async () => {
      const code = ($("restoreInput") as HTMLInputElement).value;
      const me = await restoreFromCode(code);
      if (!me) return this.toast("復元できませんでした。コードを確認してください", 4000);
      ($("restoreInput") as HTMLInputElement).value = "";
      $<HTMLInputElement>("name").value = me.profile.name; $("name").dispatchEvent(new Event("input"));
      store.set("name", me.profile.name);
      await this.refreshMe(); this.showProfileTab("me");
      this.toast(`${me.profile.name} さんのレーティング(${me.profile.rating})を復元しました`, 4000);
    };
    $("rotateBtn").onclick = async () => {
      const idn = loadIdentity(); if (!idn) return;
      const now = performance.now();
      if (now - this.rotateArmedAt > 4000) { this.rotateArmedAt = now; return this.toast("古いコードは使えなくなります。もう一度押すと再発行します", 4000); }
      this.rotateArmedAt = 0;
      const next = await rotateSecret(idn);
      this.toast(next ? "コードを再発行しました。新しいコードを保管してください" : "再発行できませんでした", 4000);
      this.codeShown = false; this.renderCode();
    };
  }

  private renderCode() {
    const idn = loadIdentity(), box = $<HTMLInputElement>("codeBox");
    box.value = idn ? (this.codeShown ? transferCode(idn) : "•".repeat(24)) : "(まだありません)";
    setText($("codeShow"), this.codeShown ? "隠す" : "表示");
  }

  private async showProfileTab(tab: "rank" | "me") {
    document.querySelectorAll<HTMLButtonElement>("#pfTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $("pfRank").hidden = tab !== "rank"; $("pfMe").hidden = tab !== "me";
    if (tab === "rank") {
      const rows = await fetchLeaderboard();
      const mine = this.me?.profile.name;
      $("lbEmpty").hidden = rows.length > 0;
      $("lbList").replaceChildren(...rows.map((r) => {
        const li = document.createElement("li"); if (r.name === mine) li.className = "me";
        li.innerHTML = `<span class="no">${r.rank}</span><span></span><span class="rt">${r.rating}</span><span class="gm">${r.games}戦</span>`;
        (li.children[1] as HTMLElement).textContent = r.name;          // 名前はtextContentで入れる(HTMLとして解釈させない)
        return li;
      }));
    } else {
      await this.refreshMe();
      this.codeShown = false; this.renderCode();
      const me = this.me;
      if (!me) {
        $("meSummary").textContent = "まだプレイヤー登録がありません。ランダム対戦(レート戦)を遊ぶと、自動で作られます。別の端末の成績を引き継ぐ場合は、下の欄にコードを貼り付けてください。";
        $("meGames").replaceChildren(); return;
      }
      const p = me.profile;
      $("meSummary").innerHTML = `<div class="stat-row"><div class="stat"><b>${p.rating}</b><span>レーティング</span></div><div class="stat"><b>${p.rank ?? "—"}</b><span>順位</span></div><div class="stat"><b>${p.wins}-${p.losses}-${p.draws}</b><span>勝-敗-分</span></div></div>`;
      $("meGames").replaceChildren(...me.games.map((g) => {
        const win = g.winner === null ? "d" : g.winner === g.myColor ? "w" : "l", d = g.after - g.before;
        const li = document.createElement("li");
        li.innerHTML = `<span class="${win}">${win === "w" ? "勝ち" : win === "l" ? "負け" : "分け"}</span><span></span><span>${g.after} (${d >= 0 ? "+" : ""}${d})</span>`;
        (li.children[1] as HTMLElement).textContent = `vs ${g.myColor === "w" ? g.black : g.white}`;
        return li;
      }));
    }
  }

  private async copyPgn() {
    const pgn = this.game.pgn();
    try { await navigator.clipboard.writeText(pgn); this.toast("棋譜(PGN)をコピーしました"); }
    catch { this.toast("コピーできませんでした。開発者ツールのコンソールに出力しました", 4000); console.log(pgn); }
  }

  private calibrate() {
    this.calibDismissed = true;
    const err = this.input.startCalib();
    if (err) this.toast(err, 4000);
  }

  private wireKeys() {
    addEventListener("keydown", (e) => {
      if (this.screen !== "game" || (e.target as HTMLElement).tagName === "INPUT" || e.metaKey || e.ctrlKey) return;
      if (this.game.promo) {                                              // 昇格の選択中は、Q/R/B/N で選ぶ。Escで取り消し
        const k = e.key.toLowerCase();
        if (k === "q" || k === "r" || k === "b" || k === "n") { this.game.choosePromotion(k); return; }
        if (e.key === "Escape") { this.game.cancelPromotion(); return; }
      }
      if (e.key === "Escape" && this.game.cal) { this.game.cancelBoardCal(); this.toast("位置合わせをやめました", 2000); return; }
      const k = e.key.toLowerCase();
      if (k === "d") this.debug = !this.debug;
      else if (k === "e") this.explain = !this.explain;
      else if (k === "f") this.input.useFilter = !this.input.useFilter;
      else if (k === "c") this.calibrate();
      else if (k === "r") { this.input.releaseLock(); this.toast("いちばん近くの手を追従し直します", 2200); }
    });
  }

  private wireModal() {
    $("modalRematch").onclick = () => { this.game.rematch(); $("modal").hidden = true; };
    $("modalHome").onclick = () => this.goHome();
    $("modalPgn").onclick = () => this.copyPgn();
    $("modalClose").onclick = () => { $("modal").hidden = true; };
  }

  // ---------- 毎フレーム ----------
  private frame(t: number) {
    if (this.screen === "game") {
      this.input.update(t);
      const opts = { explain: this.explain, debug: this.debug, hints: this.hints };
      if (this.gl) { this.gl.render(this.game, opts); drawOverlay(this.ctx, this.game, opts); }
      else draw(this.ctx, this.game, opts);
      this.diagramCtx.setTransform(2, 0, 0, 2, 0, 0);                                   // 高精細(2倍)で描く
      this.diagram.classList.toggle("on", drawMoveDiagram(this.diagramCtx, this.game, 168));
      this.input.video.hidden = !(this.gl && this.input.cameraState === "ready");     // 3D時はDOMのビデオで映す
      this.updateHud();
    }
    requestAnimationFrame((n) => this.frame(n));
  }

  private updateHud() {
    const g = this.game, inp = this.input;
    const bottom: Color = g.mode.kind === "local" ? (g.flip ? "b" : "w") : (g.myColor ?? "w"), top: Color = bottom === "w" ? "b" : "w";
    const online = g.mode.kind === "online";
    const clock = g.displayClock();

    for (const [pos, color] of [["Top", top], ["Bottom", bottom]] as const) {
      const name = g.names[color] ?? (online ? "待機中…" : "");
      const rt = g.rated && g.ratings[color] !== null ? ` · ${g.ratings[color]}` : "";
      setText($(`name${pos}`), name + rt + (g.myColor === color && online ? " (あなた)" : ""));
      $(`dot${pos}`).classList.toggle("on", !online || g.present[color]);
      const el = $(`clock${pos}`);
      if (!clock) { setText(el, ""); } else {
        setText(el, formatClock(clock[color]));
        el.classList.toggle("active", clock.running && clock.turn === color);
        el.classList.toggle("low", clock[color] < 10_000);
      }
    }

    setText($("status"), g.result ? `${resultTitle(g.result, g.myColor)} — ${reasonText(g.result.reason)}` : g.statusText());
    $("roomBox").hidden = !online;
    if (online) setText($("roomCode"), g.roomCode);
    $("ratedBadge").hidden = !g.rated;

    // 指し手リスト(変化があった時だけ作り直す)
    const moves = g.moveList;
    if (moves.length !== this.renderedMoves.length || moves[moves.length - 1] !== this.renderedMoves[this.renderedMoves.length - 1]) {
      const ol = $("moves");
      ol.replaceChildren(...moves.map((san) => Object.assign(document.createElement("li"), { textContent: san })));
      ol.scrollTop = ol.scrollHeight;
      this.renderedMoves = [...moves];
    }

    const spectator = online && !g.myColor;
    ($("resign") as HTMLButtonElement).disabled = !!g.result || spectator;
    $("draw").hidden = g.mode.kind === "ai";
    ($("draw") as HTMLButtonElement).disabled = !!g.result || spectator || (online && (!g.present.w || !g.present.b));
    $("rematch").hidden = !g.result;
    ($("rematch") as HTMLButtonElement).disabled = spectator;
    $("drawPrompt").hidden = !(g.drawOffer && g.drawOffer !== g.myColor && !g.result);
    $("rematchPrompt").hidden = !(g.rematchOffer && g.result);

    // ツールの表示
    setText($("toolSound"), `効果音: ${audioState.enabled ? "ON" : "OFF"}`);
    setText($("toolCam"), `カメラ: ${inp.cameraState === "off" ? "OFF" : "ON"}`);
    setText($("toolMap"), `実位置(実験): ${!g.boardMap ? "未設定" : g.mapOn ? "ON" : "OFF"}`);
    setText($("toolDepth"), `奥行き操作(実験): ${g.depthMode ? "ON" : "OFF"}`);
    setText($("toolHints"), `ヒント: ${this.hints ? "ON" : "OFF"}`);
    const focus = g.held?.type ?? g.hoverInfo()?.type;          // 指している/掴んでいる駒をガイドで光らせる
    document.querySelectorAll<HTMLElement>("#guideList li").forEach((li) => li.classList.toggle("on", li.dataset.type === focus));
    setText($("toolFilter"), `フィルタ: ${inp.useFilter ? "ON" : "OFF"} (F)`);

    // カメラの状態表示
    const overlay = $("camOverlay");
    const loading = inp.cameraState === "loading";
    const failed = inp.cameraState === "error" && !this.camErrorDismissed;
    overlay.hidden = !(loading || failed);
    if (loading) { setText($("camMsg"), "カメラとハンドトラッキングを準備しています…\n初回はモデルの読み込みに少し時間がかかります"); $("camActions").replaceChildren(); }
    if (failed && $("camActions").childElementCount === 0) {
      setText($("camMsg"), inp.cameraError);
      const retry = Object.assign(document.createElement("button"), { textContent: "再試行", className: "primary", onclick: () => { void inp.startCamera(); } });
      const skip = Object.assign(document.createElement("button"), { textContent: "マウス/タッチで続ける", onclick: () => { this.camErrorDismissed = true; } });
      $("camActions").append(retry, skip);
    }
    if (!failed && !loading) $("camActions").replaceChildren();
    $("calibBanner").hidden = !(inp.cameraState === "ready" && !inp.hasCalibration && !this.calibDismissed && inp.source === "hand" && !inp.calib && !g.result);

    // 結果ダイアログ(着地アニメーションの後に出す)
    if (g.resultSeq !== this.lastResultSeq) {
      this.lastResultSeq = g.resultSeq;
      if (g.result) setTimeout(() => this.showResult(), 900);
    }
    if (!g.result && !$("modal").hidden) $("modal").hidden = true;
  }

  private showResult() {
    const g = this.game;
    if (!g.result || this.screen !== "game") return;
    setText($("modalTitle"), resultTitle(g.result, g.myColor));
    setText($("modalReason"), reasonText(g.result.reason));
    const line = $("modalRating"), ch = g.myColor && g.ratingChanges ? g.ratingChanges[g.myColor] : null;
    line.hidden = !g.rated;
    if (g.rated) {
      if (ch) {
        const d = ch.after - ch.before;
        line.textContent = `レーティング ${ch.before} → ${ch.after} (${d >= 0 ? "+" : ""}${d})`;
        line.className = `rating-line ${d > 0 ? "up" : d < 0 ? "down" : "flat"}`;
        void this.refreshMe();
      } else { line.textContent = "この対局は、レートに反映されません(手数が少ない・未登録など)"; line.className = "rating-line flat"; line.style.fontSize = "13px"; }
    }
    ($("modalRematch") as HTMLButtonElement).disabled = g.mode.kind === "online" && !g.myColor;
    $("modal").hidden = false;
  }
}
