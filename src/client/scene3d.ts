import * as THREE from "three";

/**
 * スタート画面の3D背景。外部モデルは使わず、駒も手もコードで生成する。
 *  - 駒: 回転体(LatheGeometry)と球・箱の組み合わせ。ナイトだけ横顔をExtrudeで押し出す。
 *  - 手: 親指と人差し指を2ボーンIKで駒の幅に合わせて動かし、「つまんで、運んで、離す」を繰り返す。
 */

type PieceType = "p" | "r" | "n" | "b" | "q" | "k";
export type SceneMode = "title" | "menu";

const IVORY = 0xf3e6c8;
const NAVY = 0x22254a;
const UP = new THREE.Vector3(0, 1, 0);

// ---------- 駒 ----------
const BASE: [number, number][] = [[0.001, 0], [0.42, 0], [0.45, 0.05], [0.42, 0.11], [0.32, 0.17]];

function lathe(pts: [number, number][], mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 56);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function buildPiece(type: PieceType, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const sphere = (r: number, y: number, sy = 1, x = 0, z = 0) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 20), mat);
    m.position.set(x, y, z); m.scale.y = sy; m.castShadow = true;
    g.add(m);
  };
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.rotation.y = ry; m.castShadow = true;
    g.add(m);
  };

  switch (type) {
    case "p":
      g.add(lathe([...BASE, [0.2, 0.3], [0.14, 0.5], [0.22, 0.56], [0.26, 0.6], [0.2, 0.64], [0.1, 0.66]], mat));
      sphere(0.21, 0.82);
      break;
    case "r":
      g.add(lathe([...BASE, [0.27, 0.3], [0.24, 0.8], [0.34, 0.88], [0.36, 1.02], [0.4, 1.08], [0.4, 1.14], [0.3, 1.14], [0.3, 1.06], [0.001, 1.06]], mat));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        box(0.14, 0.16, 0.13, Math.cos(a) * 0.35, 1.2, Math.sin(a) * 0.35, -a);
      }
      break;
    case "b":
      g.add(lathe([...BASE, [0.22, 0.3], [0.15, 0.7], [0.26, 0.78], [0.28, 0.84], [0.14, 0.9], [0.001, 0.92]], mat));
      sphere(0.24, 1.12, 1.45);
      sphere(0.06, 1.52);
      break;
    case "q":
      g.add(lathe([...BASE, [0.24, 0.3], [0.17, 0.85], [0.3, 0.96], [0.34, 1.05], [0.2, 1.12], [0.3, 1.36], [0.32, 1.42], [0.001, 1.42]], mat));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        sphere(0.07, 1.46, 1, Math.cos(a) * 0.3, Math.sin(a) * 0.3);
      }
      sphere(0.11, 1.64);
      break;
    case "k":
      g.add(lathe([...BASE, [0.24, 0.3], [0.17, 0.85], [0.3, 0.96], [0.34, 1.05], [0.2, 1.12], [0.3, 1.36], [0.2, 1.44], [0.001, 1.46]], mat));
      box(0.1, 0.38, 0.1, 0, 1.7, 0);
      box(0.32, 0.1, 0.1, 0, 1.74, 0);
      break;
    case "n": {
      g.add(lathe([...BASE, [0.3, 0.26], [0.001, 0.26]], mat));
      const s = new THREE.Shape();
      const pts: [number, number][] = [
        [-0.26, 0.24], [0.3, 0.24], [0.28, 0.4], [0.16, 0.58], [0.22, 0.62], [0.44, 0.7], [0.48, 0.8], [0.4, 0.92],
        [0.16, 1.08], [0.1, 1.28], [-0.02, 1.14], [-0.12, 1.16], [-0.28, 0.8], [-0.3, 0.5],
      ];
      s.moveTo(...pts[0]); for (const p of pts.slice(1)) s.lineTo(...p); s.closePath();
      const geo = new THREE.ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 4, curveSegments: 8 });
      geo.translate(0, 0, -0.15);
      const head = new THREE.Mesh(geo, mat);
      head.castShadow = true; head.receiveShadow = true;
      g.add(head);
      break;
    }
  }
  return g;
}

