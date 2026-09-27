import { HandLandmarker, FilesetResolver, type NormalizedLandmark, type Landmark } from "@mediapipe/tasks-vision";
import { OneEuro } from "./filter";
import { S, type Pt } from "./projection";
import { store } from "./store";

export type PinchEndReason = "release" | "lost";
export type CameraState = "off" | "loading" | "ready" | "error";

interface Thresholds { grab: number; release: number; releaseHeld: number }
const DEFAULT_THR: Thresholds = { grab: 0.2, release: 0.4, releaseHeld: 0.55 };

const LAG = 120;              // つまむ/離す動作で指がずれる前の位置を使う(ms)
const LOST_GRACE = 400;       // 検出が一瞬落ちても掴みを維持する時間(ms)
const RELEASE_FRAMES = 3;     // 「離す」確定に必要な連続フレーム数
const GRAB_FRAMES = 2;        // 「掴む」確定に必要な連続フレーム数
const CAL_SETTLE = 800, CAL_MS = 2500;

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

  onPinchStart?: (past: Pt, now: Pt) => void;
  onPinchEnd?: (past: Pt, reason: PinchEndReason) => void;
  onNotice?: (msg: string, ms?: number) => void;

  cameraState: CameraState = "off";
  cameraError = "";
  useFilter = true;
  thr: Thresholds = { ...DEFAULT_THR, ...store.get<Partial<Thresholds>>("thr2", {}) };
  hasCalibration = store.get<boolean>("calibrated", false);
  calib: Calib | null = null;

  // 解説・デバッグ表示用
  landmarks: NormalizedLandmark[] | null = null;
  pinchRatio = 0; imgRatio = 0; fps = 0;
  rawTrail: [number, number][] = []; filtTrail: [number, number][] = []; ratioHist: [number, boolean][] = [];

  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private fx = new OneEuro(); private fy = new OneEuro();
  private hist: { t: number; x: number; y: number }[] = [];
  private lastVideoTime = -1;
  private grabFrames = 0; private relFrames = 0; private relStart = 0; private lostSince = 0;
  private seen = 0;
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
      runningMode: "VIDEO", numHands: 1,
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
    const lm = res.landmarks[0], wl = res.worldLandmarks?.[0];
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

    if (this.calib) { this.calibTick(t); return; }      // 測定中は掴み判定を止める

    if (!this.pinch) {
      this.grabFrames = this.pinchRatio < this.thr.grab ? this.grabFrames + 1 : 0;
      if (this.grabFrames >= GRAB_FRAMES) this.setPinch(true);
    } else if (this.pinchRatio > (this.holding ? this.thr.releaseHeld : this.thr.release)) {
      this.relStart ||= t;                                                // 離し始めた時刻
      if (++this.relFrames >= RELEASE_FRAMES) { this.grabFrames = 0; this.setPinch(false, this.relStart - 40); }
    } else { this.relFrames = 0; this.relStart = 0; }                     // 途中で戻ったら「離す」はキャンセル
  }

  private onHandLost(t: number) {
    if (this.source !== "hand") return;
    this.lostSince ||= t;
    if (t - this.lostSince < LOST_GRACE) return;         // 一瞬の検出落ちは無視(掴んだ駒はその場に保持)
    this.fx.reset(); this.fy.reset(); this.grabFrames = 0; this.lostSince = 0;
    if (this.calib) { this.calib = null; this.onNotice?.("手を見失ったのでキャリブレーションを中断しました"); }
    this.cancelHold();
    this.source = "none";
  }

  private cancelHold() {
    if (this.pinch) { this.pinch = false; this.onPinchEnd?.(this.screen, "lost"); }   // 意図しない場所に置かず元に戻す
  }

  private record(t: number) { push(this.hist, { t, x: this.screen.x, y: this.screen.y }, 60); }

  posAt(t: number): Pt {
    let r = this.hist[0] ?? { ...this.screen, t: 0 };
    for (const h of this.hist) { if (h.t <= t) r = h; else break; }
    return { x: r.x, y: r.y };
  }

  private setPinch(next: boolean, at?: number) {
    if (next === this.pinch) return;
    this.pinch = next; this.relFrames = 0; this.relStart = 0;
    const past = this.posAt(at ?? performance.now() - (this.source === "hand" ? LAG : 0));
    if (next) this.onPinchStart?.(past, { ...this.screen });
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
