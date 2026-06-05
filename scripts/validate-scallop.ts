// Read-only byte-exact validation of the Scallop sCoin mint exchange against the live chain via
// devInspect. Reads the SUI reserve's balance sheet, computes mint(amount) = floor(in*supply/value),
// and compares to the MarketCoin<SUI> the on-chain mint::mint returns. No wallet, no broadcast.
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

const RPC = process.env.RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';
const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });

const CORE_RT = '0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805'; // runtime (v19)
const CORE_ORIG = '0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf'; // type origin
const VERSION = '0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7';
const MARKET = '0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9';
const SUI_BS = '0x9c9077abf7a29eebce41e33addbcd6f5246a5221dd733e56ea0f00ae1b25c9e8'; // SUI balance-sheet field
const SUI = '0x2::sui::SUI';
const MARKETCOIN_SUI = `${CORE_ORIG}::reserve::MarketCoin<${SUI}>`;
const SENDER = '0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';

// Current SUI balance sheet.
const bs = await client.getObject({ id: SUI_BS, options: { showContent: true } });
const f = (bs.data!.content as any).fields.value.fields;
const cash = BigInt(f.cash), debt = BigInt(f.debt), revenue = BigInt(f.revenue), supply = BigInt(f.market_coin_supply);
const value = cash + debt - revenue;
console.log('SUI reserve: cash=', cash, 'debt=', debt, 'revenue=', revenue, 'supply=', supply, 'value=', value);

function myMint(amountIn: bigint): bigint {
  return (amountIn * supply) / value; // floor
}

function leU64(bytes: number[]): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(bytes[i]) << BigInt(8 * i);
  return v;
}

for (const amountIn of [1_000_000_000n, 1_000_000_000_000n, 777_777_777n]) {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountIn)]);
  const mc = tx.moveCall({
    target: `${CORE_RT}::mint::mint`,
    typeArguments: [SUI],
    arguments: [tx.object(VERSION), tx.object(MARKET), coin, tx.object('0x6')],
  });
  const val = tx.moveCall({ target: '0x2::coin::value', typeArguments: [MARKETCOIN_SUI], arguments: [mc] });
  tx.transferObjects([mc], SENDER);
  tx.setSender(SENDER);
  const res = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  if (res.effects.status.status !== 'success') {
    console.log(`amountIn=${amountIn}  FAILED:`, JSON.stringify(res.effects.status), JSON.stringify(res.error ?? ''));
    continue;
  }
  const rv = (res.results?.[2] as any)?.returnValues?.[0]?.[0];
  const onchain = rv ? leU64(rv) : -1n;
  const mine = myMint(amountIn);
  const diff = onchain - mine;
  console.log(`mint ${amountIn} SUI: onchain=${onchain} mine=${mine} diff=${diff} ${onchain === mine ? 'MATCH ✓' : `(Δ=${diff}, ${Number(diff) / Number(mine) * 1e6} ppm)`}`);
}