/** 手が駒をつまむ高さ(駒の底からの高さ) */
const GRIP_Y: Record<PieceType, number> = { p: 0.6, r: 0.75, n: 0.85, b: 0.72, q: 0.85, k: 0.85 };
/** つまんだ時の指先の間隔(駒の厚み + 指の太さ) */
const CLOSED_GAP: Record<PieceType, number> = { p: 0.46, r: 0.6, n: 0.46, b: 0.42, q: 0.5, k: 0.5 };

// ---------- 手 ----------
class Seg {
  readonly mesh: THREE.Mesh;
  private readonly d = new THREE.Vector3();
  constructor(r0: number, r1: number, mat: THREE.Material) {
    this.mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, 1, 20, 1), mat);
    this.mesh.castShadow = true;
  }
  set(p0: THREE.Vector3, p1: THREE.Vector3) {
    this.d.subVectors(p1, p0);
    const len = this.d.length();
    this.mesh.position.copy(p0).addScaledVector(this.d, 0.5);
    this.mesh.quaternion.setFromUnitVectors(UP, this.d.normalize());
    this.mesh.scale.set(1, Math.max(len, 1e-3), 1);
  }
}

/** 2ボーンIK: 根元rootから指先targetに届く中間関節を求める(poleで曲がる向きを指定)。届かない時は指先を引き寄せる */
function solveTwoBone(root: THREE.Vector3, target: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, outMid: THREE.Vector3, outTip: THREE.Vector3) {
  const dir = new THREE.Vector3().subVectors(target, root);
  let dist = dir.length();
  const maxD = a + b - 1e-3, minD = Math.abs(a - b) + 1e-3;
  dist = Math.min(Math.max(dist, minD), maxD);
  dir.normalize();
  const cosA = (a * a + dist * dist - b * b) / (2 * a * dist);
  const A = Math.acos(Math.min(1, Math.max(-1, cosA)));
  const pv = pole.clone().addScaledVector(dir, -pole.dot(dir));
  if (pv.lengthSq() < 1e-6) pv.set(0, 0, 1);
  pv.normalize();
  outMid.copy(root).addScaledVector(dir, a * Math.cos(A)).addScaledVector(pv, a * Math.sin(A));
  outTip.copy(root).addScaledVector(dir, dist);
}

interface Finger {
  root: THREE.Vector3; a: number; b: number; pole: THREE.Vector3;
  s1: Seg; s2: Seg; joints: THREE.Mesh[];
  mid: THREE.Vector3; tip: THREE.Vector3;
}

const HAND_YAW = -0.5;                  // 手を少し斜めに向けて、つまむ2本の指がカメラから見えるようにする
const HAND_H = 1.7;                    // 手のひらの中心から指先(つまむ点)までの縦の距離
const GRIP_LOCAL = new THREE.Vector3(0, -HAND_H, 0.02);

class Hand {
  readonly group = new THREE.Group();
  private fingers: Finger[] = [];
  private index!: Finger;
  private thumb!: Finger;

