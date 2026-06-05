// Split the wallet's native-USDC coin into N smaller coins so the MEV submitter has a POOL of owned-coin
// inventory objects to round-robin for OWNED-COIN funding of SUI-free arbs (task #78) — enabling parallel
// owned fires instead of serializing on one coin (same idea as the gas-coin pool).
//
// Key is read from /root/sui/.env (MEV_WALLET_PRIVKEY, suiprivkey bech32) and NEVER printed.
// PRECONDITION: the MEV node MUST be stopped before running this (equivocation: the node signs the wallet's
// SUI gas coins, and this tx also spends one for gas → both signing the same version locks it).
//
// Dry-runs by default; pass --execute to actually split.
// Usage: bun scripts/split-usdc-inventory.ts [count=5] [perCoinUsdc=20] [--execute]
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { readFileSync } from "fs";

const EXPECTED_ADDR = "0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const args = process.argv.slice(2).filter((a) => a !== "--execute");
const EXECUTE = process.argv.includes("--execute");
const COUNT = Number(args[0] ?? 5);
const PER_COIN_RAW = BigInt(Math.round(Number(args[1] ?? 20) * 1e6)); // USDC is 6-dec
const RPC = "https://fullnode.mainnet.sui.io:443";

const env = readFileSync("/root/sui/.env", "utf8");
const km = env.match(/^MEV_WALLET_PRIVKEY=(\S+)/m);
if (!km) throw new Error("MEV_WALLET_PRIVKEY not found in /root/sui/.env");
const { secretKey } = decodeSuiPrivateKey(km[1].trim());
const kp = Ed25519Keypair.fromSecretKey(secretKey);
const sender = kp.getPublicKey().toSuiAddress();
if (sender !== EXPECTED_ADDR) throw new Error(`derived address ${sender} != expected ${EXPECTED_ADDR}`);
console.log(`signer address: ${sender}`);

const client = new SuiJsonRpcClient({ url: RPC, network: "mainnet" });

// Pick the native-USDC coin object large enough to source the whole split.
const need = PER_COIN_RAW * BigInt(COUNT);
const usdc = await client.getCoins({ owner: sender, coinType: USDC });
const total = usdc.data.reduce((a: bigint, c: any) => a + BigInt(c.balance), 0n);
console.log(`native USDC: ${usdc.data.length} coin(s), total ${(Number(total) / 1e6).toFixed(4)} USDC`);
const source = usdc.data
  .slice()
  .sort((a: any, b: any) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))
  .find((c: any) => BigInt(c.balance) >= need);
if (!source) throw new Error(`no single USDC coin holds >= ${need} raw (${Number(need) / 1e6} USDC)`);
console.log(
  `plan: split ${COUNT} coins of ${(Number(PER_COIN_RAW) / 1e6).toFixed(2)} USDC each from ${source.coinObjectId} ` +
    `(${(Number(source.balance) / 1e6).toFixed(4)} USDC); gas paid separately in SUI`,
);

const tx = new Transaction();
tx.setSender(sender);
tx.setGasBudget(20_000_000);
const amounts = Array.from({ length: COUNT }, () => tx.pure.u64(PER_COIN_RAW));
const newCoins = tx.splitCoins(tx.object(source.coinObjectId), amounts);
tx.transferObjects(
  Array.from({ length: COUNT }, (_, i) => newCoins[i]),
  sender,
);
const bytes = await tx.build({ client });

if (!EXECUTE) {
  const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  console.log(`DRY-RUN status: ${JSON.stringify(dry.effects.status)}`);
  const g = dry.effects.gasUsed;
  console.log(`gas net: ${(Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate)) / 1e9} SUI`);
  const created = (dry.objectChanges ?? []).filter((c: any) => c.type === "created");
  console.log(`would create ${created.length} objects. Re-run with --execute to perform the split.`);
} else {
  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: bytes,
    options: { showEffects: true, showObjectChanges: true },
  });
  console.log(`digest: ${res.digest}  status: ${JSON.stringify(res.effects?.status)}`);
  await client.waitForTransaction({ digest: res.digest });
  const created = (res.objectChanges ?? []).filter(
    (c: any) => c.type === "created" && c.objectType === `0x2::coin::Coin<${USDC}>`,
  );
  console.log(`\ncreated ${created.length} new USDC coins. Add ALL of these to inventory-coins:`);
  for (const c of created as any[]) console.log(`          - "${c.objectId}"`);
  const after = await client.getCoins({ owner: sender, coinType: USDC });
  console.log(`\nafter: ${after.data.length} USDC coin(s):`);
  for (const c of after.data)
    console.log(`  ${c.coinObjectId}  ${(Number(c.balance) / 1e6).toFixed(4)} USDC`);
}
