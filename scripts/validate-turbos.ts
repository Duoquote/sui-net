// Runtime validation of the new executor's NATIVE Turbos leg: split 0.01 SUI, swap SUI->USDC via
// m::ta<SUI,USDC,FEE500BPS> on a real Turbos pool, dry-run. Success + USDC out = ta works on-chain.
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

const RPC = 'http://127.0.0.1:9000';
const SENDER = '0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const EXEC = '0xe8e94f1ed0a30154b52984156be337a0d877779389e77cb2d29500f272a36bc5';
const POOL = '0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443';
const VERSIONED = '0xf1cf0e81048df168ebeb1b8030fad24b3e0b53ae827c25053fff0779c1445b6f';
const SUI = '0x2::sui::SUI';
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const FEE = '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::fee500bps::FEE500BPS';

const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });
const tx = new Transaction();
const [coinSui] = tx.splitCoins(tx.gas, [10_000_000]); // 0.01 SUI
const balSui = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [SUI], arguments: [coinSui] });
const balUsdc = tx.moveCall({
  target: `${EXEC}::m::ta`,
  typeArguments: [SUI, USDC, FEE],
  arguments: [tx.object(POOL), tx.object('0x6'), tx.object(VERSIONED), balSui],
});
const coinUsdc = tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [USDC], arguments: [balUsdc] });
tx.transferObjects([coinUsdc], SENDER);
tx.setSender(SENDER);
tx.setGasBudget(60_000_000);

const bytes = await tx.build({ client });
const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
console.log('status:', JSON.stringify(dry.effects.status));
console.log('errorSource:', JSON.stringify((dry as any).executionErrorSource ?? 'none'));
for (const b of dry.balanceChanges ?? []) {
  const ct = (b.coinType as string).split('::').pop();
  console.log('  balanceChange:', Number(b.amount) / 1e6, ct);
}
