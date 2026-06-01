// Pool-id universe seed tool — fuzzland-faithful CreatePoolEvent backfill.
//
// Enumerates EVERY pool ever created per DEX by paginating its pool-creation event history from a
// full-history RPC (the pruned local node only keeps ~days; the public fullnode goes back to genesis),
// then writes a persisted pool catalog the MEV node loads at startup. Per-protocol cursor → resumable.
//
//   bun run scripts/backfill-pool-catalog.ts [--rpc URL] [--out DIR] [--only cetus,bluefin] [--fresh]
//
// Output DIR (default /root/sui/mev-pool-catalog):
//   pools.csv          one line per pool:  protocol|pool_id|coin_a|coin_b
//   cursors.json       { protocol: cursor }  — resume point per DEX
//
// No private key, no signing — read-only event/object queries.

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = Bun.argv.slice(2);
const flag = (name: string, def: string | null = null): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const RPC = flag("rpc", "https://fullnode.mainnet.sui.io:443")!;
const OUT = flag("out", "/root/sui/mev-pool-catalog")!;
const ONLY = (flag("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const FRESH = args.includes("--fresh");
const PAGE = 50; // suix_queryEvents hard cap

// Per-DEX pool-creation event descriptor. `coinA`/`coinB` name the parsedJson field holding the coin
// type; `null` means the event omits coins (resolve from the pool object's type params instead).
// Nested TypeName fields (`type_x.name`) are dotted. Event types use the TYPE-ORIGIN package id, which
// is stable across runtime upgrades.
type Dex = {
  protocol: string;
  eventType: string;
  poolId: string;
  coinA: string | null;
  coinB: string | null;
};
const DEXES: Dex[] = [
  {
    protocol: "cetus",
    eventType: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::factory::CreatePoolEvent",
    poolId: "pool_id", coinA: "coin_type_a", coinB: "coin_type_b",
  },
  {
    protocol: "bluefin",
    eventType: "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::events::PoolCreated",
    poolId: "id", coinA: "coin_a", coinB: "coin_b",
  },
  {
    protocol: "momentum",
    eventType: "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::create_pool::PoolCreatedEvent",
    poolId: "pool_id", coinA: "type_x.name", coinB: "type_y.name",
  },
  {
    protocol: "flowx",
    eventType: "0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d::pool_manager::PoolCreated",
    poolId: "pool_id", coinA: "coin_type_x.name", coinB: "coin_type_y.name",
  },
  // Turbos + Kriya events carry no coin types → resolve from the pool object's type params.
  {
    protocol: "turbos",
    eventType: "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool_factory::PoolCreatedEvent",
    poolId: "pool", coinA: null, coinB: null,
  },
  {
    protocol: "kriya",
    eventType: "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66::spot_dex::PoolCreatedEvent",
    poolId: "pool_id", coinA: null, coinB: null,
  },
];

let rpcCalls = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      rpcCalls++;
      if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      if (attempt >= 6) throw e;
      await Bun.sleep(400 * 2 ** attempt); // backoff on rate-limit / transient
    }
  }
}

// Canonical coin type: 0x-prefixed, lowercase 64-hex address, full struct path. Events sometimes drop
// the 0x and zero-pad inconsistently; normalize so the node's by-pair index keys match its own reads.
function canonCoin(raw: string): string | null {
  if (!raw) return null;
  const s = raw.startsWith("0x") ? raw.slice(2) : raw;
  const parts = s.split("::");
  if (parts.length < 3) return null;
  const addr = parts[0].toLowerCase().padStart(64, "0");
  return `0x${addr}::${parts.slice(1).join("::")}`;
}
function dotGet(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}
// Split a generic argument list on top-level commas only.
function splitGenerics(inner: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const catalogPath = `${OUT}/pools.csv`;
  const cursorPath = `${OUT}/cursors.json`;

  if (FRESH) {
    writeFileSync(catalogPath, "");
    writeFileSync(cursorPath, "{}");
  }
  const cursors: Record<string, any> = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, "utf8")) : {};
  const seen = new Set<string>();
  if (existsSync(catalogPath)) {
    for (const line of readFileSync(catalogPath, "utf8").split("\n")) {
      const id = line.split("|")[1];
      if (id) seen.add(id);
    }
  }

  const selected = DEXES.filter((d) => ONLY.length === 0 || ONLY.includes(d.protocol));
  const totals: Record<string, number> = {};

  for (const dex of selected) {
    let cursor = cursors[dex.protocol] ?? null;
    let added = 0;
    let buf: string[] = [];
    const flushBuf = () => {
      if (buf.length) { appendFileSync(catalogPath, buf.join("")); buf = []; }
    };
    const emit = (pid: string, a: string, b: string) => {
      buf.push(`${dex.protocol}|${pid}|${a}|${b}\n`);
      added++;
      if (buf.length >= 500) flushBuf();
    };

    // Coin-less events (Turbos/Kriya): batch-resolve coins from pool object type params.
    const needCoins: string[] = [];
    const flushCoins = async () => {
      while (needCoins.length) {
        const batch = needCoins.splice(0, 50);
        const objs = await rpc("sui_multiGetObjects", [batch, { showType: true }]);
        for (const o of objs ?? []) {
          const ty: string = o?.data?.type ?? "";
          const lt = ty.indexOf("<"), gt = ty.lastIndexOf(">");
          if (lt < 0 || gt < 0) continue;
          const cs = splitGenerics(ty.slice(lt + 1, gt));
          const a = canonCoin((cs[0] ?? "").trim()), b = canonCoin((cs[1] ?? "").trim());
          if (a && b) emit(o.data.objectId, a, b);
        }
      }
    };

    for (;;) {
      const res = await rpc("suix_queryEvents", [
        { MoveEventType: dex.eventType }, cursor, PAGE, false, // ascending → stable cursor walk
      ]);
      for (const e of res?.data ?? []) {
        const pj = e.parsedJson ?? {};
        const pid: string = dotGet(pj, dex.poolId);
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        if (dex.coinA && dex.coinB) {
          const a = canonCoin(dotGet(pj, dex.coinA)), b = canonCoin(dotGet(pj, dex.coinB));
          if (a && b) emit(pid, a, b);
        } else {
          needCoins.push(pid);
        }
      }
      if (needCoins.length >= 200) await flushCoins();
      cursor = res?.nextCursor ?? cursor;
      cursors[dex.protocol] = cursor;
      if (!res?.hasNextPage) break;
      if (added > 0 && added % 2000 < PAGE) console.log(`  ${dex.protocol}: ~${added} so far (rpc ${rpcCalls})…`);
    }
    await flushCoins();
    flushBuf();
    totals[dex.protocol] = added;
    writeFileSync(cursorPath, JSON.stringify(cursors, null, 1));
    console.log(`${dex.protocol}: +${added} pools  (catalog ${seen.size}, rpc ${rpcCalls})`);
  }

  const grand = Object.values(totals).reduce((a, b) => a + b, 0);
  console.log(`\nDONE. added ${grand} pools this run; catalog total ${seen.size}; file ${catalogPath}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
