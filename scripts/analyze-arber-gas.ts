// Synthesize the reference arber's gas-budget logic from his accumulated history (arber-tx/arber-txs.jsonl).
// Focuses on ARB txs (those calling his executor); reports how he sized BUDGET (in gas units = budget/price)
// vs the realized COMPUTATION units and NET storage, split by hop-count and success/failure.
import { readFileSync } from "fs";
const rows = readFileSync("/root/sui/arber-tx/arber-txs.jsonl", "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const q = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const f = (n: number) => n.toLocaleString("en-US");

const arbs = rows.filter((r) => r.callsExecutor);
const nonArb = rows.filter((r) => !r.callsExecutor);
console.log(`TOTAL ${rows.length} | ARB ${arbs.length} | non-arb ${nonArb.length}`);

// hopCount := executor fns minus the profit-gate `xz`. flash-open/repay (xa/xb/xya/xyb) are not swaps,
// but they DO add compute; we report by total executor MoveCalls (his PTB length) as the complexity proxy.
function bucketBy(key: (r: any) => number, rs: any[], label: string) {
  const groups: Record<number, any[]> = {};
  for (const r of rs) (groups[key(r)] ??= []).push(r);
  console.log(`\n== ${label} ==`);
  for (const k of Object.keys(groups).map(Number).sort((a, b) => a - b)) {
    const g = groups[k];
    const ok = g.filter((r) => r.ok);
    const compUnits = g.map((r) => (r.gasPrice ? r.comp / r.gasPrice : 0));
    const budgetUnits = g.map((r) => (r.gasPrice ? r.gasBudget / r.gasPrice : 0));
    const netS = g.map((r) => r.net); // comp+storage-rebate (signed)
    const okNetS = ok.map((r) => r.storage - r.rebate); // success-only net storage proxy
    console.log(
      `  ${label}=${k} (n=${g.length}, ok=${ok.length}/${((ok.length / g.length) * 100).toFixed(0)}%): ` +
        `compUnits p50=${q(compUnits, 0.5)} p95=${q(compUnits, 0.95)} max=${Math.max(...compUnits)} | ` +
        `budgetUnits p50=${q(budgetUnits, 0.5)} p95=${q(budgetUnits, 0.95)} | ` +
        `netStorage(ok) p50=${f(q(okNetS, 0.5))} p95=${f(q(okNetS, 0.95))} max=${f(Math.max(0, ...okNetS))}`,
    );
  }
}

bucketBy((r) => r.moveCalls, arbs, "moveCalls");

// His budget tiers: distinct (budgetUnits) values and frequency.
const tier: Record<number, number> = {};
for (const r of arbs) {
  const u = r.gasPrice ? Math.round(r.gasBudget / r.gasPrice) : 0;
  tier[u] = (tier[u] || 0) + 1;
}
console.log("\n== BUDGET TIERS (budget/price = gas units he reserved) ==");
for (const [u, c] of Object.entries(tier).sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`  ${f(Number(u))} units  x${c}`);

// His gas-PRICE (bid) tiers.
const price: Record<number, number> = {};
for (const r of arbs) price[r.gasPrice] = (price[r.gasPrice] || 0) + 1;
console.log("\n== GAS PRICE (bid) TIERS ==");
for (const [p, c] of Object.entries(price).sort((a, b) => b[1] - a[1]).slice(0, 10))
  console.log(`  price ${p}  x${c}`);

// The key ratio: budget reserved (units) vs realized computation (units), success arbs only.
const okArbs = arbs.filter((r) => r.ok && r.gasPrice);
const ratios = okArbs.map((r) => r.gasBudget / Math.max(1, r.comp));
console.log(
  `\n== budget / realized-computation (success arbs) ==\n  p10=${q(ratios, 0.1).toFixed(1)}x p50=${q(ratios, 0.5).toFixed(1)}x p90=${q(ratios, 0.9).toFixed(1)}x  (how many x his actual compute he reserved)`,
);

// Did he EVER run out of gas? An InsufficientGas failure on an arb.
const oog = arbs.filter((r) => /InsufficientGas|OUT_OF_GAS/i.test(r.err || ""));
console.log(`\n== InsufficientGas arbs: ${oog.length} / ${arbs.length} ==`);

// Net cost of a FAILED arb (his cheap-revert thesis): comp+storage-rebate on failures.
const failArbs = arbs.filter((r) => !r.ok);
const failNet = failArbs.map((r) => r.net);
console.log(
  `== failed-arb net cost (MIST): p50=${f(q(failNet, 0.5))} p95=${f(q(failNet, 0.95))} max=${f(Math.max(0, ...failNet))} (n=${failArbs.length}) ==`,
);
