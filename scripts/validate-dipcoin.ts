// Read-only byte-exact validation of the DipCoin constant-product curve against the live chain via
// devInspect. No wallet, no broadcast. Run: bun scripts/validate-dipcoin.ts
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

const RPC = process.env.RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';
const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });

const DIPCOIN = '0xdae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872';
const GLOBAL = '0x935229a3c32399e9fb207ec8461a54f56c6af5744c64442435ac217ab28f0d59';
const POOL = '0x7fbd7f609fcecd84329359cb6ea4eadbcd84d02a28fec9ce4652712d06474b3e';
const SUI = '0x2::sui::SUI';
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const SENDER = '0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';

// Current reserves + fee from the pool object.
const obj = await client.getObject({ id: POOL, options: { showContent: true } });
const f = (obj.data!.content as any).fields;
const balX = BigInt(f.bal_x);
const balY = BigInt(f.bal_y);
const feeRate = BigInt(f.fee_rate);
console.log('pool bal_x(SUI)=', balX, ' bal_y(USDC)=', balY, ' fee_rate=', feeRate);

function myQuoteA2B(amountIn: bigint): bigint {
  const inAfter = amountIn * (10000n - feeRate);
  return (inAfter * balY) / (balX * 10000n + inAfter);
}

for (const amountIn of [1_000_000_000n, 50_000_000_000n, 123_456_789n]) {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountIn)]);
  const out = tx.moveCall({
    target: `${DIPCOIN}::router::swap_exact_x_to_y_with_return`,
    typeArguments: [SUI, USDC],
    arguments: [tx.object(GLOBAL), tx.object(POOL), coin, tx.pure.u64(0)],
  });
  tx.transferObjects([out], SENDER);
  tx.setSender(SENDER);
  const res = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  if (res.effects.status.status !== 'success') {
    console.log(`amountIn=${amountIn}  DEVINSPECT FAILED:`, JSON.stringify(res.effects.status), JSON.stringify(res.error ?? ''));
    continue;
  }
  // Read the swap output from the emitted SwapEvent (value_y_out for an x->y swap).
  const ev = (res.events ?? []).find((e: any) => String(e.type).endsWith('::event::SwapEvent'));
  const onchain = ev ? BigInt((ev.parsedJson as any).value_y_out) : -1n;
  const mine = myQuoteA2B(amountIn);
  const ok = onchain === mine;
  console.log(`amountIn=${amountIn}  onchain=${onchain}  mine=${mine}  ${ok ? 'MATCH ✓' : 'MISMATCH ✗'}`);
}
