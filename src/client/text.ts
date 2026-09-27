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

export interface PieceInfo { name: string; short: string; move: string; value: string }
/** 駒の日本語名と動き方(初心者向け) */
export const PIECE_INFO: Record<string, PieceInfo> = {
  p: { name: "ポーン", short: "ポ", move: "前へ1マス(最初だけ2マス)。取るのは斜め前", value: "1点" },
  n: { name: "ナイト", short: "ナ", move: "L字に跳ぶ。ほかの駒を飛び越えられる", value: "3点" },
  b: { name: "ビショップ", short: "ビ", move: "斜めに何マスでも", value: "3点" },
  r: { name: "ルーク", short: "ル", move: "縦・横に何マスでも", value: "5点" },
  q: { name: "クイーン", short: "ク", move: "縦・横・斜めに何マスでも", value: "9点" },
  k: { name: "キング", short: "キ", move: "全方向に1マス。取られたら負け", value: "—" },
};
