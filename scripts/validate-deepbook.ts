// Validate the native DeepBook V3 CLOB swap-math port against the on-chain
// `pool::get_quantity_out` / `get_quantity_out_input_fee` views.
//
// For a given DeepBook V3 pool it:
//   1. reads the pool object → its `PoolInner` dynamic-field child (book params, governance taker_fee
//      / whitelisted, deep_price history) + flattens both order trees (bids/asks BigVectors) by
//      walking the slice leaves in ascending order_id order,
//   2. calls `pool::get_quantity_out<Base,Quote>(pool, base, quote, clock)` AND
//      `get_quantity_out_input_fee` via devInspect for several sizes in BOTH directions (the
//      authoritative on-chain quotes),
//   3. prints (a) a ready-to-paste Rust fixture (DeepBookState + bids/asks BookLevels) and (b) the
//      expected (base_out, quote_out, deep_required) tuples, plus a re-read version check to flag any
//      mid-read drift.
//
// Usage: bun run scripts/validate-deepbook.ts <poolId> [rpcUrl]
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { deriveDynamicFieldID } from "@mysten/sui/utils";

// DeepBook V3 API package (the executing/runtime package the moveCall targets).
const DEEPBOOK_API =
  "0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497";
const CLOCK = "0x6";
const GLOBAL_SENDER =
  "0x000000000000000000000000000000000000000000000000000000000000dead";

// Default: SUI/USDC (not whitelisted, taker_fee=200000). A whitelisted pool (taker_fee=0, no DEEP
// fee) is e.g. DEEP/SUI 0xb663828d6217467c8a1838a03793da896cbe745b150ebd57d82f814ca579fc22.
const poolId =
  process.argv[2] ??
  "0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407";
const rpc =
  process.argv[3] ?? process.env.RPC_URL ?? "https://fullnode.mainnet.sui.io:443";
const client = new SuiJsonRpcClient({ url: rpc, network: "mainnet" });

function fieldsOf(content: any): any {
  return content?.dataType === "moveObject" ? content.fields : undefined;
}

// price = ((order_id >> 64) as u64) & 0x7FFF_FFFF_FFFF_FFFF (utils::decode_order_id).
function decodePrice(orderId: bigint): bigint {
  return (orderId >> 64n) & 0x7fffffffffffffffn;
}

async function readPool() {
  const obj = await client.getObject({
    id: poolId,
    options: { showContent: true, showType: true },
  });
  const content = obj.data?.content as any;
  const f = fieldsOf(content);
  if (!f) throw new Error("pool has no move content");
  const type = obj.data?.type as string;
  // type = <pkg>::pool::Pool<Base, Quote>
  const m = type.match(/pool::Pool<(.+),\s*(.+)>$/);
  if (!m) throw new Error(`cannot parse coin types from ${type}`);
  const base = m[1].trim();
  const quote = m[2].trim();
  const innerId = f.inner.fields.id.id as string;
  const innerVersion = BigInt(f.inner.fields.version);
  return { version: obj.data?.version, base, quote, innerId, innerVersion };
}

// Derive + read the PoolInner dynamic-field child (key = inner.version : u64).
async function readPoolInner(innerId: string, innerVersion: bigint) {
  const keyBytes = bcs.u64().serialize(innerVersion).toBytes();
  const childId = deriveDynamicFieldID(innerId, "u64", keyBytes);
  const child = await client.getObject({
    id: childId,
    options: { showContent: true },
  });
  const inner = fieldsOf(child.data?.content as any)?.value?.fields;
  if (!inner) throw new Error(`PoolInner child ${childId} unreadable`);
  const book = inner.book.fields;
  const gov = inner.state.fields.governance.fields;
  const dp = inner.deep_price.fields;
  const lastTs = (arr: any[]): bigint =>
    arr.length ? BigInt(arr[arr.length - 1].fields.timestamp) : 0n;
  return {
    tickSize: BigInt(book.tick_size),
    lotSize: BigInt(book.lot_size),
    minSize: BigInt(book.min_size),
    takerFee: BigInt(gov.trade_params.fields.taker_fee),
    whitelisted: Boolean(gov.whitelisted),
    bidsBv: book.bids.fields,
    asksBv: book.asks.fields,
    deep: {
      base_prices_len: dp.base_prices.length,
      cumulative_base: BigInt(dp.cumulative_base),
      base_last_ts: lastTs(dp.base_prices),
      quote_prices_len: dp.quote_prices.length,
      cumulative_quote: BigInt(dp.cumulative_quote),
      quote_last_ts: lastTs(dp.quote_prices),
    },
  };
}

