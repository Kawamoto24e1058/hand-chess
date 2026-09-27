import * as THREE from "three";
import type { Game } from "./game";
import { sqName } from "./pieces";
import { S, SQ, View } from "./projection";
import {
  CLOSED_GAP, GRIP_Y, GltfHand, HAND_YAW, OPEN_GAP,
  addStageLights, buildBoardMeshes, buildPiece, makeMaterials,
  type HandRig, type PieceType, type StageMaterials,
} from "./scene3d";

/** 盤面座標(0..S)の(x, y) ⇔ ワールド座標(X, Z)。盤の中心が原点、1マス=1 */
const toWorldX = (bx: number) => (bx - S / 2) / SQ;
const toWorldZ = (by: number) => (by - S / 2) / SQ;

/**
 * 3Dの視点。今までの2Dの View と同じ project / unproject を、カメラの行列で実装する。
 * 入力(手・マウス)の位置は、カメラから盤の面(y=0)へ伸ばしたレイの交点として盤面座標に変換される。
 */
export class View3D extends View {
  private ray = new THREE.Raycaster();
  private v = new THREE.Vector3();
  private look = new THREE.Vector3();

  constructor(readonly camera: THREE.PerspectiveCamera) {
    super();
    this.theta = this.target;           // 起動時から3D視点(切り替え時だけ滑らかに動かす)
  }

  step() {
    super.step();
    const t = Math.min(1, this.theta / 0.52);                 // 0: 真上から / 1: 斜めから
    const elev = THREE.MathUtils.lerp(Math.PI / 2 - 0.02, 0.98, t);
    const dist = THREE.MathUtils.lerp(19.5, 20.5, t);
    this.look.set(0, 0, THREE.MathUtils.lerp(0, 0.5, t));
    this.camera.position.set(this.look.x, this.look.y + Math.sin(elev) * dist, this.look.z + Math.cos(elev) * dist);
    this.camera.lookAt(this.look);
    this.camera.updateMatrixWorld();
  }

  project(x: number, y: number, h = 0) {
    this.v.set(toWorldX(x), h / SQ, toWorldZ(y)).project(this.camera);
    return { x: (this.v.x * 0.5 + 0.5) * S, y: (-this.v.y * 0.5 + 0.5) * S, s: 1 };
  }

  unproject(sx: number, sy: number) {
    this.ray.setFromCamera(new THREE.Vector2((sx / S) * 2 - 1, -(sy / S) * 2 + 1), this.camera);
    const { origin, direction } = this.ray.ray;
    const t = direction.y === 0 ? 0 : -origin.y / direction.y;      // y=0 の面との交点
    return { x: (origin.x + direction.x * t) * SQ + S / 2, y: (origin.z + direction.z * t) * SQ + S / 2 };
  }
}

const HAND_SCALE = 0.95;             // ゲーム画面の手の大きさ(タイトルより少し小さくして、盤を隠しすぎない)
const HAND_TILT = 0.15;             // 手を自分の側(画面の手前)から差し出す向きに傾ける(前腕が画面の下へ抜ける)
const HELD_LIFT = 1.15;             // 掴んだ駒を持ち上げる高さ(ワールド)
const MAX_TARGETS = 32;
const MAX_MOVABLE = 20;
const MAX_PARTICLES = 90;

type Stat = { group: THREE.Group; type: string; color: string };

