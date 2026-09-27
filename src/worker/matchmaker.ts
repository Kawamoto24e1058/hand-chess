import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { QUEUE_TIMEOUT_MS, randomRoomCode, type QueueServerMsg } from "../shared/protocol";

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
      // マッチングで作った部屋だけを、レート戦にする(クライアントの申告では、レート戦の部屋は作れない)
      try { await this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(room)).markRated(); } catch (e) { console.error("markRated failed", e); }
      send(partner, { t: "matched", room });
      send(server, { t: "matched", room });
      partner.close(1000, "matched");
      server.close(1000, "matched");
    } else {
      this.waiting = server;
      send(server, { t: "waiting" });
      // 誰も来なければ、待ち時間の上限で打ち切る(待ちっぱなしを防ぐ)
      setTimeout(() => {
        if (this.waiting === server) { this.waiting = null; send(server, { t: "timeout" }); try { server.close(1000, "timeout"); } catch { /* */ } }
      }, QUEUE_TIMEOUT_MS);
    }

    server.addEventListener("close", () => { if (this.waiting === server) this.waiting = null; });
    server.addEventListener("error", () => { if (this.waiting === server) this.waiting = null; });

    return new Response(null, { status: 101, webSocket: client });
  }
}
