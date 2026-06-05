// Validate the native Ferra DLMM swap-math port against the on-chain `lb_pair::get_swap_out` view.
//
// For a given LBPair pool it:
//   1. reads the pool object (active_id, bin_step, PairParameters) + the bin packs around the active
//      bin (reserve_x/reserve_y/price per bin),
//   2. calls `get_swap_out(pool, amount_in, swap_for_y, clock)` via devInspect for several amounts in
//      both directions (the authoritative on-chain quote),
//   3. prints (a) a ready-to-paste Rust fixture (DlmmState + bins) and (b) the expected
//      (amount_in_left, amount_out, fee) tuples, plus a re-read version check to flag any mid-read drift.
//
// Usage: bun run scripts/validate-ferra.ts <poolId> [rpcUrl]
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";

const FERRA =
  "0x5a5c1d10e4782dbbdec3eb8327ede04bd078b294b97cfdba447b11b846b383ac";
const CLOCK = "0x6";
const GLOBAL_SENDER = "0x000000000000000000000000000000000000000000000000000000000000dead";

const poolId = process.argv[2] ??
  "0xec707780d108410b1b865cc2cf082305d9cb844876ab64b728f60cbd505ac35c"; // USDC/SUI
const rpc = process.argv[3] ?? process.env.RPC_URL ?? "https://fullnode.mainnet.sui.io:443";
const client = new SuiJsonRpcClient({ url: rpc, network: "mainnet" });

function fieldsOf(content: any): any {
  return content?.dataType === "moveObject" ? content.fields : undefined;
}

async function readPool() {
  const obj = await client.getObject({ id: poolId, options: { showContent: true, showType: true } });
  const content = obj.data?.content as any;
  const f = fieldsOf(content);
  if (!f) throw new Error("pool has no move content");
  const type = obj.data?.type as string;
  // type = <ferra>::lb_pair::LBPair<X, Y>
  const m = type.match(/LBPair<(.+),\s*(.+)>$/);
  if (!m) throw new Error(`cannot parse coin types from ${type}`);
  const coinX = m[1].trim();
  const coinY = m[2].trim();
  const params = f.parameters.fields;
  const binsTableId = f.bin_manager.fields.bins.fields.id.id;
  return {
    version: obj.data?.version,
    coinX,
    coinY,
    binStep: Number(f.bin_step),
    activeId: Number(params.active_id),
    params: {
      base_factor: Number(params.base_factor),
      filter_period: Number(params.filter_period),
      decay_period: Number(params.decay_period),
      reduction_factor: Number(params.reduction_factor),
      variable_fee_control: Number(params.variable_fee_control),
      max_volatility_accumulator: Number(params.max_volatility_accumulator),
      volatility_accumulator: Number(params.volatility_accumulator),
      volatility_reference: Number(params.volatility_reference),
      id_reference: Number(params.id_reference),
      time_of_last_update: String(params.time_of_last_update),
    },
    binsTableId,
  };
}

async function readClockSecs(): Promise<bigint> {
  const clk = await client.getObject({ id: CLOCK, options: { showContent: true } });
  const f = fieldsOf(clk.data?.content as any);
  return BigInt(f.timestamp_ms) / 1000n;
}

async function readBins(binsTableId: string, activeId: number) {
  // packs are keyed by (bin_id >> 3); scan ±16 packs around active, in parallel to shrink the
  // capture window (active pools move between sequential reads).
  const activePack = activeId >> 3;
  const packs: number[] = [];
  for (let pack = activePack - 16; pack <= activePack + 16; pack++) {
    if (pack >= 0) packs.push(pack);
  }
  const bins: { bin_id: number; reserve_x: string; reserve_y: string; price: string }[] = [];
  const results = await Promise.all(
    packs.map((pack) =>
      client
        .getDynamicFieldObject({ parentId: binsTableId, name: { type: "u32", value: pack } })
        .catch(() => null),
    ),
  );
  for (const field of results) {
    const f = fieldsOf(field?.data?.content as any);
    if (!f) continue;
    for (const b of f.value.fields.bin_data) {
      const bf = b.fields;
      bins.push({
        bin_id: Number(bf.bin_id),
        reserve_x: String(bf.reserve_x),
        reserve_y: String(bf.reserve_y),
        price: String(bf.price),
      });
    }
  }
  bins.sort((a, b) => a.bin_id - b.bin_id);
  return bins;
}

