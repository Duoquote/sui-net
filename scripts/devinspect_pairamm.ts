import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

const RPC = 'https://fullnode.mainnet.sui.io:443';
const SENDER = '0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const PKG = '0xbfac5e1c6bf6ef29b12f7723857695fd2f4da9a11a7d88162c15e9124c243a4a';
const ROUTER = '0x9cdbbd092634efdc0e7033dc1c49d9ea5fc9bc5969ba708f55e05b6fcac12177';
const FACTORY = '0x81c286135713b4bf2e78c548f5643766b5913dcd27a8e76469f146ab811e922d';
const POOL = '0x5ad7ee30ddd907e26e37b9058e7b0224299600d38fad52fc27a28d15bcdb322d';
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const CLOCK = '0x0000000000000000000000000000000000000000000000000000000000000006';

const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });

async function run(amount: bigint, minOut: bigint) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  const [coinIn] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
  const out = tx.moveCall({
    target: `${PKG}::router::swap_exact_tokens0_for_tokens1_composable`,
    typeArguments: [SUI, USDC],
    arguments: [
      tx.object(ROUTER), tx.object(FACTORY), tx.object(POOL),
      coinIn, tx.pure.u256(minOut), tx.object(CLOCK),
    ],
  });
  tx.transferObjects([out], SENDER);
  const r = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  const st = r.effects?.status;
  console.log(`amount=${amount} minOut=${minOut}: status=${st?.status} ${st?.error ?? ''}`);
  if (st?.status === 'success') {
    // pull the swap's returned coin value from events / return values
    const rv = r.results?.[1]?.returnValues;
    console.log('  returnValues:', JSON.stringify(rv)?.slice(0, 120));
  }
}

// valid swap: 1 SUI in, minOut=1 (our PTB value); plus a sub-1000 case our quote now rejects
await run(1_000_000_000n, 1n);   // 1 SUI — our quote validates this (>=1000, output>0)
await run(500n, 1n);             // <1000 — our quote rejects; chain should abort 201
