import type { Sui } from '../client/grpc.ts';
import type { Cache } from '../cache/repo.ts';
import type { GlobalOptions } from '../types.ts';
import { lookupKnown } from '../registry/known.ts';
import { shortAddress } from '../util/address.ts';
import { header, dim, c } from '../render/format.ts';

interface Input {
  objectId?: string;
}
interface ExecutedTx {
  transaction?: { kind?: { data?: { programmableTransaction?: { inputs: Input[] } } } };
}
interface RawObject {
  objectId?: string;
  objectType?: string;
}

// Struct names that denote a tradeable venue (excludes Registry/Config/etc.):
// DEX pools/pairs plus lending money markets (Scallop/Suilend-style).
const POOL_STRUCTS = new Set(['Pool', 'LBPair', 'Pair', 'TradingPair', 'Market', 'LendingMarket']);

function poolStructName(type: string): string {
  return type.split('<')[0]!.split('::').pop() ?? '';
}

export async function extractPools(
  sui: Sui,
  cache: Cache,
  opts: GlobalOptions,
  digest: string,
): Promise<void> {
  const tx = (await cache.through<ExecutedTx>(
    'tx',
    digest,
    { immutable: true, noCache: opts.noCache },
    () => sui.getTransaction(digest) as Promise<ExecutedTx>,
  )) as ExecutedTx;

  const inputs = tx.transaction?.kind?.data?.programmableTransaction?.inputs ?? [];
  const ids = [...new Set(inputs.map((i) => i.objectId).filter(Boolean))] as string[];

  // Resolve object types concurrently (type-only mask, cached).
  const resolved = await Promise.all(
    ids.map(async (id) => {
      try {
        const o = (await cache.through<RawObject>(
          'object-type',
          id,
          { noCache: opts.noCache, ttlMs: opts.cacheTtlMs, immutable: true },
          () => sui.getObject(id, ['object_id', 'object_type']) as Promise<RawObject>,
        )) as RawObject;
        return o?.objectType ? { id, type: o.objectType } : undefined;
      } catch {
        return undefined;
      }
    }),
  );

  const pools = resolved.filter(
    (r): r is { id: string; type: string } => !!r && POOL_STRUCTS.has(poolStructName(r.type)),
  );

  // Group by package (protocol).
  const byPkg = new Map<string, { id: string; type: string }[]>();
  for (const p of pools) {
    const pkg = p.type.split('::')[0]!;
    const arr = byPkg.get(pkg) ?? [];
    arr.push(p);
    byPkg.set(pkg, arr);
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        pools.map((p) => ({ poolId: p.id, type: p.type, protocol: lookupKnown(p.type.split('::')[0]!)?.name })),
        null,
        2,
      ),
    );
    return;
  }

  console.log(header('Pools in ' + digest));
  console.log('  ' + dim(`${pools.length} pool(s) across ${byPkg.size} protocol(s)`));

  // Known protocols first.
  const groups = [...byPkg.entries()].sort((a, b) => {
    const ka = lookupKnown(a[0]);
    const kb = lookupKnown(b[0]);
    if (!!ka !== !!kb) return ka ? -1 : 1;
    return (ka?.name ?? a[0]).localeCompare(kb?.name ?? b[0]);
  });

  for (const [pkg, ps] of groups) {
    const known = lookupKnown(pkg);
    const title = known ? `${c.green(known.name)} ${dim('· ' + known.kind)}` : dim('unknown ' + shortAddress(pkg));
    console.log('\n  ' + title + dim(`  (${ps.length})`));
    for (const p of ps) {
      const struct = p.type.replace(/0x[0-9a-fA-F]+::/g, '');
      console.log(`    ${p.id}  ${dim(struct)}`);
    }
  }
}
