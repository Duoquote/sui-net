// Publishes the mev_exec executor package to mainnet (interface-stub deps → linkage via explicit
// `dependencies` list of RUNTIME package ids). DRY-RUN by default; pass --execute to broadcast.
// Key is read from /root/sui/.env (MEV_WALLET_PRIVKEY, suiprivkey bech32) and NEVER printed.
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { toBase64 } from '@mysten/sui/utils';
import { readFileSync } from 'node:fs';

// Default to the LOCAL node for dry-runs; the actual --execute runs with the node STOPPED (equivocation
// safety), so pass --public (or set RPC_URL) to broadcast through the public mainnet fullnode instead.
const RPC = process.env.RPC_URL
  ?? (process.argv.includes('--public') ? 'https://fullnode.mainnet.sui.io:443' : 'http://127.0.0.1:9000');
const MODULE = '/root/sui/mev-executor/build/mev_exec/bytecode_modules/m.mv';
const EXPECTED = '0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';

// FULL transitive dependency closure at RUNTIME ids. Derived from the current executor's proven
// on-chain linkage table (11 entries) + Turbos (whose own closure is just std+sui). The three
// 0xab5e63/0xdfaadf86/0x8569b7ef are transitive deps the DEX runtimes pull in (math/integer libs).
// Computed 2026-06-02 by BFS over the on-chain linkage tables (getPackageBytecode) of every runtime
// our executor references, deduped to ONE runtime per original at the HIGHEST version (so a shared lib
// referenced by two DEXes at different versions resolves to the newer, backward-compatible one).
const DEPS = [
  '0x0000000000000000000000000000000000000000000000000000000000000001', // MoveStdlib
  '0x0000000000000000000000000000000000000000000000000000000000000002', // Sui
  '0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3', // Cetus v14 (also covers Obric's Cetus v10 ref)
  '0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c', // Bluefin
  '0x35f3190a41b98da22c997c9266143523816d73a902123dde6f60fac2e0f656d7', // BlueMove (v11, re-pointed 2026-06-01)
  '0xcf60a40f45d46fc1e828871a647c1e25a0915dec860d2662eb10fdb382c3c1d1', // Momentum
  '0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66', // Kriya
  '0xde2c47eb0da8c74e4d0f6a220c41619681221b9c2590518095f0f0c2d3f3c772', // FlowX
  '0xa5a0c25c79e428eba04fb98b3fb2a34db45ab26d4c8faf0d7e39d66a63891e64', // Turbos (runtime)
  '0xab5e63352d0f05881bdfa1631cc0f7fc1669175a00d608828a924df481a9e4bd', // transitive (clmm/gauge lib v3)
  '0xdfaadf86be9af246900d1e3f3b996cf549e7948e662a9977bdd7646d8fa3a778', // integer-mate i32/i128 v7 (covers Obric's ref)
  '0x8569b7efebec65c73b9dc15c5ac2a9542870d286fa79a3feedffbaa94ed53002', // skip_list/integer-mate lib v5 (covers Obric's ref)
  // --- 2026-06-02: FullSail + Obric integration (new runtime closure) ---
  '0x497a144ba3d93ae44d9fd23d4ff4761c329d87a505136d2269c743b2297fa881', // FullSail RUNTIME (Cetus-fork; version gate)
  '0xb49be008cf304b1dae7e7ece661b5f1b0e15324bc1422ec8c73b10eb4a6dcb19', // FullSail price_provider
  '0x2d8a7d4c585f1c20758f9b2c500477e1be35e178e79efb6ddf9d14a0dceff211', // FullSail skip_list/option_u64/linked_table lib
  '0x6b904ae739b2baad330aae14991abcd3b7354d3dc3db72507ed8dabeeb7a36de', // FullSail full_math/i128/i32/math lib
  '0xfc5ce91b953f03c30e3e48ac1d2a7706d66697c25979aeb978f9fff3fbcde5b2', // FullSail gauge_cap
  '0xba717279ef24335555bd01559381d42063fc93b3e7d4aaeaeac9c439fae8bc8a', // Obric RUNTIME (v2 oracle PMM)
  '0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91', // Pyth RUNTIME (v2; state/price_info/price/pyth)
  '0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a', // Obric transitive lib
  // --- 2026-06-04: real Obric V2 (DODO PMM) moved inside via m::pa/pb. Closure = std+sui+Pyth (the Pyth
  // runtime 0x04e20ddf above is shared with the legacy Obric); only the Obric V2 runtime itself is new. ---
  '0xa0e3b011012b80af4957afa30e556486eb3da0a7d96eeb733cf16ccd3aec32e0', // Obric V2 RUNTIME (oracle_driven_pool + trader)
  // --- 2026-06-02: DipCoin + Scallop integration (new runtime closure; BFS over linkage tables) ---
  '0xdae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872', // DipCoin (CP AMM; v1 orig==runtime)
  '0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805', // Scallop core RUNTIME (v19; market/mint/redeem/reserve/version; version gate)
  '0x80ca577876dec91ae6d22090e56c39bc60dce9086ab0729930c6900bc4162b4c', // Scallop s_coin_converter (v1 orig==runtime)
  '0xad013d5fde39e15eabda32b3dbdafd67dac32b798ce63237c27a8f73339b9b6f', // Scallop math lib (u64/u128/fixed_point32_empower)
  '0x07caedbf4c4d64288771089889a8b3e8721e5522bb55d041b14a234bf5e4d242', // Scallop transitive lib
  '0x1318fdc90319ec9c24df1456d960a447521b0a658316155895014a6e39b5482f', // Scallop transitive lib
  '0xbf926dd6ecdd3bb5231659b739e20cf864dc12f13c5b4c8b939d00fa70350b3a', // Scallop transitive lib
  '0x779b5c547976899f5474f3a5bc0db36ddf4697ad7e5a901db0415c2281d28162', // Scallop transitive lib
  '0xca5a5a62f01c79a104bf4d31669e29daa387f325c241de4edbe30986a9bc8b0d', // Scallop transitive lib
  // 0x32243989… (Scallop core v8) DROPPED — stale runtime of the same lineage as 0xde5c09ad (v19);
  // one runtime per original, keep the newest (backward-compatible) v19.
  // --- 2026-06-02: Ferra DLMM integration (closure = std+sui only; verified via `deps` linkage table).
  // DeepBook V3 is routed DIRECTLY in the PTB (not fused into the executor) because adding DeepBook +
  // DEEP would push this closure past the on-chain max of 32 package dependencies. ---
  '0x01aca2702b2402f13eacdf9f3e49f5d1bdd3ec5cc7d11847cf8acbaef1cb6d5c', // Ferra LB DLMM v2 runtime (orig 0x5a5c1d10; v1 aborted config::checked_package_version 5004 — re-derived 2026-06-04)
];

