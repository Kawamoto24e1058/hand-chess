import { GameRoom } from "./room";
import { Matchmaker } from "./matchmaker";

export { GameRoom, Matchmaker };

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  ASSETS: Fetcher;
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

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
