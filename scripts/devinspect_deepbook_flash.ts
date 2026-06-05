import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
const RPC='https://fullnode.mainnet.sui.io:443';
const SENDER='0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const SUI_POOL='0x183df694ebc852a5f90a959f0f563b82ac9691e42357e9a9fe961d71a1b809c8'; // Pool<SUI,AUSD>
const SUI='0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const AUSD='0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD';
const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });

// Borrow `amount` SUI then immediately return the SAME coin (exactly borrow_quantity) — a clean
// no-op cycle that validates the runtime's borrow+return type-check AND version gate together.
async function tryPkg(pkg:string,label:string){
  const tx=new Transaction(); tx.setSender(SENDER);
  const [coin, fl] = tx.moveCall({ target:`${pkg}::pool::borrow_flashloan_base`, typeArguments:[SUI,AUSD],
    arguments:[ tx.object(SUI_POOL), tx.pure.u64(1_000_000) ] });
  tx.moveCall({ target:`${pkg}::pool::return_flashloan_base`, typeArguments:[SUI,AUSD],
    arguments:[ tx.object(SUI_POOL), coin, fl ] });
  try {
    const r=await client.devInspectTransactionBlock({ sender:SENDER, transactionBlock:tx });
    const err=r.effects?.status?.error ?? r.error ?? null;
    console.log(`${label} (${pkg.slice(0,10)}): ${err ? 'ABORT: '+String(err).slice(0,200) : 'OK (borrow+return succeed)'}`);
  } catch(e:any){ console.log(`${label} (${pkg.slice(0,10)}): EXC ${String(e?.message||e).slice(0,200)}`); }
}
await tryPkg('0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497','v6');
await tryPkg('0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a','v2');