const env = readFileSync('/root/sui/.env', 'utf8');
const km = env.match(/^MEV_WALLET_PRIVKEY=(\S+)/m);
if (!km) throw new Error('MEV_WALLET_PRIVKEY not found in /root/sui/.env');
const { secretKey } = decodeSuiPrivateKey(km[1].trim());
const kp = Ed25519Keypair.fromSecretKey(secretKey);
const sender = kp.getPublicKey().toSuiAddress();
if (sender !== EXPECTED) throw new Error(`Derived address mismatch: ${sender} != ${EXPECTED}`);
console.log('sender:', sender);

const modBytes = readFileSync(MODULE);
console.log('module:', MODULE.split('/').pop(), modBytes.length, 'bytes');

const tx = new Transaction();
const [cap] = tx.publish({ modules: [toBase64(modBytes)], dependencies: DEPS });
tx.transferObjects([cap], sender);
tx.setSender(sender);
tx.setGasBudget(200_000_000);

const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });
const bytes = await tx.build({ client });

const EXECUTE = process.argv.includes('--execute');
if (!EXECUTE) {
  const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  console.log('DRY-RUN status:', JSON.stringify(dry.effects.status));
  console.log('errorSource:', JSON.stringify((dry as any).executionErrorSource ?? (dry as any).effects?.status?.error ?? 'none'));
  const g = dry.effects.gasUsed;
  const net = (Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate)) / 1e9;
  console.log('gas net:', net, 'SUI');
  const pub: any = (dry.objectChanges || []).find((c: any) => c.type === 'published');
  console.log('would-be PACKAGE:', pub?.packageId ?? '(none)');
} else {
  const res = await client.signAndExecuteTransaction({
    signer: kp, transaction: bytes,
    options: { showEffects: true, showObjectChanges: true },
  });
  console.log('EXEC status:', JSON.stringify(res.effects?.status));
  const pub: any = (res.objectChanges || []).find((c: any) => c.type === 'published');
  console.log('PUBLISHED PACKAGE:', pub?.packageId ?? '(none)');
  console.log('digest:', res.digest);
}
