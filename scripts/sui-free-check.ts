// Of the winner's WINNING arbs, how many cycles are SUI-FREE (contain no SUI hop at all)?
// Those are the ones our sui_anchored_route gate genuinely DROPS. Cycles that merely *enter*
// from USDC but pass through SUI are already fireable (we rotate to the SUI hop).
import { readFileSync } from "fs";
const SUI = "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const rows = readFileSync("/root/sui/wallet-tx/bfd9fa07.from.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const wins = rows.filter((r: any) => r.ok);

const norm = (t: string) => t.replace(/^0x/, "").toLowerCase();
const isSui = (t: string) => norm(t) === SUI || norm(t).endsWith("::sui::sui");
const coinName = (t: string) => { const p = t.replace(/^0x/, "").split("::"); return p.length >= 3 ? p[p.length - 1] : t; };

let suiFree = 0, hasSui = 0, noCoins = 0;
const suiFreePairs: Record<string, number> = {};
for (const r of wins) {
  // gather coins appearing ONLY in swap-leg type args (NOT balance changes — those include gas SUI)
  const coins = new Set<string>();
  for (const c of r.calls) for (const t of (c.targs ?? [])) if (t && t.includes("::")) coins.add(norm(t));
  if (coins.size === 0) { noCoins++; continue; }
  const sui = [...coins].some(isSui);
  if (sui) hasSui++;
  else {
    suiFree++;
    const names = [...coins].map(coinName).sort();
    const key = names.join(",");
    suiFreePairs[key] = (suiFreePairs[key] ?? 0) + 1;
  }
}
console.log(`\n==== SUI-FREE CYCLE ANALYSIS (winners=${wins.length}) ====`);
console.log(`contains SUI somewhere (already fireable by rotation): ${hasSui} (${(100 * hasSui / wins.length).toFixed(1)}%)`);
console.log(`SUI-FREE loop (genuinely BLOCKED by our gate):          ${suiFree} (${(100 * suiFree / wins.length).toFixed(1)}%)`);
console.log(`no coin info:                                           ${noCoins}`);
console.log(`\n---- top SUI-free coin sets (the arbs we can't touch at all) ----`);
Object.entries(suiFreePairs).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, n]) => console.log(`  ${n.toString().padStart(4)}  {${k}}`));
