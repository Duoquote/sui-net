// Resolve the distinct object inputs a competitor touches to their on-chain TYPE (DEX + coin pair),
// so we can compare their actual venue/coin coverage to what WE model. Read-only, public RPC.
// Usage: bun scripts/resolve-pools.ts <jsonl> [rpcUrl]
import { readFileSync, writeFileSync } from "fs";

const FILE = process.argv[2];
const RPC = process.argv[3] ?? "https://fullnode.mainnet.sui.io:443";
if (!FILE) throw new Error("usage: resolve-pools.ts <jsonl>");

async function rpc(method: string, params: any[], tries = 6): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (r.status === 429 || r.status >= 500) throw new Error("http " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) { if (i === tries - 1) throw e; await new Promise((s) => setTimeout(s, 500 * (i + 1))); }
  }
}

const rows = readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// count txs per object id
const objTx = new Map<string, number>();
for (const r of rows) for (const id of new Set<string>(r.objIds)) objTx.set(id, (objTx.get(id) ?? 0) + 1);
const ids = [...objTx.keys()];
console.log(`resolving ${ids.length} distinct object inputs...`);

const meta = new Map<string, { type: string }>();
for (let i = 0; i < ids.length; i += 50) {
  const batch = ids.slice(i, i + 50);
  const res = await rpc("sui_multiGetObjects", [batch, { showType: true }]);
  for (const o of res) {
    const id = o.data?.objectId ?? o.error?.object_id;
    if (id && o.data?.type) meta.set(id, { type: o.data.type });
  }
}

// classify: extract the "<pkg>::module::Struct" head + coin type args
function classify(type: string): { dex: string; coins: string[] } {
  // type like 0xPKG::module::Struct<0xC1::m::A, 0xC2::m::B>
  const lt = type.indexOf("<");
  const head = lt < 0 ? type : type.slice(0, lt);
  const inner = lt < 0 ? "" : type.slice(lt + 1, type.lastIndexOf(">"));
  // split top-level type args
  const coins: string[] = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "<") depth++; if (ch === ">") depth--;
    if (ch === "," && depth === 0) { coins.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) coins.push(cur.trim());
  return { dex: head, coins: coins.map((c) => c.split("::").slice(-1)[0]) };
}

const dexCount = new Map<string, number>();
const coinCount = new Map<string, number>();
const pairCount = new Map<string, number>();
const poolRows: string[] = [];
for (const [id, n] of objTx) {
  const m = meta.get(id);
  if (!m) continue;
  const { dex, coins } = classify(m.type);
  // only count things that look like pools (have coin type args)
  if (coins.length >= 2) {
    dexCount.set(dex, (dexCount.get(dex) ?? 0) + n);
    for (const c of coins) coinCount.set(c, (coinCount.get(c) ?? 0) + n);
    const pair = coins.slice(0, 2).sort().join("/");
    pairCount.set(pair, (pairCount.get(pair) ?? 0) + n);
    poolRows.push(`${id}\t${n}\t${coins.join("/")}\t${m.type}`);
  }
}

const top = (m: Map<string, number>, k = 40) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
console.log(`\n=== DEX/pool-defining packages (by #txs) — head of pool type ===`);
for (const [d, c] of top(dexCount, 30)) console.log(`  ${String(c).padStart(6)}  ${d}`);
console.log(`\n=== coins (by #txs) ===`);
for (const [c, n] of top(coinCount, 40)) console.log(`  ${String(n).padStart(6)}  ${c}`);
console.log(`\n=== top pairs (by #txs) ===`);
for (const [p, n] of top(pairCount, 40)) console.log(`  ${String(n).padStart(6)}  ${p}`);

const out = FILE.replace(/\.jsonl$/, ".pools.tsv");
writeFileSync(out, poolRows.sort((a, b) => Number(b.split("\t")[1]) - Number(a.split("\t")[1])).join("\n"));
console.log(`\npool rows -> ${out}  (${poolRows.length} pools, ${meta.size}/${ids.length} resolved)`);
