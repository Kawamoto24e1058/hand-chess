// サーバー(GameRoom / Matchmaker)の結合テスト: node scripts/e2e-server.mjs [http://localhost:5199]
// 本番URLに対して実行すると、テスト用のプレイヤー(名前が E2E_ で始まる)と対局がD1に実際に書き込まれる。
// 掃除するには: npx wrangler d1 execute hand-chess --remote --command "DELETE FROM games WHERE white_name LIKE 'E2E\_%' ESCAPE '\' OR black_name LIKE 'E2E\_%' ESCAPE '\'; DELETE FROM players WHERE name LIKE 'E2E\_%' ESCAPE '\';"
const HTTP = process.argv[2] ?? "http://localhost:5199";
const BASE = HTTP.replace(/^http/, "ws");
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
ok(pres?.abandonIn.b > 80_000 && pres.abandonIn.b <= 90_000 && pres.abandonIn.w === null, "切断中の側の、あと何ms戻らなければ負けになるかが通知される", `(${pres?.abandonIn.b}ms)`);
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
await sleep(700);
const lastJoined = (c) => c.inbox.filter((m) => m.t === "joined").pop();
const ja2 = lastJoined(a), jb3 = lastJoined(b2);
ok(ja2?.color === "b" && jb3?.color === "w", "再戦で先後が入れ替わる(最終的に、片方が白・もう片方が黒)");
b2.send({ t: "move", move: { from: "e2", to: "e4" } });
ok(!!(await a.wait((m) => m.t === "move" && m.san === "e4")), "入れ替え後は、新しい白(元の黒側)が先に指せる");

// フールズメイト → チェックメイト
const c2 = "T" + Math.random().toString(36).slice(2, 6).toUpperCase();
const p = client(`${BASE}/ws/room/${c2}?tc=none`), q = client(`${BASE}/ws/room/${c2}`);
await Promise.all([p.opened, q.opened]);
p.send({ t: "join", name: "P" }); await p.wait((m) => m.t === "sync"); q.send({ t: "join", name: "Q" }); await q.wait((m) => m.t === "sync");
await sleep(200);
for (const [who, from, to] of [[p, "f2", "f3"], [q, "e7", "e5"], [p, "g2", "g4"], [q, "d8", "h4"]]) { who.send({ t: "move", move: { from, to } }); await sleep(400); }
const mate = await p.wait((m) => m.t === "gameover");
ok(mate?.result.reason === "checkmate" && mate.result.winner === "b", "チェックメイトを検出して勝敗を配信");

// 連投制限: 短時間に大量のメッセージを送ると、接続が切られる
{
  const cf = "T" + Math.random().toString(36).slice(2, 6).toUpperCase();
  const flood = client(`${BASE}/ws/room/${cf}`); await flood.opened;
  let closedCode = null; flood.ws.onclose = (e) => { closedCode = e.code; };
  flood.send({ t: "join", name: "Flood" });
  for (let i = 0; i < 80; i++) flood.send({ t: "ping" });
  await sleep(800);
  ok(closedCode === 1008, "メッセージを連投すると、接続が切られる", `(code ${closedCode})`);
}

// ランダムマッチ
const m1 = client(`${BASE}/ws/queue`), m2 = client(`${BASE}/ws/queue`);
await Promise.all([m1.opened, m2.opened]);
const r1 = await m1.wait((m) => m.t === "matched"), r2 = await m2.wait((m) => m.t === "matched");
ok(r1?.room && r1.room === r2?.room, "ランダムマッチで2人に同じ部屋コードが通知される");


// ---------- レート戦(ランダムマッチ + 認証 + Elo + 保存) ----------
const post = async (path, body) => { const r = await fetch(HTTP + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const uname = (x) => `E2E_${x}${Math.random().toString(36).slice(2, 6)}`;   // 本番で紛れても掃除しやすいよう、目印を付ける
const pa = await post("/api/register", { name: uname("RA") }), pb = await post("/api/register", { name: uname("RB") });
ok(pa.status === 201 && pa.id && pa.secret && pa.rating === 1200, "プレイヤー登録でID・秘密のキー・初期レート1200が返る");
ok((await post("/api/me", { id: pa.id, secret: "wrong" })).status === 401, "秘密のキーが違うと認証できない");

async function matchedRoom() {
  const q1 = client(`${BASE}/ws/queue`), q2 = client(`${BASE}/ws/queue`); await Promise.all([q1.opened, q2.opened]);
  const m = await q1.wait((x) => x.t === "matched"); await q2.wait((x) => x.t === "matched"); return m.room;
}
async function playFoolsMate(room, whiteAuth, blackAuth) {
  const W = client(`${BASE}/ws/room/${room}`), B = client(`${BASE}/ws/room/${room}`); await Promise.all([W.opened, B.opened]);
  W.send({ t: "join", name: "x", auth: whiteAuth }); const sw = await W.wait((m) => m.t === "sync");
  B.send({ t: "join", name: "y", auth: blackAuth }); await B.wait((m) => m.t === "sync");
  for (const [who, from, to] of [[W, "f2", "f3"], [B, "e7", "e5"], [W, "g2", "g4"], [B, "d8", "h4"]]) { who.send({ t: "move", move: { from, to } }); await sleep(250); }
  return { W, B, sync: sw };
}

let room = await matchedRoom();
let g = await playFoolsMate(room, { id: pa.id, secret: pa.secret }, { id: pb.id, secret: pb.secret });
ok(g.sync.rated === true, "ランダムマッチで作った部屋は、レート戦になっている");
const rt = await g.W.wait((m) => m.t === "rating", 2500);
ok(rt?.changes.w.before === 1200 && rt.changes.w.after === 1180 && rt.changes.b.after === 1220, "フールズメイト(黒の勝ち)で、黒+20 / 白-20 が反映される", `(${JSON.stringify(rt?.changes)})`);
const lb = await (await fetch(HTTP + "/api/leaderboard")).json();
ok(lb.rows.some((r) => r.name === pb.name && r.rating === 1220 && r.games === 1), "ランキングに、対局後のレートが載る");
const me = await post("/api/me", { id: pb.id, secret: pb.secret });
ok(me.profile?.rating === 1220 && me.profile.wins === 1 && me.games?.length === 1 && me.games[0].after === 1220, "プロフィールに、戦績と直近の対局が保存されている");

// 自作自演(同じプレイヤーが両側): レートに反映しない
room = await matchedRoom();
g = await playFoolsMate(room, { id: pa.id, secret: pa.secret }, { id: pa.id, secret: pa.secret });
ok((await g.W.wait((m) => m.t === "rating", 1500)) === null, "同じプレイヤーが両側に座っても、レートには反映されない");

// 部屋コード対戦(レート戦ではない)
const codeRoom = "T" + Math.random().toString(36).slice(2, 6).toUpperCase();
g = await playFoolsMate(codeRoom, { id: pa.id, secret: pa.secret }, { id: pb.id, secret: pb.secret });
ok(g.sync.rated === false && (await g.W.wait((m) => m.t === "rating", 1200)) === null, "部屋コード対戦は、レートに反映されない");

// キーの再発行(引き継ぎコードの無効化)
const rot = await post("/api/rotate", { id: pb.id, secret: pb.secret });
ok(rot.secret && (await post("/api/me", { id: pb.id, secret: pb.secret })).status === 401 && (await post("/api/me", { id: pb.id, secret: rot.secret })).status === 200, "キーを再発行すると、古いキーは使えなくなる");

console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
process.exit(failed ? 1 : 0);
