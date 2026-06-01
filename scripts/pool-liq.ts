// Inspect Bluefin/CLMM pool: liquidity, current tick/sqrt_price, fee, coin types.
const RPC = "http://127.0.0.1:9000";
async function rpc(method: string, params: any[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
for (const id of process.argv.slice(2)) {
  const o = await rpc("sui_getObject", [id, { showContent: true, showType: true }]);
  const c = o.data?.content;
  const f = c?.fields ?? {};
  console.log(`\n=== ${id} ===`);
  console.log("type:", o.data?.type?.slice(0, 140));
  // common CLMM fields across cetus/bluefin
  const pick = (k: string) => (f[k] !== undefined ? (typeof f[k] === "object" ? JSON.stringify(f[k]).slice(0, 80) : f[k]) : undefined);
  for (const k of ["liquidity", "current_sqrt_price", "current_tick_index", "tick_spacing", "fee_rate", "is_pause", "coin_a", "coin_b", "reserve_x", "reserve_y", "sqrt_price", "tick_current_index", "fee", "swap_fee_rate"]) {
    const v = pick(k);
    if (v !== undefined) console.log(`  ${k}: ${v}`);
  }
}
