import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * スタート画面の3D背景。外部モデルは使わず、駒も手もコードで生成する。
 *  - 駒: 回転体(LatheGeometry)と球・箱の組み合わせ。ナイトだけ横顔をExtrudeで押し出す。
 *  - 手: 親指と人差し指を2ボーンIKで駒の幅に合わせて動かし、「つまんで、運んで、離す」を繰り返す。
 */

export type PieceType = "p" | "r" | "n" | "b" | "q" | "k";
export type SceneMode = "title" | "menu";

export const UP_AXIS = new THREE.Vector3(0, 1, 0);
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

// 駒の差し色(王冠・十字・目)。半透明の予告用の材質を渡された時は、その材質をそのまま使う
const GOLD = new THREE.MeshStandardMaterial({ color: 0xffc94d, roughness: 0.25, metalness: 0.85, emissive: 0x6a4300, emissiveIntensity: 0.35 });
const SLIT = new THREE.MeshStandardMaterial({ color: 0x0e1018, roughness: 0.6, metalness: 0.1 });

/**
 * 駒の3Dモデル。遠目・上からでも種類が分かるよう、シルエットと差し色をはっきりさせている。
 *  キング=大きな金の十字 / クイーン=金の王冠 / ビショップ=切れ込みのある司教帽 / ナイト=目とたてがみのある馬 / ルーク=胸壁 / ポーン=丸い頭
 */
export function buildPiece(type: PieceType, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const ghost = mat.transparent;                                  // 予告用の半透明の駒なら、差し色も同じ材質にする
  const gold: THREE.Material = ghost ? mat : GOLD;
  const isLight = (mat.userData as { side?: string }).side === "w";
  const eye: THREE.Material = ghost ? mat : isLight ? SLIT : GOLD;

  const sphere = (r: number, y: number, m: THREE.Material = mat, sy = 1, x = 0, z = 0) => {
    const o = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 20), m);
    o.position.set(x, y, z); o.scale.y = sy; o.castShadow = !ghost;
    g.add(o); return o;
  };
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material = mat, ry = 0) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z); o.rotation.y = ry; o.castShadow = !ghost;
    g.add(o); return o;
  };
  const cone = (r: number, h: number, x: number, y: number, z: number, m: THREE.Material) => {
    const o = new THREE.Mesh(new THREE.ConeGeometry(r, h, 14), m);
    o.position.set(x, y, z); o.castShadow = !ghost;
    g.add(o); return o;
  };
  const ring = (r: number, y: number, tube: number, m: THREE.Material) => {
    const o = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 12, 40), m);
    o.rotation.x = Math.PI / 2; o.position.y = y; o.castShadow = !ghost;
    g.add(o); return o;
  };

  switch (type) {
    case "p":                                                        // ポーン: いちばん小さく、丸い頭
      g.add(lathe([...BASE, [0.2, 0.3], [0.14, 0.5], [0.22, 0.56], [0.26, 0.6], [0.2, 0.64], [0.1, 0.66]], mat));
      sphere(0.21, 0.82);
      break;
    case "r":                                                        // ルーク: 塔と胸壁
      g.add(lathe([...BASE, [0.28, 0.3], [0.25, 0.85], [0.36, 0.95], [0.38, 1.06], [0.42, 1.12], [0.42, 1.2], [0.31, 1.2], [0.31, 1.1], [0.001, 1.1]], mat));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        box(0.17, 0.2, 0.15, Math.cos(a) * 0.36, 1.27, Math.sin(a) * 0.36, mat, -a);
      }
      break;
    case "b":                                                        // ビショップ: 細身で、切れ込みのある司教帽と金の玉
      g.add(lathe([...BASE, [0.22, 0.3], [0.15, 0.75], [0.27, 0.84], [0.3, 0.9], [0.15, 0.98], [0.001, 1.0]], mat));
      ring(0.2, 0.9, 0.035, gold);
      sphere(0.25, 1.24, mat, 1.5);
      { const slit = box(0.035, 0.36, 0.6, 0, 1.34, 0, ghost ? mat : SLIT); slit.rotation.z = -0.62; }
      sphere(0.075, 1.68, gold);
      break;
    case "q":                                                        // クイーン: 高さがあり、金の王冠
      g.add(lathe([...BASE, [0.25, 0.3], [0.17, 0.9], [0.31, 1.02], [0.36, 1.12], [0.2, 1.2], [0.31, 1.5], [0.35, 1.58], [0.001, 1.58]], mat));
      ring(0.24, 1.16, 0.03, gold);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2, x = Math.cos(a) * 0.29, z = Math.sin(a) * 0.29;
        cone(0.07, 0.3, x, 1.74, z, gold);
        sphere(0.05, 1.92, gold, 1, x, z);
      }
      sphere(0.13, 1.72, gold);
      break;
    case "k":                                                        // キング: いちばん高く、大きな金の十字
      g.add(lathe([...BASE, [0.25, 0.3], [0.17, 0.9], [0.31, 1.02], [0.36, 1.12], [0.2, 1.2], [0.32, 1.5], [0.36, 1.6], [0.001, 1.6]], mat));
      ring(0.25, 1.16, 0.03, gold);
      box(0.13, 0.5, 0.13, 0, 1.86, 0, gold);
      box(0.4, 0.13, 0.13, 0, 1.92, 0, gold);
      break;
    case "n": {                                                      // ナイト: 目・耳・たてがみのある馬の横顔
      g.add(lathe([...BASE, [0.3, 0.26], [0.001, 0.26]], mat));
      const sh = new THREE.Shape();
      const pts: [number, number][] = [
        [-0.28, 0.24], [0.32, 0.24], [0.3, 0.42], [0.18, 0.6], [0.24, 0.66], [0.46, 0.72], [0.54, 0.82], [0.48, 0.96],
        [0.24, 1.1], [0.2, 1.36], [0.09, 1.2], [0.03, 1.34], [-0.05, 1.16], [-0.16, 1.2], [-0.2, 1.06], [-0.3, 1.0],
        [-0.28, 0.84], [-0.36, 0.7], [-0.32, 0.5], [-0.34, 0.36],
      ];
      sh.moveTo(...pts[0]); for (const q of pts.slice(1)) sh.lineTo(...q); sh.closePath();
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.32, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 4, curveSegments: 8 });
      geo.translate(0, 0, -0.16);
      const head = new THREE.Mesh(geo, mat);
      head.castShadow = !ghost; head.receiveShadow = !ghost;
      g.add(head);
      for (const z of [-0.2, 0.2]) sphere(0.055, 1.0, eye, 1, 0.3, z);                 // 目
      for (const z of [-0.1, 0.1]) sphere(0.03, 0.78, eye, 1, 0.52, z);                // 鼻の穴
      break;
    }
  }
  return g;
}

