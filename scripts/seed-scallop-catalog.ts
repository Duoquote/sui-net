// Seed Scallop `s_coin_converter::SCoinTreasury<S, U>` shared objects into the MEV pool catalog.
//
// Scallop's sCoin converter emits NO pool-creation event (task #90), so the event-cursor backfill in
// backfill-pool-catalog.ts can't reach it. Instead we enumerate every treasury from its on-chain USERS:
// paginate `mint_s_coin`/`burn_s_coin` callers (both take `&mut SCoinTreasury<S,U>` as arg 0 with type
// args `<S, U>`), collect the distinct treasury object ids + their `<S = sCoin, U = underlying>` types.
//
// The MEV Scallop adapter (pools/scallop.rs) models each treasury as a synthetic pool: pool_id = the
// treasury, coin_a = U (underlying), coin_b = S (sCoin); a2b = mint (U->S), b2a = redeem (S->U). So we
// write `scallop|<treasury>|<U>|<S>`. Idempotent: rewrites the catalog's scallop rows in place.
//
// Usage: bun run scripts/seed-scallop-catalog.ts            # dry-run (prints rows)
//        bun run scripts/seed-scallop-catalog.ts --write    # rewrite the catalog's scallop rows
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const SCOIN_CONVERTER = "0x80ca577876dec91ae6d22090e56c39bc60dce9086ab0729930c6900bc4162b4c";
const CATALOG = "/root/sui/mev-pool-catalog/pools.csv";
const rpc = process.argv.includes("--public") || true
  ? "https://fullnode.mainnet.sui.io:443"
  : "http://127.0.0.1:9000";
const client = new SuiJsonRpcClient({ url: rpc, network: "mainnet" });

/** treasury id -> { s, u } (full type strings) */
async function enumerateTreasuries(): Promise<Map<string, { s: string; u: string }>> {
  const out = new Map<string, { s: string; u: string }>();
  for (const fn of ["mint_s_coin", "burn_s_coin"]) {
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 8; page++) {
      const res: any = await client.queryTransactionBlocks({
        filter: { MoveFunction: { package: SCOIN_CONVERTER, module: "s_coin_converter", function: fn } },
        options: { showInput: true },
        cursor: cursor ?? null,
        limit: 50,
        order: "descending" as any,
      });
      for (const t of res.data ?? []) {
        const txd = (t.transaction as any)?.data?.transaction;
        const inputs = txd?.inputs ?? [];
        for (const c of txd?.transactions ?? []) {
          const mc = c.MoveCall;
          if (!mc || mc.function !== fn) continue;
          const ta = mc.type_arguments ?? [];
          const a0 = mc.arguments?.[0];
          const idx = a0 && typeof a0 === "object" && "Input" in a0 ? a0.Input : undefined;
          const tid = idx !== undefined ? inputs[idx]?.objectId : undefined;
          if (tid && ta.length >= 2) out.set(tid, { s: ta[0], u: ta[1] });
        }
      }
      cursor = res.nextCursor;
      if (!res.hasNextPage) break;
    }
  }
  return out;
}

async function main() {
  const treasuries = await enumerateTreasuries();
  const rows = [...treasuries.entries()].map(([tid, { s, u }]) => `scallop|${tid}|${u}|${s}`);
  rows.sort();
  console.error(`enumerated ${rows.length} Scallop SCoinTreasury pools`);
  for (const r of rows) console.log(r);

  if (process.argv.includes("--write")) {
    copyFileSync(CATALOG, `${CATALOG}.pre-scallop.bak`);
    const kept = readFileSync(CATALOG, "utf8")
      .split("\n")
      .filter((l) => l.length > 0 && !l.startsWith("scallop|"));
    writeFileSync(CATALOG, [...kept, ...rows].join("\n") + "\n");
    console.error(`catalog rewritten: ${kept.length} non-scallop + ${rows.length} scallop rows`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
