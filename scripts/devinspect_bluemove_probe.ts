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
tx.moveCall({target:`${BM}::utils::sort_token_type`,typeArguments:[UP,NEON]});      // [0] UP<NEON ?
tx.moveCall({target:`${BM}::swap::check_pool_exist`,typeArguments:[UP,NEON],arguments:[tx.object(DEX)]});  // [1]
tx.moveCall({target:`${BM}::swap::check_pool_exist`,typeArguments:[NEON,UP],arguments:[tx.object(DEX)]});  // [2]
const r=await client.devInspectTransactionBlock({sender:SENDER,transactionBlock:tx});
const rv=r.results||[];
const b=(i:number)=> rv[i]?.returnValues?.[0]?.[0]?.[0];  // first byte of bool
console.log('sort_token_type<UP,NEON> (UP<NEON):', b(0));
console.log('check_pool_exist<UP,NEON>:', b(1));
console.log('check_pool_exist<NEON,UP>:', b(2));
console.log('status:', r.effects?.status?.status, r.effects?.status?.error||'');