/** 手が駒をつまむ高さ(駒の底からの高さ) */
export const GRIP_Y: Record<PieceType, number> = { p: 0.6, r: 0.8, n: 0.85, b: 0.8, q: 0.9, k: 0.9 };
/** つまんだ時の指先の間隔(駒の厚み + 指の太さ) */
export const CLOSED_GAP: Record<PieceType, number> = { p: 0.5, r: 0.7, n: 0.56, b: 0.48, q: 0.58, k: 0.58 };

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

/** 関節の点列を、円柱(先細り)と関節の球でつなぐ */
class Limb {
  private segs: Seg[] = [];
  private joints: THREE.Mesh[] = [];
  constructor(radii: number[], mat: THREE.Material, parent: THREE.Object3D) {
    radii.forEach((r, i) => {
      const j = new THREE.Mesh(new THREE.SphereGeometry(r, 22, 16), mat);
      j.castShadow = true; parent.add(j); this.joints.push(j);
      if (i < radii.length - 1) { const sg = new Seg(r, radii[i + 1], mat); parent.add(sg.mesh); this.segs.push(sg); }
    });
  }
  set(points: THREE.Vector3[]) {
    points.forEach((p, i) => this.joints[i].position.copy(p));
    this.segs.forEach((sg, i) => sg.set(points[i], points[i + 1]));
  }
}

