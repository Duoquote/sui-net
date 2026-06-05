// Fetch a wallet's full tx history from PUBLIC mainnet JSON-RPC into JSONL.
// Captures FULL balance changes (EVERY owner, not just this wallet) so we can trace where
// funds flow — the goal is to see if "losing" arbs actually sweep profit to another wallet.
// Read-only. Usage: bun scripts/fetch-wallet-history.ts <wallet> [maxTx] [direction] [rpcUrl]
//   direction: from | to | both   (default both: txs the wallet SENT and txs it RECEIVED in)
const WALLET = (process.argv[2] ?? "").toLowerCase();
if (!WALLET) throw new Error("usage: fetch-wallet-history.ts <wallet> [maxTx] [from|to|both] [rpcUrl]");
const MAX_TX = Number(process.argv[3] ?? 10000);
const DIRECTION = (process.argv[4] ?? "both") as "from" | "to" | "both";
const RPC = process.argv[5] ?? "https://fullnode.mainnet.sui.io:443";
const OUT_DIR = "/root/sui/wallet-tx";
const PAGE = 50;

import { mkdirSync, writeFileSync, appendFileSync } from "fs";

function norm(a: string): string {
  if (!a) return a;
  a = a.toLowerCase();
  return a.startsWith("0x") ? a : "0x" + a;
}
const W = norm(WALLET);

async function rpc(method: string, params: any[], tries = 8): Promise<any> {
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
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
}

type Call = { pkg: string; mod: string; fn: string; targs: string[] };
type BalDelta = { owner: string; coin: string; amount: string };
type Row = {
  digest: string;
  ts: number;
  epoch: number;
  sender: string;
  ok: boolean;
  err: string | null;
  dir: string; // "from" if wallet signed, "to" if only received
  gasPrice: number;
  gasBudget: number;
  comp: number;
  storage: number;
  rebate: number;
  gasNet: number; // out-of-pocket gas (comp + storage - rebate)
  cmds: number;
  calls: Call[]; // every MoveCall in order
  objIds: string[]; // every object-input id (pools/configs/clocks)
  bal: BalDelta[]; // EVERY balance change (all owners) — for flow tracing
  walletSui: number; // this wallet's net SUI delta
};

function ownerOf(o: any): string {
  if (!o) return "?";
  if (typeof o === "string") return o;
  return o.AddressOwner ?? o.ObjectOwner ?? (o.Shared ? "Shared" : "?") ?? "?";
}

function extractRow(tx: any, dir: string): Row {
  const eff = tx.effects;
  const g = eff.gasUsed ?? {};
  const comp = Number(g.computationCost ?? 0);
  const storage = Number(g.storageCost ?? 0);
  const rebate = Number(g.storageRebate ?? 0);
  const gd = tx.transaction?.data;
  const sender = norm(gd?.sender ?? "");
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
  const bal: BalDelta[] = [];
  let walletSui = 0;
  for (const bc of tx.balanceChanges ?? []) {
    const owner = norm(ownerOf(bc.owner));
    bal.push({ owner, coin: bc.coinType, amount: String(bc.amount) });
    if (owner === W && bc.coinType === "0x2::sui::SUI") walletSui += Number(bc.amount);
  }
  const isOk = eff.status?.status === "success";
  return {
    digest: tx.digest,
    ts: Number(tx.timestampMs ?? 0),
    epoch: Number(eff.executedEpoch ?? 0),
    sender,
    ok: isOk,
    err: isOk ? null : eff.status?.error ?? "failure",
    dir,
    gasPrice,
    gasBudget,
    comp,
    storage,
    rebate,
    gasNet: comp + storage - rebate,
    cmds: cmdsArr.length,
    calls,
    objIds,
    bal,
    walletSui,
  };
}

async function fetchDir(filterDir: "from" | "to", jsonl: string): Promise<number> {
  const filter = filterDir === "from" ? { FromAddress: W } : { ToAddress: W };
  let cursor: string | null = null;
  let n = 0;
  let pages = 0;
  let ok = 0;
  const t0 = Date.now();
  while (n < MAX_TX) {
    const page = await rpc("suix_queryTransactionBlocks", [
      { filter, options: { showEffects: true, showInput: true, showBalanceChanges: true } },
      cursor,
      PAGE,
      true,
    ]);
    pages++;
    const buf: string[] = [];
    for (const tx of page.data) {
      const row = extractRow(tx, filterDir);
      if (row.ok) ok++;
      buf.push(JSON.stringify(row));
      n++;
      if (n >= MAX_TX) break;
    }
    if (buf.length) appendFileSync(jsonl, buf.join("\n") + "\n");
    if (pages % 10 === 0)
      console.log(`  [${filterDir}] ${n} txs / ${ok} ok / ${pages} pages / ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (!page.hasNextPage || !page.nextCursor || n >= MAX_TX) break;
    cursor = page.nextCursor;
  }
  console.log(`DONE [${filterDir}] ${W}: ${n} txs (${ok} ok) in ${pages} pages, ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${jsonl}`);
  return n;
}

mkdirSync(OUT_DIR, { recursive: true });
const tag = W.slice(2, 10);
if (DIRECTION === "from" || DIRECTION === "both") {
  const f = `${OUT_DIR}/${tag}.from.jsonl`;
  writeFileSync(f, "");
  await fetchDir("from", f);
}
if (DIRECTION === "to" || DIRECTION === "both") {
  const f = `${OUT_DIR}/${tag}.to.jsonl`;
  writeFileSync(f, "");
  await fetchDir("to", f);
}
console.log("ALL DONE");
