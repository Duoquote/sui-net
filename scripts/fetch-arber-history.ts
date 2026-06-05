// Fetch the reference arbitrageur's full tx history from PUBLIC mainnet RPC (his txs are ~6mo old, so
// they are pruned from our local node but retained by the public fullnode). Accumulates one JSONL row
// per tx under arber-tx/ for offline synthesis of his gas-budget logic.
//
// Read-only. Usage: bun scripts/fetch-arber-history.ts [maxTx] [rpcUrl]
const ARBER = "0x175f25c26747f190873f5bb9c1b18f98d05f1304244c5712e5603d18dc718858";
// His own minified executor package — a tx that calls it is an ARB; anything else (e.g. his last 8
// wind-down transfers) is not.
const EXECUTOR_PKG = "0x93af8d29e93194a22f11901afec814f82987e830875ac4d231c81d3b6b316eab";
const RPC = process.argv[3] ?? "https://fullnode.mainnet.sui.io:443";
const MAX_TX = Number(process.argv[2] ?? 12000);
const OUT_DIR = "/root/sui/arber-tx";
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

type Row = {
  digest: string;
  ts: number;
  epoch: number;
  ok: boolean;
  err: string | null;
  gasPrice: number; // bid (MIST)
  gasBudget: number; // ceiling (MIST)
  comp: number; // computationCost (MIST)
  storage: number; // storageCost gross (MIST)
  rebate: number; // storageRebate (MIST)
  nonRef: number; // nonRefundableStorageFee (MIST)
  gross: number; // comp + storage (what the budget must cover)
  net: number; // comp + storage - rebate (out-of-pocket)
  budgetUtil: number; // gross / gasBudget (how close he sized to the ceiling)
  cmds: number; // # PTB commands
  moveCalls: number; // # MoveCall commands
  callsExecutor: boolean; // PTB calls his own executor package
  fns: string[]; // executor fn names invoked (his minified jk fns), in order
  suiDelta: number; // SUI balance change for ARBER (MIST)
};

mkdirSync(OUT_DIR, { recursive: true });
const JSONL = OUT_DIR + "/arber-txs.jsonl";
writeFileSync(JSONL, ""); // truncate

let cursor: string | null = null;
let n = 0;
let pages = 0;
const t0 = Date.now();
outer: while (n < MAX_TX) {
  const page = await rpc("suix_queryTransactionBlocks", [
    {
      filter: { FromAddress: ARBER },
      options: { showEffects: true, showInput: true, showBalanceChanges: true },
    },
    cursor,
    PAGE,
    true, // descending: newest first
  ]);
  pages++;
  const buf: string[] = [];
  for (const tx of page.data) {
    const eff = tx.effects;
    const g = eff.gasUsed;
    const comp = Number(g.computationCost);
    const storage = Number(g.storageCost);
    const rebate = Number(g.storageRebate);
    const nonRef = Number(g.nonRefundableStorageFee ?? 0);
    const gross = comp + storage;
    const net = comp + storage - rebate;
    const gd = tx.transaction?.data;
    const gasBudget = Number(gd?.gasData?.budget ?? 0);
    const gasPrice = Number(gd?.gasData?.price ?? 0);
    const txd = gd?.transaction;
    const cmdsArr: any[] = txd?.transactions ?? [];
    let moveCalls = 0;
    const fns: string[] = [];
    let callsExecutor = false;
    for (const c of cmdsArr) {
      if (c.MoveCall) {
        moveCalls++;
        const pkg = c.MoveCall.package ?? "";
        if (pkg === EXECUTOR_PKG) {
          callsExecutor = true;
          fns.push(c.MoveCall.function);
        }
      }
    }
    let suiDelta = 0;
    for (const bc of tx.balanceChanges ?? []) {
      if (
        bc.coinType === "0x2::sui::SUI" &&
        (bc.owner?.AddressOwner === ARBER || bc.owner === ARBER)
      ) {
        suiDelta += Number(bc.amount);
      }
    }
    const row: Row = {
      digest: tx.digest,
      ts: Number(tx.timestampMs ?? 0),
      epoch: Number(eff.executedEpoch ?? 0),
      ok: eff.status?.status === "success",
      err: eff.status?.status === "success" ? null : eff.status?.error ?? "failure",
      gasPrice,
      gasBudget,
      comp,
      storage,
      rebate,
      nonRef,
      gross,
      net,
      budgetUtil: gasBudget ? gross / gasBudget : 0,
      cmds: cmdsArr.length,
      moveCalls,
      callsExecutor,
      fns,
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
    console.log(`  ${n} txs / ${pages} pages / ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (!page.hasNextPage || !page.nextCursor) break;
  cursor = page.nextCursor;
}

console.log(`DONE: ${n} txs in ${pages} pages, ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${JSONL}`);