/** 指先の爪: 指の向き(dir)に沿わせ、面が out の向きを向くように置く */
function placeNail(nail: THREE.Mesh, tip: THREE.Vector3, dir: THREE.Vector3, out: THREE.Vector3, r: number) {
  const y = dir.clone().normalize();
  const z = out.clone().addScaledVector(y, -out.dot(y)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  nail.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  nail.position.copy(tip).addScaledVector(y, -0.075).addScaledVector(z, r * 0.78);
}

export const HAND_YAW = -0.5;                  // 手を少し斜めに向けて、つまむ2本の指がカメラから見えるようにする
const HAND_H = 1.35;                    // 手のひらの中心から、つまむ点までの縦の距離
const GRIP_LOCAL = new THREE.Vector3(-0.42, -HAND_H, 0.18);   // つまむ点(手のひらの前、親指と人差し指の間)

/** 手の見た目(手続き生成 / GLBモデル)の共通インターフェース */
export interface HandRig {
  readonly group: THREE.Group;
  /** 手のひらの中心から見た、つまむ点(親指と人差し指の間)の位置 */
  readonly grip: THREE.Vector3;
  pose(gap: number): void;
}

interface Digit { root: THREE.Vector3; len: number[]; pole: THREE.Vector3; dir: THREE.Vector3; limb: Limb; nail: THREE.Mesh }

export class Hand implements HandRig {
  readonly group = new THREE.Group();
  readonly grip = GRIP_LOCAL;
  private index: Digit;
  private thumb: Digit;
  private readonly tmp = { mid: new THREE.Vector3(), j2: new THREE.Vector3(), tip: new THREE.Vector3(), t: new THREE.Vector3() };

  constructor(skin: THREE.Material, nailMat: THREE.Material, cuff: THREE.Material) {
    const g = this.group;
    const mesh = (geo: THREE.BufferGeometry, m: THREE.Material) => { const o = new THREE.Mesh(geo, m); o.castShadow = true; g.add(o); return o; };

    // 手のひら(角の丸い板)と、親指の付け根のふくらみ(母指球)、手首
    mesh(new RoundedBoxGeometry(0.96, 1.06, 0.34, 6, 0.15), skin).position.set(-0.02, 0, 0);
    const thenar = mesh(new THREE.SphereGeometry(1, 28, 20), skin);
    thenar.scale.set(0.3, 0.5, 0.21); thenar.position.set(-0.42, 0.02, 0.1); thenar.rotation.z = 0.25;
    const wrist = new Seg(0.3, 0.27, skin); wrist.set(new THREE.Vector3(0, 0.3, 0), new THREE.Vector3(0.05, 0.75, -0.04)); g.add(wrist.mesh);

    // 前腕(斜め上へ伸びて画面の外へ)と袖口
    const armDir = new THREE.Vector3(0.3, 1, -0.25).normalize();
    const arm = new Seg(0.27, 0.4, skin); arm.set(new THREE.Vector3(0.05, 0.7, -0.04), new THREE.Vector3(0.05, 0.7, -0.04).addScaledVector(armDir, 5)); g.add(arm.mesh);
    const cuffMesh = mesh(new THREE.CylinderGeometry(0.44, 0.47, 0.42, 36), cuff);
    cuffMesh.position.set(0.05, 0.7, -0.04).addScaledVector(armDir, 0.85); cuffMesh.quaternion.setFromUnitVectors(UP, armDir);

    // 人差し指(3関節) と 親指(中手骨 + 2関節)。指先の向きを先に決めて、そこから逆算して関節を曲げる
    const nail = () => { const n = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), nailMat); n.scale.set(0.068, 0.105, 0.03); g.add(n); return n; };
    this.index = { root: new THREE.Vector3(-0.25, -0.5, 0.06), len: [0.46, 0.34, 0.26], pole: new THREE.Vector3(0.8, 0, -0.3),
      dir: new THREE.Vector3(-0.45, -0.85, 0.15).normalize(), limb: new Limb([0.105, 0.092, 0.08, 0.068], skin, g), nail: nail() };
    this.thumb = { root: new THREE.Vector3(-0.6, -0.5, 0.14), len: [0.5, 0.42], pole: new THREE.Vector3(-0.8, 0, -0.2),
      dir: new THREE.Vector3(0.5, -0.8, 0.25).normalize(), limb: new Limb([0.125, 0.105, 0.09], skin, g), nail: nail() };
    new Limb([0.14, 0.125], skin, g).set([new THREE.Vector3(-0.3, 0.32, 0.05), this.thumb.root]);   // 親指の中手骨

    // 残りの3本(中指・薬指・小指)は、手のひら側に握り込む(順運動学で3関節を曲げる)
    const curled: { x: number; y: number; len: number[]; r: number[] }[] = [
      { x: -0.03, y: -0.53, len: [0.5, 0.35, 0.27], r: [0.104, 0.092, 0.08, 0.067] },
      { x: 0.19, y: -0.5, len: [0.46, 0.32, 0.25], r: [0.098, 0.086, 0.075, 0.063] },
      { x: 0.39, y: -0.42, len: [0.37, 0.25, 0.22], r: [0.085, 0.075, 0.065, 0.055] },
    ];
    for (const f of curled) {
      let ang = 0; const pts = [new THREE.Vector3(f.x, f.y, 0.06)];
      [1.2, 1.45, 0.9].forEach((flex, i) => {
        ang += flex;                                              // 手のひら側(+Z)へ曲げる
        pts.push(pts[i].clone().add(new THREE.Vector3(0, -Math.cos(ang), Math.sin(ang)).multiplyScalar(f.len[i])));
      });
      new Limb(f.r, skin, g).set(pts);
      const n = nail(); const d = pts[3].clone().sub(pts[2]).normalize();
      placeNail(n, pts[3], d, new THREE.Vector3(0, 0.6, -0.8), f.r[3]);
    }
  }

  /** gap: 親指と人差し指の指先の間隔。指先をつまむ点の左右に置き、IKで関節を決める */
  pose(gap: number) {
    const { mid, j2, tip, t } = this.tmp;

    // 人差し指: 指先(=つまむ点の右)から、指先の向きぶん戻した位置(遠位関節)を2ボーンIKで解く
    const ix = this.index;
    t.copy(GRIP_LOCAL).add(new THREE.Vector3(gap / 2, 0, 0));
    const target = t.clone().addScaledVector(ix.dir, -ix.len[2]);
    solveTwoBone(ix.root, target, ix.len[0], ix.len[1], ix.pole, mid, j2);
    tip.copy(j2).addScaledVector(ix.dir, ix.len[2]);
    ix.limb.set([ix.root, mid, j2, tip]);
    placeNail(ix.nail, tip, ix.dir, new THREE.Vector3(0.9, 0.2, -0.3), 0.068);

    // 親指: 中手骨は固定で、2関節を直接IKで解く
    const th = this.thumb;
    t.copy(GRIP_LOCAL).add(new THREE.Vector3(-gap / 2, 0, 0));
    solveTwoBone(th.root, t, th.len[0], th.len[1], th.pole, mid, tip);
    th.limb.set([th.root, mid, tip]);
    placeNail(th.nail, tip, tip.clone().sub(mid), new THREE.Vector3(-0.9, 0.2, -0.3), 0.09);
  }
}

