import { INITIAL_RATING } from "../shared/elo";
import type { ApiGameRow, ApiLeaderboardRow, ApiProfile, Color } from "../shared/protocol";

export interface PlayerRow {
  id: string;
  secret_hash: string;
  name: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
}

export const cleanName = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16) || "Player";

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** 新しいプレイヤーを作る。秘密のキーはここでだけ返し、サーバーにはハッシュだけ保存する */
export async function registerPlayer(db: D1Database, name: string): Promise<{ id: string; secret: string; name: string; rating: number }> {
  const id = randomHex(8), secret = randomHex(24), now = Date.now(), n = cleanName(name);
  await db.prepare("INSERT INTO players (id, secret_hash, name, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(secret), n, INITIAL_RATING, now, now).run();
  return { id, secret, name: n, rating: INITIAL_RATING };
}

/** IDと秘密のキーが正しければ、プレイヤーを返す */
export async function authenticate(db: D1Database, id: unknown, secret: unknown): Promise<PlayerRow | null> {
  if (typeof id !== "string" || typeof secret !== "string" || id.length > 32 || secret.length > 128) return null;
  const row = await db.prepare("SELECT * FROM players WHERE id = ?").bind(id).first<PlayerRow>();
  if (!row) return null;
  return row.secret_hash === (await sha256Hex(secret)) ? row : null;
}

export async function renamePlayer(db: D1Database, id: string, name: string): Promise<string> {
  const n = cleanName(name);
  await db.prepare("UPDATE players SET name = ?, updated_at = ? WHERE id = ?").bind(n, Date.now(), id).run();
  return n;
}

export async function rankOf(db: D1Database, rating: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS c FROM players WHERE games > 0 AND rating > ?").bind(rating).first<{ c: number }>();
  return (r?.c ?? 0) + 1;
}

export async function profileOf(db: D1Database, p: PlayerRow): Promise<ApiProfile> {
  return { id: p.id, name: p.name, rating: Math.round(p.rating), games: p.games, wins: p.wins, losses: p.losses, draws: p.draws, rank: p.games > 0 ? await rankOf(db, p.rating) : null };
}

/** ランキング(対局数が1以上のプレイヤーだけ) */
export async function leaderboard(db: D1Database, limit = 50): Promise<ApiLeaderboardRow[]> {
  const { results } = await db.prepare("SELECT name, rating, games FROM players WHERE games > 0 ORDER BY rating DESC, games DESC LIMIT ?").bind(limit).all<{ name: string; rating: number; games: number }>();
  return results.map((r, i) => ({ rank: i + 1, name: r.name, rating: Math.round(r.rating), games: r.games }));
}

/** 自分の直近の対局 */
export async function recentGames(db: D1Database, id: string, limit = 20): Promise<ApiGameRow[]> {
  const { results } = await db.prepare(
    "SELECT * FROM games WHERE white_id = ?1 OR black_id = ?1 ORDER BY played_at DESC LIMIT ?2",
  ).bind(id, limit).all<Record<string, string | number | null>>();
  return results.map((g) => {
    const mine: Color = g.white_id === id ? "w" : "b";
    return {
      id: String(g.id), playedAt: Number(g.played_at), white: String(g.white_name), black: String(g.black_name),
      winner: (g.winner as Color | null) ?? null, reason: String(g.reason), myColor: mine,
      before: Number(mine === "w" ? g.white_before : g.black_before), after: Number(mine === "w" ? g.white_after : g.black_after),
    };
  });
}

/** 秘密のキーを作り直す(古いキー=引き継ぎコードは使えなくなる)。漏れた時の対策 */
export async function rotateSecret(db: D1Database, id: string): Promise<string> {
  const secret = randomHex(24);
  await db.prepare("UPDATE players SET secret_hash = ?, updated_at = ? WHERE id = ?").bind(await sha256Hex(secret), Date.now(), id).run();
  return secret;
}
