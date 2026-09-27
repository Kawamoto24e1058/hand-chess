import type { ClientMsg, QueueServerMsg, ServerMsg } from "../shared/protocol";

// 席トークンはタブごと(sessionStorage)に持つ。リロード/回線切れでは同じ席に戻れ、別タブは別プレイヤーとして扱える
const tokenKey = (room: string) => `hc:token:${room}`;
const loadToken = (room: string): string | undefined => { try { return sessionStorage.getItem(tokenKey(room)) ?? undefined; } catch { return undefined; } };
const saveToken = (room: string, token: string) => { try { sessionStorage.setItem(tokenKey(room), token); } catch { /* 保存できなくても続行 */ } };

const wsBase = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

export type NetStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * 対局部屋へのWebSocket接続。切れたら自動で再接続し、部屋ごとに保存した席トークンで同じ席に戻る。
 */
export class RoomConnection {
  status: NetStatus = "connecting";
  private ws: WebSocket | null = null;
  private retry = 0;
  private closedByUs = false;
  private pingTimer = 0;
  private retryTimer = 0;

  constructor(
    private room: string,
    private tc: string,
    private name: string,
    private onMsg: (m: ServerMsg) => void,
    private onStatus: (s: NetStatus) => void,
  ) {
    this.connect();
  }

  private setStatus(s: NetStatus) { this.status = s; this.onStatus(s); }

  private connect() {
    this.setStatus(this.retry === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(`${wsBase()}/ws/room/${this.room}?tc=${encodeURIComponent(this.tc)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("open");
      this.send({ t: "join", name: this.name, token: loadToken(this.room) });
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: "ping" }), 25_000);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try { m = JSON.parse(e.data as string); } catch { return; }
      if (m.t === "joined" && m.token) saveToken(this.room, m.token);
      this.onMsg(m);
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      if (this.closedByUs) return this.setStatus("closed");
      if (e.code === 4000) return this.setStatus("closed");        // 別の場所から接続された
      this.retry++;
      this.setStatus("reconnecting");
      this.retryTimer = window.setTimeout(() => this.connect(), Math.min(5000, 400 * 2 ** Math.min(this.retry, 4)));
    };
    ws.onerror = () => { /* onclose側で再接続する */ };
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close() {
    this.closedByUs = true;
    clearInterval(this.pingTimer); clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}

/** ランダムマッチの待機。2人揃うと同じ部屋コードが返る。cancel() で待機をやめる */
export function findMatch(onWaiting: () => void): { promise: Promise<string>; cancel: () => void } {
  const ws = new WebSocket(`${wsBase()}/ws/queue`);
  let done = false;
  const promise = new Promise<string>((resolve, reject) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as QueueServerMsg;
      if (m.t === "waiting") onWaiting();
      else if (m.t === "matched") { done = true; resolve(m.room); }
    };
    ws.onerror = () => reject(new Error("マッチングサーバーに接続できません"));
    ws.onclose = () => { if (!done) reject(new Error("cancelled")); };
  });
  return { promise, cancel: () => { done = true; ws.close(); } };
}
