import { getDb } from './db.ts';

const NETWORK = 'mainnet';

// Tagged codec so cached JSON round-trips bigint and Uint8Array (module bytecode).
function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return { __bi__: v.toString() };
    if (v instanceof Uint8Array) return { __u8__: Buffer.from(v).toString('base64') };
    return v;
  });
}

function decode<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object') {
      if (typeof v.__bi__ === 'string') return BigInt(v.__bi__);
      if (typeof v.__u8__ === 'string') return new Uint8Array(Buffer.from(v.__u8__, 'base64'));
    }
    return v;
  }) as T;
}

export interface ReadOpts {
  immutable?: boolean;
  ttlMs?: number;
  noCache?: boolean;
}

export class Cache {
  read<T>(kind: string, key: string, opts: ReadOpts = {}): T | undefined {
    if (opts.noCache) return undefined;
    const row = getDb()
      .query('SELECT value, fetched_at, immutable FROM cache WHERE network = ? AND kind = ? AND key = ?')
      .get(NETWORK, kind, key) as
      | { value: string; fetched_at: number; immutable: number }
      | null;
    if (!row) return undefined;
    if (row.immutable) return decode<T>(row.value);
    const ttl = opts.ttlMs ?? 0;
    if (ttl > 0 && Date.now() - row.fetched_at < ttl) return decode<T>(row.value);
    return undefined;
  }

  write(kind: string, key: string, value: unknown, immutable = false): void {
    getDb().run(
      `INSERT INTO cache (network, kind, key, value, fetched_at, immutable)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(network, kind, key) DO UPDATE SET
         value = excluded.value, fetched_at = excluded.fetched_at, immutable = excluded.immutable`,
      [NETWORK, kind, key, encode(value), Date.now(), immutable ? 1 : 0],
    );
  }

  /** Cache-through: return cached value or fetch, store, and return it. */
  async through<T>(
    kind: string,
    key: string,
    opts: ReadOpts & { immutable?: boolean },
    fetch: () => Promise<T>,
  ): Promise<T> {
    const hit = this.read<T>(kind, key, opts);
    if (hit !== undefined) return hit;
    const value = await fetch();
    this.write(kind, key, value, opts.immutable ?? false);
    return value;
  }
}
