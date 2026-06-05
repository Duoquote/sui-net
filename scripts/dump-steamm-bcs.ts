// Dumps raw BCS bytes + ground-truth field values for the STEAMM Rust adapter fixtures.
// Writes the LendingMarket BCS to a file (large) and prints pool/bank BCS (small) as hex, plus the
// reserve accounting fields (available_amount, ctoken_supply, borrowed_amount) for the SEND/USDC
// reserves so the Rust parser's unit test can assert byte-exact extraction offline.
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { writeFileSync } from 'node:fs';

const RPC = process.env.RPC_URL ?? 'https://fullnode.mainnet.sui.io:443';
const client = new SuiJsonRpcClient({ url: RPC, network: 'mainnet' });

const POOL = '0x30cf88801f636759645dc8e63b32a4f8166d081defdf325c2da5c97a782aface';
const MARKET = '0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1';
const BANK_SEND = '0x6c4398e6f60241bae3c94355bb10d72a2eabd174c1fc93533e7bd02fe3ed0e83';
const BANK_USDC = '0x9e709157b2228dee4d71f24e91345e2b690beadce84a5a2312fb17b13ce40d58';

async function bcsHex(id: string): Promise<{ hex: string; bytes: number[] }> {
  const r = await client.getObject({ id, options: { showBcs: true } });
  const b64 = (r.data!.bcs as any).bcsBytes as string;
  const bytes = Array.from(Buffer.from(b64, 'base64'));
  return { hex: Buffer.from(bytes).toString('hex'), bytes };
}
async function content(id: string): Promise<any> {
  const r = await client.getObject({ id, options: { showContent: true } });
  return (r.data!.content as any).fields;
}

const pool = await bcsHex(POOL);
const bankS = await bcsHex(BANK_SEND);
const bankU = await bcsHex(BANK_USDC);
console.log(`POOL_BCS_HEX (${pool.bytes.length} bytes):\n${pool.hex}\n`);
console.log(`BANK_SEND_BCS_HEX (${bankS.bytes.length} bytes):\n${bankS.hex}\n`);
console.log(`BANK_USDC_BCS_HEX (${bankU.bytes.length} bytes):\n${bankU.hex}\n`);

const market = await bcsHex(MARKET);
writeFileSync('/root/sui/sui-upstream/mev/src/pools/testdata/steamm_lending_market.bcs', Buffer.from(market.bytes));
console.log(`LendingMarket BCS written: ${market.bytes.length} bytes -> mev/src/pools/testdata/steamm_lending_market.bcs`);

// Ground-truth values for the fixture asserts.
const m = await content(MARKET);
function reserveFields(idx: number) {
  const r = m.reserves[idx].fields;
  const borrowed = r.borrowed_amount.fields?.value ?? r.borrowed_amount.value ?? r.borrowed_amount;
  return { array_index: r.array_index, available_amount: r.available_amount, ctoken_supply: r.ctoken_supply, borrowed_amount: borrowed };
}
console.log(`\nreserves.length = ${m.reserves.length}`);
console.log(`reserve[7]  (USDC) = ${JSON.stringify(reserveFields(7))}`);
console.log(`reserve[17] (SEND) = ${JSON.stringify(reserveFields(17))}`);

const bs = await content(BANK_SEND);
const bu = await content(BANK_USDC);
function bankFields(b: any) {
  const lending = b.lending?.fields ?? b.lending;
  return {
    funds_available: b.funds_available,
    btoken_supply: b.btoken_supply.fields?.value ?? b.btoken_supply.value ?? b.btoken_supply,
    has_lending: b.lending != null,
    ctokens: lending?.ctokens,
    reserve_array_index: lending?.reserve_array_index,
  };
}
console.log(`\nbankSEND = ${JSON.stringify(bankFields(bs))}`);
console.log(`bankUSDC = ${JSON.stringify(bankFields(bu))}`);
const p = await content(POOL);
console.log(`\npool balance_a=${p.balance_a} balance_b=${p.balance_b} offset=${p.quoter.fields.offset} fee=${p.pool_fee_config.fields.fee_numerator}/${p.pool_fee_config.fields.fee_denominator}`);
