// Read-only byte-exact validation of STEAMM CpQuoter swap math vs live chain via devInspect.
// A STEAMM swap underlyingA->underlyingB = bank.to_btokens(A) -> cpmm pool swap -> bank.from_btokens(B).
// We read pool + both banks + the 2 Suilend reserves (via RPC JSON), compute each step in JS, and compare
// to the on-chain bank::to_btokens / cpmm::quote_swap / bank::from_btokens. No wallet, no broadcast.
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

const RPC = process.env.RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';
const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });

const STEAMM = '0x4fb1cf45dffd6230305f1d269dd1816678cc8e3ba0b747a813a556921219f261';
const POOL = '0x30cf88801f636759645dc8e63b32a4f8166d081defdf325c2da5c97a782aface'; // BSEND/BUSDC CpQuoter
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
const DEC = 10n ** 18n; // Suilend Decimal scale

async function obj(id: string): Promise<any> {
  const r = await client.getObject({ id, options: { showContent: true } });
  return (r.data!.content as any).fields;
}
function leU64(bytes: number[]): bigint { let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(bytes[i]) << BigInt(8 * i); return v; }

const pool = await obj(POOL);
const bankS = await obj(BANK_SEND);
const bankU = await obj(BANK_USDC);
const market = await obj(MARKET);

// CpQuoter offset + pool fee config.
const offset = BigInt(pool.quoter?.fields?.offset ?? 0);
const feeNum = BigInt(pool.pool_fee_config.fields.fee_numerator);
const feeDen = BigInt(pool.pool_fee_config.fields.fee_denominator);
const balA = BigInt(pool.balance_a), balB = BigInt(pool.balance_b);
console.log(`pool: balA(bSEND)=${balA} balB(bUSDC)=${balB} offset=${offset} fee=${feeNum}/${feeDen}`);

// Bank fields + their Suilend reserve (available + borrowed)/ctoken_supply = ctoken_ratio.
function bankInfo(bank: any, name: string) {
  const btSupply = BigInt(bank.btoken_supply.fields?.value ?? bank.btoken_supply.value ?? bank.btoken_supply);
  const fundsAvail = BigInt(bank.funds_available);
  const hasLending = bank.lending != null && (bank.lending.fields ?? bank.lending).ctokens != null;
  const lending = bank.lending?.fields ?? bank.lending;
  const ctokens = hasLending ? BigInt(lending.ctokens) : 0n;
  const idx = hasLending ? Number(lending.reserve_array_index) : -1;
  let ratioNum = 1n, ratioDen = 1n; // ctoken_ratio = ratioNum/ratioDen (as Decimal-ish)
  if (hasLending) {
    const res = market.reserves[idx].fields;
    const avail = BigInt(res.available_amount);
    const borrowed = BigInt(res.borrowed_amount.fields?.value ?? res.borrowed_amount.value ?? res.borrowed_amount); // Decimal (×1e18)
    const ctokenSupply = BigInt(res.ctoken_supply);
    // total_supply (Decimal) = available(×1e18) + borrowed(already ×1e18); ctoken_ratio = total_supply/ctoken_supply
    ratioNum = avail * DEC + borrowed; // Decimal numerator
    ratioDen = ctokenSupply; // ctoken_supply is plain u64
    console.log(`${name} reserve[${idx}]: avail=${avail} borrowed/1e18=${borrowed / DEC} ctokenSupply=${ctokenSupply}`);
  }
  // total_funds (Decimal ×1e18) = funds_available×1e18 + ctokens × ctoken_ratio
  // ctoken_ratio = ratioNum / ratioDen  (ratioNum already ×1e18)
  const totalFundsDec = fundsAvail * DEC + (ctokens * ratioNum) / ratioDen; // Decimal (×1e18)
  console.log(`${name}: btokenSupply=${btSupply} fundsAvail=${fundsAvail} ctokens=${ctokens} totalFunds≈${totalFundsDec / DEC}`);
  return { btSupply, totalFundsDec };
}
const S = bankInfo(bankS, 'SEND');
const U = bankInfo(bankU, 'USDC');

