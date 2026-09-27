import { HandLandmarker, FilesetResolver, type NormalizedLandmark, type Landmark } from "@mediapipe/tasks-vision";
import { OneEuro } from "./filter";
import { S, type Pt } from "./projection";
import { store } from "./store";
import type { P3 } from "./calibration";

export type PinchEndReason = "release" | "lost";
/** 画面上の位置(x, y)と、奥行きの指標 r(手が大きく映る=カメラに近いほど大きい。マウスや未検出は 0) */
export type Pos = Pt & { r: number; p3: P3 | null };
export type CameraState = "off" | "loading" | "ready" | "error";

interface Thresholds { grab: number; release: number; releaseHeld: number }
const DEFAULT_THR: Thresholds = { grab: 0.2, release: 0.4, releaseHeld: 0.55 };

const LAG = 120;              // つまむ/離す動作で指がずれる前の位置を使う(ms)
const LOST_GRACE = 400;       // 検出が一瞬落ちても掴みを維持する時間(ms)
const RELEASE_FRAMES = 3;     // 「離す」確定に必要な連続フレーム数
const GRAB_FRAMES = 2;        // 「掴む」確定に必要な連続フレーム数
const CAL_SETTLE = 800, CAL_MS = 2500;
const MIN_HAND_SIZE = 0.07;        // 手首〜中指の付け根の長さ(画像に対する割合)。これより小さい手(遠い人)は無視
const PALM_SEGMENTS: [number, number][] = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 9], [9, 13], [13, 17], [5, 17]];   // 手のひらの骨格
const LOCK_RADIUS = 0.22;          // 追従中の手が、前のフレームからこれ以上離れたら別の手とみなす

/** 正規化されたカメラ座標(ミラー済み)を、カメラ中央80%が盤面全体に対応する画面座標に */
export const toScreen = (nx: number, ny: number): [number, number] => [
  Math.min(1, Math.max(0, (1 - nx - 0.1) / 0.8)) * S,
  Math.min(1, Math.max(0, (ny - 0.1) / 0.8)) * S,
];

const dist = (a: NormalizedLandmark, b: NormalizedLandmark) => Math.hypot(a.x - b.x, a.y - b.y);
const dist3 = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const push = <T,>(a: T[], v: T, n: number) => { a.push(v); if (a.length > n) a.shift(); };

interface Calib { step: "open" | "pinch"; t0: number; samples: number[]; open: number; text: string }

/**
 * ポインタ入力(手 / マウス・タッチ)。
 * 手: MediaPipe Hand Landmarkerで親指先と人差し指先の中点をカーソルにし、指先の距離(ピンチ比)で掴む/離すを判定する。
 * どちらの入力も onPinchStart / onPinchEnd に同じ形で通知するので、ゲーム側は入力の種類を意識しない。
 */
export class HandInput {
  readonly video = document.createElement("video");
  screen: Pt = { x: -1, y: -1 };
  pinch = false;
  source: "none" | "hand" | "mouse" = "none";
  holding = false;                       // ゲーム側が駒を掴んでいる間はtrue(離す閾値を緩めるため)

  onPinchStart?: (past: Pos, now: Pos) => void;
  onPinchEnd?: (past: Pos, reason: PinchEndReason) => void;
  onNotice?: (msg: string, ms?: number) => void;

  cameraState: CameraState = "off";
  cameraError = "";
  useFilter = true;
  thr: Thresholds = { ...DEFAULT_THR, ...store.get<Partial<Thresholds>>("thr2", {}) };
  hasCalibration = store.get<boolean>("calibrated", false);
  calib: Calib | null = null;

  // 解説・デバッグ表示用
  landmarks: NormalizedLandmark[] | null = null;
  otherHands: NormalizedLandmark[][] = [];              // 追従していない(無視している)手。画面に薄く出して、拾っていないことを示す
  pinchRatio = 0; imgRatio = 0; fps = 0;
  p3: P3 | null = null;                                 // 手(親指と人差し指の中点)の、カメラの前での3次元位置(メートル相当)。実位置マッピング用
  depth = 0;                                            // 奥行きの指標(大きいほどカメラに近い)。手が見えていない時・マウスの時は0
  rawTrail: [number, number][] = []; filtTrail: [number, number][] = []; ratioHist: [number, boolean][] = [];

  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private fx = new OneEuro(); private fy = new OneEuro();
  private hist: { t: number; x: number; y: number; r: number; p3: P3 | null }[] = [];
  private depthF = new OneEuro(0.8, 0.02);
  private p3F = [new OneEuro(1.2, 0.02), new OneEuro(1.2, 0.02)];
  private lastVideoTime = -1;
  private grabFrames = 0; private relFrames = 0; private relStart = 0; private lostSince = 0;
  private seen = 0;
  private lockPos: { x: number; y: number } | null = null;   // 追従中の手の位置(手の付け根)。これに近い手を追い続ける
  private fpsCount = 0; private fpsT = performance.now();

