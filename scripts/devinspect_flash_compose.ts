import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
const RPC='https://fullnode.mainnet.sui.io:443';
const SENDER='0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const FLASH='0xa97ea4dcec35b97906425ad2a868f0599dcf4cd137b0dde224ee24ebce4055f2'; // mev_exec_fl
const MAIN='0xaef678d60b44054ed865f2ddd61d5d063c74e8170f9bfee48131e650ede0ee95';  // mev_exec (gz)
const SUI='0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const AUSD='0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD';
const SUI_AUSD='0x183df694ebc852a5f90a959f0f563b82ac9691e42357e9a9fe961d71a1b809c8';
const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });

// Full finalize chain spanning BOTH our packages in one PTB:
//   flash m::dbb -> flash m::drb (profit=0) -> MAIN m::gz(0, min_out=0) -> transfer.
// Validates the cross-package Balance threading + that the flash pkg and the swap/gz pkg compose.
const amt=1_000_000;
const tx=new Transaction(); tx.setSender(SENDER);
const [bal, fl] = tx.moveCall({ target:`${FLASH}::m::dbb`, typeArguments:[SUI,AUSD], arguments:[ tx.object(SUI_AUSD), tx.pure.u64(amt) ] });
const [profit] = tx.moveCall({ target:`${FLASH}::m::drb`, typeArguments:[SUI,AUSD], arguments:[ tx.object(SUI_AUSD), bal, tx.pure.u64(amt), fl ] });
const [coin] = tx.moveCall({ target:`${MAIN}::m::gz`, typeArguments:[SUI], arguments:[ profit, tx.pure.u64(0) ] });
tx.transferObjects([coin], SENDER);
const r=await client.devInspectTransactionBlock({ sender:SENDER, transactionBlock:tx });
const err=r.effects?.status?.error ?? r.error ?? null;
console.log(err ? 'ABORT: '+String(err).slice(0,260) : 'OK — flash pkg + main pkg compose (dbb→drb→gz→transfer)');