// to_btokens = floor(amount × btoken_supply / total_funds). total_funds is Decimal(×1e18); amount is plain.
// floor(decimal.div(decimal.mul(from(amount), btSupply_as_decimal?)...)) — match decompiled:
//   to_btokens = floor( (amount × btoken_supply_decimal) / total_funds_decimal )  [v4=btoken_supply, v5=total_funds]
// btoken_supply and total_funds are both Decimal; ratio = (amount × btSupply) / totalFunds (units cancel ×1e18).
function toBtokens(amount: bigint, b: { btSupply: bigint; totalFundsDec: bigint }): bigint {
  // amount(plain) × btSupply(plain, as decimal ×1e18) / totalFundsDec(×1e18) -> the 1e18 cancels
  return (amount * b.btSupply * DEC) / b.totalFundsDec; // floor
}
function fromBtokens(amount: bigint, b: { btSupply: bigint; totalFundsDec: bigint }): bigint {
  return (amount * b.totalFundsDec) / (b.btSupply * DEC); // floor
}
// cpmm gross out (a2b: in=bSEND, out=bUSDC): safe_mul_div(balB+offset, amtIn, balA+amtIn); then fee on gross.
function cpmmNet(amtIn: bigint): bigint {
  const gross = ((balB + offset) * amtIn) / (balA + amtIn); // a2b
  const poolFee = (gross * feeNum + feeDen - 1n) / feeDen; // assume ceil; validate
  return gross - poolFee;
}

const RT = STEAMM;
// ---- 1) to_btokens (deposit SEND) ----
for (const amountIn of [1_000_000_000n, 100_000_000_000n]) {
  const tx = new Transaction();
  tx.moveCall({ target: `${RT}::bank::compound_interest_if_any`, typeArguments: [MAIN_POOL, SEND, B_SEND], arguments: [tx.object(BANK_SEND), tx.object(MARKET), tx.object('0x6')] });
  tx.moveCall({ target: `${RT}::bank::to_btokens`, typeArguments: [MAIN_POOL, SEND, B_SEND], arguments: [tx.object(BANK_SEND), tx.object(MARKET), tx.pure.u64(amountIn), tx.object('0x6')] });
  tx.setSender(SENDER);
  const res = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  if (res.effects.status.status !== 'success') { console.log(`to_btokens(${amountIn}) FAILED:`, JSON.stringify(res.error ?? res.effects.status)); continue; }
  const on = leU64((res.results?.[1] as any).returnValues[0][0]); const mine = toBtokens(amountIn, S);
  console.log(`to_btokens(${amountIn} SEND): on=${on} mine=${mine} ${on === mine ? '✓' : `Δ=${on - mine} (${(Number(on - mine) / Number(on) * 1e6).toFixed(3)}ppm)`}`);
}
// ---- 2) cpmm::quote_swap (bSEND -> bUSDC), explicit bToken amounts ----
for (const btIn of [998_000_000n, 50_000_000_000n]) {
  const tx = new Transaction();
  const q = tx.moveCall({ target: `${RT}::cpmm::quote_swap`, typeArguments: [B_SEND, B_USDC, LP], arguments: [tx.object(POOL), tx.pure.u64(btIn), tx.pure.bool(true)] });
  tx.moveCall({ target: `${RT}::quote::amount_out`, arguments: [q] });
  tx.setSender(SENDER);
  const res = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  if (res.effects.status.status !== 'success') { console.log(`cpmm(${btIn}) FAILED:`, JSON.stringify(res.error ?? res.effects.status)); continue; }
  const on = leU64((res.results?.[1] as any).returnValues[0][0]); const mine = cpmmNet(btIn);
  console.log(`cpmm(${btIn} bSEND->bUSDC): on=${on} mine=${mine} ${on === mine ? 'MATCH ✓' : `Δ=${on - mine}`}`);
}
// ---- 3) from_btokens (redeem bUSDC -> USDC) ----
for (const btIn of [1_000_000n, 100_000_000n]) {
  const tx = new Transaction();
  tx.moveCall({ target: `${RT}::bank::compound_interest_if_any`, typeArguments: [MAIN_POOL, USDC, B_USDC], arguments: [tx.object(BANK_USDC), tx.object(MARKET), tx.object('0x6')] });
  tx.moveCall({ target: `${RT}::bank::from_btokens`, typeArguments: [MAIN_POOL, USDC, B_USDC], arguments: [tx.object(BANK_USDC), tx.object(MARKET), tx.pure.u64(btIn), tx.object('0x6')] });
  tx.setSender(SENDER);
  const res = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  if (res.effects.status.status !== 'success') { console.log(`from_btokens(${btIn}) FAILED:`, JSON.stringify(res.error ?? res.effects.status)); continue; }
  const on = leU64((res.results?.[1] as any).returnValues[0][0]); const mine = fromBtokens(btIn, U);
  console.log(`from_btokens(${btIn} bUSDC): on=${on} mine=${mine} ${on === mine ? '✓' : `Δ=${on - mine} (${(Number(on - mine) / Number(on) * 1e6).toFixed(3)}ppm)`}`);
}