  constructor() {
    this.video.playsInline = true; this.video.muted = true;
  }

  /** つまむ進み具合(0: 開いている 〜 1: 掴む閾値に到達)。カーソルの周りの表示に使う */
  get pinchProgress(): number {
    if (this.source !== "hand") return this.pinch ? 1 : 0;
    if (this.pinch) return 1;
    return Math.min(1, Math.max(0, (this.thr.release - this.pinchRatio) / Math.max(1e-3, this.thr.release - this.thr.grab)));
  }

  /** 追従を解除する。次に、いちばん近くに映った手を追従し直す(二人対戦で手番が変わった時など) */
  releaseLock() { this.lockPos = null; this.cancelHold(); this.fx.reset(); this.fy.reset(); }

  // ---------- カメラ ----------
  async startCamera(): Promise<void> {
    if (this.cameraState === "loading" || this.cameraState === "ready") return;
    this.cameraState = "loading"; this.cameraError = "";
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("カメラはHTTPSまたはlocalhostでのみ使えます");
      if (!this.landmarker) this.landmarker = await this.createLandmarker();
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.cameraState = "ready";
    } catch (e) {
      this.cameraState = "error";
      const err = e as DOMException;
      this.cameraError = err.name === "NotAllowedError" ? "カメラの使用が許可されていません(マウス/タッチでは操作できます)"
        : err.name === "NotFoundError" ? "カメラが見つかりません(マウス/タッチでは操作できます)"
        : `カメラを開始できません: ${err.message}`;
    }
  }

  stopCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.video.srcObject = null;
    this.cameraState = "off"; this.landmarks = null;
    if (this.source === "hand") { this.cancelHold(); this.source = "none"; }
  }

  private async createLandmarker(): Promise<HandLandmarker> {
    const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    const make = (delegate: "GPU" | "CPU") => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "/models/hand_landmarker.task", delegate },
      runningMode: "VIDEO", numHands: 3,          // 見ている人の手も検出して、追従する1つを自分で選ぶ
      minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,   // 既定0.5より緩めて検出落ちを減らす
    });
    try { return await make("GPU"); } catch { return await make("CPU"); }
  }

  // ---------- マウス/タッチ ----------
  attachMouse(canvas: HTMLCanvasElement) {
    const toCanvas = (e: PointerEvent): Pt => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * S, y: ((e.clientY - r.top) / r.height) * S };
    };
    const handActive = () => performance.now() - this.seen < 500;
    const move = (e: PointerEvent) => {
      if (handActive()) return;
      const p = toCanvas(e); this.screen = p; this.source = "mouse"; this.record(performance.now());
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerdown", (e) => {
      if (handActive() || e.button > 0) return;
      move(e); canvas.setPointerCapture(e.pointerId); this.setPinch(true);
    });
    const up = () => { if (this.source === "mouse") this.setPinch(false); };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  }

  // ---------- 毎フレーム ----------
  update(t: number) {
    const now = performance.now();
    if (now - this.fpsT > 1000) { this.fps = this.fpsCount; this.fpsCount = 0; this.fpsT = now; }
    if (this.cameraState !== "ready" || !this.landmarker || this.video.readyState < 2 || this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime; this.fpsCount++;

    const res = this.landmarker.detectForVideo(this.video, t);
    const hands = res.landmarks.map((l, i) => ({ lm: l, wl: res.worldLandmarks?.[i], size: dist(l[0], l[9]), c: l[9] }));

    // 追従する手を1つに決める: 追従中は「前の位置に近い手」を追い続け、まだ決まっていなければ「いちばん近く(大きく)映った手」を選ぶ
    let pick: (typeof hands)[number] | null = null;
    if (this.lockPos) {
      let bd = LOCK_RADIUS;
      for (const h of hands) { const d = Math.hypot(h.c.x - this.lockPos.x, h.c.y - this.lockPos.y); if (d < bd) { bd = d; pick = h; } }
    } else if (hands.length) {
      const biggest = hands.reduce((a, b) => (b.size > a.size ? b : a));
      if (biggest.size >= MIN_HAND_SIZE) pick = biggest;
    }
    this.otherHands = hands.filter((h) => h !== pick).map((h) => h.lm);
    const lm = pick?.lm, wl = pick?.wl;
    if (pick) this.lockPos = { x: pick.c.x, y: pick.c.y };
    this.landmarks = lm ?? null;

    if (!lm) { this.onHandLost(t); return; }
    this.lostSince = 0; this.source = "hand"; this.seen = performance.now();

    // 親指先(4)と人差し指先(8)の中点をカーソルに(つまむ動作でずれにくい)
    const [sx, sy] = toScreen((lm[4].x + lm[8].x) / 2, (lm[4].y + lm[8].y) / 2);
    const fxv = this.fx.filter(sx, t), fyv = this.fy.filter(sy, t);     // フィルタは常に更新し、ON/OFFは使う値の切替だけ
    this.screen = { x: this.useFilter ? fxv : sx, y: this.useFilter ? fyv : sy };
    this.record(t);

    // ピンチ比: 手のサイズ(手のひら幅と長さの平均)で指先距離を割る。3D比と画像比の小さい方を採用(向きによる破綻を防ぐ)
    this.imgRatio = dist(lm[4], lm[8]) / ((dist(lm[5], lm[17]) + 0.75 * dist(lm[0], lm[9])) / 2);
    this.pinchRatio = wl
      ? Math.min(this.imgRatio, dist3(wl[4], wl[8]) / ((dist3(wl[5], wl[17]) + 0.75 * dist3(wl[0], wl[9])) / 2))
      : this.imgRatio;
    push(this.rawTrail, [sx, sy], 40); push(this.filtTrail, [fxv, fyv], 40); push(this.ratioHist, [this.pinchRatio, this.pinch], 160);

    this.depth = this.estimateDepth(lm, wl, t);
    this.p3 = this.depth > 0 ? this.estimateP3(lm, t) : null;

    if (this.calib) { this.calibTick(t); return; }      // 測定中は掴み判定を止める

    if (!this.pinch) {
      this.grabFrames = this.pinchRatio < this.thr.grab ? this.grabFrames + 1 : 0;
      if (this.grabFrames >= GRAB_FRAMES) this.setPinch(true);
    } else if (this.pinchRatio > (this.holding ? this.thr.releaseHeld : this.thr.release)) {
      this.relStart ||= t;                                                // 離し始めた時刻
      if (++this.relFrames >= RELEASE_FRAMES) { this.grabFrames = 0; this.setPinch(false, this.relStart - 40); }
    } else { this.relFrames = 0; this.relStart = 0; }                     // 途中で戻ったら「離す」はキャンセル
  }

  /**
   * 奥行きの指標: 手のひらの線分について「画像上の長さ ÷ 実寸(メートル)」を求め、最大のものを使う。
   * カメラに近いほど大きい(焦点距離÷距離に比例)。向きで縮んで見える線分は小さくなるので、最大値を取れば向きの影響を受けにくい。
   */
  private estimateDepth(lm: NormalizedLandmark[], wl: Landmark[] | undefined, t: number): number {
    if (!wl) return 0;
    const W = this.video.videoWidth || 640, H = this.video.videoHeight || 480;
    let best = 0;
    for (const [a, b] of PALM_SEGMENTS) {
      const wd = dist3(wl[a], wl[b]);
      if (wd < 1e-4) continue;
      best = Math.max(best, Math.hypot((lm[a].x - lm[b].x) * W, (lm[a].y - lm[b].y) * H) / wd);
    }
    return best > 0 ? this.depthF.filter(best, t) : 0;
  }

  /**
   * 手の3次元位置(カメラ座標、メートル相当)。奥行き Z = f / r(r は 画像上の長さ÷実寸 = f/Z)、X・Y はピンホールカメラの式。
   * 焦点距離 f は一般的なWebカメラ(水平画角およそ60〜65°)を仮定して 0.9×幅(px) とする。
   * f の仮定が多少ずれても、四隅キャリブレーションが一次式のスケールごと吸収する。
   */
  private estimateP3(lm: NormalizedLandmark[], t: number): P3 {
    const W = this.video.videoWidth || 640, H = this.video.videoHeight || 480, r = this.depth;
    const mx = this.p3F[0].filter((lm[4].x + lm[8].x) / 2, t), my = this.p3F[1].filter((lm[4].y + lm[8].y) / 2, t);
    return { x: ((mx - 0.5) * W) / r, y: ((my - 0.5) * H) / r, z: (0.9 * W) / r };
  }

  private onHandLost(t: number) {
    if (this.source !== "hand") return;
    this.lostSince ||= t;
    if (t - this.lostSince < LOST_GRACE) return;         // 一瞬の検出落ちは無視(掴んだ駒はその場に保持)
    this.fx.reset(); this.fy.reset(); this.depthF.reset(); this.p3F.forEach((f) => f.reset()); this.depth = 0; this.p3 = null; this.grabFrames = 0; this.lostSince = 0; this.lockPos = null;
    if (this.calib) { this.calib = null; this.onNotice?.("手を見失ったのでキャリブレーションを中断しました"); }
    this.cancelHold();
    this.source = "none";
  }

  private cancelHold() {
    if (this.pinch) { this.pinch = false; this.onPinchEnd?.({ ...this.screen, r: this.depth, p3: this.p3 }, "lost"); }   // 意図しない場所に置かず元に戻す
  }

  private record(t: number) { push(this.hist, { t, x: this.screen.x, y: this.screen.y, r: this.depth, p3: this.p3 }, 60); }

  posAt(t: number): Pos {
    let r = this.hist[0] ?? { ...this.screen, r: this.depth, p3: this.p3, t: 0 };
    for (const h of this.hist) { if (h.t <= t) r = h; else break; }
    return { x: r.x, y: r.y, r: r.r, p3: r.p3 };
  }

  private setPinch(next: boolean, at?: number) {
    if (next === this.pinch) return;
    this.pinch = next; this.relFrames = 0; this.relStart = 0;
    const past = this.posAt(at ?? performance.now() - (this.source === "hand" ? LAG : 0));
    if (next) this.onPinchStart?.(past, { ...this.screen, r: this.depth, p3: this.p3 });
    else this.onPinchEnd?.(past, "release");
  }

  // ---------- キャリブレーション: 「開く」「つまむ」を2.5秒ずつ測り、その間に閾値を置く ----------
  startCalib(): string | null {
    if (this.cameraState !== "ready") return "カメラが使えないため、キャリブレーションはできません";
    if (this.source !== "hand") return "手をカメラに映してから実行してください";
    this.cancelHold(); this.grabFrames = 0;
    this.calib = { step: "open", t0: performance.now(), samples: [], open: 0, text: "" };
    return null;
  }

  private calibTick(t: number) {
    const c = this.calib!;
    const el = t - c.t0, left = Math.max(0, Math.ceil((CAL_SETTLE + CAL_MS - el) / 1000));
    c.text = c.step === "open" ? `手を大きく開いてください… ${left}` : `親指と人差し指をしっかりつまんでください… ${left}`;
    if (el > CAL_SETTLE) c.samples.push(this.pinchRatio);              // 動かし始めの値は捨てる
    if (el < CAL_SETTLE + CAL_MS) return;
    const s = [...c.samples].sort((a, b) => a - b), med = s[s.length >> 1];
    if (c.step === "open") { this.calib = { step: "pinch", t0: t, samples: [], open: med, text: "" }; return; }
    const open = c.open, range = open - med;
    this.calib = null;
    if (!(range > 0.25)) { this.onNotice?.(`差が小さすぎます(開く${open.toFixed(2)} / つまむ${med.toFixed(2)})。もう一度どうぞ`, 6000); return; }
    // つまみ値から開き値への 15/45/60% 位置。掴みは「ほぼ完全に触れた時」だけにする
    this.thr = { grab: med + 0.15 * range, release: med + 0.45 * range, releaseHeld: med + 0.6 * range };
    store.set("thr2", this.thr); store.set("calibrated", true); this.hasCalibration = true;
    this.onNotice?.(`設定完了(つまむ${med.toFixed(2)} / 開く${open.toFixed(2)})`, 4000);
  }
}