// ---------- 骨入りの手のモデル(WebXR generic-hand, GLB) ----------
const FINGER_NAMES = ["index", "middle", "ring", "pinky"] as const;
const fingerJoints = (f: string) => [`${f}-finger-phalanx-proximal`, `${f}-finger-phalanx-intermediate`, `${f}-finger-phalanx-distal`, `${f}-finger-tip`];
const THUMB_JOINTS = ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"];
const MODEL_SCALE = 12;                                        // モデルはメートル単位(手のひら約9cm)なので、シーンの大きさに拡大
const MODEL_CENTER = new THREE.Vector3(0.035, 0.005, 0.015);   // 手のひらの中心(モデル座標)
const GLB_GRIP = new THREE.Vector3(-0.3, -0.62, 0.55);         // 手のひらの前方、指を曲げて届く位置

/**
 * WebXRの標準の手モデルは、関節(骨)が同じ階層に並んでいて、各関節の位置と向きを直接指定できる。
 * 人差し指と親指はIKで求めた関節位置に、残りの指は握り込む姿勢に、骨の位置・向きを合わせる。
 */
export class GltfHand implements HandRig {
  readonly group = new THREE.Group();
  readonly grip = GLB_GRIP;
  private root = new THREE.Group();
  private bones = new Map<string, THREE.Object3D>();
  private restPos = new Map<string, THREE.Vector3>();     // モデル座標での初期位置
  private restQuat = new Map<string, THREE.Quaternion>();
  private nails: Record<string, THREE.Mesh> = {};
  private tmp = { mid: new THREE.Vector3(), j2: new THREE.Vector3(), tip: new THREE.Vector3() };

