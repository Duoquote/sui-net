// Are WE finding the same opportunities the winner does? Cross-reference the winner's recent WINNING
// pools against (a) the pools OUR engine logs finding opportunities on, and (b) the coins involved (to
// flag unmodeled DEXes/coins). Pure analysis of already-fetched data + our node log.
import { readFileSync } from "fs";

const winnerRows = readFileSync("/root/sui/wallet-tx/bfd9fa07.from.jsonl", "utf8")
  .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const wins = winnerRows.filter((r: any) => r.ok);

// Known non-pool input ids to exclude (clock, common shared singletons/configs/price-feeds).
const NON_POOL = new Set<string>([
  "0x0000000000000000000000000000000000000000000000000000000000000006", // Clock
]);
const isPoolish = (id: string) => !NON_POOL.has(id) && id.length === 66;
const coinName = (t: string) => { const p = t.replace(/^0x/, "").split("::"); return p.length >= 3 ? p[p.length - 1] : t; };

// --- winner: distinct winning pools + coin frequency + time span ---
const winnerPools = new Map<string, number>(); // pool id -> win count
const coinFreq = new Map<string, number>();
let tMin = Infinity, tMax = 0;
for (const r of wins) {
  if (r.ts) { tMin = Math.min(tMin, r.ts); tMax = Math.max(tMax, r.ts); }
  const seen = new Set<string>();
  for (const id of r.objIds) if (isPoolish(id)) seen.add(id);
  for (const id of seen) winnerPools.set(id, (winnerPools.get(id) ?? 0) + 1);
  const coins = new Set<string>();
  for (const c of r.calls) for (const t of (c.targs ?? [])) if (t && t.includes("::")) coins.add(coinName(t));
  for (const c of coins) coinFreq.set(c, (coinFreq.get(c) ?? 0) + 1);
}
console.log(`\n==== WINNER recent wins=${wins.length}  span=${new Date(tMin).toISOString()}..${new Date(tMax).toISOString()} ====`);
console.log(`distinct winning pools: ${winnerPools.size}`);

// --- our side: pools that appear in OUR log opportunity/submit/declined lines (= pools we FOUND opps on) ---
const ourLog = readFileSync("/root/sui/logs/sui-node.log", "utf8");
const ourFound = new Set<string>();
for (const m of ourLog.matchAll(/0x[0-9a-f]{64}/g)) ourFound.add(m[0]);
// Restrict to lines that are MEV opportunity/submit context by re-scanning those lines only:
const ourPoolsInMevLines = new Set<string>();
for (const line of ourLog.split("\n")) {
  if (/MEV (submit|shadow)|pool_ids=|WOULD submit|BROADCASTING|gas policy/.test(line)) {
    for (const m of line.matchAll(/0x[0-9a-f]{64}/g)) ourPoolsInMevLines.add(m[0]);
  }
}
console.log(`distinct pools appearing in OUR MEV opportunity/submit log lines: ${ourPoolsInMevLines.size}`);

// --- overlap ---
let overlap = 0;
const missed: [string, number][] = [];
for (const [pool, cnt] of winnerPools) {
  if (ourPoolsInMevLines.has(pool)) overlap++;
  else missed.push([pool, cnt]);
}
console.log(`\n---- OVERLAP: winner winning pools we ALSO found opportunities on ----`);
console.log(`  ${overlap}/${winnerPools.size} (${(100 * overlap / winnerPools.size).toFixed(0)}%)`);
console.log(`  winner pools we NEVER logged an opportunity on: ${missed.length}`);

// top winner pools we never touched (by their win count) — these are the gap
missed.sort((a, b) => b[1] - a[1]);
console.log(`\n---- TOP winner-winning pools absent from our MEV logs (pool -> winner win count) ----`);
for (const [pool, cnt] of missed.slice(0, 20)) console.log(`  ${cnt.toString().padStart(4)}  ${pool}`);

// --- coin coverage: which coins dominate the winner's wins (to spot unmodeled venues/coins) ---
console.log(`\n---- winner win COIN frequency (top 30) ----`);
[...coinFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  .forEach(([c, n]) => console.log(`  ${n.toString().padStart(4)}  ${c}`));
