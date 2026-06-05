// Analyze the fetched wallet history. Goal: figure out what the bot does AND where funds go
// (the user's hypothesis: profits don't return to the signing wallet — they're swept elsewhere).
import { readFileSync } from "fs";

const W = "0xbfd9fa076ac3dbc1dfeb28fa2ecaa6b500a25c098f2efc8f7ce84b8c6fe3dda2";
const DIR = "/root/sui/wallet-tx";

type Call = { pkg: string; mod: string; fn: string; targs: string[] };
type BalDelta = { owner: string; coin: string; amount: string };
type Row = {
  digest: string; ts: number; epoch: number; sender: string; ok: boolean; err: string | null;
  dir: string; gasPrice: number; gasBudget: number; comp: number; storage: number; rebate: number;
  gasNet: number; cmds: number; calls: Call[]; objIds: string[]; bal: BalDelta[]; walletSui: number;
};

function load(f: string): Row[] {
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function coinShort(c: string): string {
  const p = c.split("::");
  return p.length >= 3 ? p[p.length - 2] + "::" + p[p.length - 1] : c;
}
function pct(n: number, d: number): string { return d ? ((100 * n) / d).toFixed(1) + "%" : "0%"; }
function fmt(n: number): string { return n.toLocaleString("en-US"); }

const from = load(`${DIR}/bfd9fa07.from.jsonl`);
const to = load(`${DIR}/bfd9fa07.to.jsonl`);

// ---- time span ----
const tsAll = from.map((r) => r.ts).filter((t) => t > 0);
const tMin = Math.min(...tsAll), tMax = Math.max(...tsAll);
const days = (tMax - tMin) / 86400000;
console.log(`\n==== WALLET ${W} ====`);
console.log(`FROM (signed) txs: ${from.length}   TO (received) txs: ${to.length}`);
console.log(`Span: ${new Date(tMin).toISOString()} .. ${new Date(tMax).toISOString()}  (${days.toFixed(1)} days)`);
console.log(`Throughput: ${(from.length / Math.max(days, 0.01)).toFixed(0)} signed tx/day`);

// ---- success / fail ----
const ok = from.filter((r) => r.ok);
const fail = from.filter((r) => !r.ok);
console.log(`\n---- FROM outcome ----`);
console.log(`ok=${ok.length} (${pct(ok.length, from.length)})  fail=${fail.length} (${pct(fail.length, from.length)})`);
const errHist: Record<string, number> = {};
for (const r of fail) { const e = (r.err ?? "?").slice(0, 70); errHist[e] = (errHist[e] ?? 0) + 1; }
console.log(`top errors:`);
Object.entries(errHist).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([e, c]) => console.log(`  ${c.toString().padStart(5)}  ${e}`));

// ---- what it calls (move call targets) ----
const callHist: Record<string, number> = {};
const pkgHist: Record<string, number> = {};
for (const r of from) {
  for (const c of r.calls) {
    callHist[`${c.mod}::${c.fn}`] = (callHist[`${c.mod}::${c.fn}`] ?? 0) + 1;
    pkgHist[c.pkg] = (pkgHist[c.pkg] ?? 0) + 1;
  }
}
console.log(`\n---- top MoveCall fns (signed txs) ----`);
Object.entries(callHist).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, c]) => console.log(`  ${c.toString().padStart(6)}  ${k}`));
console.log(`\n---- top packages called ----`);
Object.entries(pkgHist).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, c]) => console.log(`  ${c.toString().padStart(6)}  ${k}`));

// ---- gas spend ----
let gasTotal = 0;
for (const r of from) gasTotal += r.gasNet;
console.log(`\n---- gas ----`);
console.log(`total out-of-pocket gas over ${from.length} signed txs: ${(gasTotal / 1e9).toFixed(4)} SUI`);

// ---- THE KEY ANALYSIS: where do funds go in SIGNED txs ----
// For each signed tx, sum balance deltas per (owner, coin). Aggregate over all signed txs:
//   - wallet's own net per coin
//   - every OTHER address's net per coin (the potential profit sink)
const walletNet: Record<string, number> = {};
const otherNet: Record<string, Record<string, number>> = {}; // owner -> coin -> net
const otherTxCount: Record<string, number> = {};
for (const r of from) {
  const seenOwners = new Set<string>();
  for (const b of r.bal) {
    const amt = Number(b.amount);
    if (b.owner === W) {
      walletNet[b.coin] = (walletNet[b.coin] ?? 0) + amt;
    } else if (b.owner && b.owner !== "Shared" && b.owner !== "?") {
      otherNet[b.owner] = otherNet[b.owner] ?? {};
      otherNet[b.owner][b.coin] = (otherNet[b.owner][b.coin] ?? 0) + amt;
      seenOwners.add(b.owner);
    }
  }
  for (const o of seenOwners) otherTxCount[o] = (otherTxCount[o] ?? 0) + 1;
}
console.log(`\n---- wallet's OWN net balance deltas across all signed txs ----`);
Object.entries(walletNet).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12)
  .forEach(([c, v]) => console.log(`  ${(v / 1e9).toFixed(4).padStart(16)}  ${coinShort(c)}`));

// rank OTHER recipients by how many signed txs they appear in (frequent counterparties)
console.log(`\n---- OTHER addresses appearing in the wallet's signed txs (by tx count) ----`);
const rankedOthers = Object.entries(otherTxCount).sort((a, b) => b[1] - a[1]).slice(0, 12);
for (const [owner, cnt] of rankedOthers) {
  console.log(`\n  ${owner}   (in ${cnt} signed txs, ${pct(cnt, from.length)})`);
  const coins = otherNet[owner];
  Object.entries(coins).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6)
    .forEach(([c, v]) => console.log(`      net ${(v / 1e9).toFixed(4).padStart(16)}  ${coinShort(c)}`));
}

// ---- who funds this wallet (TO direction): senders of incoming SUI ----
console.log(`\n---- TO direction: net incoming by counterparty (who funds / sweeps this wallet) ----`);
const inboundBySender: Record<string, Record<string, number>> = {};
for (const r of to) {
  for (const b of r.bal) {
    if (b.owner !== W) continue; // only this wallet's deltas in txs it received
    // attribute to the tx sender (the counterparty that signed)
    const s = r.sender;
    inboundBySender[s] = inboundBySender[s] ?? {};
    inboundBySender[s][b.coin] = (inboundBySender[s][b.coin] ?? 0) + Number(b.amount);
  }
}
Object.entries(inboundBySender)
  .sort((a, b) => Math.abs((b[1]["0x2::sui::SUI"] ?? 0)) - Math.abs((a[1]["0x2::sui::SUI"] ?? 0)))
  .slice(0, 10)
  .forEach(([s, coins]) => {
    const sui = (coins["0x2::sui::SUI"] ?? 0) / 1e9;
    console.log(`  sender ${s}  SUI net to wallet: ${sui.toFixed(4)}`);
  });
