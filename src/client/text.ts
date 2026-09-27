import type { Color, GameResult, ResultReason } from "../shared/protocol";

const REASON: Record<ResultReason, string> = {
  checkmate: "チェックメイト", resign: "投了", timeout: "時間切れ", abandoned: "相手の切断",
  stalemate: "ステイルメイト", repetition: "同一局面の繰り返し", insufficient: "駒不足", fifty: "50手ルール", agreement: "合意による引き分け",
};
export const reasonText = (r: ResultReason) => REASON[r];

/** 見ている人の視点での結果タイトル。myColor が null(ローカル対戦/観戦)なら色で表す */
export function resultTitle(r: GameResult, myColor: Color | null): string {
  if (r.winner === null) return "引き分け";
  if (myColor) return r.winner === myColor ? "あなたの勝ち！" : "あなたの負け";
  return `${r.winner === "w" ? "白" : "黒"}の勝ち`;
}

export function formatClock(ms: number): string {
  const s = Math.ceil(ms / 1000), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
