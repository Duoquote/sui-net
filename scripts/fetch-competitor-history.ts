// Fetch a competitor arbitrageur's tx history from PUBLIC mainnet RPC with RICH per-tx data for a
// COVERAGE/CADENCE comparison against our bot (why do they find far more opportunities than we do?).
// Captures every MoveCall target (pkg::module::fn + typeArgs), every object input (pool ids), and the
// wallet's per-coin balance deltas — enough to map which DEXes/coins/pools they touch that we don't.
//
// Read-only. Usage: bun scripts/fetch-competitor-history.ts <wallet> [maxTx] [rpcUrl]
const WALLET = process.argv[2];
if (!WALLET) throw new Error("usage: fetch-competitor-history.ts <wallet> [maxTx] [rpcUrl]");
const MAX_TX = Number(process.argv[3] ?? 10000);
const RPC = process.argv[4] ?? "https://fullnode.mainnet.sui.io:443";
const OUT_DIR = "/root/sui/competitor-tx";
const PAGE = 50;

import { mkdirSync, writeFileSync, appendFileSync } from "fs";

async function rpc(method: string, params: any[], tries = 6): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error("http " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
}

type Call = { pkg: string; mod: string; fn: string; targs: string[] };
type Row = {
  digest: string;
  ts: number;
  epoch: number;
  ok: boolean;
  err: string | null;
  gasPrice: number;
  gasBudget: number;
  comp: number;
  storage: number;
  rebate: number;
  net: number; // out-of-pocket gas (comp + storage - rebate)
  cmds: number; // total PTB commands
  moveCalls: number;
  calls: Call[]; // every MoveCall, in order
  objIds: string[]; // every object input id (pools/configs/clocks)
  coins: Record<string, number>; // coinType -> net delta for THIS wallet (MIST/raw)
  suiDelta: number;
};

function short(addr: string): string {
  return addr.startsWith("0x") ? addr : "0x" + addr;
}

mkdirSync(OUT_DIR, { recursive: true });
const tag = short(WALLET).slice(2, 10);
const JSONL = `${OUT_DIR}/${tag}.jsonl`;
writeFileSync(JSONL, "");

let cursor: string | null = null;
let n = 0;
let pages = 0;
let ok = 0;
const t0 = Date.now();
outer: while (n < MAX_TX) {
  const page = await rpc("suix_queryTransactionBlocks", [
    {
      filter: { FromAddress: short(WALLET) },
      options: { showEffects: true, showInput: true, showBalanceChanges: true },
    },
    cursor,
    PAGE,
    true,
  ]);
  pages++;
  const buf: string[] = [];
  for (const tx of page.data) {
    const eff = tx.effects;
    const g = eff.gasUsed;
    const comp = Number(g.computationCost);
    const storage = Number(g.storageCost);
    const rebate = Number(g.storageRebate);
    const gd = tx.transaction?.data;
    const gasBudget = Number(gd?.gasData?.budget ?? 0);
    const gasPrice = Number(gd?.gasData?.price ?? 0);
    const txd = gd?.transaction;
    const cmdsArr: any[] = txd?.transactions ?? [];
    const inputs: any[] = txd?.inputs ?? [];
    const objIds: string[] = [];
    for (const inp of inputs) {
      const id = inp?.objectId ?? inp?.objectID;
      if (id) objIds.push(id);
    }
    const calls: Call[] = [];
    for (const c of cmdsArr) {
      if (c.MoveCall) {
        calls.push({
          pkg: c.MoveCall.package ?? "",
          mod: c.MoveCall.module ?? "",
          fn: c.MoveCall.function ?? "",
          targs: c.MoveCall.type_arguments ?? c.MoveCall.typeArguments ?? [],
        });
      }
    }
    const coins: Record<string, number> = {};
    let suiDelta = 0;
    for (const bc of tx.balanceChanges ?? []) {
      const owner = bc.owner?.AddressOwner ?? bc.owner;
      if (owner !== short(WALLET)) continue;
      coins[bc.coinType] = (coins[bc.coinType] ?? 0) + Number(bc.amount);
      if (bc.coinType === "0x2::sui::SUI") suiDelta += Number(bc.amount);
    }
    const isOk = eff.status?.status === "success";
    if (isOk) ok++;
    const row: Row = {
      digest: tx.digest,
      ts: Number(tx.timestampMs ?? 0),
      epoch: Number(eff.executedEpoch ?? 0),
      ok: isOk,
      err: isOk ? null : eff.status?.error ?? "failure",
      gasPrice,
      gasBudget,
      comp,
      storage,
      rebate,
      net: comp + storage - rebate,
      cmds: cmdsArr.length,
      moveCalls: calls.length,
      calls,
      objIds,
      coins,
      suiDelta,
    };
    buf.push(JSON.stringify(row));
    n++;
    if (n >= MAX_TX) {
      appendFileSync(JSONL, buf.join("\n") + "\n");
      break outer;
    }
  }
  if (buf.length) appendFileSync(JSONL, buf.join("\n") + "\n");
  if (pages % 10 === 0)
    console.log(`  ${n} txs / ${ok} ok / ${pages} pages / ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (!page.hasNextPage || !page.nextCursor) break;
  cursor = page.nextCursor;
}

console.log(`DONE ${short(WALLET)}: ${n} txs (${ok} ok) in ${pages} pages, ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${JSONL}`);
