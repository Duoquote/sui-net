import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
const RPC='https://fullnode.mainnet.sui.io:443';
const SENDER='0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const BM='0x35f3190a41b98da22c997c9266143523816d73a902123dde6f60fac2e0f656d7';
const DEX='0x3f2d9f724f4a1ce5e71676448dc452be9a6243dac9c5b975a588c8c867066e92';
const UP='0x87dfe1248a1dc4ce473bd9cb2937d66cdc6c30fee63f3fe0dbb55c7a09d35dec::up::UP';
const NEON='0x6e3401540bfefc0c1cd6167f80d3ae9dbbe0acf255ec3c43be1ba694cf56d1f4::neon::NEON';
const client=new SuiJsonRpcClient({url:RPC,network:'mainnet'});
const tx=new Transaction(); tx.setSender(SENDER);
const [z]=tx.moveCall({target:'0x2::coin::zero',typeArguments:[UP]});
// full router path: swap_exact_input_<UP,NEON>(amount, Coin<UP>, min_out, &mut Dex_Info, ctx) -> Coin<NEON>
const [out]=tx.moveCall({target:`${BM}::router::swap_exact_input_`,typeArguments:[UP,NEON],
  arguments:[tx.pure.u64(0), z, tx.pure.u64(0), tx.object(DEX)]});
tx.transferObjects([out],SENDER);
const r=await client.devInspectTransactionBlock({sender:SENDER,transactionBlock:tx});
const err=r.effects?.status?.error??r.error??null;
console.log(err?'ABORT: '+String(err).slice(0,220):'OK — router swap_exact_input_<UP,NEON> executes (so historical failure = stale state)');