/** ゲーム画面の3D描画。盤の上の駒・ハイライト・パーティクル・つまむ手を、Game の状態から毎フレーム同期する。 */
export class GameRenderer {
  readonly view: View3D;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private stage = new THREE.Group();                   // 盤・駒・印をまとめたグループ(手番が変わると回す)
  private spin = 0;                                    // 回転の残り(ラジアン)。0に向かってなめらかに戻す
  private lastFlip: boolean | null = null;
  private lastT = performance.now();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  private mats: StageMaterials;
  private pool = new Map<string, THREE.Group[]>();
  private statics = new Map<string, Stat>();             // マス → 静止している駒
  private moving: Stat | null = null;                    // 移動アニメーション中の駒
  private heldObj: Stat | null = null;                   // 掴まれている駒
  private lastMarks: THREE.Mesh[] = [];
  private targetMarks: THREE.Mesh[] = [];               // 行き先の点
  private targetHalos: THREE.Mesh[] = [];              // 点の縁取り(明るいマスでも暗いマスでも見えるように)
  private targetTints: THREE.Mesh[] = [];               // 行き先のマス全体の色付け
  private hoverRing: THREE.Mesh;
  private pieceRing: THREE.Mesh;                        // 今掴もうとしている駒の足元のリング
  private movableRings: THREE.Mesh[] = [];              // 動かせる駒の足元の印
  private captureRings: THREE.Mesh[] = [];              // 取れるマスの赤い印
  private ghost: Stat | null = null;                    // 置き先に出す、半透明の駒の予告
  private originGhost: Stat | null = null;              // 元のマスに残す、半透明の駒
  private originRing: THREE.Mesh;                       // 元のマスの印
  private originTint: THREE.Mesh;
  private pathLine: THREE.Mesh;                         // 元のマスから今の位置までの線
  private ghostPool = new Map<string, THREE.Group[]>();
  private ghostMats: { w: THREE.Material; b: THREE.Material };
  private checkMark: THREE.Mesh;
  private points: THREE.Points;
  private hand: HandRig | null = null;
  private dropLine: THREE.Mesh;                         // 手のつまむ位置から、盤まで垂直に落ちる線
  private dropDot: THREE.Mesh;                          // 指先の真下の点(つまむと締まる)
  private handGap = OPEN_GAP;
  private handPos = new THREE.Vector3(0, 3, 2);
  private ro: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.view = new View3D(this.camera);
    this.mats = makeMaterials();
    this.scene.add(this.stage);
    addStageLights(this.scene);
    buildBoardMeshes(this.stage, false);

