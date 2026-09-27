/** localStorageの薄いラッパー(プライベートモード等で使えなくても壊れない) */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem("hc:" + key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch { return fallback; }
  },
  set(key: string, value: unknown) {
    try { localStorage.setItem("hc:" + key, JSON.stringify(value)); } catch { /* 保存できなくても続行 */ }
  },
};
