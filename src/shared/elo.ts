/** Elo レーティング。初期値1200、30戦までは変動を大きく(K=40)、以降は K=24 */
export const INITIAL_RATING = 1200;
export const MIN_PLIES_FOR_RATING = 4;          // これ未満で終わった対局はレートに反映しない(すぐ投了して稼ぐ・下げる対策)

export const kFactor = (games: number) => (games < 30 ? 40 : 24);

/** a が b に勝つ期待値(0〜1) */
export const expectedScore = (ra: number, rb: number) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

export interface EloInput {
  white: { rating: number; games: number };
  black: { rating: number; games: number };
  winner: "w" | "b" | null;                     // null = 引き分け
}

/** 対局後の新しいレーティング(小数のまま)。表示は四捨五入 */
export function updateElo({ white, black, winner }: EloInput): { white: number; black: number } {
  const sw = winner === "w" ? 1 : winner === "b" ? 0 : 0.5;
  const ew = expectedScore(white.rating, black.rating);
  return {
    white: white.rating + kFactor(white.games) * (sw - ew),
    black: black.rating + kFactor(black.games) * ((1 - sw) - (1 - ew)),
  };
}