  constructor(gltf: GLTF, skin: THREE.Material, nailMat: THREE.Material, cuff: THREE.Material, withArm: boolean) {
    // モデルを「指が下向き、手のひらが手前(+Z)」の座標系に置く: 回転(Y軸90°)・拡大・手のひらの中心を原点に
    this.root.rotation.y = Math.PI / 2;
    this.root.scale.setScalar(MODEL_SCALE);
    this.root.position.copy(MODEL_CENTER).applyAxisAngle(UP, Math.PI / 2).multiplyScalar(-MODEL_SCALE);
    this.root.add(gltf.scene);
    this.group.add(this.root);

    gltf.scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        const m = o as THREE.SkinnedMesh; m.material = skin; m.castShadow = true; m.frustumCulled = false;
      }
      if ((o as THREE.Bone).isBone || o.name.includes("-")) {
        this.bones.set(o.name, o);
        this.restPos.set(o.name, o.position.clone());
        this.restQuat.set(o.name, o.quaternion.clone());
      }
    });

    // 前腕と袖口(手首の位置から斜め上へ)。ゲーム画面では盤を隠さないよう、手だけにする
    const wrist = this.local("wrist");
    const armDir = new THREE.Vector3(0.3, 1, -0.25).normalize();
    const arm = new Seg(0.3, 0.4, skin);
    arm.set(wrist.clone().addScaledVector(armDir, -0.05), wrist.clone().addScaledVector(armDir, 16));
    const cuffMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.47, 0.42, 36), cuff);
    cuffMesh.position.copy(wrist).addScaledVector(armDir, 0.9); cuffMesh.quaternion.setFromUnitVectors(UP, armDir);
    if (withArm) this.group.add(arm.mesh, cuffMesh);

    for (const n of [...FINGER_NAMES, "thumb"]) {
      const nail = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), nailMat);
      nail.scale.set(0.062, 0.1, 0.028); this.group.add(nail); this.nails[n] = nail;
    }
  }

  static load(skin: THREE.Material, nailMat: THREE.Material, cuff: THREE.Material, withArm = true): Promise<GltfHand> {
    return new GLTFLoader().loadAsync("/hand/right.glb").then((g) => new GltfHand(g, skin, nailMat, cuff, withArm));
  }

  // モデル座標 <-> 手のローカル座標(手のひらの中心が原点、指は-Y方向、手のひらは+Z向き)
  private toLocal(p: THREE.Vector3) { return p.clone().sub(MODEL_CENTER).applyAxisAngle(UP, Math.PI / 2).multiplyScalar(MODEL_SCALE); }
  private toModel(p: THREE.Vector3) { return p.clone().divideScalar(MODEL_SCALE).applyAxisAngle(UP, -Math.PI / 2).add(MODEL_CENTER); }
  private local(name: string) { return this.toLocal(this.restPos.get(name)!); }
  private restLocal(names: string[]) { return names.map((n) => this.local(n)); }

  /** 関節の点列(ローカル座標)に、各骨の位置と向きを合わせる */
  private apply(names: string[], pts: THREE.Vector3[]) {
    const pm = pts.map((p) => this.toModel(p));
    const q = new THREE.Quaternion();
    for (let i = 0; i < names.length; i++) {
      const bone = this.bones.get(names[i]);
      if (!bone) continue;
      if (i < names.length - 1) {
        const restDir = this.restPos.get(names[i + 1])!.clone().sub(this.restPos.get(names[i])!).normalize();
        q.setFromUnitVectors(restDir, pm[i + 1].clone().sub(pm[i]).normalize());   // 初期の向き → 新しい向き
      }
      bone.position.copy(pm[i]);
      bone.quaternion.copy(q).multiply(this.restQuat.get(names[i])!);
    }
  }

  private nail(key: string, tip: THREE.Vector3, distal: THREE.Vector3, r: number) {
    placeNail(this.nails[key], tip, tip.clone().sub(distal), new THREE.Vector3(0, 0.25, -1), r);
  }

  pose(gap: number) {
    const { mid, j2, tip } = this.tmp;

    // 人差し指: 指先(=つまむ点の右)から指先の向きぶん戻した位置(遠位関節)へ、2ボーンIK
    const iN = fingerJoints("index"), ir = this.restLocal(iN);
    const iL = [ir[0].distanceTo(ir[1]), ir[1].distanceTo(ir[2]), ir[2].distanceTo(ir[3])];
    const iDir = new THREE.Vector3(-0.35, -0.65, 0.5).normalize();
    const iTip = GLB_GRIP.clone().add(new THREE.Vector3(gap / 2, 0, 0));
    solveTwoBone(ir[0], iTip.clone().addScaledVector(iDir, -iL[2]), iL[0], iL[1], new THREE.Vector3(0.4, 0.3, -1), mid, j2);
    tip.copy(j2).addScaledVector(iDir, iL[2]);
    const ip = [ir[0], mid.clone(), j2.clone(), tip.clone()];
    this.apply(iN, ip);
    this.nail("index", ip[3], ip[2], 0.07);

    // 親指: 中手骨を目標へ向けて回し(対立)、残りの2関節をIKで解く
    const tr = this.restLocal(THUMB_JOINTS);
    const tLm = tr[0].distanceTo(tr[1]), tLp = tr[1].distanceTo(tr[2]), tLd = tr[2].distanceTo(tr[3]);
    const tTip = GLB_GRIP.clone().add(new THREE.Vector3(-gap / 2, 0, 0));
    const dirM = tTip.clone().sub(tr[0]).normalize().lerp(tr[1].clone().sub(tr[0]).normalize(), 0.25).normalize();
    const mcp = tr[0].clone().addScaledVector(dirM, tLm);
    solveTwoBone(mcp, tTip, tLp, tLd, new THREE.Vector3(-0.6, 0.2, -0.6), mid, tip);
    const tp = [tr[0], mcp, mid.clone(), tip.clone()];
    this.apply(THUMB_JOINTS, tp);
    this.nail("thumb", tp[3], tp[2], 0.09);

    // 中指・薬指・小指: 手のひら側(+Z)へ握り込む(順運動学)
    const flex: Record<string, number[]> = { middle: [1.25, 1.5, 0.9], ring: [1.25, 1.5, 0.9], pinky: [1.2, 1.5, 0.9] };
    for (const f of ["middle", "ring", "pinky"]) {
      const names = fingerJoints(f), r = this.restLocal(names);
      let ang = 0;
      const pts = [r[0]];
      flex[f].forEach((a, i) => {
        ang += a;
        pts.push(pts[i].clone().add(new THREE.Vector3(0, -Math.cos(ang), Math.sin(ang)).multiplyScalar(r[i].distanceTo(r[i + 1]))));
      });
      this.apply(names, pts);
      this.nail(f, pts[3], pts[2], 0.065);
    }
  }
}


