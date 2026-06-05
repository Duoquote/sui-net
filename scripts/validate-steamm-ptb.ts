// Read-only on-chain validation of the FULL STEAMM swap PTB (mint → cpmm::swap → burn) the Rust
// `ptb/steamm.rs` builds — via devInspect (no signing, no broadcast). Mirrors the leg EXACTLY for a
// USDC→SEND (b2a) hop using a real owned USDC inventory coin, and compares the on-chain SEND output to
// the byte-exact formula. This is the pre-arm gate for the PTB plumbing (type args, coin::value-as-
// amount, call chaining), complementing the per-step validate-steamm.ts.
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

const RPC = process.env.RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';
const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });

const STEAMM = '0x4fb1cf45dffd6230305f1d269dd1816678cc8e3ba0b747a813a556921219f261';
const POOL = '0x30cf88801f636759645dc8e63b32a4f8166d081defdf325c2da5c97a782aface';
const MARKET = '0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1';
const BANK_SEND = '0x6c4398e6f60241bae3c94355bb10d72a2eabd174c1fc93533e7bd02fe3ed0e83';
const BANK_USDC = '0x9e709157b2228dee4d71f24e91345e2b690beadce84a5a2312fb17b13ce40d58';
const SENDER = '0x6c0d08c59e029b5354c4f0e836e0de311f8117b57aecce41f364871ac123d257';
const MAIN_POOL = '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf::suilend::MAIN_POOL';
const SEND = '0xb45fcfcc2cc07ce0702cc2d229621e046c906ef14d9b25e8e4d25f6e8763fef7::send::SEND';
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const B_SEND = '0xfeebc6d1ec2fc29467b40240ab1a23a9983464b18d0a16405ea313ea681247c3::b_send::B_SEND';
const B_USDC = '0x7fb074a648b8521f65136ac701e94abf55151efc26a39cdab589fabe92285535::b_usdc::B_USDC';
const LP = '0xa7b4ee3bc1979e42324ace952af3fc4c451c752376d2ea5f6b5efaa6e265e9ca::steamm_lp_bsend_busdc::STEAMM_LP_BSEND_BUSDC';
const DEC = 10n ** 18n;
const AMOUNT_IN = 5_000_000n; // 5 USDC (6 decimals) — well within an inventory coin.

function leU64(bytes: number[]): bigint { let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(bytes[i]) << BigInt(8 * i); return v; }
async function obj(id: string): Promise<any> {
  const r = await client.getObject({ id, options: { showContent: true } });
  return (r.data!.content as any).fields;
}

// ---- expected output from the byte-exact formula (fresh state) ----
const pool = await obj(POOL), bankS = await obj(BANK_SEND), bankU = await obj(BANK_USDC), market = await obj(MARKET);
const balA = BigInt(pool.balance_a), balB = BigInt(pool.balance_b), offset = BigInt(pool.quoter.fields.offset);
const feeNum = BigInt(pool.pool_fee_config.fields.fee_numerator), feeDen = BigInt(pool.pool_fee_config.fields.fee_denominator);
function totalFunds(b: any) {
  const fa = BigInt(b.funds_available), bt = BigInt(b.btoken_supply.fields.value);
  const l = b.lending.fields, ct = BigInt(l.ctokens), idx = Number(l.reserve_array_index);
  const r = market.reserves[idx].fields;
  const ratioNum = BigInt(r.available_amount) * DEC + BigInt(r.borrowed_amount.fields.value);
  const tf = fa * DEC + (ct * ratioNum) / BigInt(r.ctoken_supply);
  return { bt, tf };
}
const S = totalFunds(bankS), U = totalFunds(bankU);
const toBt = (amt: bigint, b: { bt: bigint; tf: bigint }) => amt * b.bt * DEC / b.tf;
const fromBt = (amt: bigint, b: { bt: bigint; tf: bigint }) => amt * b.tf / (b.bt * DEC);
// USDC -> SEND (b2a): mint USDC->bUSDC, cpmm b2a (bUSDC->bSEND), burn bSEND->SEND.
const btIn = toBt(AMOUNT_IN, U);
const grossSEND = balA * btIn / (balB + offset + btIn); // b2a gross (bSEND out)
const fee = (grossSEND * feeNum + feeDen - 1n) / feeDen;
const btOut = grossSEND - fee;
const expectedSEND = fromBt(btOut, S);
console.log(`expected: ${AMOUNT_IN} USDC -> btIn(bUSDC)=${btIn} -> btOut(bSEND)=${btOut} -> ${expectedSEND} SEND`);

