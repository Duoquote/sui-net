// MERGE all of the wallet's SUI coins and re-split into N evenly-sized gas coins, so the MEV submitter
// has a clean POOL to round-robin for concurrent fan-out submission. Merges by setting the gas payment
// to ALL SUI coins (smashed into one), then splits N-1 equal coins off it; the gas coin keeps the Nth.
//
// Key from /root/sui/.env (MEV_WALLET_PRIVKEY), NEVER printed. Dry-runs by default; pass --execute.
// PRECONDITION: the MEV node MUST be STOPPED before --execute (equivocation: node + this tx both
// signing the same gas-coin version → validators lock it until epoch end).
// Usage: bun scripts/rebalance-gas-coins.ts [count=10] [--execute]
import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { readFileSync } from "fs";

const EXPECTED_ADDR = "0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257";
const EXECUTE = process.argv.includes("--execute");
const COUNT = Number(process.argv.slice(2).filter((a) => a !== "--execute")[0] ?? 10);
const GAS_RESERVE = 10_000_000n; // 0.01 SUI held back for the tx gas; the rest is split evenly
const RPC = "https://fullnode.mainnet.sui.io:443";

const env = readFileSync("/root/sui/.env", "utf8");
const km = env.match(/^MEV_WALLET_PRIVKEY=(\S+)/m);
if (!km) throw new Error("MEV_WALLET_PRIVKEY not found in /root/sui/.env");
const { secretKey } = decodeSuiPrivateKey(km[1].trim());
const kp = Ed25519Keypair.fromSecretKey(secretKey);
const sender = kp.getPublicKey().toSuiAddress();
if (sender !== EXPECTED_ADDR) throw new Error(`derived address ${sender} != expected ${EXPECTED_ADDR}`);
console.log(`signer: ${sender}`);

const client = new SuiJsonRpcClient({ url: RPC, network: "mainnet" });

const coins = (await client.getCoins({ owner: sender, coinType: "0x2::sui::SUI" })).data;
const total = coins.reduce((a: bigint, c: any) => a + BigInt(c.balance), 0n);
console.log(`before: ${coins.length} SUI coin(s), total ${(Number(total) / 1e9).toFixed(4)} SUI`);
for (const c of coins) console.log(`  ${c.coinObjectId}  ${(Number(c.balance) / 1e9).toFixed(4)}`);
if (total < GAS_RESERVE + BigInt(COUNT) * 1_000_000n) throw new Error("insufficient balance");

// Each of the COUNT coins gets total/COUNT; the gas coin keeps the remainder (≈ the same), so we only
// SPLIT COUNT-1 new coins. The tx gas comes out of the gas coin (the COUNT-th), keeping the splits even.
const each = (total - GAS_RESERVE) / BigInt(COUNT);
const splits = COUNT - 1;
console.log(`plan: MERGE all ${coins.length} coins, split ${splits} new coins of ${(Number(each) / 1e9).toFixed(4)} SUI; gas coin keeps the ${COUNT}th (≈ same).`);

const tx = new Transaction();
tx.setSender(sender);
tx.setGasBudget(20_000_000);
// Merge: pay gas with ALL coins → they smash into the first (the surviving gas coin).
tx.setGasPayment(coins.map((c: any) => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest })));
const newCoins = tx.splitCoins(tx.gas, Array.from({ length: splits }, () => tx.pure.u64(each)));
tx.transferObjects(Array.from({ length: splits }, (_, i) => newCoins[i]), sender);
const bytes = await tx.build({ client });

if (!EXECUTE) {
  const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  console.log(`DRY-RUN status: ${JSON.stringify(dry.effects.status)}`);
  const g = dry.effects.gasUsed;
  console.log(`gas net: ${(Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate)) / 1e9} SUI`);
  const created = (dry.objectChanges ?? []).filter((c: any) => c.type === "created");
  console.log(`would create ${created.length} new coins (final total ${created.length + 1} coins). Re-run with --execute (NODE STOPPED).`);
} else {
  const res = await client.signAndExecuteTransaction({
    signer: kp, transaction: bytes,
    options: { showEffects: true, showObjectChanges: true },
  });
  console.log(`digest: ${res.digest}  status: ${JSON.stringify(res.effects?.status)}`);
  await client.waitForTransaction({ digest: res.digest });
  const after = (await client.getCoins({ owner: sender, coinType: "0x2::sui::SUI" })).data;
  console.log(`\nafter: ${after.length} SUI coins. gas-coin-ids:`);
  for (const c of after) console.log(`      - "${c.coinObjectId}"   # ${(Number(c.balance) / 1e9).toFixed(4)} SUI`);
}
