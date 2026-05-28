import type { Plain } from '../util/value.ts';

export interface PoolKind {
  kind: string; // short label: CLMM | DLMM | AMM | Stable | Oracle AMM | ...
  detail: string; // human explanation of the mechanism
}

/**
 * Classify a pool's market-making mechanism from its on-chain fields. This is
 * structural (independent of the protocol registry), so it works even for
 * unknown protocols. Order matters: more specific mechanisms are checked first.
 */
export function classifyPool(type: string, fields: Record<string, Plain>): PoolKind {
  const keys = new Set(Object.keys(fields));
  const has = (...ks: string[]) => ks.some((k) => keys.has(k));
  const balanceNested =
    fields['balance'] && typeof fields['balance'] === 'object' && !Array.isArray(fields['balance']);

  // DLMM / Liquidity Book: discrete price bins.
  if (has('bin_step', 'bin_manager', 'active_id', 'bins', 'active_bin') || /lb_pair|LBPair/.test(type)) {
    return { kind: 'DLMM', detail: 'discretized liquidity bins (Liquidity Book)' };
  }

  // CLMM: a sqrt price plus a tick structure.
  const sqrt = has('sqrt_price', 'current_sqrt_price');
  const ticks = has('ticks', 'tick_map', 'tick_bitmap', 'tick_index', 'tick_manager', 'ticks_manager', 'tick_spacing');
  if (sqrt && ticks) return { kind: 'CLMM', detail: 'concentrated liquidity (Uniswap-v3 style sqrt price + ticks)' };
  if (sqrt) return { kind: 'CLMM-like', detail: 'sqrt-price based, no tick table observed' };

  // Oracle-priced pools.
  if (has('oracle_config', 'oracle_driven') || (/oracle/i.test(type) && has('feed_id', 'core_data'))) {
    return { kind: 'Oracle AMM', detail: 'price sourced from an oracle' };
  }

  // Stable swaps (amplified curve).
  if (has('amp', 'amplification', 'initial_a', 'future_a') || (has('stable') && fields['stable'] === true)) {
    return { kind: 'Stable', detail: 'amplified stable-swap curve' };
  }

  // STEAMM-style pluggable quoter; the quoter type appears in the pool's generics.
  if (has('quoter')) {
    const q = type.match(/(\w*[Qq]uoter)/)?.[1];
    const oracle = q && /omm|oracle/i.test(q);
    return {
      kind: oracle ? 'Oracle AMM (quoter)' : 'AMM (quoter)',
      detail: q ? `pluggable quoter: ${q}` : 'pluggable quoter module decides pricing',
    };
  }

  // Constant-product AMM: a pair of reserves and nothing fancier.
  if (
    has('reserve_x', 'reserve_y', 'reserve_a', 'reserve_b', 'bal_x', 'bal_y', 'coin_a', 'coin_b',
        'coin_x', 'coin_y', 'balance_a', 'balance_b', 'balance_x', 'balance_y') ||
    balanceNested
  ) {
    return { kind: 'AMM', detail: 'constant-product (x*y=k) reserves' };
  }

  return { kind: 'unknown', detail: 'mechanism not recognized from fields' };
}