// ---- build the PTB exactly as ptb/steamm.rs does, devInspect it ----
const usdc = await client.getCoins({ owner: SENDER, coinType: USDC });
if (!usdc.data.length) { console.log('NO USDC coin owned by sender — cannot devInspect'); process.exit(1); }
const usdcCoin = usdc.data.find((c) => BigInt(c.balance) >= AMOUNT_IN) ?? usdc.data[0];
console.log(`using USDC coin ${usdcCoin.coinObjectId} (balance ${usdcCoin.balance})`);

const tx = new Transaction();
tx.setSender(SENDER);
const clock = tx.object('0x6');
const market_arg = tx.object(MARKET);
// Split exactly AMOUNT_IN off the owned USDC coin (so the leg consumes a known amount).
const [coinIn] = tx.splitCoins(tx.object(usdcCoin.coinObjectId), [tx.pure.u64(AMOUNT_IN)]);
const amt = tx.moveCall({ target: '0x2::coin::value', typeArguments: [USDC], arguments: [coinIn] });
// mint_btokens<MAIN, USDC, B_USDC>(bank_usdc, market, &mut coinIn, amt, clock) -> Coin<B_USDC>
const minted = tx.moveCall({
  target: `${STEAMM}::bank::mint_btokens`, typeArguments: [MAIN_POOL, USDC, B_USDC],
  arguments: [tx.object(BANK_USDC), market_arg, coinIn, amt, clock],
});
tx.moveCall({ target: '0x2::coin::destroy_zero', typeArguments: [USDC], arguments: [coinIn] });
const btAmt = tx.moveCall({ target: '0x2::coin::value', typeArguments: [B_USDC], arguments: [minted] });
const zeroOut = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [B_SEND], arguments: [] });
// cpmm::swap<B_SEND, B_USDC, LP>(pool, &mut coin_bSEND(zero), &mut coin_bUSDC(minted), a2b=false, btAmt, 0)
tx.moveCall({
  target: `${STEAMM}::cpmm::swap`, typeArguments: [B_SEND, B_USDC, LP],
  arguments: [tx.object(POOL), zeroOut, minted, tx.pure.bool(false), btAmt, tx.pure.u64(0)],
});
tx.moveCall({ target: '0x2::coin::destroy_zero', typeArguments: [B_USDC], arguments: [minted] });
const btOutArg = tx.moveCall({ target: '0x2::coin::value', typeArguments: [B_SEND], arguments: [zeroOut] });
// burn_btokens<MAIN, SEND, B_SEND>(bank_send, market, &mut zeroOut, btOut, clock) -> Coin<SEND>
const sendCoin = tx.moveCall({
  target: `${STEAMM}::bank::burn_btokens`, typeArguments: [MAIN_POOL, SEND, B_SEND],
  arguments: [tx.object(BANK_SEND), market_arg, zeroOut, btOutArg, clock],
});
// Read the realized SEND output, then return the bToken remnant + the SEND coin to sender.
const outVal = tx.moveCall({ target: '0x2::coin::value', typeArguments: [SEND], arguments: [sendCoin] });
tx.transferObjects([zeroOut, sendCoin], tx.pure.address(SENDER));

const res = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
if (res.effects.status.status !== 'success') {
  console.log('PTB devInspect FAILED:', JSON.stringify(res.error ?? res.effects.status, null, 2));
  process.exit(1);
}
// outVal is the last coin::value result; find it among results.
const valResults = (res.results ?? []).filter((r: any) => r.returnValues?.length === 1 && r.returnValues[0][1] === 'u64');
const onchainSEND = leU64((valResults[valResults.length - 1] as any).returnValues[0][0]);
const drift = expectedSEND === 0n ? 0 : Number(onchainSEND - expectedSEND) / Number(expectedSEND) * 1e6;
console.log(`PTB devInspect SUCCESS ✓`);
console.log(`on-chain SEND out = ${onchainSEND}  | expected = ${expectedSEND}  | drift = ${drift.toFixed(2)} ppm`);
console.log(onchainSEND > 0n && Math.abs(drift) < 2000 ? 'PASS ✓ (PTB executes + output matches formula within interest drift)' : 'CHECK — drift outside expected band');
