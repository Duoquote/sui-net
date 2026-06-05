// Publishes the mev_exec_fl DeepBook-flash executor to mainnet. DRY-RUN by default (against the public
// fullnode with --public, else the local node); pass --execute to broadcast. Key from /root/sui/.env
// (MEV_WALLET_PRIVKEY) — NEVER printed. Closure = std + sui + deepbook v6 + DEEP (4 deps; well under 32).
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { toBase64 } from '@mysten/sui/utils';
import { readFileSync } from 'node:fs';

const RPC = process.env.RPC_URL
  ?? (process.argv.includes('--public') ? 'https://fullnode.mainnet.sui.io:443' : 'http://127.0.0.1:9000');
const MODULE = '/root/sui/mev-executor-flash/build/mev_exec_fl/bytecode_modules/m.mv';
const EXPECTED = '0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';

const DEPS = [
  '0x0000000000000000000000000000000000000000000000000000000000000001', // MoveStdlib
  '0x0000000000000000000000000000000000000000000000000000000000000002', // Sui
  '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497', // DeepBook v6 RUNTIME (pool flash+swap)
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270', // DEEP coin
  // --- Aftermath AMM closure (computed via BFS over the v3 runtimes' linkage tables) ---
  '0xf948935b111990c2b604900c9b2eeb8f24dcf9868a45d1ea1653a5f282c10e29', // amm v3 (pool/pool_registry/swap)
  '0xaead64e3b3cc7972ba86396df07066c90176f42c6aea53b6df0d8ab11007ece2', // vault v2 (original 0x2d9316f1)
  '0x64213b0e4a52bac468d4ac3f140242f70714381653a1919a6d57cd49c628207a', // treasury
  '0xa6baab1e668c7868991c1c3c11e144100f5734c407d020f72a01b9d1a8bcb97f', // insurance_fund
  '0xc66fabf1a9253e43c70f1cc02d40a1d18db183140ecaae2a3f58fa6b66c55acf', // referral_vault
  '0x73baa782c55003b3a359dec04b189312565d18e7309d4a51f5f112f891e3b2ab', // aftermath transitive lib
  '0xbc7b2c577ad9362fbb0dba397d17f3bcc81bf7aa916559f99a77eaee05d0947c', // aftermath transitive lib
  // --- Magma (Cetus-fork CLMM) closure ---
  '0x0acd1d187950450ae3e625375f8067a7802e99a05b6e655e1fec124a0e3c891e', // magma v5 runtime (pool/config)
  '0x599866e9faedafd1c0a451baa4645a504fedc4db2bae88679d1a022221e8cbf6', // magma forked lib
  '0x682eaba7450909645bf949db3fc5881432a00b49b4c06d6974ecc4ee684e7992', // magma forked lib
  '0x6e8bb2f02e53ab1b456b467bb3e6bed7421663d6d098e884b187dab36319278d', // magma forked lib
  // --- 2026-06-04: LBM (Cetus-DLMM fork) closure. flash_swap threads GlobalConfig+Versioned. Runtime v9
  // re-derived from the Cetus aggregator linkage (v1 origin 0x5664f9d3 went stale at versioned check). Its
  // two lib deps are the SHARED integer-mate runtimes (0xdfaadf86 v7, 0x8569b7ef v5), not Magma's forks. ---
  '0x0489a4b326c17428d9ae6f10023468109b097f10e705af30ccc27bbb18ead065', // LBM v9 runtime (pool/config/versioned)
  '0xdfaadf86be9af246900d1e3f3b996cf549e7948e662a9977bdd7646d8fa3a778', // integer-mate i32/i128 v7 (LBM lib)
  '0x8569b7efebec65c73b9dc15c5ac2a9542870d286fa79a3feedffbaa94ed53002', // skip_list/integer-mate v5 (LBM lib)
  // --- 2026-06-04: PairAMM (Uniswap-V2 CP) moved inside via m::qa/qb. Closure = std+sui only → +1 dep. ---
  '0xbfac5e1c6bf6ef29b12f7723857695fd2f4da9a11a7d88162c15e9124c243a4a', // PairAMM v1 runtime (pair/router/factory)
  // --- 2026-06-04: STEAMM (bToken AMM over Suilend banks) moved inside via m::ta/tb (mint->swap->burn).
  // FULL transitive closure from STEAMM core's linkage_table (Suilend drags Pyth + SuiSystem + math libs):
  // +7 deps → overflow closure 26. ---
  '0x0000000000000000000000000000000000000000000000000000000000000003', // SuiSystem (Suilend staking ref)
  '0x4fb1cf45dffd6230305f1d269dd1816678cc8e3ba0b747a813a556921219f261', // STEAMM core (bank/cpmm/pool)
  '0xd2a67633ccb8de063163e25bcfca242929caf5cf1a26c2929dab519ee0b8f331', // Suilend v11 runtime (lending_market/reserve/decimal)
  '0x04e20ddf36af412a4096f9014f4a565af9e812db9a05cc40254846cf6ed0ad91', // Pyth v2 runtime (Suilend oracle prices)
  '0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a', // Suilend transitive lib v1
  '0x82e6f4f75441eae97d2d5850f41a09d28c7b64a05b067d37748d471f43aaf3f7', // Suilend transitive lib v4
  '0xb87cea7e4220461e35dff856185814d6a37ef479ce895ffbe4efa1d1af5aacbc', // Suilend transitive lib v1
];

const env = readFileSync('/root/sui/.env', 'utf8');
const km = env.match(/^MEV_WALLET_PRIVKEY=(\S+)/m);
if (!km) throw new Error('MEV_WALLET_PRIVKEY not found in /root/sui/.env');
const { secretKey } = decodeSuiPrivateKey(km[1].trim());
const kp = Ed25519Keypair.fromSecretKey(secretKey);
const sender = kp.getPublicKey().toSuiAddress();
if (sender !== EXPECTED) throw new Error(`Derived address mismatch: ${sender} != ${EXPECTED}`);
console.log('sender:', sender, '| RPC:', RPC);

const modBytes = readFileSync(MODULE);
console.log('module:', MODULE.split('/').pop(), modBytes.length, 'bytes', '| deps:', DEPS.length);

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
