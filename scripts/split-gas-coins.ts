// Split the wallet's single SUI gas coin into N smaller coins so the MEV submitter has a POOL of gas
// coins to round-robin — enabling concurrent (parallel) submissions instead of serializing on one coin.
//
// Key is read from /root/sui/.env (MEV_WALLET_PRIVKEY, suiprivkey bech32) and NEVER printed.
// PRECONDITION: the MEV node MUST be stopped before running this, or it could equivocate the gas coin
// (both the node and this tx signing the same object version → the validators lock it until epoch end).
//
// Dry-runs by default; pass --execute to actually split.
// Usage: bun scripts/split-gas-coins.ts [count=10] [perCoinSui=0.5] [--execute]
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { readFileSync } from "fs";

const EXPECTED_ADDR = "0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257";
const args = process.argv.slice(2).filter((a) => a !== "--execute");
const EXECUTE = process.argv.includes("--execute");
const COUNT = Number(args[0] ?? 10);
const PER_COIN_MIST = BigInt(Math.round(Number(args[1] ?? 0.5) * 1e9));
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

const before = await client.getCoins({ owner: sender, coinType: "0x2::sui::SUI" });
const total = before.data.reduce((a: bigint, c: any) => a + BigInt(c.balance), 0n);
console.log(`before: ${before.data.length} SUI coin(s), total ${(Number(total) / 1e9).toFixed(4)} SUI`);
const needed = PER_COIN_MIST * BigInt(COUNT);
if (total < needed + 100_000_000n) throw new Error(`insufficient balance for ${COUNT}x${PER_COIN_MIST} + gas`);
console.log(`plan: split ${COUNT} coins of ${(Number(PER_COIN_MIST) / 1e9).toFixed(3)} SUI each from the gas coin`);

const tx = new Transaction();
tx.setSender(sender);
tx.setGasBudget(20_000_000);
const amounts = Array.from({ length: COUNT }, () => tx.pure.u64(PER_COIN_MIST));
const newCoins = tx.splitCoins(tx.gas, amounts);
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
    (c: any) => c.type === "created" && c.objectType === "0x2::coin::Coin<0x2::sui::SUI>",
  );
  console.log(`\ncreated ${created.length} new SUI coins. Add ALL of these to gas-coin-ids:`);
  for (const c of created as any[]) console.log(`      - "${c.objectId}"`);
  const after = await client.getCoins({ owner: sender, coinType: "0x2::sui::SUI" });
  console.log(`\nafter: ${after.data.length} SUI coin(s):`);
  for (const c of after.data)
    console.log(`  ${c.coinObjectId}  ${(Number(c.balance) / 1e9).toFixed(4)} SUI`);
}
