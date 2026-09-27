import { Chess } from "chess.js";
import type { MoveInput } from "../shared/protocol";

const VAL: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

/** Stockfish(WASM, Web Worker)。読み込めない/タイムアウト時は自作のminimaxにフォールバック */
export class Engine {
  private worker: Worker | null = null;
  private ready = false;
  private resolve: ((mv: string | null) => void) | null = null;

  get isStockfish() { return this.ready; }

  init() {
    if (this.worker) return;
    try {
      const w = new Worker("/engine/stockfish-nnue-16-single.js");
      w.onmessage = (e) => {
        const line = String(e.data);
        if (line === "uciok") w.postMessage("isready");
        else if (line === "readyok") this.ready = true;
        else if (line.startsWith("bestmove") && this.resolve) {
          const r = this.resolve; this.resolve = null; r(line.split(" ")[1] ?? null);
        }
      };
      w.onerror = () => { this.worker = null; this.ready = false; };
      w.postMessage("uci");
      this.worker = w;
    } catch { this.worker = null; }
  }

  async bestMove(chess: Chess, skill: number): Promise<MoveInput | null> {
    const uci = await this.ask(chess.fen(), skill);
    if (uci && uci !== "(none)") return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
    return this.fallback(new Chess(chess.fen()));
  }

  private ask(fen: string, skill: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.worker || !this.ready) return resolve(null);
      const timer = setTimeout(() => { this.resolve = null; resolve(null); }, 8000);
      this.resolve = (mv) => { clearTimeout(timer); resolve(mv); };
      this.worker.postMessage(`setoption name Skill Level value ${skill}`);
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage("go movetime 700");
    });
  }

  // ---- フォールバック: 深さ2のminimax + alpha-beta ----
  private evaluate(g: Chess): number {
    let s = 0;
    const b = g.board();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = b[r][c];
      if (!p) continue;
      const v = VAL[p.type] + (p.type === "k" ? 0 : 10 - (Math.abs(3.5 - r) + Math.abs(3.5 - c)) * 2.5);
      s += p.color === "w" ? v : -v;
    }
    return s;
  }

  private search(g: Chess, depth: number, alpha: number, beta: number): number {
    const moves = g.moves({ verbose: true });
    if (!moves.length) return g.inCheck() ? (g.turn() === "w" ? -99999 - depth : 99999 + depth) : 0;
    if (depth === 0) return this.evaluate(g);
    const white = g.turn() === "w";
    let best = white ? -Infinity : Infinity;
    for (const m of moves) {
      g.move(m);
      const v = this.search(g, depth - 1, alpha, beta);
      g.undo();
      if (white) { best = Math.max(best, v); alpha = Math.max(alpha, v); } else { best = Math.min(best, v); beta = Math.min(beta, v); }
      if (beta <= alpha) break;
    }
    return best;
  }

  private fallback(g: Chess): MoveInput | null {
    const white = g.turn() === "w";
    let best: MoveInput | null = null;
    let bv = white ? -Infinity : Infinity;
    for (const m of g.moves({ verbose: true })) {
      g.move(m);
      const v = this.search(g, 2, -Infinity, Infinity) + Math.random() * 4;
      g.undo();
      if (white ? v > bv : v < bv) { bv = v; best = { from: m.from, to: m.to, promotion: m.promotion }; }
    }
    return best;
  }
}
