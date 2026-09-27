import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { randomRoomCode, type QueueServerMsg } from "../shared/protocol";

/**
 * ランダム対戦の待機キュー。1人待っているところに2人目が来たら、部屋コードを発行して2人に通知する。
 * 待機中のWebSocketは開いたままなので、Durable Objectはメモリ上の状態を保持できる。
 */
export class Matchmaker extends DurableObject<Env> {
  private waiting: WebSocket | null = null;

  async fetch(_req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    const send = (ws: WebSocket, msg: QueueServerMsg) => {
      try { ws.send(JSON.stringify(msg)); } catch { /* 切断済み */ }
    };

    const partner = this.waiting;
    if (partner && partner.readyState === WebSocket.READY_STATE_OPEN) {
      this.waiting = null;
      const room = randomRoomCode();
      send(partner, { t: "matched", room });
      send(server, { t: "matched", room });
      partner.close(1000, "matched");
      server.close(1000, "matched");
    } else {
      this.waiting = server;
      send(server, { t: "waiting" });
    }

    server.addEventListener("close", () => { if (this.waiting === server) this.waiting = null; });
    server.addEventListener("error", () => { if (this.waiting === server) this.waiting = null; });

    return new Response(null, { status: 101, webSocket: client });
  }
}
