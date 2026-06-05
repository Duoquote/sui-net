import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
const RPC='https://fullnode.mainnet.sui.io:443';
const SENDER='0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const PKG='0xa97ea4dcec35b97906425ad2a868f0599dcf4cd137b0dde224ee24ebce4055f2';
const SUI='0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const AUSD='0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD';
const USDC='0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const DEEP='0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
const SUI_AUSD='0x183df694ebc852a5f90a959f0f563b82ac9691e42357e9a9fe961d71a1b809c8';
const DEEP_USDC='0xde096bb2c59538a25c89229127fe0bc8b63ecdbe52a3693099cc40a1d8a2cfd4';
const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });

// Borrow `amt` via m::dbb/dbq, immediately repay the EXACT principal via m::drb/drq, destroy the
// (zero) profit remainder. End-to-end validates our package links to DeepBook v6 + clears its version
// gate + the split/return plumbing — the Magma "devInspect every leg" discipline.
async function tryLeg(label:string, borrow:string, repay:string, types:string[], pool:string){
  const amt=1_000_000;
  const tx=new Transaction(); tx.setSender(SENDER);
  const [bal, fl] = tx.moveCall({ target:`${PKG}::m::${borrow}`, typeArguments:types,
    arguments:[ tx.object(pool), tx.pure.u64(amt) ] });
  const [profit] = tx.moveCall({ target:`${PKG}::m::${repay}`, typeArguments:types,
    arguments:[ tx.object(pool), bal, tx.pure.u64(amt), fl ] });
  // remainder is exactly zero (principal == borrowed) → destroy_zero consumes the no-drop Balance.
  const borrowedCoin = (borrow==='dbb') ? types[0] : types[1];
  tx.moveCall({ target:'0x2::balance::destroy_zero', typeArguments:[borrowedCoin], arguments:[profit] });
  try{
    const r=await client.devInspectTransactionBlock({ sender:SENDER, transactionBlock:tx });
    const err=r.effects?.status?.error ?? r.error ?? null;
    console.log(`${label}: ${err ? 'ABORT: '+String(err).slice(0,220) : 'OK (dbb/drb cycle succeeds on-chain)'}`);
  }catch(e:any){ console.log(`${label}: EXC ${String(e?.message||e).slice(0,220)}`); }
}
await tryLeg('BASE  SUI  (m::dbb/drb on Pool<SUI,AUSD>)',  'dbb','drb',[SUI,AUSD], SUI_AUSD);
await tryLeg('QUOTE USDC (m::dbq/drq on Pool<DEEP,USDC>)', 'dbq','drq',[DEEP,USDC], DEEP_USDC);
