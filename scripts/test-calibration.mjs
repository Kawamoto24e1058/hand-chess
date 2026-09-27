// 実位置キャリブレーションの計算の検証: 既知の写像から合成データを作り、復元できるか・雑音や平面上のデータでも壊れないかを見る
// 実行: node scripts/test-calibration.mjs
import { fitBoardMap, applyBoardMap, fitError, tiltDegrees } from "../src/client/calibration.ts";

let failed = 0;
const ok = (c, n, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n} ${extra}`); if (!c) failed++; };
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const noise = (s) => (rnd() - 0.5) * 2 * s;

// 真の写像: 盤のx = 900*X + 100*Z, 盤のy = -800*Z + 250*Y (手を前に出す=Zが小さい=盤の奥=yが小さい)
const truth = (p) => ({ x: 360 + 900 * (p.x - 0.0) + 100 * (p.z - 0.5), y: 360 - 800 * (p.z - 0.5) + 250 * (p.y - 0.0) });
const corners = [[0.5, 7.5], [7.5, 7.5], [7.5, 0.5], [0.5, 0.5], [4, 4]].map(([cx, cy]) => ({ x: cx * 90, y: cy * 90 }));
const handFor = (b) => {                       // 盤の位置から、手の位置を逆算(適当に非共面の位置を作る)
  const z = 0.5 - (b.y - 360) / 800 + (rnd() - 0.5) * 0.1;
  const y = ((b.y - 360) + 800 * (z - 0.5)) / 250;
  const x = (b.x - 360 - 100 * (z - 0.5)) / 900;
  return { x, y, z };
};

// 1) 雑音なし・手の位置が3次元に散らばっている場合: 完全に復元できる
let samples = corners.map((b) => ({ b, p: handFor(b) }));
let m = fitBoardMap(samples, 1e-9);
ok(fitError(m, samples) < 1, "雑音なしで、盤の位置を復元できる", `(誤差 ${fitError(m, samples).toFixed(3)}px)`);
const probe = { x: 0.1, y: 0.05, z: 0.45 };
const a = applyBoardMap(m, probe), t = truth(probe);
ok(Math.hypot(a.x - t.x, a.y - t.y) < 2, "見ていない位置でも正しく予測する", `(差 ${Math.hypot(a.x - t.x, a.y - t.y).toFixed(2)}px)`);

// 2) 雑音あり(手の位置に約1cm): 誤差が雑音の大きさに見合う範囲に収まる
samples = corners.map((b) => { const p = handFor(b); return { b, p: { x: p.x + noise(0.01), y: p.y + noise(0.01), z: p.z + noise(0.01) } }; });
m = fitBoardMap(samples);
ok(fitError(m, samples) < 60, "雑音があっても、大きく外れない", `(誤差 ${fitError(m, samples).toFixed(1)}px)`);

// 3) 手が1つの平面の上だけを動いた場合(縮退): 式が壊れず(NaNにならず)、平面上の位置は正しく対応する
const plane = (b) => { const p = handFor(b); return { x: p.x, z: p.z, y: 0.2 + 0.5 * p.x - 0.3 * p.z }; };   // y は x と z から決まる=同一平面
samples = corners.map((b) => ({ b, p: plane(b) }));
m = fitBoardMap(samples);
ok(!!m && [...m.sx, ...m.sy].every(Number.isFinite), "手が同一平面上でも、係数が有限(縮退しても壊れない)");
ok(fitError(m, samples) < 25, "同一平面上でも、示した位置には対応する", `(誤差 ${fitError(m, samples).toFixed(1)}px)`);

// 4) 傾きの推定: 手が画面に平行な面(Z一定)を動いた場合は0°付近、奥行き方向に動く場合は大きくなる
const flat = corners.map((b) => ({ b, p: { x: (b.x - 360) / 900, y: (b.y - 360) / 800, z: 0.5 } }));
const tilted = corners.map((b) => ({ b, p: { x: (b.x - 360) / 900, y: 0.1, z: 0.5 - (b.y - 360) / 800 } }));
const t0 = tiltDegrees(fitBoardMap(flat, 1e-9)), t1 = tiltDegrees(fitBoardMap(tilted, 1e-9));
ok(t0 < 10, "画面に平行に動く手 → 傾きが小さい", `(${t0.toFixed(1)}°)`);
ok(t1 > 60, "奥行き方向に動く手 → 傾きが大きい", `(${t1.toFixed(1)}°)`);

ok(fitBoardMap(samples.slice(0, 2)) === null, "サンプルが足りなければ null を返す");
console.log(failed ? `\n${failed} 件失敗` : "\nすべて成功");
process.exit(failed ? 1 : 0);