type Level = {
  price: bigint;
  quantity: bigint;
  filled_quantity: bigint;
  expire_timestamp: bigint;
};

// Walk a BigVector: descend vals[0] `depth` times to the MIN leaf, then chase `next` across leaves,
// flattening every order into a Level (ascending order_id).
async function collectOrders(bv: any): Promise<Level[]> {
  const parent = bv.id.id as string;
  const depth = Number(bv.depth);
  let sid = BigInt(bv.root_id);
  if (sid === 0n) return [];

  const readSlice = async (slice_id: bigint): Promise<any | null> => {
    const keyBytes = bcs.u64().serialize(slice_id).toBytes();
    const childId = deriveDynamicFieldID(parent, "u64", keyBytes);
    const obj = await client
      .getObject({ id: childId, options: { showContent: true } })
      .catch(() => null);
    return fieldsOf(obj?.data?.content as any)?.value?.fields ?? null;
  };

  // Descend to min leaf.
  for (let i = 0; i < depth; i++) {
    const s = await readSlice(sid);
    if (!s || !s.vals.length) return [];
    sid = BigInt(s.vals[0]);
  }

  const out: Level[] = [];
  let leaves = 0;
  while (sid !== 0n && leaves < 4096) {
    const s = await readSlice(sid);
    if (!s) break;
    for (const v of s.vals) {
      const o = v.fields;
      out.push({
        price: decodePrice(BigInt(o.order_id)),
        quantity: BigInt(o.quantity),
        filled_quantity: BigInt(o.filled_quantity),
        expire_timestamp: BigInt(o.expire_timestamp),
      });
    }
    sid = BigInt(s.next);
    leaves++;
  }
  return out;
}

async function readClockMs(): Promise<bigint> {
  const clk = await client.getObject({
    id: CLOCK,
    options: { showContent: true },
  });
  const f = fieldsOf(clk.data?.content as any);
  return BigInt(f.timestamp_ms);
}

async function view(
  fn: "get_quantity_out" | "get_quantity_out_input_fee",
  base: string,
  quote: string,
  baseQty: bigint,
  quoteQty: bigint,
): Promise<{ a: string; b: string; deep: string } | null> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${DEEPBOOK_API}::pool::${fn}`,
    typeArguments: [base, quote],
    arguments: [
      tx.object(poolId),
      tx.pure.u64(baseQty),
      tx.pure.u64(quoteQty),
      tx.object(CLOCK),
    ],
  });
  const res = await client.devInspectTransactionBlock({
    sender: GLOBAL_SENDER,
    transactionBlock: tx,
  });
  if (res.error) {
    console.error(`  devInspect error (${fn} b=${baseQty} q=${quoteQty}): ${res.error}`);
    return null;
  }
  const rv = res.results?.[0]?.returnValues;
  if (!rv || rv.length < 3) return null;
  const dec = (v: [number[], string]) =>
    bcs.U64.parse(Uint8Array.from(v[0])).toString();
  return { a: dec(rv[0] as any), b: dec(rv[1] as any), deep: dec(rv[2] as any) };
}

async function captureStable(maxAttempts = 12) {
  // Retry until the pool object version is unchanged across the WHOLE capture (pool read → inner read
  // → both order-tree walks → devInspect views). Active pools (e.g. SUI/USDC) move every checkpoint,
  // so a stable capture may take several attempts; calmer pools (whitelisted DEEP/SUI) settle fast.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pool = await readPool();
    const inner = await readPoolInner(pool.innerId, pool.innerVersion);
    const nowMs = await readClockMs();
    const [bids, asks] = await Promise.all([
      collectOrders(inner.bidsBv),
      collectOrders(inner.asksBv),
    ]);

    const probes = buildProbes(inner);
    const [buyGq, buyIf, sellGq, sellIf] = await Promise.all([
      Promise.all(probes.quoteProbes.map((q) => view("get_quantity_out", pool.base, pool.quote, 0n, q))),
      Promise.all(probes.quoteProbes.map((q) => view("get_quantity_out_input_fee", pool.base, pool.quote, 0n, q))),
      Promise.all(probes.baseProbes.map((b) => view("get_quantity_out", pool.base, pool.quote, b, 0n))),
      Promise.all(probes.baseProbes.map((b) => view("get_quantity_out_input_fee", pool.base, pool.quote, b, 0n))),
    ]);

    const after = await client.getObject({ id: poolId, options: { showContent: false } });
    const stable = pool.version === after.data?.version;
    if (stable || attempt === maxAttempts) {
      return { pool, inner, nowMs, bids, asks, probes, buyGq, buyIf, sellGq, sellIf, stable, afterVersion: after.data?.version };
    }
    console.error(`# attempt ${attempt}: version drifted ${pool.version} -> ${after.data?.version}, retrying...`);
  }
  throw new Error("unreachable");
}

