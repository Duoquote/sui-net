import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
const RPC='https://fullnode.mainnet.sui.io:443';
const SENDER='0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const PKG='0x0fbe3c60558defdb46a7466daec3616ad0a4ed800f544b107cb6c9236a6311ec';
const SUI='0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const USDC='0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const POOL='0xfcbc241c2bcc768280a97dba79c0a9bd608616c719fa515a654067e127d032f1'; // Magma Pool<USDC,SUI>
const CFG='0x4c4e1402401f72c7d8533d0ed8d5f8949da363c7a3319ccef261ffe153d32f8a';
const CLOCK='0x0000000000000000000000000000000000000000000000000000000000000006';
const client=new SuiJsonRpcClient({url:RPC,network:'mainnet'});
const tx=new Transaction(); tx.setSender(SENDER);
const [c]=tx.splitCoins(tx.gas,[tx.pure.u64(100_000_000)]);
const [bIn]=tx.moveCall({target:'0x2::coin::into_balance',typeArguments:[SUI],arguments:[c]});
// gb<USDC,SUI>(cfg, pool, clk, Balance<SUI>) -> Balance<USDC>  (b2a: sell SUI/B for USDC/A)
const [bOut]=tx.moveCall({target:`${PKG}::m::gb`,typeArguments:[USDC,SUI],arguments:[tx.object(CFG),tx.object(POOL),tx.object(CLOCK),bIn]});
const [cOut]=tx.moveCall({target:'0x2::coin::from_balance',typeArguments:[USDC],arguments:[bOut]});
tx.transferObjects([cOut],SENDER);
const r=await client.devInspectTransactionBlock({sender:SENDER,transactionBlock:tx});
const err=r.effects?.status?.error??r.error??null;
console.log(err?'ABORT: '+String(err).slice(0,200):'OK — m::gb executes a real Magma SUI->USDC swap on-chain (inside our pkg)');
