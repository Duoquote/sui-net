import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
const RPC='https://fullnode.mainnet.sui.io:443';
const SENDER='0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const PKG='0xe75a137b62bb7fa1be0b73664fa0fae2e4f2ba604d07a9ff9d333b3ed417e57b';
const SUI='0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const BUCK='0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK';
const AF_LP='0x62e39f5554a2badccab46bf3fab044e3f7dc889d42a567a68d3c1b2e5463001f::af_lp::AF_LP';
const POOL='0xdeacf7ab460385d4bcb567f183f916367f7d43666a2c72323013822eb3c57026';
const REG='0xfcc774493db2c45c79f688f88d28023a3e7d98e4ee9f48bbf5c7990f651577ae';
const VAULT='0xf194d9b1bcad972e45a7dd67dd49b3ee1e3357a00a50850c52cd51bb450e13b4';
const TREASURY='0x28e499dff5e864a2eafe476269a4f5035f1c16f338da7be18b103499abf271ce';
const INSURANCE='0xf0c40d67b078000e18032334c3325c47b9ec9f3d9ae4128be820d54663d14e3b';
const REFERRAL='0x35d35b0e5b177593d8c3a801462485572fc30861e6ce96a55af6dc4730709278';
const client=new SuiJsonRpcClient({url:RPC,network:'mainnet'});
const tx=new Transaction(); tx.setSender(SENDER);
const [c]=tx.splitCoins(tx.gas,[tx.pure.u64(100_000_000)]);
const [bIn]=tx.moveCall({target:'0x2::coin::into_balance',typeArguments:[SUI],arguments:[c]});
const [bOut]=tx.moveCall({target:`${PKG}::m::am`,typeArguments:[AF_LP,SUI,BUCK],
  arguments:[tx.object(POOL),tx.object(REG),tx.object(VAULT),tx.object(TREASURY),tx.object(INSURANCE),tx.object(REFERRAL),
    tx.pure.u64(1),tx.pure.u64('1000000000000000000'),bIn]});
const [cOut]=tx.moveCall({target:'0x2::coin::from_balance',typeArguments:[BUCK],arguments:[bOut]});
tx.transferObjects([cOut],SENDER);
const r=await client.devInspectTransactionBlock({sender:SENDER,transactionBlock:tx});
const err=r.effects?.status?.error??r.error??null;
console.log(err?'ABORT: '+String(err).slice(0,220):'OK — m::am executes Aftermath SUI→BUCK swap on-chain (inside our pkg)');
