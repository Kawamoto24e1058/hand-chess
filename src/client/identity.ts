import type { ApiGameRow, ApiLeaderboardRow, ApiProfile } from "../shared/protocol";
import { store } from "./store";

/**
 * プレイヤーの識別(ログイン不要)。初回に、サーバーでIDと秘密のキーを作り、この端末に保存する。
 * 端末を替える・データを消す時は、「引き継ぎコード」(IDとキーをまとめたもの)で復元できる。
 */
export interface Identity { id: string; secret: string }

// URLに ?profile=名前 を付けると、プレイヤーの保存先を分けられる(1台のブラウザで別のプレイヤーとして遊ぶ時・動作確認用)。
// ページを開いた時点のURLで決める(対局中にURLが ?room= に変わっても、保存先は変わらない)
const PROFILE = (new URLSearchParams(location.search).get("profile") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
const KEY = PROFILE ? `identity:${PROFILE}` : "identity";
const CODE_RE = /^HC-([0-9a-f]{16})-([0-9a-f]{48})$/;

export const loadIdentity = (): Identity | null => {
  const v = store.get<Identity | null>(KEY, null);
  return v && typeof v.id === "string" && typeof v.secret === "string" ? v : null;
};
const saveIdentity = (i: Identity | null) => store.set(KEY, i);

export const transferCode = (i: Identity) => `HC-${i.id}-${i.secret}`;
export const parseTransferCode = (code: string): Identity | null => {
  const m = CODE_RE.exec(code.trim());
  return m ? { id: m[1], secret: m[2] } : null;
};

async function api<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: (await res.json().catch(() => null)) as T | null };
  } catch { return { ok: false, status: 0, data: null }; }
}

/** 保存済みのIDがあればそれを返し、なければ新しく作る。APIが使えない時は null(レートなしで遊べる) */
export async function ensureIdentity(name: string): Promise<Identity | null> {
  const have = loadIdentity();
  if (have) return have;
  const r = await api<{ id: string; secret: string }>("/api/register", { name });
  if (!r.ok || !r.data) return null;
  const i = { id: r.data.id, secret: r.data.secret };
  saveIdentity(i);
  return i;
}

export interface Me { profile: ApiProfile; games: ApiGameRow[] }

/** 自分のプロフィール。IDが無効(キーの再発行など)なら、保存済みのIDを消して null を返す */
export async function fetchMe(i: Identity): Promise<Me | null> {
  const r = await api<Me>("/api/me", i);
  if (r.status === 401) { saveIdentity(null); return null; }
  return r.ok ? r.data : null;
}

export async function renameMe(i: Identity, name: string) { await api("/api/rename", { ...i, name }); }

/** 引き継ぎコードで復元する。正しければ保存して、プロフィールを返す */
export async function restoreFromCode(code: string): Promise<Me | null> {
  const i = parseTransferCode(code);
  if (!i) return null;
  const r = await api<Me>("/api/me", i);
  if (!r.ok || !r.data) return null;
  saveIdentity(i);
  return r.data;
}

/** 秘密のキーを作り直す(古い引き継ぎコードは使えなくなる) */
export async function rotateSecret(i: Identity): Promise<Identity | null> {
  const r = await api<{ secret: string }>("/api/rotate", i);
  if (!r.ok || !r.data) return null;
  const next = { id: i.id, secret: r.data.secret };
  saveIdentity(next);
  return next;
}

export async function fetchLeaderboard(): Promise<ApiLeaderboardRow[]> {
  const r = await api<{ rows: ApiLeaderboardRow[] }>("/api/leaderboard");
  return r.data?.rows ?? [];
}