// ---------- タイトルとゲームで共有する部品 ----------
export interface StageMaterials { ivory: THREE.Material; navy: THREE.Material; skin: THREE.Material; nail: THREE.Material; cuff: THREE.Material }

export function makeMaterials(): StageMaterials {
  return {
    ivory: Object.assign(new THREE.MeshStandardMaterial({ color: IVORY, roughness: 0.34, metalness: 0.06 }), { userData: { side: "w" } }),
    navy: Object.assign(new THREE.MeshStandardMaterial({ color: NAVY, roughness: 0.28, metalness: 0.4, emissive: 0x0b0f2a, emissiveIntensity: 0.6 }), { userData: { side: "b" } }),
    skin: new THREE.MeshPhysicalMaterial({ color: 0xd49a7c, roughness: 0.62, metalness: 0, sheen: 0.6, sheenColor: new THREE.Color(0xff9d7e), sheenRoughness: 0.55, emissive: 0x1e0a04, emissiveIntensity: 0.3 }),
    nail: new THREE.MeshStandardMaterial({ color: 0xf0c9bb, roughness: 0.22, metalness: 0.05 }),
    cuff: new THREE.MeshStandardMaterial({ color: 0x1b2a44, roughness: 0.4, metalness: 0.3, emissive: 0x66ccff, emissiveIntensity: 0.55 }),
  };
}

