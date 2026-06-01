// Dissect a single tx: commands, move calls, type args, inputs, balance changes.
const RPC = "http://127.0.0.1:9000";
const DIGEST = process.argv[2];
async function rpc(method: string, params: any[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}
const tx = await rpc("sui_getTransactionBlock", [DIGEST, { showInput: true, showEffects: true, showEvents: true, showBalanceChanges: true, showObjectChanges: true }]);
const data = tx.transaction.data;
const ptb = data.transaction;
console.log("=== status ===", JSON.stringify(tx.effects.status));
console.log("=== gasUsed ===", JSON.stringify(tx.effects.gasUsed));
console.log("=== sender ===", data.sender);
console.log("\n=== inputs ===");
(ptb.inputs ?? []).forEach((inp: any, i: number) => {
  let s = `[${i}] ${inp.type}`;
  if (inp.type === "pure") s += ` val=${JSON.stringify(inp.value)} (${inp.valueType})`;
  else if (inp.type === "object") s += ` ${inp.objectType ?? ""} id=${inp.objectId ?? inp.objectId} ver=${inp.version ?? ""}`;
  console.log(s);
});
console.log("\n=== commands ===");
(ptb.transactions ?? []).forEach((c: any, i: number) => {
  const kind = Object.keys(c)[0];
  let detail = "";
  if (kind === "MoveCall") {
    const m = c.MoveCall;
    detail = `${m.package.slice(0, 10)}…::${m.module}::${m.function}` + (m.type_arguments?.length ? `<${m.type_arguments.map((t: string) => t.split("::").pop()).join(",")}>` : "") + ` args=${JSON.stringify(m.arguments)}`;
  } else if (kind === "SplitCoins") detail = JSON.stringify(c.SplitCoins);
  else if (kind === "MergeCoins") detail = JSON.stringify(c.MergeCoins);
  else if (kind === "TransferObjects") detail = JSON.stringify(c.TransferObjects);
  else detail = JSON.stringify(c[kind]).slice(0, 120);
  console.log(`  #${i} ${kind}: ${detail}`);
});
console.log("\n=== balance changes ===");
for (const bc of tx.balanceChanges ?? []) console.log(`  ${bc.coinType.split("::").pop()}  ${bc.amount}  ${JSON.stringify(bc.owner).slice(0, 60)}`);
console.log("\n=== events (count) ===", (tx.events ?? []).length);
for (const e of tx.events ?? []) console.log("  ", e.type.split("::").slice(-2).join("::"));