  constructor(skin: THREE.Material, cuff: THREE.Material) {
    const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), skin);
    palm.scale.set(0.5, 0.58, 0.2); palm.castShadow = true;
    this.group.add(palm);

    // 前腕と袖口
    const arm = new Seg(0.3, 0.38, skin);
    arm.set(new THREE.Vector3(0, 0.35, -0.02), new THREE.Vector3(0.6, 4.6, 1.5));
    this.group.add(arm.mesh);
    const cuffMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.44, 0.34, 32), cuff);
    const c0 = new THREE.Vector3(0.09, 0.85, 0.14), dir = new THREE.Vector3(0.6, 4.25, 1.52).normalize();
    cuffMesh.position.copy(c0); cuffMesh.quaternion.setFromUnitVectors(UP, dir);
    this.group.add(cuffMesh);

    // 人差し指と親指(つまむ2本)
    this.index = this.makeFinger(new THREE.Vector3(0.28, -0.55, 0.05), 0.72, 0.6, new THREE.Vector3(0.5, 0, 0.9), 0.115, skin);
    this.thumb = this.makeFinger(new THREE.Vector3(-0.34, -0.55, 0.1), 0.72, 0.56, new THREE.Vector3(-0.5, 0, 0.9), 0.125, skin);
    // 残りの3本は手の甲側に折り込む
    const curled: [number, number, number][] = [[0.1, -0.55, -0.12], [-0.08, -0.5, -0.2], [-0.24, -0.42, -0.26]];
    for (const [x, y, z] of curled) {
      const f = this.makeFinger(new THREE.Vector3(x, y, z), 0.36, 0.3, new THREE.Vector3(0, 0.3, -1), 0.1, skin);
      solveTwoBone(f.root, f.root.clone().add(new THREE.Vector3(0.02, -0.34, -0.2)), f.a, f.b, f.pole, f.mid, f.tip);
      this.applyFinger(f);
    }
  }

  private makeFinger(root: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, r: number, mat: THREE.Material): Finger {
    const s1 = new Seg(r * 1.15, r, mat), s2 = new Seg(r, r * 0.8, mat);
    const joints = [r * 1.15, r, r * 0.8].map((jr) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(jr, 16, 12), mat);
      m.castShadow = true;
      return m;
    });
    this.group.add(s1.mesh, s2.mesh, ...joints);
    const f: Finger = { root, a, b, pole, s1, s2, joints, mid: new THREE.Vector3(), tip: new THREE.Vector3() };
    this.fingers.push(f);
    return f;
  }

  private applyFinger(f: Finger) {
    f.s1.set(f.root, f.mid); f.s2.set(f.mid, f.tip);
    f.joints[0].position.copy(f.root); f.joints[1].position.copy(f.mid); f.joints[2].position.copy(f.tip);
  }

  /** gap: 親指と人差し指の指先の間隔。指先をつまむ点の左右に置いてIKで関節を決める */
  pose(gap: number) {
    const t = new THREE.Vector3();
    solveTwoBone(this.index.root, t.copy(GRIP_LOCAL).add(new THREE.Vector3(gap / 2, 0, 0)), this.index.a, this.index.b, this.index.pole, this.index.mid, this.index.tip);
    this.applyFinger(this.index);
    solveTwoBone(this.thumb.root, t.copy(GRIP_LOCAL).add(new THREE.Vector3(-gap / 2, 0, 0)), this.thumb.a, this.thumb.b, this.thumb.pole, this.thumb.mid, this.thumb.tip);
    this.applyFinger(this.thumb);
  }
}

// ---------- 動きの台本 ----------
interface Actor { obj: THREE.Group; type: PieceType; pos: THREE.Vector3 }
interface Step { actor: Actor; to: THREE.Vector3 }

const PHASES: [string, number][] = [
  ["approach", 1.1], ["descend", 0.55], ["pinch", 0.4], ["lift", 0.55],
  ["carry", 1.25], ["lower", 0.5], ["release", 0.4], ["retreat", 0.9],
];
const CYCLE = PHASES.reduce((s, [, d]) => s + d, 0);
const OPEN_GAP = 1.35;

const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const sq = (file: number, rank: number) => new THREE.Vector3(file - 3.5, 0, 4.5 - rank);   // file 0..7 (a-h), rank 1..8

