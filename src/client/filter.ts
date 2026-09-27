/** One Euro Filter: 遅い動きは強く平滑化し、速い動きは遅れずに追従する適応型ローパスフィルタ */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(private minCutoff = 1.2, private beta = 0.02, private dCutoff = 1) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(v: number, t: number): number {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max((t - this.t) / 1000, 1e-3);
    this.dx += OneEuro.alpha(this.dCutoff, dt) * ((v - this.x) / dt - this.dx);
    this.x += OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (v - this.x);
    this.t = t;
    return this.x;
  }

  reset() { this.x = null; this.dx = 0; }
}
