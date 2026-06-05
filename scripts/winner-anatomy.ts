// Extract the EXACT anatomy of the winner's successful arbs from from.jsonl (ok=true).
// Answers: what coin do they flash (anchor)? which DEXes/pools? route shapes? profit? gas posture?
import { readFileSync } from "fs";
const DIR = "/root/sui/wallet-tx";
const TREASURY = "0x30e0784ba08efa30b34f32638aea14b00b2e52136729c1780d7aea65d001f738";
const rows = readFileSync(`${DIR}/bfd9fa07.from.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const coinName = (t: string) => { if (!t) return "?"; const p = t.replace(/^0x/, "").split("::"); return p.length >= 3 ? p[p.length - 1] : t; };

// jk fn -> DEX family (from signatures + deps)
const DEX: Record<string, string> = {};
for (const f of ["xa", "xb", "xya", "xyb"]) DEX[f] = "FLASH";
for (const f of ["rtb", "xz", "dispose_residue", "dxx"]) DEX[f] = "SETTLE";
for (const f of ["adw", "aw"]) DEX[f] = "Aftermath";
for (const f of ["ba", "bb"]) DEX[f] = "BlueMove";
for (const f of ["bfa", "bfb", "bfax", "bfay", "bfbx", "bfby"]) DEX[f] = "CLMM_bf";
for (const f of ["ca", "cb", "cax", "cay", "cbx", "cby"]) DEX[f] = "CLMM_c";
for (const f of ["da", "db", "d3a", "d3b", "d3_inner"]) DEX[f] = "DeepBookV3";
for (const f of ["f3a", "f3b"]) DEX[f] = "FlowXv3";
for (const f of ["fa", "fb"]) DEX[f] = "FlowXv2";
for (const f of ["k3a", "k3b"]) DEX[f] = "KriyaCLMM";
for (const f of ["ka", "kb"]) DEX[f] = "KriyaSpot";
for (const f of ["sa", "sb"]) DEX[f] = "Suiswap";
for (const f of ["ta", "tb"]) DEX[f] = "Turbos";
for (const f of ["sob", "spa", "sb2", "spb"]) DEX[f] = "STEAMM"; // seen on the other jk pkg

const wins = rows.filter((r) => r.ok);
const losers = rows.filter((r) => !r.ok);
console.log(`\n==== WINNER ARB ANATOMY  (winners=${wins.length} / total=${rows.length}) ====`);

// ---- flash/anchor coin per winner ----
const flashCoin: Record<string, number> = {};
let flashed = 0;
const dexFreq: Record<string, number> = {};
const routeShape: Record<string, number> = {};
const hopHist: Record<number, number> = {};
const poolHits: Record<string, number> = {};
let profitTotalByCoin: Record<string, number> = {};
const gasWin: number[] = [], gasLose: number[] = [];

for (const r of wins) {
  // anchor coin = coin flashed (xa borrows T0, xb borrows T1)
  let anchor: string | null = null;
  const route: string[] = [];
  let hops = 0;
  for (const c of r.calls) {
    const fam = DEX[c.fn];
    if ((c.fn === "xa" || c.fn === "xb") && anchor === null) {
      anchor = coinName(c.fn === "xa" ? c.targs[0] : c.targs[1]);
      flashed++;
    }
    if (fam && fam !== "FLASH" && fam !== "SETTLE") { route.push(fam); hops++; dexFreq[fam] = (dexFreq[fam] ?? 0) + 1; }
  }
  if (anchor === null) {
    // no flash -> wallet-funded; anchor = whatever the first swap input coin is (approx via first non-settle targ)
    const first = r.calls.find((c: any) => DEX[c.fn] && DEX[c.fn] !== "SETTLE");
    anchor = first ? coinName(first.targs?.[0]) : "NONE";
  }
  flashCoin[anchor] = (flashCoin[anchor] ?? 0) + 1;
  routeShape[route.join(">") || "(none)"] = (routeShape[route.join(">") || "(none)"] ?? 0) + 1;
  hopHist[hops] = (hopHist[hops] ?? 0) + 1;
  for (const o of r.objIds) poolHits[o] = (poolHits[o] ?? 0) + 1;
  for (const b of r.bal) if (b.owner === TREASURY) profitTotalByCoin[b.coin] = (profitTotalByCoin[b.coin] ?? 0) + Number(b.amount);
  gasWin.push(r.gasPrice);
}
for (const r of losers) gasLose.push(r.gasPrice);

const top = (o: Record<string, number>, n = 15) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

console.log(`\n---- ANCHOR / FLASHED COIN (the entry coin of each winning arb) ----`);
console.log(`winners that flash-borrow: ${flashed}/${wins.length} (${(100 * flashed / wins.length).toFixed(0)}%)`);
for (const [c, n] of top(flashCoin)) console.log(`  ${n.toString().padStart(5)}  ${c}`);

console.log(`\n---- DEX usage across winning legs ----`);
for (const [d, n] of top(dexFreq)) console.log(`  ${n.toString().padStart(6)}  ${d}`);

console.log(`\n---- ROUTE SHAPES (DEX sequence) ----`);
for (const [s, n] of top(routeShape, 18)) console.log(`  ${n.toString().padStart(5)}  ${s}`);

console.log(`\n---- HOP COUNT (swap legs per winning arb) ----`);
for (const [h, n] of Object.entries(hopHist).sort((a, b) => Number(a[0]) - Number(b[0]))) console.log(`  ${h} hops: ${n}`);

console.log(`\n---- TOP POOLS in winning arbs (object id -> win count) ----`);
for (const [p, n] of top(poolHits, 20)) console.log(`  ${n.toString().padStart(5)}  ${p}`);

console.log(`\n---- PROFIT captured (treasury deltas across winners) ----`);
for (const [c, v] of Object.entries(profitTotalByCoin).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 10))
  console.log(`  ${(v / 1e9).toFixed(2).padStart(12)}  ${coinName(c)}`);

console.log(`\n---- GAS POSTURE (RGP bid) ----`);
console.log(`  winners: median gasPrice=${med(gasWin)}  max=${Math.max(...gasWin)}  min=${Math.min(...gasWin)}`);
console.log(`  losers:  median gasPrice=${med(gasLose)}  max=${Math.max(...gasLose)}`);
const distinctGasW = [...new Set(gasWin)].sort((a, b) => a - b);
console.log(`  distinct winner gasPrices: ${distinctGasW.slice(0, 12).join(", ")}${distinctGasW.length > 12 ? " ..." : ""}`);
