// Elo の計算の検証: node scripts/test-elo.mjs
import { updateElo, expectedScore, kFactor } from "../src/shared/elo.ts";
let failed = 0;
const ok = (c, n, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n} ${extra}`); if (!c) failed++; };

ok(Math.abs(expectedScore(1200, 1200) - 0.5) < 1e-9, "同じレートなら期待値は0.5");
ok(expectedScore(1600, 1200) > 0.9 && expectedScore(1200, 1600) < 0.1, "400差なら約91%対9%");
ok(kFactor(0) === 40 && kFactor(29) === 40 && kFactor(30) === 24, "K値は30戦まで40、以降24");

let r = updateElo({ white: { rating: 1200, games: 0 }, black: { rating: 1200, games: 0 }, winner: "w" });
ok(Math.round(r.white) === 1220 && Math.round(r.black) === 1180, "同じレートで白が勝つと、+20 / -20", `(${r.white}, ${r.black})`);
r = updateElo({ white: { rating: 1200, games: 0 }, black: { rating: 1200, games: 0 }, winner: null });
ok(Math.abs(r.white - 1200) < 1e-9 && Math.abs(r.black - 1200) < 1e-9, "同じレートの引き分けは、変動なし");
r = updateElo({ white: { rating: 1000, games: 50 }, black: { rating: 1400, games: 50 }, winner: null });
ok(r.white > 1000 && r.black < 1400, "格下が格上と引き分けると、格下は上がり、格上は下がる", `(${r.white.toFixed(1)}, ${r.black.toFixed(1)})`);
const before = 1300 + 1250, after = updateElo({ white: { rating: 1300, games: 50 }, black: { rating: 1250, games: 50 }, winner: "b" });
ok(Math.abs(after.white + after.black - before) < 1e-9, "K値が同じなら、2人の合計は保存される");
console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
process.exit(failed ? 1 : 0);