export class StartScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  private hand: Hand;
  private handLight = new THREE.PointLight(0x66ccff, 26, 9, 1.6);
  private flash: THREE.Mesh;
  private steps: Step[] = [];
  private giants: { a: Actor; side: number; k: number }[] = [];
  private stepIdx = 0;
  private stepT = 0;
  private lastRest = new THREE.Vector3();
  private flashT = 9;
  private flashed = false;
  private raf = 0;
  private last = 0;
  private mode: SceneMode = "title";
  private camPos = new THREE.Vector3(0, 5.6, 10.4);
  private camLook = new THREE.Vector3(0, 0.9, -0.4);
  private pointer = new THREE.Vector2();
  private reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private ro: ResizeObserver;
  private onPointer = (e: PointerEvent) => { this.pointer.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1); };

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.fog = new THREE.Fog(0x0a0d14, 12, 26);
    this.buildLights();

    const ivory = new THREE.MeshStandardMaterial({ color: IVORY, roughness: 0.34, metalness: 0.06 });
    const navy = new THREE.MeshStandardMaterial({ color: NAVY, roughness: 0.28, metalness: 0.4, emissive: 0x0b0f2a, emissiveIntensity: 0.6 });
    this.buildBoard();
    const actors = this.buildPieces(ivory, navy);

    const skin = new THREE.MeshStandardMaterial({ color: 0xeef1f8, roughness: 0.42, metalness: 0.08, emissive: 0x0a1830, emissiveIntensity: 0.5 });
    const cuff = new THREE.MeshStandardMaterial({ color: 0x1b2a44, roughness: 0.4, metalness: 0.3, emissive: 0x66ccff, emissiveIntensity: 0.55 });
    this.hand = new Hand(skin, cuff);
    this.hand.group.rotation.y = HAND_YAW;
    this.scene.add(this.hand.group, this.handLight);

    this.flash = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 48), new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.flash.rotation.x = -Math.PI / 2;
    this.scene.add(this.flash);

    // つまんで動かす台本(ナイトが行ったり来たりするので、切れ目なくループする)
    this.steps = [
      { actor: actors.wN, to: sq(4, 4) }, { actor: actors.bN, to: sq(4, 5) },
      { actor: actors.wN, to: sq(2, 3) }, { actor: actors.bN, to: sq(2, 6) },
    ];
    this.lastRest = this.restGrip(actors.wN.pos);
    this.renderFrame(0);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    addEventListener("pointermove", this.onPointer, { passive: true });
  }

  // ---------- 構築 ----------
  private buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x0a0d14, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(-4.5, 9, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 26 });
    sun.shadow.bias = -0.0004; sun.shadow.radius = 4;
    this.scene.add(sun);
    const rim = new THREE.PointLight(0x7d8cff, 55, 20, 1.5);
    rim.position.set(5.5, 3.5, -6);
    this.scene.add(rim);
    const fill = new THREE.PointLight(0x4fd0c0, 22, 16, 1.6);
    fill.position.set(-6, 2, 5);
    this.scene.add(fill);
  }

  private buildBoard() {
    // 舞台の床(暗い円盤) + 盤(厚みのある箱)
    const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ color: 0x0d1220, roughness: 0.55, metalness: 0.5 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.26; floor.receiveShadow = true;
    this.scene.add(floor);

    const frame = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.25, 9.2), new THREE.MeshStandardMaterial({ color: 0x141a2c, roughness: 0.4, metalness: 0.5 }));
    frame.position.y = -0.14; frame.receiveShadow = true;
    this.scene.add(frame);

    const light = new THREE.MeshStandardMaterial({ color: 0xc9d2e6, roughness: 0.42, metalness: 0.08 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x27345a, roughness: 0.38, metalness: 0.2 });
    const geo = new THREE.BoxGeometry(1, 0.08, 1);
    for (let f = 0; f < 8; f++) for (let r = 1; r <= 8; r++) {
      const m = new THREE.Mesh(geo, (f + r) % 2 ? light : dark);
      const p = sq(f, r); m.position.set(p.x, -0.04, p.z); m.receiveShadow = true;
      this.scene.add(m);
    }
  }

  private buildPieces(ivory: THREE.Material, navy: THREE.Material): { wN: Actor; bN: Actor } {
    const place = (type: PieceType, mat: THREE.Material, pos: THREE.Vector3, scale = 1, ry = 0): Actor => {
      const obj = buildPiece(type, mat);
      obj.position.copy(pos); obj.scale.setScalar(scale); obj.rotation.y = ry;
      this.scene.add(obj);
      return { obj, type, pos: pos.clone() };
    };
    const back: PieceType[] = ["r", "n", "b", "q", "k", "b", "n", "r"];
    // b/g ファイルのナイトは個別に置く(b側は動かす2体になる)
    for (let f = 0; f < 8; f++) {
      if (f !== 1 && f !== 6) place(back[f], ivory, sq(f, 1), 1, 0);
      if (f !== 1 && f !== 6) place(back[f], navy, sq(f, 8), 1, 0);
      if (f !== 3 && f !== 4) { place("p", ivory, sq(f, 2)); place("p", navy, sq(f, 7)); }
    }
    place("n", ivory, sq(6, 1), 1, Math.PI / 2 + 0.25);
    place("n", navy, sq(6, 8), 1, -Math.PI / 2 - 0.25);
    place("p", ivory, sq(3, 4)); place("p", navy, sq(3, 5));         // d4 / d5 の向かい合うポーン

    // 動かす2体のナイト(白はc3、黒はc6)。向きは、つまむ方向(横)から見て薄くなるように
    const wN = place("n", ivory, sq(2, 3), 1, Math.PI / 2 + HAND_YAW);
    const bN = place("n", navy, sq(2, 6), 1, -Math.PI / 2 + HAND_YAW);

    // 左右に、画面いっぱいの巨大な駒(横位置は画面の縦横比に合わせて resize() で調整)
    this.giants = [
      { a: place("k", navy, new THREE.Vector3(-6, -0.26, 1.4), 2.9, 0.55), side: -1, k: 1 },
      { a: place("q", ivory, new THREE.Vector3(6, -0.26, 0.6), 2.7, -0.55), side: 1, k: 1 },
      { a: place("b", navy, new THREE.Vector3(-10, -0.26, -2.8), 2.6, 0.3), side: -1, k: 1.75 },
      { a: place("r", ivory, new THREE.Vector3(10, -0.26, -3.2), 2.4, -0.3), side: 1, k: 1.75 },
    ];
    return { wN, bN };
  }

  // ---------- 位置の計算 ----------
  private hoverGrip(a: Actor, at = a.pos) { return new THREE.Vector3(at.x, at.y + GRIP_Y[a.type] + 0.95, at.z); }
  private atGrip(a: Actor, at = a.pos) { return new THREE.Vector3(at.x, at.y + GRIP_Y[a.type], at.z); }
  private restDx = 2.8;                     // 待機位置の横オフセット(縦長画面では画面内に収める)
  private restGrip(at: THREE.Vector3) { return new THREE.Vector3(at.x + this.restDx, at.y + 3.4, at.z + 0.9); }

  private resize() {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // 画面の左右の端に巨大な駒が半分ほど入るように、横位置を縦横比から決める
    const halfW = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect * 11;
    this.restDx = this.camera.aspect < 1 ? 1.5 : 2.8;
    const x = Math.min(8.5, Math.max(5.2, halfW * 0.72));
    for (const g of this.giants) { g.a.obj.position.x = g.side * x * g.k; g.a.pos.x = g.a.obj.position.x; }
  }

  setMode(mode: SceneMode) { this.mode = mode; }

  start() {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (t: number) => { this.raf = requestAnimationFrame(loop); this.renderFrame(Math.min(0.05, (t - this.last) / 1000)); this.last = t; };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  dispose() {
    this.stop(); this.ro.disconnect(); removeEventListener("pointermove", this.onPointer);
    this.renderer.dispose();
  }

  // ---------- 毎フレーム ----------
  private renderFrame(dt: number) {
    dt *= this.reduceMotion ? 0.35 : 1;
    this.stepT += dt;
    if (this.stepT >= CYCLE) { this.finishStep(); this.stepT -= CYCLE; }
    this.animate();

    // カメラ: タイトルは寄り、メニューは引いて少し高く。マウスで軽く視差
    const menu = this.mode === "menu";
    const portrait = this.camera.aspect < 1;
    const dist = portrait ? 1.55 : 1;
    const wantPos = menu ? new THREE.Vector3(0, 9.4 * dist, 15.5 * dist) : new THREE.Vector3(0, 5.6 * dist, 10.4 * dist);
    const wantLook = menu ? new THREE.Vector3(0, -0.3, -0.6) : new THREE.Vector3(portrait ? -0.5 : 0, 0.9, -0.4);
    this.camPos.lerp(wantPos, 0.04); this.camLook.lerp(wantLook, 0.04);
    const t = performance.now() / 1000;
    this.camera.position.set(this.camPos.x + this.pointer.x * 0.7 + Math.sin(t * 0.25) * 0.25, this.camPos.y - this.pointer.y * 0.35, this.camPos.z);
    this.camera.lookAt(this.camLook);
    this.renderer.render(this.scene, this.camera);
  }

  private finishStep() {
    const s = this.steps[this.stepIdx];
    s.actor.pos.copy(s.to); s.actor.obj.position.copy(s.to);
    this.lastRest = this.restGrip(s.to);
    this.stepIdx = (this.stepIdx + 1) % this.steps.length;
    this.flashed = false;
  }

  private animate() {
    const step = this.steps[this.stepIdx];
    const a = step.actor, A = a.pos, B = step.to;
    let acc = 0, name = PHASES[0][0], u = 0;
    for (const [n, d] of PHASES) { if (this.stepT < acc + d) { name = n; u = (this.stepT - acc) / d; break; } acc += d; }
    const e = ease(Math.min(1, Math.max(0, u)));
    const closed = CLOSED_GAP[a.type];

    const grip = new THREE.Vector3();
    let gap = OPEN_GAP;
    const piece = A.clone();                         // 駒の位置(つまんでいる間は手に付いてくる)
    const gy = GRIP_Y[a.type];

    switch (name) {
      case "approach": grip.lerpVectors(this.lastRest, this.hoverGrip(a, A), e); break;
      case "descend": grip.lerpVectors(this.hoverGrip(a, A), this.atGrip(a, A), e); break;
      case "pinch": grip.copy(this.atGrip(a, A)); gap = THREE.MathUtils.lerp(OPEN_GAP, closed, e); break;
      case "lift": grip.lerpVectors(this.atGrip(a, A), this.hoverGrip(a, A), e); gap = closed; piece.y = grip.y - gy; break;
      case "carry": {
        grip.lerpVectors(this.hoverGrip(a, A), this.hoverGrip(a, B), e); grip.y += 0.7 * Math.sin(Math.PI * u);
        gap = closed; piece.set(grip.x, grip.y - gy, grip.z); break;
      }
      case "lower": grip.lerpVectors(this.hoverGrip(a, B), this.atGrip(a, B), e); gap = closed; piece.set(grip.x, grip.y - gy, grip.z); break;
      case "release": grip.copy(this.atGrip(a, B)); gap = THREE.MathUtils.lerp(closed, OPEN_GAP, e); piece.copy(B); break;
      default: grip.lerpVectors(this.atGrip(a, B), this.restGrip(B), e); piece.copy(B); break;   // retreat
    }
    a.obj.position.copy(piece);

    // つまんだ瞬間に、指先のところから光の輪が広がる
    if (name === "pinch" && u > 0.85 && !this.flashed) { this.flashed = true; this.flashT = 0; this.flash.position.copy(this.atGrip(a, A)); this.flash.position.y = this.atGrip(a, A).y; }
    this.flashT += 0.016;
    const fm = this.flash.material as THREE.MeshBasicMaterial;
    fm.opacity = Math.max(0, 0.9 - this.flashT * 1.8);
    this.flash.scale.setScalar(1 + this.flashT * 5);

    // 手のひらは、つまむ点の真上。少しだけ揺らす
    const t = performance.now() / 1000;
    this.hand.group.position.set(grip.x - GRIP_LOCAL.x, grip.y - GRIP_LOCAL.y + Math.sin(t * 2) * 0.03, grip.z - GRIP_LOCAL.z);
    this.hand.pose(gap);
    this.handLight.position.set(grip.x + 0.4, grip.y + 0.8, grip.z + 1.6);
  }
}
