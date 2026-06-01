// Publishes the mev_exec executor package to mainnet (interface-stub deps → linkage via explicit
// `dependencies` list of RUNTIME package ids). DRY-RUN by default; pass --execute to broadcast.
// Key is read from /root/sui/.env (MEV_WALLET_PRIVKEY, suiprivkey bech32) and NEVER printed.
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { toBase64 } from '@mysten/sui/utils';
import { readFileSync } from 'node:fs';

const RPC = 'http://127.0.0.1:9000';
const MODULE = '/root/sui/mev-executor/build/mev_exec/bytecode_modules/m.mv';
const EXPECTED = '0x6ff8394771d9ca2f0ebd795900cc4d5f1f421eea979f3f178a2e159a39dcd781';

// FULL transitive dependency closure at RUNTIME ids. Derived from the current executor's proven
// on-chain linkage table (11 entries) + Turbos (whose own closure is just std+sui). The three
// 0xab5e63/0xdfaadf86/0x8569b7ef are transitive deps the DEX runtimes pull in (math/integer libs).
const DEPS = [
  '0x0000000000000000000000000000000000000000000000000000000000000001', // MoveStdlib
  '0x0000000000000000000000000000000000000000000000000000000000000002', // Sui
  '0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3', // Cetus
  '0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c', // Bluefin
  '0x35f3190a41b98da22c997c9266143523816d73a902123dde6f60fac2e0f656d7', // BlueMove (v11, re-pointed 2026-06-01)
  '0xcf60a40f45d46fc1e828871a647c1e25a0915dec860d2662eb10fdb382c3c1d1', // Momentum
  '0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66', // Kriya
  '0xde2c47eb0da8c74e4d0f6a220c41619681221b9c2590518095f0f0c2d3f3c772', // FlowX
  '0xa5a0c25c79e428eba04fb98b3fb2a34db45ab26d4c8faf0d7e39d66a63891e64', // Turbos (runtime)
  '0xab5e63352d0f05881bdfa1631cc0f7fc1669175a00d608828a924df481a9e4bd', // transitive (DEX math lib)
  '0xdfaadf86be9af246900d1e3f3b996cf549e7948e662a9977bdd7646d8fa3a778', // transitive (DEX math lib)
  '0x8569b7efebec65c73b9dc15c5ac2a9542870d286fa79a3feedffbaa94ed53002', // transitive (DEX math lib)
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
