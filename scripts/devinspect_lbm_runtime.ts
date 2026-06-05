// Validate the LBM (Cetus DLMM, 0x5664f9d3 origin) runtime-package fix: the stale v1 origin
// version-gates at `versioned::check_version`; the live v9 runtime (0x0489a4b3) must clear it.
// We call `pool::flash_swap` WITHOUT repaying — a later "unused value" / hot-potato error proves we
// got PAST the version gate (the only thing under test). Usage: bun run scripts/devinspect_lbm_runtime.ts
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const V1_ORIGIN = "0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b";
const V9_RUNTIME = "0x0489a4b326c17428d9ae6f10023468109b097f10e705af30ccc27bbb18ead065";
const POOL = "0x0b1dd1d40746705ff45c565f4c8b6e0bfc667952f0c9443fe4231c1a430b288a"; // Pool<USDC,XAUM>
const CFG = "0xf31b605d117f959b9730e8c07b08b856cb05143c5e81d5751c90d2979e82f599";
const VERSIONED = "0x05370b2d656612dd5759cbe80463de301e3b94a921dfc72dd9daa2ecdeb2d0a8";
const CLOCK = "0x6";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const XAUM = "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM";
const SENDER = "0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257";

const client = new SuiJsonRpcClient({ url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" });

async function probe(pkg: string, label: string) {
  const tx = new Transaction();
  // flash_swap<USDC,XAUM>(&mut pool, a2b, by_amount_in=true, amount, &cfg, &versioned, &clk)
  tx.moveCall({
    target: `${pkg}::pool::flash_swap`,
    typeArguments: [USDC, XAUM],
    arguments: [
      tx.object(POOL),
      tx.pure.bool(true),
      tx.pure.bool(true),
      tx.pure.u64(1000),
      tx.object(CFG),
      tx.object(VERSIONED),
      tx.object(CLOCK),
    ],
  });
  const res = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  const err = res.error ?? res.results?.map((r: any) => r.status).find(Boolean) ?? "(no top-level error)";
  const gated = JSON.stringify(res).includes("check_version");
  console.log(`\n[${label}] pkg=${pkg.slice(0, 10)}`);
  console.log(`  version-gate hit (check_version): ${gated ? "YES (BAD)" : "no (PASSED gate)"}`);
  console.log(`  error: ${typeof err === "string" ? err : JSON.stringify(err)}`);
}

async function main() {
  await probe(V1_ORIGIN, "v1 origin (stale, expect check_version abort)");
  await probe(V9_RUNTIME, "v9 runtime (fix, expect PAST gate)");
}
main().catch((e) => { console.error(e); process.exit(1); });