async function getSwapOut(
  coinX: string,
  coinY: string,
  amountIn: bigint,
  swapForY: boolean,
): Promise<{ inLeft: string; out: string; fee: string } | null> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${FERRA}::lb_pair::get_swap_out`,
    typeArguments: [coinX, coinY],
    arguments: [
      tx.object(poolId),
      tx.pure.u64(amountIn),
      tx.pure.bool(swapForY),
      tx.object(CLOCK),
    ],
  });
  const res = await client.devInspectTransactionBlock({
    sender: GLOBAL_SENDER,
    transactionBlock: tx,
  });
  if (res.error) {
    console.error(`  devInspect error (amt=${amountIn}, forY=${swapForY}): ${res.error}`);
    return null;
  }
  const rv = res.results?.[0]?.returnValues;
  if (!rv || rv.length < 3) return null;
  const dec = (v: [number[], string]) => bcs.U64.parse(Uint8Array.from(v[0])).toString();
  return { inLeft: dec(rv[0] as any), out: dec(rv[1] as any), fee: dec(rv[2] as any) };
}

async function main() {
  const pool = await readPool();
  const nowSecs = await readClockSecs();
  const bins = await readBins(pool.binsTableId, pool.activeId);
  console.log(`# Ferra LBPair ${poolId}`);
  console.log(`# now_secs=${nowSecs}`);
  console.log(`# coinX=${pool.coinX}`);
  console.log(`# coinY=${pool.coinY}`);
  console.log(
    `# active_id=${pool.activeId} bin_step=${pool.binStep} params=${JSON.stringify(pool.params)} bins=${bins.length}`,
  );

  // Choose probe amounts relative to the active bin's reserves.
  const active = bins.find((b) => b.bin_id === pool.activeId);
  const activeY = active ? BigInt(active.reserve_y) : 1_000_000n;
  const activeX = active ? BigInt(active.reserve_x) : 1_000_000n;
  const probesForY = [activeX / 10n + 1n, activeX / 2n + 1n, activeX * 3n + 7n].filter((x) => x > 0n);
  const probesForX = [activeY / 10n + 1n, activeY / 2n + 1n, activeY * 3n + 7n].filter((x) => x > 0n);

  // Run all probes in parallel to keep the whole capture window short (so the version stays stable).
  const [resForY, resForX] = await Promise.all([
    Promise.all(probesForY.map((amt) => getSwapOut(pool.coinX, pool.coinY, amt, true))),
    Promise.all(probesForX.map((amt) => getSwapOut(pool.coinX, pool.coinY, amt, false))),
  ]);
  console.log(`\n## get_swap_out (swap_for_y = true, sell X for Y)`);
  probesForY.forEach((amt, i) => {
    const r = resForY[i];
    console.log(`  in=${amt}  ->  in_left=${r?.inLeft} out=${r?.out} fee=${r?.fee}`);
  });
  console.log(`\n## get_swap_out (swap_for_y = false, sell Y for X)`);
  probesForX.forEach((amt, i) => {
    const r = resForX[i];
    console.log(`  in=${amt}  ->  in_left=${r?.inLeft} out=${r?.out} fee=${r?.fee}`);
  });

  // Re-read version to flag any mid-read drift (pool moved while we sampled).
  const after = await client.getObject({ id: poolId, options: { showContent: false } });
  console.log(
    `\n# version before=${pool.version} after=${after.data?.version}` +
      (pool.version === after.data?.version ? " (stable)" : " (DRIFTED — re-run)"),
  );

  // Rust fixture.
  console.log(`\n// ----- Rust fixture (paste into math::ferra tests) -----`);
  const p = pool.params;
  console.log(`let state = DlmmState {`);
  console.log(`    active_id: ${pool.activeId},`);
  console.log(`    bin_step: ${pool.binStep},`);
  console.log(`    now_secs: ${nowSecs},`);
  console.log(`    params: DlmmParams { base_factor: ${p.base_factor}, filter_period: ${p.filter_period}, decay_period: ${p.decay_period}, reduction_factor: ${p.reduction_factor}, variable_fee_control: ${p.variable_fee_control}, max_volatility_accumulator: ${p.max_volatility_accumulator}, volatility_accumulator: ${p.volatility_accumulator}, volatility_reference: ${p.volatility_reference}, id_reference: ${p.id_reference}, time_of_last_update: ${p.time_of_last_update} },`);
  console.log(`    bins: BTreeMap::from([`);
  for (const b of bins) {
    console.log(`        (${b.bin_id}u32, DlmmBin { reserve_x: ${b.reserve_x}, reserve_y: ${b.reserve_y}, price: ${b.price} }),`);
  }
  console.log(`    ]),`);
  console.log(`    window_lower: Some(0), window_upper: Some(u32::MAX),`);
  console.log(`};`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
