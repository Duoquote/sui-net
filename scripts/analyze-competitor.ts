// Offline analysis of a competitor's fetched tx history (from fetch-competitor-history.ts).
// Answers: how many opportunities, how often, what DEXes/coins/pools, what route shapes — and which of
// their venues we DON'T model. Pure offline. Usage: bun scripts/analyze-competitor.ts <jsonl> [label]
import { readFileSync } from "fs";

const FILE = process.argv[2];
if (!FILE) throw new Error("usage: analyze-competitor.ts <jsonl> [label]");
const LABEL = process.argv[3] ?? FILE.split("/").pop();

// DEX runtime/defining package ids WE MODEL (from publish-executor DEPS + ptb/mod.rs). Anything they call
// that is NOT here is a candidate coverage gap (resolved on-chain in resolve-packages.ts).
const KNOWN: Record<string, string> = {
  "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3": "Cetus(v14rt)",
  "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f": "Cetus(orig)",
  "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c": "Bluefin(rt)",
  "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352": "Bluefin(orig)",
  "0xcf60a40f45d46fc1e828871a647c1e25a0915dec860d2662eb10fdb382c3c1d1": "Momentum(rt)",
  "0x2375a0b1ec12010aaea3b2545acfa2ad34cfbba03ce4b59f4c39e1e25eed1b2a": "Momentum(orig)",
  "0xde2c47eb0da8c74e4d0f6a220c41619681221b9c2590518095f0f0c2d3f3c772": "FlowX(rt)",
  "0x27565d24a4cd51127ac90e4074a841bbe356cca7bf5759ddc14a975be1632abc": "FlowX(clmm)",
  "0x67624a1533b5aff5d0dfcf5e598684350efd38134d2d245f475524c03a64e656": "FlowX(amm)",
  "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66": "Kriya(rt)",
  "0xa5a0c25c79e428eba04fb98b3fb2a34db45ab26d4c8faf0d7e39d66a63891e64": "Turbos(rt)",
  "0x35f3190a41b98da22c997c9266143523816d73a902123dde6f60fac2e0f656d7": "BlueMove(rt)",
  "0x497a144ba3d93ae44d9fd23d4ff4761c329d87a505136d2269c743b2297fa881": "FullSail(rt)",
  "0xba717279ef24335555bd01559381d42063fc93b3e7d4aaeaeac9c439fae8bc8a": "Obric(rt)",
  "0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91": "Pyth(rt)",
  "0xdae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872": "DipCoin(rt)",
  "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805": "Scallop(core)",
  "0x80ca577876dec91ae6d22090e56c39bc60dce9086ab0729930c6900bc4162b4c": "Scallop(scoin)",
  // common infra (not DEXes)
  "0x0000000000000000000000000000000000000000000000000000000000000001": "MoveStdlib",
  "0x0000000000000000000000000000000000000000000000000000000000000002": "Sui",
  "0x0000000000000000000000000000000000000000000000000000000000000003": "SuiSystem",
  "0xdee9": "DeepBookV2",
  "0x000000000000000000000000000000000000000000000000000000000000dee9": "DeepBookV2",
};
// singleton object ids to exclude from "distinct pools" (clock, known configs)
const NON_POOL = new Set<string>([
  "0x0000000000000000000000000000000000000000000000000000000000000006", // clock
]);

type Row = {
  digest: string; ts: number; epoch: number; ok: boolean; err: string | null;
  gasPrice: number; gasBudget: number; comp: number; storage: number; rebate: number; net: number;
  cmds: number; moveCalls: number;
  calls: { pkg: string; mod: string; fn: string; targs: string[] }[];
  objIds: string[]; coins: Record<string, number>; suiDelta: number;
};

const lines = readFileSync(FILE, "utf8").split("\n").filter(Boolean);
const rows: Row[] = lines.map((l) => JSON.parse(l));

const n = rows.length;
const okRows = rows.filter((r) => r.ok);
const ok = okRows.length;
const tsMin = Math.min(...rows.map((r) => r.ts).filter((t) => t > 0));
const tsMax = Math.max(...rows.map((r) => r.ts));
const spanH = (tsMax - tsMin) / 3.6e6;

function inc(m: Map<string, number>, k: string, by = 1) { m.set(k, (m.get(k) ?? 0) + by); }
function top(m: Map<string, number>, k = 30): [string, number][] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
}

