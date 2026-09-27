// サーバー(GameRoom / Matchmaker)の結合テスト: node scripts/e2e-server.mjs [http://localhost:5199]
const BASE = (process.argv[2] ?? "http://localhost:5199").replace(/^http/, "ws");
let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return {
    ws, inbox, opened,
    send: (m) => ws.send(JSON.stringify(m)),
    async wait(pred, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; await sleep(20); }
      return null;
    },
  };
}

const code = "T" + Math.random().toString(36).slice(2, 6).toUpperCase();
const a = client(`${BASE}/ws/room/${code}?tc=5%2B3`), b = client(`${BASE}/ws/room/${code}`);
await Promise.all([a.opened, b.opened]);
// 入室は順番に(ネットワーク越しでは同時に送ると到着順が入れ替わり、白黒が逆になる)
a.send({ t: "join", name: "Alice" });
const ja = await a.wait((m) => m.t === "joined");
b.send({ t: "join", name: "Bob" });
const jb = await b.wait((m) => m.t === "joined");
ok(ja?.color === "w" && jb?.color === "b", "入室順に白・黒が割り当てられる");
const sync = await a.wait((m) => m.t === "sync");
ok(sync?.timeControl.baseMs === 300000, "持ち時間(5+3)が最初の入室者の指定で確定");

b.send({ t: "move", move: { from: "e7", to: "e5" } });
ok((await b.wait((m) => m.t === "error"))?.message.includes("あなたの番"), "手番でない側の着手は拒否");
a.send({ t: "move", move: { from: "e2", to: "e5" } });
ok((await a.wait((m) => m.t === "error"))?.message.includes("指せません"), "不正な手は拒否");
a.send({ t: "move", move: { from: "e2", to: "e4" } });
const mv = await b.wait((m) => m.t === "move");
ok(mv?.san === "e4", "合法手は相手に配信される");
ok(mv?.clock.running === false, "1手目では時計は動かない");
b.send({ t: "move", move: { from: "e7", to: "e5" } });
const mv2 = await a.wait((m) => m.t === "move" && m.san === "e5");
ok(mv2?.clock.running === true && mv2.clock.turn === "w", "双方が指したら白の時計が動き出す");

// 切断 → 復帰(同じトークン)
const tokenB = jb.token;
b.ws.close(); await sleep(300);
const pres = await a.wait((m) => m.t === "presence" && m.present.b === false);
ok(!!pres, "相手の切断が通知される");
const b2 = client(`${BASE}/ws/room/${code}`); await b2.opened;
b2.send({ t: "join", name: "Bob", token: tokenB });
const jb2 = await b2.wait((m) => m.t === "joined"), sync2 = await b2.wait((m) => m.t === "sync");
ok(jb2?.color === "b" && sync2?.moves.length === 2, "同じトークンで再接続すると席と局面が復元される");

// 引き分け提案 → 承諾
b2.send({ t: "draw-offer" });
ok(!!(await a.wait((m) => m.t === "draw-offer" && m.by === "b")), "引き分け提案が届く");
a.send({ t: "draw-accept" });
const go = await b2.wait((m) => m.t === "gameover");
ok(go?.result.reason === "agreement" && go.result.winner === null, "合意で引き分け");

// 再戦 → 先後交代
a.send({ t: "rematch" }); b2.send({ t: "rematch" });
const ja2 = await a.wait((m) => m.t === "joined");
ok(ja2?.color === "b", "再戦で先後が入れ替わる");

// フールズメイト → チェックメイト
const c2 = "T" + Math.random().toString(36).slice(2, 6).toUpperCase();
const p = client(`${BASE}/ws/room/${c2}?tc=none`), q = client(`${BASE}/ws/room/${c2}`);
await Promise.all([p.opened, q.opened]);
p.send({ t: "join", name: "P" }); await p.wait((m) => m.t === "sync"); q.send({ t: "join", name: "Q" }); await q.wait((m) => m.t === "sync");
await sleep(200);
for (const [who, from, to] of [[p, "f2", "f3"], [q, "e7", "e5"], [p, "g2", "g4"], [q, "d8", "h4"]]) { who.send({ t: "move", move: { from, to } }); await sleep(400); }
const mate = await p.wait((m) => m.t === "gameover");
ok(mate?.result.reason === "checkmate" && mate.result.winner === "b", "チェックメイトを検出して勝敗を配信");

// ランダムマッチ
const m1 = client(`${BASE}/ws/queue`), m2 = client(`${BASE}/ws/queue`);
await Promise.all([m1.opened, m2.opened]);
const r1 = await m1.wait((m) => m.t === "matched"), r2 = await m2.wait((m) => m.t === "matched");
ok(r1?.room && r1.room === r2?.room, "ランダムマッチで2人に同じ部屋コードが通知される");

console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
process.exit(failed ? 1 : 0);
