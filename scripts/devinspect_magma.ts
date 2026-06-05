import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
const RPC='https://fullnode.mainnet.sui.io:443';
const SENDER='0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const CFG='0x4c4e1402401f72c7d8533d0ed8d5f8949da363c7a3319ccef261ffe153d32f8a';
const POOL='0xfcbc241c2bcc768280a97dba79c0a9bd608616c719fa515a654067e127d032f1'; // Magma Pool<USDC,SUI>
const USDC='0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const SUI='0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const CLOCK='0x0000000000000000000000000000000000000000000000000000000000000006';
const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });
async function tryPkg(pkg:string,label:string){
  const tx=new Transaction(); tx.setSender(SENDER);
  // flash_swap<USDC,SUI>(cfg, pool, a2b=true, by_in=true, amount=1000, sqrt_limit, clock)
  tx.moveCall({ target:`${pkg}::pool::flash_swap`, typeArguments:[USDC,SUI],
    arguments:[ tx.object(CFG), tx.object(POOL), tx.pure.bool(true), tx.pure.bool(true),
      tx.pure.u64(1000), tx.pure.u128('4295048017'), tx.object(CLOCK) ] });
  const r=await client.devInspectTransactionBlock({ sender:SENDER, transactionBlock:tx });
  const err=r.effects?.status?.error ?? r.error ?? '(no error field)';
  console.log(`${label} (${pkg.slice(0,8)}): ${String(err).slice(0,300)}`);
}
await tryPkg('0x0acd1d187950450ae3e625375f8067a7802e99a05b6e655e1fec124a0e3c891e','MAGMA-v5');
await tryPkg('0x75b2e9ecad34944b8d0c874e568c90db0cf9437f0d7392abfd4cb902972f3e40','CETUS(our const)');
