// Runtime validation of the re-pointed BlueMove leg: split 0.01 SUI, swap SUI->MOCHI via
// m::va<SUI,MOCHI>(Dex_Info, Balance<SUI>) on the v5 executor (BlueMove dep = live v11), dry-run.
// Success + MOCHI out = the version-25 abort is fixed and m::va swaps on the live package.
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

const RPC = 'http://127.0.0.1:9000';
const SENDER = '0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const EXEC = '0xbeb249a2cb6f5de5a08e2837b47577dc8120cf7f053613b0119c3a16f6b98120';
const DEX_INFO = '0x3f2d9f724f4a1ce5e71676448dc452be9a6243dac9c5b975a588c8c867066e92';
const SUI = '0x2::sui::SUI';
const MOCHI = '0xa26788cb462ae9242d9483bdbe5a82188ba0eaeae3c5e9237d30cbcb83ce7a88::mochi::MOCHI';

const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });
const tx = new Transaction();
const [coinSui] = tx.splitCoins(tx.gas, [10_000_000]); // 0.01 SUI
const balSui = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [SUI], arguments: [coinSui] });
const balMochi = tx.moveCall({
  target: `${EXEC}::m::va`,
  typeArguments: [SUI, MOCHI],
  arguments: [tx.object(DEX_INFO), balSui],
});
const coinMochi = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [MOCHI], arguments: [balMochi] });
tx.transferObjects([coinMochi], SENDER);
tx.setSender(SENDER);
tx.setGasBudget(60_000_000);

const bytes = await tx.build({ client });
const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
console.log('status:', JSON.stringify(dry.effects.status));
for (const b of dry.balanceChanges ?? []) {
  const ct = (b.coinType as string).split('::').pop();
  console.log('  balanceChange:', Number(b.amount), ct);
}
