// Forensic over our wallet's last N hours: P&L, burn breakdown, biggest-burn tx.
// Read-only; queries local fullnode JSON-RPC on :9000.
const RPC = "http://127.0.0.1:9000";
const WALLET = "0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257";
const HOURS = Number(process.argv[2] ?? 6);
const NOW = Date.now();
const SINCE = NOW - HOURS * 3600_000;

async function rpc(method: string, params: any[]) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}

type Row = {
  digest: string;
  ts: number;
  ok: boolean;
  err?: string;
  comp: number;
  storage: number;
  rebate: number;
  nonRef: number;
  netGas: number; // SUI paid out of pocket (mist)
  cmds: number;
  balDelta: number; // SUI balance change for our wallet (mist)
};

let cursor: string | null = null;
const rows: Row[] = [];
outer: while (true) {
  const page = await rpc("suix_queryTransactionBlocks", [
    { filter: { FromAddress: WALLET }, options: { showEffects: true, showInput: true, showBalanceChanges: true } },
    cursor,
    50,
    true, // descending (newest first)
  ]);
  for (const tx of page.data) {
    const ts = Number(tx.timestampMs ?? 0);
    if (ts && ts < SINCE) break outer;
    const eff = tx.effects;
    const g = eff.gasUsed;
    const comp = Number(g.computationCost);
    const storage = Number(g.storageCost);
    const rebate = Number(g.storageRebate);
    const nonRef = Number(g.nonRefundableStorageFee);
    const netGas = comp + storage - rebate; // out-of-pocket
    const ok = eff.status.status === "success";
    let cmds = 0;
    try {
      const txd = tx.transaction?.data?.transaction;
      if (txd?.transactions) cmds = txd.transactions.length;
    } catch {}
    let balDelta = 0;
    for (const bc of tx.balanceChanges ?? []) {
      if (bc.coinType === "0x2::sui::SUI" && bc.owner?.AddressOwner === WALLET) {
        balDelta += Number(bc.amount);
      }
    }
    rows.push({
      digest: tx.digest,
      ts,
      ok,
      err: ok ? undefined : (eff.status.error ?? "").slice(0, 80),
      comp, storage, rebate, nonRef, netGas, cmds, balDelta,
    });
  }
  if (!page.hasNextPage || !page.nextCursor) break;
  cursor = page.nextCursor;
}

const M = 1e9;
const succ = rows.filter((r) => r.ok);
const rev = rows.filter((r) => !r.ok);
const netPnl = rows.reduce((a, r) => a + r.balDelta, 0);
const grossWin = succ.reduce((a, r) => a + r.balDelta, 0);
const burnRev = rev.reduce((a, r) => a + r.netGas, 0);

console.log(`\n=== Forensic: last ${HOURS}h for ${WALLET.slice(0, 10)}… ===`);
console.log(`window: ${new Date(SINCE).toISOString()} → ${new Date(NOW).toISOString()}`);
console.log(`txs: ${rows.length}  success: ${succ.length}  revert: ${rev.length}  (${rows.length ? Math.round(100 * rev.length / rows.length) : 0}% revert)`);
console.log(`NET P&L (SUI balance delta, incl gas): ${(netPnl / M).toFixed(6)} SUI`);
console.log(`  gross win over ${succ.length} lands: ${(grossWin / M).toFixed(6)} SUI`);
console.log(`  burn over ${rev.length} reverts (netGas): ${(burnRev / M).toFixed(6)} SUI`);

// error buckets
const buckets = new Map<string, { n: number; burn: number }>();
for (const r of rev) {
  const key = (r.err ?? "?").replace(/[0-9]+/g, "#");
  const b = buckets.get(key) ?? { n: 0, burn: 0 };
  b.n++; b.burn += r.netGas;
  buckets.set(key, b);
}
console.log(`\n--- revert error buckets (by count) ---`);
for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
  console.log(`  ${String(v.n).padStart(4)}  burn ${(v.burn / M).toFixed(5)} SUI   ${k}`);
}

// biggest burns
console.log(`\n--- top 12 biggest-burn txs ---`);
for (const r of [...rows].sort((a, b) => b.netGas - a.netGas).slice(0, 12)) {
  console.log(`  ${(r.netGas / M).toFixed(5)} SUI  ${r.ok ? "OK " : "REV"}  cmds=${String(r.cmds).padStart(2)}  comp=${r.comp} stor=${r.storage} reb=${r.rebate}  ${r.digest}  ${r.err ?? ""}`);
}

// command-count distribution
const cmdDist = new Map<number, number>();
for (const r of rows) cmdDist.set(r.cmds, (cmdDist.get(r.cmds) ?? 0) + 1);
console.log(`\n--- command-count distribution ---`);
for (const [c, n] of [...cmdDist.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(c).padStart(2)} cmds: ${n}`);
}

// top wins
console.log(`\n--- top 12 wins (SUI balance delta) ---`);
for (const r of [...rows].sort((a, b) => b.balDelta - a.balDelta).slice(0, 12)) {
  console.log(`  +${(r.balDelta / M).toFixed(6)} SUI  cmds=${r.cmds}  ${r.digest}`);
}
const wins = succ.map(r => r.balDelta).sort((a,b)=>b-a);
const top1 = wins[0] ?? 0; const top3 = wins.slice(0,3).reduce((a,b)=>a+b,0);
console.log(`\nwin concentration: top1=${(top1/M).toFixed(4)} (${grossWin? Math.round(100*top1/grossWin):0}% of gross), top3=${(top3/M).toFixed(4)} (${grossWin?Math.round(100*top3/grossWin):0}%)`);