/** 盤(枠 + 64マス)。floor=true なら舞台の床の円盤も置く。マスは file 0..7 → x=-3.5..3.5、rank 1..8 → z=3.5..-3.5 */
export function buildBoardMeshes(scene: THREE.Scene, floor: boolean) {
  if (floor) {
    const f = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ color: 0x0d1220, roughness: 0.55, metalness: 0.5 }));
    f.rotation.x = -Math.PI / 2; f.position.y = -0.26; f.receiveShadow = true;
    scene.add(f);
  }
  const frame = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.25, 9.2), new THREE.MeshStandardMaterial({ color: 0x141a2c, roughness: 0.4, metalness: 0.5 }));
  frame.position.y = -0.14; frame.receiveShadow = true;
  scene.add(frame);
  const light = new THREE.MeshStandardMaterial({ color: 0xc9d2e6, roughness: 0.42, metalness: 0.08 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x27345a, roughness: 0.38, metalness: 0.2 });
  const geo = new THREE.BoxGeometry(1, 0.08, 1);
  for (let f = 0; f < 8; f++) for (let r = 1; r <= 8; r++) {
    const m = new THREE.Mesh(geo, (f + r) % 2 ? light : dark);
    m.position.set(f - 3.5, -0.04, 4.5 - r); m.receiveShadow = true;
    scene.add(m);
  }
}

export function addStageLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x0a0d14, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-4.5, 9, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 26 });
  sun.shadow.bias = -0.0004; sun.shadow.radius = 4;
  scene.add(sun);
  const rim = new THREE.PointLight(0x7d8cff, 55, 20, 1.5);
  rim.position.set(5.5, 3.5, -6);
  scene.add(rim);
  const fill = new THREE.PointLight(0x4fd0c0, 22, 16, 1.6);
  fill.position.set(-6, 2, 5);
  scene.add(fill);
}

// ---------- 動きの台本 ----------
interface Actor { obj: THREE.Group; type: PieceType; pos: THREE.Vector3 }
interface Step { actor: Actor; to: THREE.Vector3 }

const PHASES: [string, number][] = [
  ["approach", 1.1], ["descend", 0.55], ["pinch", 0.4], ["lift", 0.55],
  ["carry", 1.25], ["lower", 0.5], ["release", 0.4], ["retreat", 0.9],
];
const CYCLE = PHASES.reduce((s, [, d]) => s + d, 0);
export const OPEN_GAP = 1.2;

const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const sq = (file: number, rank: number) => new THREE.Vector3(file - 3.5, 0, 4.5 - rank);   // file 0..7 (a-h), rank 1..8

export class StartScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  private hand: HandRig;
  private skinMat!: THREE.Material;
  private nailMat!: THREE.Material;
  private cuffMat!: THREE.Material;
  private handLight = new THREE.PointLight(0x9fd8ff, 9, 8, 1.8);
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
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.fog = new THREE.Fog(0x0a0d14, 12, 26);
    addStageLights(this.scene);

    const { ivory, navy, skin, nail: nailMat, cuff } = makeMaterials();
    buildBoardMeshes(this.scene, true);
    const actors = this.buildPieces(ivory, navy);

    this.skinMat = skin; this.nailMat = nailMat; this.cuffMat = cuff;
    this.hand = new Hand(skin, nailMat, cuff);           // 骨入りモデルを読み込むまでの仮の手
    this.hand.group.rotation.y = HAND_YAW;
    this.scene.add(this.hand.group, this.handLight);

    // 骨入りの手のモデルを読み込めたら差し替える(失敗したら仮の手のまま)
    GltfHand.load(skin, nailMat, cuff).then((h) => {
      h.group.rotation.y = HAND_YAW;
      this.scene.remove(this.hand.group);
      this.hand = h; this.scene.add(h.group);
    }).catch((e) => console.warn("手のモデルを読み込めません(簡易の手を使います)", e));

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
    const off = this.hand.grip.clone().applyAxisAngle(UP, HAND_YAW);            // つまむ点のワールドでの手のひらからのずれ
    this.hand.group.position.set(grip.x - off.x, grip.y - off.y + Math.sin(t * 2) * 0.03, grip.z - off.z);
    this.hand.pose(gap);
    this.handLight.position.set(grip.x + 0.4, grip.y + 0.8, grip.z + 1.6);
  }
}
