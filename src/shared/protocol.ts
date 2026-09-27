// クライアントとサーバー(Durable Object)で共有する通信の型

export type Color = "w" | "b";

export interface MoveInput {
  from: string;
  to: string;
  promotion?: string;
}

export interface TimeControl {
  baseMs: number;       // 0 = 時間無制限
  incrementMs: number;
}

export const TIME_CONTROLS: Record<string, TimeControl> = {
  "5+3": { baseMs: 5 * 60_000, incrementMs: 3000 },
  "10+0": { baseMs: 10 * 60_000, incrementMs: 0 },
  "3+2": { baseMs: 3 * 60_000, incrementMs: 2000 },
  none: { baseMs: 0, incrementMs: 0 },
};
export const DEFAULT_TC_KEY = "5+3";

export type ResultReason =
  | "checkmate" | "resign" | "timeout" | "abandoned"
  | "stalemate" | "repetition" | "insufficient" | "fifty" | "agreement";

export interface GameResult {
  winner: Color | null;     // null = 引き分け
  reason: ResultReason;
}

/** 送信時点の持ち時間(残りms)。running のとき turn 側だけが受信時刻から減っていく */
export interface ClockState {
  w: number;
  b: number;
  turn: Color;
  running: boolean;
}

export interface Presence {
  w: boolean;
  b: boolean;
}

/** 切断されている側が、あと何ms戻らなければ負けになるか(切断されていなければ null) */
export interface AbandonIn {
  w: number | null;
  b: number | null;
}

export interface Names {
  w: string | null;
  b: string | null;
}

export type ClientMsg =
  | { t: "join"; name: string; token?: string }
  | { t: "move"; move: MoveInput }
  | { t: "resign" }
  | { t: "draw-offer" }
  | { t: "draw-accept" }
  | { t: "draw-decline" }
  | { t: "rematch" }
  | { t: "ping" };

export type ServerMsg =
  | { t: "joined"; color: Color | null; token: string; room: string }
  | {
      t: "sync";
      moves: MoveInput[];
      names: Names;
      present: Presence;
      abandonIn: AbandonIn;
      clock: ClockState;
      timeControl: TimeControl;
      result: GameResult | null;
      drawOffer: Color | null;
    }
  | { t: "move"; move: MoveInput; san: string; clock: ClockState }
  | { t: "presence"; present: Presence; names: Names; abandonIn: AbandonIn }
  | { t: "gameover"; result: GameResult; clock: ClockState }
  | { t: "draw-offer"; by: Color }
  | { t: "draw-declined" }
  | { t: "rematch-offer"; by: Color }
  | { t: "error"; message: string }
  | { t: "pong" };

export type QueueServerMsg = { t: "waiting" } | { t: "matched"; room: string } | { t: "timeout" };

/** ランダムマッチの待ち時間の上限(サーバーが打ち切る) */
export const QUEUE_TIMEOUT_MS = 90_000;

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 5;
export const randomRoomCode = (): string =>
  Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]).join("");