// --- package / DEX usage (count distinct txs that touch each package) ---
const pkgTx = new Map<string, number>();      // pkg -> # txs touching it
const pkgModFn = new Map<string, number>();   // pkg::mod::fn -> # calls
const modByPkg = new Map<string, Set<string>>();
for (const r of rows) {
  const seen = new Set<string>();
  for (const c of r.calls) {
    inc(pkgModFn, `${(KNOWN[c.pkg] ?? c.pkg.slice(0, 10))}::${c.mod}::${c.fn}`);
    if (!modByPkg.has(c.pkg)) modByPkg.set(c.pkg, new Set());
    modByPkg.get(c.pkg)!.add(c.mod);
    if (!seen.has(c.pkg)) { seen.add(c.pkg); inc(pkgTx, c.pkg); }
  }
}

// --- coin universe (distinct txs that move each coin) ---
const coinTx = new Map<string, number>();
for (const r of rows) for (const ct of Object.keys(r.coins)) inc(coinTx, ct);

// --- distinct pools (object inputs minus singletons/known configs) ---
const poolSet = new Set<string>();
const poolTx = new Map<string, number>();
for (const r of rows) {
  for (const id of r.objIds) {
    if (NON_POOL.has(id)) continue;
    poolSet.add(id);
    inc(poolTx, id);
  }
}

// --- route shape ---
const mcHist = new Map<string, number>();
const cmdHist = new Map<string, number>();
for (const r of rows) { inc(mcHist, String(r.moveCalls)); inc(cmdHist, String(r.cmds)); }

// --- profit (net SUI to wallet incl gas) ---
const suiDeltas = okRows.map((r) => r.suiDelta).sort((a, b) => a - b);
const sumSui = rows.reduce((s, r) => s + r.suiDelta, 0);
const sumSuiOk = okRows.reduce((s, r) => s + r.suiDelta, 0);
const med = suiDeltas.length ? suiDeltas[Math.floor(suiDeltas.length / 2)] : 0;
const posOk = okRows.filter((r) => r.suiDelta > 0).length;

// classify a pkg
const lbl = (p: string) => KNOWN[p] ?? "??" + p.slice(0, 10);
const unknownPkgs = top(pkgTx, 100).filter(([p]) => !(p in KNOWN));

console.log(`\n========== ${LABEL} ==========`);
console.log(`txs=${n}  ok=${ok} (${(100 * ok / n).toFixed(1)}%)  span=${spanH.toFixed(1)}h`);
console.log(`cadence: ${(n / spanH).toFixed(0)} tx/h total, ${(ok / spanH).toFixed(0)} ok/h`);
console.log(`net SUI (all): ${(sumSui / 1e9).toFixed(3)}   net SUI (ok only): ${(sumSuiOk / 1e9).toFixed(3)}`);
console.log(`median ok suiDelta: ${(med / 1e9).toFixed(6)} SUI   ok-txs with +SUI: ${posOk}/${ok}`);
console.log(`distinct pools(obj inputs): ${poolSet.size}   distinct coins: ${coinTx.size}`);

console.log(`\n--- top packages by #txs (★=we model, ?=gap) ---`);
for (const [p, c] of top(pkgTx, 25)) {
  const mods = [...(modByPkg.get(p) ?? [])].slice(0, 5).join(",");
  console.log(`  ${(p in KNOWN ? "★" : "?")} ${String(c).padStart(6)}  ${lbl(p).padEnd(16)} [${mods}]  ${p}`);
}

console.log(`\n--- top coins by #txs touched ---`);
for (const [ct, c] of top(coinTx, 25)) {
  const short = ct.length > 40 ? ct.slice(0, 12) + "…" + ct.split("::").slice(-1)[0] : ct;
  console.log(`  ${String(c).padStart(6)}  ${short}`);
}

console.log(`\n--- route shape: moveCalls/tx (top) ---`);
for (const [k, c] of top(mcHist, 12)) console.log(`  ${k.padStart(3)} calls: ${c}`);
console.log(`--- cmds/tx (top) ---`);
for (const [k, c] of top(cmdHist, 12)) console.log(`  ${k.padStart(3)} cmds: ${c}`);

console.log(`\n--- top err reasons (failed txs) ---`);
const errs = new Map<string, number>();
for (const r of rows) if (!r.ok && r.err) inc(errs, r.err.length > 70 ? r.err.slice(0, 70) : r.err);
for (const [e, c] of top(errs, 8)) console.log(`  ${String(c).padStart(6)}  ${e}`);

// dump distinct unknown packages (potential coverage gaps) for on-chain resolution
console.log(`\n--- UNKNOWN packages (potential coverage gaps), pkg<TAB>#txs<TAB>mods ---`);
for (const [p, c] of unknownPkgs.slice(0, 40)) {
  console.log(`GAP\t${p}\t${c}\t${[...(modByPkg.get(p) ?? [])].join(",")}`);
}
