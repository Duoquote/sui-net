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
  // Non-generic creation event: filter by exact MoveEventType, coins from parsedJson fields.
  eventType?: string;
  // Generic creation event (e.g. DeepBook `pool::PoolCreated<Base,Quote>`): the coins live in the
  // event TYPE's generic params, so we can't filter by a bare MoveEventType. Query by MoveEventModule
  // and keep only events whose type starts with `<pkg>::<module>::<struct><`.
  eventModule?: { package: string; module: string; struct: string };
  // When set, parse coin_a/coin_b from the event type's generic params instead of parsedJson.
  coinsFromType?: boolean;
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
  // DeepBook V3 (CLOB): GENERIC event `pool::PoolCreated<Base,Quote>` — coins are in the event type's
  // generic params (parsedJson has only scalars). Query by module, parse coins from the type.
  {
    protocol: "deepbook_v3",
    eventModule: { package: "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809", module: "pool", struct: "PoolCreated" },
    coinsFromType: true,
    poolId: "pool_id", coinA: null, coinB: null,
  },
  // FullSail CLMM: factory event carries the coin types.
  {
    protocol: "fullsail",
    eventType: "0xe74104c66dd9f16b3096db2cc00300e556aa92edc871be4bc052b5dfb80db239::factory::CreatePoolEvent",
    poolId: "pool_id", coinA: "coin_type_a", coinB: "coin_type_b",
  },
  // Magma CLMM (Cetus fork): identical `factory::CreatePoolEvent {pool_id, coin_type_a, coin_type_b}`.
  {
    protocol: "magma",
    eventType: "0x4a35d3dfef55ed3631b7158544c6322a23bc434fe4fca1234cb680ce0505f82d::factory::CreatePoolEvent",
    poolId: "pool_id", coinA: "coin_type_a", coinB: "coin_type_b",
  },
  // Ferra DLMM: `lb_factory::CreatePairEvent`, pool id is `pair_id`, coins in the event.
  {
    protocol: "ferra",
    eventType: "0x5a5c1d10e4782dbbdec3eb8327ede04bd078b294b97cfdba447b11b846b383ac::lb_factory::CreatePairEvent",
    poolId: "pair_id", coinA: "coin_type_a", coinB: "coin_type_b",
  },
  // DipCoin AMM: coinless event, pool id is `pool_address` → resolve coins from the pool object.
  {
    protocol: "dipcoin",
    eventType: "0xdae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872::event::OperatorCreatePoolEvent",
    poolId: "pool_address", coinA: null, coinB: null,
  },
  // PairAMM (UniV2 fork): `factory::PairCreated {pair, token0.name, token1.name}`.
  {
    protocol: "pairamm",
    eventType: "0xbfac5e1c6bf6ef29b12f7723857695fd2f4da9a11a7d88162c15e9124c243a4a::factory::PairCreated",
    poolId: "pair", coinA: "token0.name", coinB: "token1.name",
  },
  // LBM Liquidity-Book DLMM (0x5664f9d3): `registry::CreatePoolEvent {pool_id, coin_type_a, coin_type_b}`.
  {
    protocol: "lbm",
    eventType: "0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b::registry::CreatePoolEvent",
    poolId: "pool_id", coinA: "coin_type_a", coinB: "coin_type_b",
  },
  // BlueMove constant-product AMM: `swap::Created_Pool_Event` carries the coin type NAMES (no 0x,
  // canonCoin re-prefixes). The separate `stable_swap` AMM is out of adapter scope, so only the
  // `swap::Pool` venue is seeded here.
  {
    protocol: "bluemove",
    eventType: "0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9::swap::Created_Pool_Event",
    poolId: "pool_id", coinA: "token_x_name", coinB: "token_y_name",
  },
  // Obric V2 oracle-PMM: `oracle_driven_pool::AddPoolEvent` carries base/quote coin NAMES. This is the
  // 0xa0e3b011 `oracle_driven_pool::Pool` contract competitors actually arb (distinct from the older
  // 0xb84e63d2 `v2::TradingPair` our legacy adapter modelled).
  {
    protocol: "obric_v2",
    eventType: "0xa0e3b011012b80af4957afa30e556486eb3da0a7d96eeb733cf16ccd3aec32e0::oracle_driven_pool::AddPoolEvent",
    poolId: "pool_id", coinA: "base_coin_type", coinB: "quote_coin_type",
  },
  // Aftermath AMM: `events::CreatedPoolEvent` carries the full `coins` array (canonical type strings,
  // no 0x). We seed the DOMINANT pair (coins[0]/coins[1]) — matching the adapter's coin_a/coin_b; the
  // full coin set is recovered from the pool object's `type_names` at parse. (Pool<LP> has no coins in
  // its Move generics, so `coinsFromType` can't be used — the coins live in the event/field.)
  {
    protocol: "aftermath",
    eventType: "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c::events::CreatedPoolEvent",
    poolId: "pool_id", coinA: "coins.0", coinB: "coins.1",
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

    // Filter (MoveEventType for non-generic, MoveEventModule for generic). For a generic event we
    // also keep only the matching struct prefix `<pkg>::<module>::<struct><`.
    const filter = dex.eventModule
      ? { MoveEventModule: { package: dex.eventModule.package, module: dex.eventModule.module } }
      : { MoveEventType: dex.eventType };
    const typePrefix = dex.eventModule
      ? `${dex.eventModule.package}::${dex.eventModule.module}::${dex.eventModule.struct}<`
      : null;
    for (;;) {
      const res = await rpc("suix_queryEvents", [
        filter, cursor, PAGE, false, // ascending → stable cursor walk
      ]);
      for (const e of res?.data ?? []) {
        if (typePrefix && !e.type?.startsWith(typePrefix)) continue;
        const pj = e.parsedJson ?? {};
        const pid: string = dotGet(pj, dex.poolId);
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        if (dex.coinsFromType) {
          // Coins are the event type's generic params: `...::Struct<A, B>`.
          const lt = e.type.indexOf("<"), gt = e.type.lastIndexOf(">");
          const cs = lt >= 0 && gt >= 0 ? splitGenerics(e.type.slice(lt + 1, gt)) : [];
          const a = canonCoin((cs[0] ?? "").trim()), b = canonCoin((cs[1] ?? "").trim());
          if (a && b) emit(pid, a, b);
        } else if (dex.coinA && dex.coinB) {
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

  // STEAMM: special two-pass. Its pool event (`events::Event<pool::NewPoolResult>`) names coins as
  // bTokens (b_sui, b_usdc …), but the node indexes STEAMM by the UNDERLYING coins — so first build a
  // bToken→underlying map from the bank events (`events::Event<bank::NewBankEvent>`, which carry both),
  // then translate each pool's bTokens. Only `cpmm::CpQuoter` pools are tradeable by our adapter.
  if (ONLY.length === 0 || ONLY.includes("steamm")) {
    const SP = "0x4fb1cf45dffd6230305f1d269dd1816678cc8e3ba0b747a813a556921219f261";
    const bankEvt = `${SP}::events::Event<${SP}::bank::NewBankEvent>`;
    const poolEvt = `${SP}::events::Event<${SP}::pool::NewPoolResult>`;
    // Pass 1: bToken → underlying (banks are few; re-read fully each run).
    const bmap = new Map<string, string>();
    let bc: any = null;
    for (;;) {
      const r = await rpc("suix_queryEvents", [{ MoveEventType: bankEvt }, bc, PAGE, false]);
      for (const e of r?.data ?? []) {
        const ev = e.parsedJson?.event ?? {};
        const bt = canonCoin(ev.btoken_type?.name), un = canonCoin(ev.coin_type?.name);
        if (bt && un) bmap.set(bt, un);
      }
      bc = r?.nextCursor ?? bc;
      if (!r?.hasNextPage) break;
    }
    // Pass 2: pools (resumable via cursor), translate bTokens → underlyings.
    let added = 0, buf: string[] = [];
    let cursor = cursors["steamm"] ?? null;
    for (;;) {
      const r = await rpc("suix_queryEvents", [{ MoveEventType: poolEvt }, cursor, PAGE, false]);
      for (const e of r?.data ?? []) {
        const ev = e.parsedJson?.event ?? {};
        if (!String(ev.quoter_type?.name ?? "").includes("cpmm::CpQuoter")) continue; // only CpQuoter is tradeable
        const pid = ev.pool_id;
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        const a = bmap.get(canonCoin(ev.coin_type_a?.name) ?? ""), b = bmap.get(canonCoin(ev.coin_type_b?.name) ?? "");
        if (a && b) { buf.push(`steamm|${pid}|${a}|${b}\n`); added++; }
      }
      if (buf.length) { appendFileSync(catalogPath, buf.join("")); buf = []; }
      cursor = r?.nextCursor ?? cursor;
      cursors["steamm"] = cursor;
      if (!r?.hasNextPage) break;
    }
    writeFileSync(cursorPath, JSON.stringify(cursors, null, 1));
    totals["steamm"] = added;
    console.log(`steamm: +${added} pools  (banks ${bmap.size}, catalog ${seen.size}, rpc ${rpcCalls})`);
  }

  const grand = Object.values(totals).reduce((a, b) => a + b, 0);
  console.log(`\nDONE. added ${grand} pools this run; catalog total ${seen.size}; file ${catalogPath}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
