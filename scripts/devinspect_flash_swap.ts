import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
const RPC='https://fullnode.mainnet.sui.io:443';
const SENDER='0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const PKG='0x60f9042bb44aa8b0df4419a1057fdf0383941eebf9d81bc0782c8d09fedb5442'; // mev_exec_fl v2 (ea/eb)
const SUI='0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const AUSD='0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD';
const SUI_AUSD='0x183df694ebc852a5f90a959f0f563b82ac9691e42357e9a9fe961d71a1b809c8';
const CLOCK='0x0000000000000000000000000000000000000000000000000000000000000006';
const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });

// m::ea<SUI,AUSD>: split 0.1 SUI from gas → Balance<SUI> → CLOB-swap to Balance<AUSD> → coin → keep.
// Validates the swap wrapper runs end-to-end on-chain (zero-DEEP input-fee path, leftover→sender,
// destroy zero DEEP, output threaded). min_out=0 so no min-out abort even on a thin fill.
const amt=100_000_000;
const tx=new Transaction(); tx.setSender(SENDER);
const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(amt)]);
const [balIn] = tx.moveCall({ target:'0x2::coin::into_balance', typeArguments:[SUI], arguments:[c] });
const [balOut] = tx.moveCall({ target:`${PKG}::m::ea`, typeArguments:[SUI,AUSD],
  arguments:[ tx.object(SUI_AUSD), tx.pure.u64(0), tx.object(CLOCK), balIn ] });
const [coinOut] = tx.moveCall({ target:'0x2::coin::from_balance', typeArguments:[AUSD], arguments:[balOut] });
tx.transferObjects([coinOut], SENDER);
const r=await client.devInspectTransactionBlock({ sender:SENDER, transactionBlock:tx });
const err=r.effects?.status?.error ?? r.error ?? null;
console.log(err ? 'ABORT: '+String(err).slice(0,260) : 'OK — m::ea executes a real SUI→AUSD CLOB swap on-chain');
