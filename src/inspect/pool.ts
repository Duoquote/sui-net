import type { Sui } from '../client/grpc.ts';
import type { Cache } from '../cache/repo.ts';
import type { GlobalOptions } from '../types.ts';
import { decodeValue, type Plain } from '../util/value.ts';
import { lookupKnown } from '../registry/known.ts';
import { classifyPool } from './poolKind.ts';
import { Coins } from './coins.ts';
import { normalizeAddress } from '../util/address.ts';
import { header, dim, c, groupDigits } from '../render/format.ts';

interface RawObject {
  objectId?: string;
  objectType?: string;
  json?: unknown;
}

/** Split the top-level generic arguments of a fully-qualified type. */
function topLevelTypeArgs(type: string): string[] {
  const lt = type.indexOf('<');
  if (lt < 0) return [];
  const inner = type.slice(lt + 1, type.lastIndexOf('>'));
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

const RESERVE_PAIRS: Array<[string, string]> = [
  ['coin_a', 'coin_b'],
  ['reserve_x', 'reserve_y'],
  ['reserve_a', 'reserve_b'],
  ['coin_x', 'coin_y'],
  ['balance_x', 'balance_y'],
  ['balance_a', 'balance_b'],
  ['bal_x', 'bal_y'],
];

function asNum(v: Plain): string | undefined {
  if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** Find the (a, b) reserve amounts, descending one level into a `balance` struct. */
function findReserves(fields: Record<string, Plain>): { a: string; b: string } | undefined {
  for (const [ka, kb] of RESERVE_PAIRS) {
    const a = asNum(fields[ka]);
    const b = asNum(fields[kb]);
    if (a !== undefined && b !== undefined) return { a, b };
  }
  const bal = fields['balance'];
  if (bal && typeof bal === 'object' && !Array.isArray(bal)) {
    for (const [ka, kb] of [...RESERVE_PAIRS, ['x', 'y'] as [string, string]]) {
      const a = asNum((bal as Record<string, Plain>)[ka]);
      const b = asNum((bal as Record<string, Plain>)[kb]);
      if (a !== undefined && b !== undefined) return { a, b };
    }
  }
  return undefined;
}

function firstField(fields: Record<string, Plain>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = asNum(fields[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Coin types inside a VecSet-like node ({ keys: { contents: [...] } }). */
function vecSetTypes(node: Plain): string[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const ks = (node as Record<string, Plain>)['keys'];
  const contents = ks && typeof ks === 'object' && !Array.isArray(ks) ? (ks as Record<string, Plain>)['contents'] : undefined;
  return Array.isArray(contents) ? contents.filter((x): x is string => typeof x === 'string') : [];
}

/** For a lending market, the active supply + collateral asset coin types. */
function lendingAssets(fields: Record<string, Plain>): { supply: string[]; collateral: string[] } | undefined {
  const st = fields['asset_active_states'];
  if (!st || typeof st !== 'object' || Array.isArray(st)) return undefined;
  const s = st as Record<string, Plain>;
  return { supply: vecSetTypes(s['base']), collateral: vecSetTypes(s['collateral']) };
}

/** Marginal price (coinB per coinA) from a Q64.64 sqrt price. */
function priceFromSqrt(sqrt: string, decA: number, decB: number): number {
  const ratio = Number(BigInt(sqrt)) / 2 ** 64;
  return ratio * ratio * 10 ** (decA - decB);
}

function priceFromReserves(a: string, b: string, decA: number, decB: number): number {
  const ra = Number(BigInt(a)) / 10 ** decA;
  const rb = Number(BigInt(b)) / 10 ** decB;
  return ra === 0 ? 0 : rb / ra;
}

function sigFigs(n: number, figs = 6): string {
  if (!isFinite(n) || n === 0) return '0';
  return Number(n.toPrecision(figs)).toString();
}

/** Decode a {bits:u32} i32 tick into a signed integer. */
function signedTick(v: Plain): number | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const bits = (v as Record<string, Plain>)['bits'];
    if (typeof bits === 'string' || typeof bits === 'number') {
      const u = Number(bits);
      return u >= 2 ** 31 ? u - 2 ** 32 : u;
    }
  }
  return undefined;
}

export async function inspectPool(
  sui: Sui,
  cache: Cache,
  opts: GlobalOptions,
  poolId: string,
): Promise<void> {
  const id = normalizeAddress(poolId);
  const obj = (await cache.through<RawObject>(
    'object',
    id,
    { noCache: opts.noCache, ttlMs: opts.cacheTtlMs },
    () => sui.getObject(id) as Promise<RawObject>,
  )) as RawObject;

  const type = obj.objectType ?? '';
  const fields = (decodeValue(obj.json as never) ?? {}) as Record<string, Plain>;
  const coins = new Coins(sui, cache, opts.noCache);

  // Coin types: prefer explicit fields, else top-level type args.
  const args = topLevelTypeArgs(type);
  const ctxField = fields['coin_type_x'];
  const ctyField = fields['coin_type_y'];
  const coinA = typeof ctxField === 'string' ? ctxField : args[0];
  const coinB = typeof ctyField === 'string' ? ctyField : args[1];

  const pkg = type.split('::')[0] ?? '';
  const reserves = findReserves(fields);
  const sqrt = firstField(fields, ['sqrt_price', 'current_sqrt_price']);
  const liquidity = firstField(fields, ['liquidity']);

  const known = lookupKnown(pkg);
  const cls = classifyPool(type, fields);
  const lending = cls.kind === 'Lending' ? lendingAssets(fields) : undefined;

  // JSON mode: emit a structured summary.
  if (opts.json) {
    const out: Record<string, unknown> = {
      poolId: id, type, protocol: known?.name, kind: cls.kind, kindDetail: cls.detail,
      coinA, coinB, reserves, sqrtPrice: sqrt, liquidity,
      assets: lending,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const name = typeof fields['name'] === 'string' ? ` ${dim('[' + fields['name'] + ']')}` : '';
  console.log(header('Pool ' + id) + name);
  console.log('  ' + dim('protocol: ') + (known ? c.green(known.name) : dim('unknown ' + pkg.slice(0, 10) + '…')));
  console.log('  ' + dim('kind:     ') + c.yellow(cls.kind) + dim(' — ' + cls.detail));
  console.log('  ' + dim('type:     ') + shortType(type));

  // Lending market: list the per-asset markets instead of an AMM pair view.
  if (lending) {
    const shortCoin = (t: string) => t.split('::').slice(-2).join('::');
    const all = [...new Set([...lending.supply, ...lending.collateral])];
    const sym = new Map<string, string>();
    await Promise.all(all.map(async (t) => sym.set(t, (await coins.meta(t)).symbol)));
    const collat = new Set(lending.collateral);
    console.log(
      '\n' + c.bold('Asset markets') +
        dim(` (${lending.supply.length} lendable, ${lending.collateral.length} collateral)`),
    );
    for (const t of lending.supply) {
      const tag = collat.has(t) ? dim(' · collateral') : '';
      console.log('  ' + (sym.get(t) ?? '?').padEnd(10) + dim(shortCoin(t)) + tag);
    }
    for (const t of lending.collateral.filter((t) => !lending.supply.includes(t))) {
      console.log('  ' + (sym.get(t) ?? '?').padEnd(10) + dim(shortCoin(t)) + dim(' · collateral only'));
    }
    console.log(
      '\n' + dim('per-asset reserves, interest and risk parameters are stored in this object’s tables (dynamic fields)'),
    );
    const df = await sui.listDynamicFields(id);
    const n = (df.dynamicFields ?? []).length;
    const more = df.nextPageToken ? '+' : '';
    console.log(dim(`dynamic fields on this object: ${n}${more}`) + (n ? dim(' — use `fields ' + id + '`') : ''));
    return;
  }

  // Coins + reserves.
  const ma = coinA ? await coins.meta(coinA) : { symbol: '?', decimals: 0 };
  const mb = coinB ? await coins.meta(coinB) : { symbol: '?', decimals: 0 };
  if (coinA) console.log('  ' + dim('coin A: ') + `${ma.symbol} ${dim(shortType(coinA))}`);
  if (coinB) console.log('  ' + dim('coin B: ') + `${mb.symbol} ${dim(shortType(coinB))}`);

  if (reserves) {
    console.log('\n' + c.bold('Holdings'));
    console.log('  ' + `${await coins.format(coinA!, reserves.a)}`);
    console.log('  ' + `${await coins.format(coinB!, reserves.b)}`);
  }

  // Price.
  let price: number | undefined;
  let basis = '';
  if (sqrt) {
    price = priceFromSqrt(sqrt, ma.decimals, mb.decimals);
    basis = 'sqrt_price';
  } else if (reserves) {
    price = priceFromReserves(reserves.a, reserves.b, ma.decimals, mb.decimals);
    basis = 'reserves';
  }
  if (price && isFinite(price) && price > 0) {
    console.log('\n' + c.bold('Spot price') + dim(` (from ${basis}, approximate)`));
    console.log('  ' + `≈ ${sigFigs(price)} ${mb.symbol} per ${ma.symbol}`);
    console.log('  ' + dim(`≈ ${sigFigs(1 / price)} ${ma.symbol} per ${mb.symbol}`));
  }

  // CLMM extras + fees (raw — fee scales differ by protocol).
  const extras: Array<[string, string]> = [];
  if (liquidity) extras.push(['liquidity', groupDigits(liquidity)]);
  const tick = signedTick(fields['current_tick_index'] ?? fields['tick_current_index']);
  if (tick !== undefined) extras.push(['current tick', String(tick)]);
  for (const fk of ['fee', 'fee_rate', 'swap_fee_rate', 'protocol_fee_share', 'tick_spacing']) {
    const v = asNum(fields[fk]);
    if (v !== undefined) extras.push([fk + ' (raw)', v]);
  }
  if (extras.length) {
    console.log('\n' + c.bold('Parameters'));
    for (const [k, v] of extras) console.log('  ' + dim(k + ': ') + v);
  }

  // Dynamic fields presence (answers "does this pool use dynamic fields?").
  const df = await sui.listDynamicFields(id);
  const n = (df.dynamicFields ?? []).length;
  const more = df.nextPageToken ? '+' : '';
  console.log('\n' + dim(`dynamic fields on this object: ${n}${more}`) + (n ? dim(' — use `fields ' + id + '`') : ''));
}

function shortType(type: string): string {
  return type.replace(/0x[0-9a-fA-F]+::/g, '');
}
