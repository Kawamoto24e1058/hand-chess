import { GameRoom } from "./room";
import { Matchmaker } from "./matchmaker";
import { authenticate, leaderboard, profileOf, recentGames, registerPlayer, renamePlayer, rotateSecret } from "./players";

export { GameRoom, Matchmaker };

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  ASSETS: Fetcher;
  DB: D1Database;
}

const isWebSocket = (req: Request) => req.headers.get("Upgrade") === "websocket";

/** ブラウザからの接続は、このサイト自身のページ(同じホスト)からだけ受け付ける。Originが無い接続(テスト用のスクリプトなど)は通す */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return true;
  try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    const room = url.pathname.match(/^\/ws\/room\/([A-Z0-9]{4,8})$/);
    if (room) {
      if (!isWebSocket(req)) return new Response("WebSocketで接続してください", { status: 426 });
      if (!originAllowed(req)) return new Response("許可されていない接続元です", { status: 403 });
      return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(room[1])).fetch(req);
    }

    if (url.pathname === "/ws/queue") {
      if (!isWebSocket(req)) return new Response("WebSocketで接続してください", { status: 426 });
      if (!originAllowed(req)) return new Response("許可されていない接続元です", { status: 403 });
      return env.MATCHMAKER.get(env.MATCHMAKER.idFromName("global")).fetch(req);
    }

    if (url.pathname === "/api/health") return Response.json({ ok: true });
    if (url.pathname.startsWith("/api/")) return handleApi(req, env, url);

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

// ---------- プレイヤー登録・ランキングのAPI ----------
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra } });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > 2048) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { return null; }
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.DB) return json({ error: "データベースが設定されていません" }, 503);
  const path = url.pathname;
  try {
    if (path === "/api/leaderboard" && req.method === "GET") {
      return json({ rows: await leaderboard(env.DB, 50) }, 200, { "Cache-Control": "public, max-age=20" });
    }
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    if (!originAllowed(req)) return json({ error: "許可されていない接続元です" }, 403);
    const body = await readBody(req);
    if (!body) return json({ error: "リクエストが正しくありません" }, 400);

    if (path === "/api/register") {
      const p = await registerPlayer(env.DB, String(body.name ?? ""));
      return json(p, 201);
    }
    const me = await authenticate(env.DB, body.id, body.secret);
    if (!me) return json({ error: "認証できません" }, 401);
    if (path === "/api/me") return json({ profile: await profileOf(env.DB, me), games: await recentGames(env.DB, me.id) });
    if (path === "/api/rotate") return json({ secret: await rotateSecret(env.DB, me.id) });
    if (path === "/api/rename") return json({ name: await renamePlayer(env.DB, me.id, String(body.name ?? "")) });
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error("api error", e);
    return json({ error: "サーバーエラー" }, 500);
  }
}