function buildProbes(inner: Awaited<ReturnType<typeof readPoolInner>>) {
  // Built without the order book so probe sizes are deterministic from scalars (so the same sizes are
  // used across retries). Sizes are scaled to min_size and a fixed multiple thereof.
  const m = inner.minSize;
  const quoteProbes = [m, m * 50n, m * 5000n].filter((x) => x > 0n);
  const baseProbes = [m, m * 50n, m * 5000n].filter((x) => x > 0n);
  return { quoteProbes, baseProbes };
}

async function main() {
  const cap = await captureStable();
  const { pool, inner, nowMs, bids, asks } = cap;

  console.log(`# DeepBook V3 pool ${poolId}`);
  console.log(`# base=${pool.base}`);
  console.log(`# quote=${pool.quote}`);
  console.log(
    `# tick_size=${inner.tickSize} lot_size=${inner.lotSize} min_size=${inner.minSize} ` +
      `taker_fee=${inner.takerFee} whitelisted=${inner.whitelisted} now_ms=${nowMs}`,
  );
  console.log(
    `# bids=${bids.length} asks=${asks.length} deep=${JSON.stringify(
      inner.deep,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    )}`,
  );

  const { quoteProbes, baseProbes } = cap.probes;
  const { buyGq, buyIf, sellGq, sellIf } = cap;

  console.log(`\n## BUY base (quote_in > 0) — get_quantity_out  [base_out, quote_left, deep_req]`);
  quoteProbes.forEach((q, i) => {
    const r = buyGq[i];
    console.log(`  quote_in=${q}  ->  base_out=${r?.a} quote_left=${r?.b} deep=${r?.deep}`);
  });
  console.log(`\n## BUY base (quote_in > 0) — get_quantity_out_input_fee  [base_out, quote_left, 0]`);
  quoteProbes.forEach((q, i) => {
    const r = buyIf[i];
    console.log(`  quote_in=${q}  ->  base_out=${r?.a} quote_left=${r?.b} deep=${r?.deep}`);
  });
  console.log(`\n## SELL base (base_in > 0) — get_quantity_out  [base_left, quote_out, deep_req]`);
  baseProbes.forEach((b, i) => {
    const r = sellGq[i];
    console.log(`  base_in=${b}  ->  base_left=${r?.a} quote_out=${r?.b} deep=${r?.deep}`);
  });
  console.log(`\n## SELL base (base_in > 0) — get_quantity_out_input_fee  [base_left, quote_out, 0]`);
  baseProbes.forEach((b, i) => {
    const r = sellIf[i];
    console.log(`  base_in=${b}  ->  base_left=${r?.a} quote_out=${r?.b} deep=${r?.deep}`);
  });

  console.log(
    `\n# version before=${pool.version} after=${cap.afterVersion}` +
      (cap.stable ? " (stable)" : " (DRIFTED — re-run for a byte-exact fixture)"),
  );

  // ----- Rust fixture -----
  const d = inner.deep;
  console.log(`\n// ----- Rust fixture (paste into math::deepbook tests) -----`);
  console.log(`let state = DeepBookState {`);
  console.log(`    tick_size: ${inner.tickSize},`);
  console.log(`    lot_size: ${inner.lotSize},`);
  console.log(`    min_size: ${inner.minSize},`);
  console.log(`    taker_fee: ${inner.takerFee},`);
  console.log(`    whitelisted: ${inner.whitelisted},`);
  console.log(
    `    deep: DeepPriceState { base_prices_len: ${d.base_prices_len}, cumulative_base: ${d.cumulative_base}, base_last_ts: ${d.base_last_ts}, quote_prices_len: ${d.quote_prices_len}, cumulative_quote: ${d.cumulative_quote}, quote_last_ts: ${d.quote_last_ts} },`,
  );
  const fmtLevels = (levels: Level[]) =>
    levels
      .map(
        (l) =>
          `        BookLevel { price: ${l.price}, quantity: ${l.quantity}, filled_quantity: ${l.filled_quantity}, expire_timestamp: ${l.expire_timestamp} },`,
      )
      .join("\n");
  console.log(`    bids: vec![\n${fmtLevels(bids)}\n    ],`);
  console.log(`    asks: vec![\n${fmtLevels(asks)}\n    ],`);
  console.log(`    now_ms: ${nowMs},`);
  console.log(`    materialized: true,`);
  console.log(`};`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
