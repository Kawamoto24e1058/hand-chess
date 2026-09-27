import type { Game } from "./game";
import { toScreen } from "./hand";
import { glyphOf, sqName } from "./pieces";
import { reasonText, resultTitle } from "./text";
import { S, SQ } from "./projection";
import type { Color } from "../shared/protocol";

const K = 0.8;   // projection.ts と同じ盤の縮小率(駒の大きさの基準)

export interface RenderOpts { explain: boolean; debug: boolean }

export function draw(ctx: CanvasRenderingContext2D, g: Game, opts: RenderOpts) {
  const { view, input } = g;
  view.step();
  const now = performance.now();
  ctx.save();
  if (g.shake > 0.3) { ctx.translate((Math.random() - 0.5) * g.shake, (Math.random() - 0.5) * g.shake); g.shake *= 0.86; } else g.shake = 0;
  ctx.clearRect(0, 0, S, S);

  // 背景: 鏡像のカメラ映像(暗くして盤を読みやすく)
  if (input.cameraState === "ready" && input.video.readyState >= 2) {
    ctx.save(); ctx.translate(S, 0); ctx.scale(-1, 1); ctx.drawImage(input.video, 0, 0, S, S); ctx.restore();
  }
  ctx.fillStyle = input.cameraState === "ready" ? "rgba(0,0,0,.45)" : "#0d1017"; ctx.fillRect(0, 0, S, S);

  const quad = (x: number, y: number, w: number, h: number) => {
    const p = [view.project(x, y), view.project(x + w, y), view.project(x + w, y + h), view.project(x, y + h)];
    ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y); ctx.closePath();
  };

  const cur = g.cursor;
  const target = cur ? g.snapTarget(cur) : null;
  const board = g.chess.board(), size = SQ * 0.9 * K, kingSq = g.kingInCheckSquare;

  // ---- 盤 ----
  for (let dr = 0; dr < 8; dr++) for (let dc = 0; dc < 8; dc++) {
    const c = g.flip ? 7 - dc : dc, r = g.flip ? 7 - dr : dr, sq = sqName(c, r);
    ctx.fillStyle = (dr + dc) % 2 ? "rgba(40,55,85,.9)" : "rgba(215,222,235,.85)";
    quad(dc * SQ, dr * SQ, SQ, SQ); ctx.fill();
    if (g.lastMove && (sq === g.lastMove.from || sq === g.lastMove.to)) { ctx.fillStyle = "rgba(255,220,80,.4)"; ctx.fill(); }
    if (sq === kingSq) { ctx.fillStyle = `rgba(255,60,60,${0.3 + 0.2 * Math.sin(now / 120)})`; ctx.fill(); }
    if (g.held?.targets.has(sq)) { ctx.fillStyle = "rgba(80,220,120,.4)"; ctx.fill(); }
    if (sq === target && !g.thinking) { ctx.strokeStyle = input.pinch ? "#f66" : "#6cf"; ctx.lineWidth = 3; ctx.stroke(); }
  }
  // 盤の座標ラベル(手前の辺と左の辺)
  ctx.font = "13px sans-serif"; ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let i = 0; i < 8; i++) {
    const file = g.flip ? 7 - i : i, rank = g.flip ? i : 7 - i;
    const a = view.project((i + 0.5) * SQ, S + 6); ctx.fillText("abcdefgh"[file], a.x, a.y);
    const b = view.project(-14, (i + 0.5) * SQ); ctx.textBaseline = "middle"; ctx.fillText(String(rank + 1), b.x, b.y); ctx.textBaseline = "top";
  }

  // ---- 影・台座・駒(奥の段から描く) ----
  const base = (x: number, y: number, r: number, color?: Color) => {
    const q = view.project(x, y), rx = r * K * q.s * (color ? 1.25 : 1), ry = rx * (0.4 + 0.6 * Math.cos(view.theta));
    ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(q.x, q.y + 2, rx, ry, 0, 0, 7); ctx.fill();
    if (!color) return;
    ctx.fillStyle = color === "w" ? "#f4e7c0" : "#26264a"; ctx.beginPath(); ctx.ellipse(q.x, q.y, rx, ry, 0, 0, 7); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = color === "w" ? "#fff" : "#7d8cff"; ctx.stroke();
  };
  const glyph = (gl: string, x: number, y: number, sc: number, color: Color, sz: number) => {
    ctx.font = `${sz * sc}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    ctx.lineWidth = 6; ctx.strokeStyle = color === "w" ? "#1b1b1b" : "#e6ecff"; ctx.strokeText(gl, x, y);
    ctx.fillStyle = color === "w" ? "#fff6dc" : "#1a1a2e"; ctx.fillText(gl, x, y);
  };
  for (let dr = 0; dr < 8; dr++) for (let dc = 0; dc < 8; dc++) {
    const c = g.flip ? 7 - dc : dc, r = g.flip ? 7 - dr : dr, p = board[r][c], sq = sqName(c, r);
    if (!p || g.held?.from === sq || g.anim?.to === sq) continue;
    const cx = (dc + 0.5) * SQ, cy = (dr + 0.5) * SQ, q = view.project(cx, cy, SQ * 0.38);
    base(cx, cy, SQ * 0.3, p.color); glyph(glyphOf(p.type), q.x, q.y, q.s, p.color, size);
  }

  // 移動中の駒(相手の手は弧を描く / 自分の手は指の位置から着地)
  const a = g.anim;
  if (a) {
    const p = Math.min(1, (now - a.t0) / a.dur), e = 1 - Math.pow(1 - p, 3);
    const x = a.x0 + (a.x1 - a.x0) * e, y = a.y0 + (a.y1 - a.y0) * e;
    const h = SQ * 0.38 + (a.own ? (1 - e) * SQ * 0.92 : Math.sin(Math.PI * p) * SQ * 0.9);
    base(x, y, SQ * 0.3, a.color);
    const q = view.project(x, y, h); glyph(a.glyph, q.x, q.y, q.s, a.color, size);
    if (p >= 1) g.landFx(a);
  }

  // 掴んでいる駒(光らせる)
  if (g.held && cur) {
    base(cur.x, cur.y, SQ * 0.3, g.held.color);
    const q = view.project(cur.x, cur.y, SQ * 1.3);
    ctx.shadowColor = "#6cf"; ctx.shadowBlur = 26;
    glyph(g.held.glyph, q.x, q.y, q.s, g.held.color, size * 1.15); ctx.shadowBlur = 0;
  }

  // パーティクル
  for (let i = g.particles.length - 1; i >= 0; i--) {
    const p = g.particles[i]; p.x += p.vx; p.y += p.vy; p.z += p.vz; p.vz -= 0.5; p.life -= 0.022;
    if (p.z < 0) { p.z = 0; p.vz *= -0.4; }
    if (p.life <= 0) { g.particles.splice(i, 1); continue; }
    const q = view.project(p.x, p.y, p.z); ctx.globalAlpha = p.life; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(q.x, q.y, 3.5 * q.s, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
  }

  // 手の骨格(カメラ映像と同じ向き)
  if (input.landmarks) {
    ctx.fillStyle = "rgba(120,220,255,.9)";
    for (const p of input.landmarks) { const [x, y] = toScreen(p.x, p.y); ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); }
  }
  // カーソル
  if (cur) {
    const q = view.project(cur.x, cur.y);
    ctx.fillStyle = input.pinch ? "#f66" : "#6cf"; ctx.beginPath(); ctx.arc(q.x, q.y, input.pinch ? 7 : 11, 0, 7); ctx.fill();
  }

  if (opts.explain) drawExplain(ctx, g);

  // 終局バナー
  if (g.result && !g.anim) {
    ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(0, S / 2 - 70, S, 140);
    ctx.font = "bold 48px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#fc6"; ctx.fillText(resultTitle(g.result, g.myColor), S / 2, S / 2 - 12);
    ctx.font = "22px sans-serif"; ctx.fillStyle = "#ddd"; ctx.fillText(reasonText(g.result.reason), S / 2, S / 2 + 34);
  }
  // キャリブレーションのガイド(観客にも見える大きさ)
  if (input.calib?.text) {
    ctx.fillStyle = "rgba(0,0,0,.65)"; ctx.fillRect(0, S / 2 - 50, S, 100);
    ctx.font = "bold 32px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#6cf"; ctx.fillText(input.calib.text, S / 2, S / 2);
  }
  ctx.restore();

  if (opts.debug) {
    ctx.fillStyle = "#0f0"; ctx.font = "14px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`detect ${input.fps}fps  pinch ${input.pinchRatio.toFixed(2)} (img ${input.imgRatio.toFixed(2)})  src ${input.source}  cam ${input.cameraState}`, 8, 8);
    ctx.fillText(`thr grab<${input.thr.grab.toFixed(2)} rel>${input.thr.release.toFixed(2)}/${input.thr.releaseHeld.toFixed(2)}`, 8, 26);
  }
}

/** LT用: 生の指先(赤) vs One Euro後(水色)の軌跡、ピンチ比のグラフと閾値、遅延補正の位置(黄) */
function drawExplain(ctx: CanvasRenderingContext2D, g: Game) {
  const { input, view } = g;
  const line = (pts: [number, number][], color: string) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
  };
  line(input.rawTrail, "rgba(255,90,90,.95)"); line(input.filtTrail, "rgba(90,220,255,.95)");
  if (input.screen.x >= 0) {
    const past = input.posAt(performance.now() - 120), b = view.unproject(past.x, past.y), q = view.project(b.x, b.y);
    ctx.strokeStyle = "#fd3"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q.x, q.y, 14, 0, 7); ctx.stroke();
  }
  const gx = 12, gy = 36, gw = 260, gh = 52, ymax = 0.8;
  const Y = (v: number) => gy + gh - (Math.min(v, ymax) / ymax) * gh;
  ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fillRect(gx - 6, gy - 22, gw + 12, gh + 30);
  const lines: [number, string, string][] = [[input.thr.grab, "#6f6", "掴む"], [input.thr.release, "#fa4", "離す"], [input.thr.releaseHeld, "#f66", "離す(掴み中)"]];
  for (const [v, c, n] of lines) {
    ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(gx, Y(v)); ctx.lineTo(gx + gw, Y(v)); ctx.stroke();
    ctx.fillStyle = c; ctx.font = "11px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText(n, gx + gw, Y(v) - 1);
  }
  input.ratioHist.forEach(([, on], i) => { if (on) { ctx.fillStyle = "rgba(255,90,90,.25)"; ctx.fillRect(gx + (i * gw) / 160, gy, gw / 160 + 1, gh); } });
  line(input.ratioHist.map(([v], i) => [gx + (i * gw) / 160, Y(v)] as [number, number]), "#fff");
  ctx.fillStyle = "#fff"; ctx.font = "12px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  ctx.fillText(`ピンチ比  フィルタ:${input.useFilter ? "ON" : "OFF"}  赤=生 水=補正後 黄=遅延補正位置`, gx, gy - 6);
}
