import { readFileSync } from "fs";
const T = "0x30e0784ba08efa30b34f32638aea14b00b2e52136729c1780d7aea65d001f738";
const DIR = "/root/sui/wallet-tx";
const load = (f: string) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const coinShort = (c: string) => { const p = c.split("::"); return p.length >= 3 ? p[p.length - 1] : c; };

const to = load(`${DIR}/30e0784b.to.jsonl`);   // deposits INTO treasury
const from = load(`${DIR}/30e0784b.from.jsonl`); // sweeps OUT of treasury

// --- time span of incoming ---
const ts = to.map((r: any) => r.ts).filter((t: number) => t > 0);
const tMin = Math.min(...ts), tMax = Math.max(...ts);
const hrs = (tMax - tMin) / 3600000;
console.log(`\n==== TREASURY ${T} ====`);
console.log(`Incoming sample: ${to.length} txs over ${hrs.toFixed(1)}h (${new Date(tMin).toISOString()} .. ${new Date(tMax).toISOString()})`);

// --- group incoming by SENDER (which signer wallets feed the treasury?) ---
const bySender: Record<string, { txs: number; sui: number; coins: Set<string> }> = {};
let totalSuiIn = 0;
for (const r of to) {
  const s = r.sender;
  bySender[s] = bySender[s] ?? { txs: 0, sui: 0, coins: new Set() };
  bySender[s].txs++;
  for (const b of r.bal) {
    if (b.owner !== T) continue;
    if (b.coin === "0x2::sui::SUI") { bySender[s].sui += Number(b.amount); totalSuiIn += Number(b.amount); }
    else bySender[s].coins.add(coinShort(b.coin));
  }
}
const senders = Object.entries(bySender).sort((a, b) => b[1].sui - a[1].sui);
console.log(`\n---- WHO FEEDS THE TREASURY (incoming grouped by signer) ----`);
console.log(`distinct signer wallets: ${senders.length}`);
for (const [s, v] of senders.slice(0, 15)) {
  console.log(`  ${s}  ${v.txs.toString().padStart(5)} txs  +${(v.sui / 1e9).toFixed(2).padStart(10)} SUI  (+${v.coins.size} other coins)`);
}
console.log(`\nTotal SUI into treasury over this ${to.length}-tx / ${hrs.toFixed(1)}h sample: ${(totalSuiIn / 1e9).toFixed(2)} SUI`);
console.log(`Implied rate: ${(totalSuiIn / 1e9 / hrs).toFixed(1)} SUI/h  ≈ ${(totalSuiIn / 1e9 / hrs * 24).toFixed(0)} SUI/day (SUI-leg only)`);

// --- outgoing sweeps ---
console.log(`\n---- TREASURY OUTGOING (sweeps) : ${from.length} txs ----`);
const dest: Record<string, Record<string, number>> = {};
const tsf = from.map((r: any) => r.ts).filter((t: number) => t > 0);
const hrsf = (Math.max(...tsf) - Math.min(...tsf)) / 3600000;
for (const r of from) {
  for (const b of r.bal) {
    if (b.owner === T || b.owner === "Shared" || b.owner === "?") continue;
    dest[b.owner] = dest[b.owner] ?? {};
    dest[b.owner][b.coin] = (dest[b.owner][b.coin] ?? 0) + Number(b.amount);
  }
}
console.log(`sweep span ${hrsf.toFixed(1)}h; destinations:`);
for (const [d, coins] of Object.entries(dest).sort((a, b) => (b[1]["0x2::sui::SUI"] ?? 0) - (a[1]["0x2::sui::SUI"] ?? 0)).slice(0, 8)) {
  const top = Object.entries(coins).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5)
    .map(([c, v]) => `${(v / 1e9).toFixed(2)} ${coinShort(c)}`).join(", ");
  console.log(`  -> ${d}\n       ${top}`);
}