    // ハイライト用の板(盤の上に薄く重ねる)
    const flat = (color: number, geo: THREE.BufferGeometry, opacity: number) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.012; m.visible = false; m.renderOrder = 2;
      this.stage.add(m);
      return m;
    };
    const sqGeo = new THREE.PlaneGeometry(0.98, 0.98);
    this.lastMarks = [flat(0xffdc50, sqGeo, 0.38), flat(0xffdc50, sqGeo, 0.38)];
    this.checkMark = flat(0xff3c3c, sqGeo, 0.5);
    const disc = new THREE.CircleGeometry(0.15, 32), halo = new THREE.CircleGeometry(0.215, 32);
    for (let i = 0; i < MAX_TARGETS; i++) {
      const tint = flat(0x19e08a, sqGeo, 0.26), h = flat(0x000000, halo, 0.42), dot = flat(0x19e08a, disc, 1);
      tint.position.y = 0.010; h.position.y = 0.013; dot.position.y = 0.016;           // 重なる順(色付け → 縁取り → 点)
      this.targetTints.push(tint); this.targetHalos.push(h); this.targetMarks.push(dot);
    }
    this.hoverRing = flat(0x66ccff, new THREE.RingGeometry(0.4, 0.47, 40), 0.95);
    this.pieceRing = flat(0x66e0ff, new THREE.RingGeometry(0.46, 0.56, 44), 0.9);
    // 元の位置の表示(青紫): マスの色付け・リング・半透明の駒・今の位置までの線
    this.originTint = flat(0x7d8cff, sqGeo, 0.3);
    this.originRing = flat(0x9aa8ff, new THREE.RingGeometry(0.36, 0.46, 44), 0.95);
    const lineGeo = new THREE.PlaneGeometry(1, 0.07); lineGeo.rotateX(-Math.PI / 2);
    this.pathLine = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ color: 0xaab6ff, transparent: true, opacity: 0.55, depthWrite: false }));
    this.pathLine.position.y = 0.014; this.pathLine.visible = false; this.pathLine.renderOrder = 2;
    this.stage.add(this.pathLine);
    const thin = new THREE.RingGeometry(0.43, 0.47, 40), red = new THREE.RingGeometry(0.34, 0.44, 40);
    for (let i = 0; i < MAX_MOVABLE; i++) this.movableRings.push(flat(0x66e0ff, thin, 0.4));
    for (let i = 0; i < MAX_TARGETS; i++) this.captureRings.push(flat(0xff5a5a, red, 0.85));
    // 置き先の予告(半透明の駒)
    const ghostOf = (m: THREE.Material) => { const c = m.clone(); c.transparent = true; c.opacity = 0.42; c.depthWrite = false; return c; };
    this.ghostMats = { w: ghostOf(this.mats.ivory), b: ghostOf(this.mats.navy) };

    // 指先から盤へ落ちる線と、真下の点: 手が浮いて見えても、どこを指しているかが分かる
    const lineMat = new THREE.MeshBasicMaterial({ color: 0x9fe6ff, transparent: true, opacity: 0.5, depthWrite: false });
    this.dropLine = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 8), lineMat);
    this.dropLine.visible = false; this.dropLine.renderOrder = 2; this.stage.add(this.dropLine);
    this.dropDot = flat(0xffffff, new THREE.CircleGeometry(0.12, 32), 0.85);
    this.dropDot.position.y = 0.02;

    // パーティクル
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.13, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.points.frustumCulled = false;
    this.stage.add(this.points);

    // 骨入りの手(自分の手に重ねて動かす)。読み込めなくても遊べる
    GltfHand.load(this.mats.skin, this.mats.nail, this.mats.cuff, false).then((h) => {
      h.group.visible = false; h.group.scale.setScalar(HAND_SCALE); h.group.rotation.order = "YXZ";
      this.scene.add(h.group); this.hand = h;
    }).catch((e) => console.warn("手のモデルを読み込めません(3Dの手は表示されません)", e));

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.view.step();
  }

  private resize() {
    const w = this.canvas.clientWidth || S, h = this.canvas.clientHeight || S;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() { this.ro.disconnect(); this.renderer.dispose(); }

  // ---------- 駒のプール(生成コストを避けて使い回す) ----------
  private acquire(type: string, color: string, bottom: string): Stat {
    const key = color + type;
    const g = this.pool.get(key)?.pop() ?? buildPiece(type as PieceType, color === "w" ? this.mats.ivory : this.mats.navy);
    g.visible = true; this.stage.add(g);
    if (type === "n") g.rotation.y = this.knightYaw(color, bottom);
    return { group: g, type, color };
  }

  private release(s: Stat) {
    this.stage.remove(s.group);
    const key = s.color + s.type;
    const list = this.pool.get(key) ?? [];
    list.push(s.group); this.pool.set(key, list);
  }

  /** ナイトは横顔が見える向きに並べる(手前側は右向き、奥側は左向き)。掴んだ時だけ、指の間に収まる向きへ回す */
  private knightYaw(color: string, bottom: string, grabbed = false) {
    if (grabbed) return (color === bottom ? Math.PI / 2 : -Math.PI / 2) + HAND_YAW;
    return color === bottom ? 0 : Math.PI;
  }

  // ---------- 毎フレーム ----------
  render(g: Game, opts: { hints: boolean } = { hints: true }) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000); this.lastT = now;
    if (this.lastFlip !== null && this.lastFlip !== g.flip) this.spin = Math.PI;      // 手番が変わった: 見た目を変えずに180°回した状態から始める
    this.lastFlip = g.flip;
    this.spin = this.spin > 0.004 ? this.spin * Math.exp(-dt * 5.2) : 0;               // 約0.9秒でなめらかに正面へ
    this.stage.rotation.y = this.spin;
    this.view.step();
    if (g.shake > 0.3) {                                // 駒を取った時の画面の揺れ
      this.camera.position.x += (Math.random() - 0.5) * g.shake * 0.02;
      this.camera.position.y += (Math.random() - 0.5) * g.shake * 0.02;
      g.shake *= 0.86;
    } else g.shake = 0;

    const bottom = g.flip ? "b" : "w";
    const board = g.chess.board();

    // 静止している駒を、現在の局面に合わせる(掴み中・移動中の駒は別扱い)
    const want = new Map<string, { type: string; color: string }>();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = board[r][c]; if (!p) continue;
      const sq = sqName(c, r);
      if (g.held?.from === sq || g.anim?.to === sq) continue;
      want.set(sq, { type: p.type, color: p.color });
    }
    for (const [sq, st] of [...this.statics]) {
      const w = want.get(sq);
      if (!w || w.type !== st.type || w.color !== st.color) { this.release(st); this.statics.delete(sq); }
    }
    for (const [sq, w] of want) {
      let st = this.statics.get(sq);
      if (!st) { st = this.acquire(w.type, w.color, bottom); this.statics.set(sq, st); }
      const c = g.sqCenter(sq);
      st.group.position.set(toWorldX(c.x), 0, toWorldZ(c.y));
      if (st.type === "n") st.group.rotation.y = this.knightYaw(st.color, bottom);
    }

    // 移動中の駒(相手の手は弧を描く / 自分の手は指の位置から着地)
    const a = g.anim;
    if (a) {
      if (!this.moving || this.moving.type !== a.type || this.moving.color !== a.color) {
        if (this.moving) this.release(this.moving);
        this.moving = this.acquire(a.type, a.color, bottom);
      }
      const p = Math.min(1, (now - a.t0) / a.dur), e = 1 - Math.pow(1 - p, 3);
      const x = a.x0 + (a.x1 - a.x0) * e, y = a.y0 + (a.y1 - a.y0) * e;
      const h = a.own ? (1 - e) * HELD_LIFT : Math.sin(Math.PI * p) * 1.0;
      this.moving.group.position.set(toWorldX(x), h, toWorldZ(y));
      if (p >= 1) g.landFx(a);
    } else if (this.moving) { this.release(this.moving); this.moving = null; }

    // 掴んでいる駒(手に付いて持ち上がり、青く光る)
    const cur = g.cursor;
    if (g.held && cur) {
      if (!this.heldObj || this.heldObj.type !== g.held.type || this.heldObj.color !== g.held.color) {
        if (this.heldObj) this.release(this.heldObj);
        this.heldObj = this.acquire(g.held.type, g.held.color, bottom);
      }
      this.heldObj.group.position.set(toWorldX(cur.x), HELD_LIFT, toWorldZ(cur.y));
      if (this.heldObj.type === "n") this.heldObj.group.rotation.y = this.knightYaw(this.heldObj.color, bottom, true);   // 指の間に収まる向き
    } else {
      if (this.heldObj) { this.release(this.heldObj); this.heldObj = null; }
    }

    this.updateMarks(g, cur, now);
    this.updateHints(g, cur, now, opts.hints, bottom);
    this.updateParticles(g);
    this.updateHand(g, cur);
    this.renderer.render(this.scene, this.camera);
  }

  private place(m: THREE.Mesh, sq: string, g: Game) {
    const c = g.sqCenter(sq);
    m.position.x = toWorldX(c.x); m.position.z = toWorldZ(c.y); m.visible = true;
  }

  /** 最後の手・行ける場所・王手・カーソルの下のマスを、盤の上に重ねる */
  private updateMarks(g: Game, cur: { x: number; y: number } | null, now: number) {
    this.lastMarks.forEach((m, i) => {
      const sq = g.lastMove ? (i === 0 ? g.lastMove.from : g.lastMove.to) : null;
      if (sq) this.place(m, sq, g); else m.visible = false;
    });
    const quiet = g.held ? [...g.held.targets].filter((t) => !g.held!.captures.has(t)) : [];
    const caps = g.held ? [...g.held.captures] : [];
    const pulse = 1 + 0.1 * Math.sin(now / 200);
    this.targetMarks.forEach((m, i) => {
      const h = this.targetHalos[i], tint = this.targetTints[i];
      if (quiet[i]) { this.place(m, quiet[i], g); this.place(h, quiet[i], g); m.scale.setScalar(pulse); h.scale.setScalar(pulse); }
      else { m.visible = false; h.visible = false; }
      const sq = i < quiet.length ? quiet[i] : caps[i - quiet.length];              // 色付けは、行き先すべてに(取れるマスは赤)
      if (sq) {
        this.place(tint, sq, g);
        const isCap = i >= quiet.length;
        (tint.material as THREE.MeshBasicMaterial).color.set(isCap ? 0xff4d4d : 0x19e08a);
        (tint.material as THREE.MeshBasicMaterial).opacity = isCap ? 0.34 : 0.26;
      } else tint.visible = false;
    });
    this.captureRings.forEach((m, i) => { if (caps[i]) { this.place(m, caps[i], g); m.scale.setScalar(pulse); } else m.visible = false; });

    const king = g.kingInCheckSquare;
    if (king) { this.place(this.checkMark, king, g); (this.checkMark.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.2 * Math.sin(now / 120); }
    else this.checkMark.visible = false;

    const t = cur ? g.snapTarget(cur) : null;
    if (t && !g.thinking && !g.result) {
      this.place(this.hoverRing, t, g);
      (this.hoverRing.material as THREE.MeshBasicMaterial).color.set(g.input.pinch ? 0xff6666 : 0x66ccff);
    } else this.hoverRing.visible = false;
  }


  /** 「どれを掴もうとしているか」「どこに置けるか」の表示 */
  private updateHints(g: Game, cur: { x: number; y: number } | null, now: number, hints: boolean, bottom: string) {
    // 動かせる駒の足元に、ゆっくり脈打つ印(ヒント)
    const movable = hints && !g.held && !g.anim ? [...g.movableSquares()] : [];
    this.movableRings.forEach((m, i) => {
      if (movable[i]) { this.place(m, movable[i], g); (m.material as THREE.MeshBasicMaterial).opacity = 0.28 + 0.22 * Math.sin(now / 320 + i); } else m.visible = false;
    });

    // 今掴もうとしている駒: 足元のリングが、つまむにつれて濃く・大きくなる
    const hov = g.hoverInfo();
    if (hov?.movable) {
      const prog = g.input.pinchProgress;
      this.place(this.pieceRing, hov.sq, g);
      this.pieceRing.scale.setScalar(1.12 - 0.12 * prog);
      (this.pieceRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.45 * prog;
    } else this.pieceRing.visible = false;

    // 置き先の予告: 掴んでいる駒を、吸着する先のマスに半透明で出す
    const held = g.held;
    const t = held && cur ? g.snapTarget(cur) : null;
    if (held && t && held.targets.has(t)) {
      if (!this.ghost || this.ghost.type !== held.type || this.ghost.color !== held.color) {
        if (this.ghost) this.releaseGhost(this.ghost);
        this.ghost = this.acquireGhost(held.type, held.color, bottom);
      }
      const c = g.sqCenter(t);
      this.ghost.group.position.set(toWorldX(c.x), 0, toWorldZ(c.y));
      if (held.type === "n") this.ghost.group.rotation.y = this.knightYaw(held.color, bottom);
    } else if (this.ghost) { this.releaseGhost(this.ghost); this.ghost = null; }

    // 元の位置: 掴んだ駒がどこから来たかが分かるように、元のマスを青紫で示し、半透明の駒を残す
    if (held && cur) {
      const o = g.sqCenter(held.from);
      this.place(this.originTint, held.from, g); this.place(this.originRing, held.from, g);
      if (!this.originGhost || this.originGhost.type !== held.type || this.originGhost.color !== held.color) {
        if (this.originGhost) this.releaseGhost(this.originGhost);
        this.originGhost = this.acquireGhost(held.type, held.color, bottom);
      }
      this.originGhost.group.position.set(toWorldX(o.x), 0, toWorldZ(o.y));
      if (held.type === "n") this.originGhost.group.rotation.y = this.knightYaw(held.color, bottom);
      // 元のマスから今の位置までの細い線
      const dx = toWorldX(cur.x) - toWorldX(o.x), dz = toWorldZ(cur.y) - toWorldZ(o.y), len = Math.hypot(dx, dz);
      this.pathLine.visible = len > 0.6;
      this.pathLine.position.x = toWorldX(o.x) + dx / 2; this.pathLine.position.z = toWorldZ(o.y) + dz / 2;
      this.pathLine.rotation.y = -Math.atan2(dz, dx);
      this.pathLine.scale.x = Math.max(0.001, len - 0.5);
    } else {
      this.originTint.visible = false; this.originRing.visible = false; this.pathLine.visible = false;
      if (this.originGhost) { this.releaseGhost(this.originGhost); this.originGhost = null; }
    }
  }

  private acquireGhost(type: string, color: string, bottom: string): Stat {
    const key = color + type;
    let grp = this.ghostPool.get(key)?.pop();
    if (!grp) {
      grp = buildPiece(type as PieceType, color === "w" ? this.ghostMats.w : this.ghostMats.b);
      grp.traverse((o) => { (o as THREE.Mesh).castShadow = false; (o as THREE.Mesh).receiveShadow = false; o.renderOrder = 3; });
    }
    grp.visible = true; this.stage.add(grp);
    if (type === "n") grp.rotation.y = this.knightYaw(color, bottom);
    return { group: grp, type, color };
  }

  private releaseGhost(s: Stat) {
    this.stage.remove(s.group);
    const key = s.color + s.type, list = this.ghostPool.get(key) ?? [];
    list.push(s.group); this.ghostPool.set(key, list);
  }

  private updateParticles(g: Game) {
    const pos = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.points.geometry.getAttribute("color") as THREE.BufferAttribute;
    const tmp = new THREE.Color();
    for (let i = g.particles.length - 1; i >= 0; i--) {
      const p = g.particles[i];
      p.x += p.vx; p.y += p.vy; p.z += p.vz; p.vz -= 0.5; p.life -= 0.022;
      if (p.z < 0) { p.z = 0; p.vz *= -0.4; }
      if (p.life <= 0) g.particles.splice(i, 1);
    }
    const n = Math.min(g.particles.length, MAX_PARTICLES);
    for (let i = 0; i < n; i++) {
      const p = g.particles[i];
      pos.setXYZ(i, toWorldX(p.x), p.z / SQ, toWorldZ(p.y));
      tmp.set(p.color).multiplyScalar(Math.max(0, p.life));       // 加算合成なので、暗くして消えていく
      col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    for (let i = n; i < MAX_PARTICLES; i++) { pos.setXYZ(i, 0, -50, 0); col.setXYZ(i, 0, 0, 0); }
    pos.needsUpdate = true; col.needsUpdate = true;
  }

  /** 自分の手(カメラが捉えた手)に、3Dの手を重ねる。つまむと指が閉じ、掴んだ駒は指の間に収まる */
  private updateHand(g: Game, cur: { x: number; y: number } | null) {
    const h = this.hand;
    if (!h) return;
    const show = g.input.source === "hand" && !!cur && !g.result;
    h.group.visible = show;
    this.dropLine.visible = show; this.dropDot.visible = show;
    if (!show || !cur) return;

    const held = g.held;
    const gripY = held ? HELD_LIFT + GRIP_Y[held.type as PieceType] : 1.15;       // 掴んでいる時は駒の首の高さ、普通は盤の少し上
    const want = new THREE.Vector3(toWorldX(cur.x), gripY, toWorldZ(cur.y));
    this.handPos.lerp(want, 0.45);
    const targetGap = g.input.pinch ? CLOSED_GAP[(held?.type ?? "p") as PieceType] : OPEN_GAP;
    this.handGap += (targetGap - this.handGap) * 0.35;

    // 落下線と真下の点(掴んでいる間は、駒の真下=影の位置を示す)
    const px = toWorldX(cur.x), pz = toWorldZ(cur.y), top = Math.max(0.05, this.handPos.y);
    this.dropLine.position.set(px, top / 2, pz); this.dropLine.scale.y = top;
    this.dropDot.position.x = px; this.dropDot.position.z = pz;
    this.dropDot.scale.setScalar(g.input.pinch ? 0.55 : 1);
    (this.dropDot.material as THREE.MeshBasicMaterial).opacity = g.input.pinch ? 1 : 0.7;

    h.group.rotation.set(HAND_TILT, HAND_YAW, 0);
    const off = h.grip.clone().multiplyScalar(HAND_SCALE).applyQuaternion(h.group.quaternion);
    h.group.position.copy(this.handPos).sub(off);
    h.pose(this.handGap / HAND_SCALE);                  // 指の間隔は、手のローカル単位(拡大前)に直して渡す
  }
}
