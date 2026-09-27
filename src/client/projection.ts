export const S = 720;          // canvasの一辺(論理px)
export const SQ = S / 8;       // 1マスの大きさ
const K = 0.8;                 // 盤の縮小率
const F = 1100;                // 焦点距離(透視の強さ)

export interface Pt { x: number; y: number }

/** 盤面(平面)を傾けて見せる疑似3D。project: 盤面→画面 / unproject: 画面→盤面 */
export class View {
  theta = 0;                   // 現在の傾き(rad)
  target = 0.52;               // 目標の傾き(0で真上から)

  step() { this.theta += (this.target - this.theta) * 0.12; }
  toggle3D() { this.target = this.target ? 0 : 0.52; }
  private off() { return -this.theta * 63; }

  /** 盤面座標(x,y)と高さhを画面座標に。奥(yが小さい)ほど遠く小さい。s は拡大率 */
  project(x: number, y: number, h = 0): Pt & { s: number } {
    const u = (x - S / 2) * K, v = (y - S / 2) * K, hh = h * K;
    const c = Math.cos(this.theta), s = Math.sin(this.theta);
    const yy = v * c - hh * s, zz = -v * s - hh * c, sc = F / (F + zz);
    return { x: S / 2 + u * sc, y: S / 2 + this.off() + yy * sc, s: sc };
  }

  unproject(sx: number, sy: number): Pt {
    const c = Math.cos(this.theta), s = Math.sin(this.theta);
    const py = sy - S / 2 - this.off(), px = sx - S / 2;
    const v = (py * F) / (F * c + py * s), u = (px * (F - v * s)) / F;
    return { x: u / K + S / 2, y: v / K + S / 2 };
  }
}
