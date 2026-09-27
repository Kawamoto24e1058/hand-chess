/**
 * 「手の3次元位置 → 盤の位置」の対応(実位置キャリブレーション)。
 *
 * 盤の四隅と中央を、手でつまんで示してもらい、その時の手の位置(カメラの前の3次元位置)と盤の座標の組から、
 * 盤のx・yそれぞれを「手の位置(X, Y, Z)の一次式」として求める。
 * 手が動く面の傾き(=ノートPCの画面の傾きや、手の動かし方)は、この一次式の中にまるごと含まれる。
 * 手の位置が同じ平面に乗っていて式が一意に決まらない時は、係数が最小のもの(=手が動いた面に沿った対応)を選ぶ。
 */

export interface P3 { x: number; y: number; z: number }
export interface CalSample { p: P3; b: { x: number; y: number } }
/** board = [sx·(p - pm)] + bm を、x・y それぞれ持つ */
export interface BoardMap { pm: [number, number, number]; bm: [number, number]; sx: [number, number, number]; sy: [number, number, number] }

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

/** 3x3 の連立方程式 M·x = v をガウスの消去法で解く */
function solve3(M: number[][], v: number[]): number[] | null {
  const A = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-14) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

/** 最小二乗法(リッジ正則化つき)で、手の位置の一次式を求める。サンプルは3個以上必要 */
export function fitBoardMap(samples: CalSample[], ridge = 1e-3): BoardMap | null {
  if (samples.length < 3) return null;
  const pm: [number, number, number] = [mean(samples.map((s) => s.p.x)), mean(samples.map((s) => s.p.y)), mean(samples.map((s) => s.p.z))];
  const bm: [number, number] = [mean(samples.map((s) => s.b.x)), mean(samples.map((s) => s.b.y))];
  const rows = samples.map((s) => [s.p.x - pm[0], s.p.y - pm[1], s.p.z - pm[2]]);
  // 手の位置の広がり(スケール)に対する相対的な正則化。手が動いた範囲に比べて、ほとんど動いていない方向の係数は0に寄せる
  const scale = Math.max(1e-9, Math.sqrt(rows.reduce((s, r) => s + r[0] * r[0] + r[1] * r[1] + r[2] * r[2], 0) / rows.length));
  const AtA = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? ridge * scale * scale * rows.length : 0)));
  const solveFor = (axis: "x" | "y") => solve3(AtA, [0, 1, 2].map((i) => rows.reduce((s, r, k) => s + r[i] * (samples[k].b[axis] - bm[axis === "x" ? 0 : 1]), 0)));
  const sx = solveFor("x"), sy = solveFor("y");
  return sx && sy ? { pm, bm, sx: sx as [number, number, number], sy: sy as [number, number, number] } : null;
}

export function applyBoardMap(m: BoardMap, p: P3): { x: number; y: number } {
  const d = [p.x - m.pm[0], p.y - m.pm[1], p.z - m.pm[2]];
  return {
    x: m.bm[0] + m.sx[0] * d[0] + m.sx[1] * d[1] + m.sx[2] * d[2],
    y: m.bm[1] + m.sy[0] * d[0] + m.sy[1] * d[1] + m.sy[2] * d[2],
  };
}

/** 平均の二乗誤差の平方根(盤面px)。キャリブレーションの良し悪しの目安 */
export function fitError(m: BoardMap, samples: CalSample[]): number {
  const e = samples.map((s) => { const q = applyBoardMap(m, s.p); return (q.x - s.b.x) ** 2 + (q.y - s.b.y) ** 2; });
  return Math.sqrt(mean(e));
}

/**
 * 手の動く面の傾き(度): 写像が変化しない方向(=手の動く面の法線)が、カメラの光軸(Z軸)となす角。
 * 0°なら手はカメラに正対した面(画面に平行)を動き、大きいほど、手前と奥へ斜めに動く(画面が寝ている)ことを表す。
 */
export function tiltDegrees(m: BoardMap): number {
  const [a, b] = [m.sx, m.sy];
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];      // 外積: 写像の勾配2本に直交する方向
  const len = Math.hypot(n[0], n[1], n[2]);
  return len < 1e-12 ? 0 : (Math.acos(Math.min(1, Math.abs(n[2]) / len)) * 180) / Math.PI;
}
