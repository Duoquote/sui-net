import type { Sui } from '../client/grpc.ts';
import type { Cache } from '../cache/repo.ts';
import { fromUnits } from '../render/format.ts';

export interface CoinMeta {
  symbol: string;
  decimals: number;
}

function lastSeg(coinType: string): string {
  return coinType.split('::').pop() ?? coinType;
}

/** Ensure the address portion of a coin type carries a 0x prefix. */
function canonical(coinType: string): string {
  return coinType.startsWith('0x') ? coinType : '0x' + coinType;
}

/** Caches coin symbol/decimals lookups (in-memory + SQLite) and formats amounts. */
export class Coins {
  private mem = new Map<string, CoinMeta>();

  constructor(
    private sui: Sui,
    private cache: Cache,
    private noCache = false,
  ) {}

  async meta(coinType: string): Promise<CoinMeta> {
    const ct = canonical(coinType);
    const cached = this.mem.get(ct);
    if (cached) return cached;
    const m = await this.cache.through<CoinMeta | undefined>(
      'coin-meta',
      ct,
      { immutable: true, noCache: this.noCache },
      () => this.sui.getCoinMeta(ct),
    );
    const meta = m ?? { symbol: lastSeg(ct), decimals: 0 };
    this.mem.set(ct, meta);
    return meta;
  }

  /** Human amount with symbol, e.g. "1,234.56 USDC". */
  async format(coinType: string, raw: string | bigint): Promise<string> {
    const m = await this.meta(coinType);
    return `${fromUnits(raw, m.decimals)} ${m.symbol}`;
  }
}
