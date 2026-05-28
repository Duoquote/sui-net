import type { Sui } from '../client/grpc.ts';
import type { GlobalOptions } from '../types.ts';
import type { Cache } from '../cache/repo.ts';
import { decodeValue, type Plain, toJson } from '../util/value.ts';
import { labelFor } from '../registry/known.ts';
import { header, kv, dim, c } from '../render/format.ts';

const OWNER_KINDS: Record<number, string> = {
  0: 'Unknown',
  1: 'Address',
  2: 'Object (child)',
  3: 'Shared',
  4: 'Immutable',
};

interface RawObject {
  objectId?: string;
  version?: string | bigint;
  digest?: string;
  objectType?: string;
  owner?: { kind?: number; address?: string; version?: string | bigint };
  hasPublicTransfer?: boolean;
  previousTransaction?: string;
  storageRebate?: string | bigint;
  json?: unknown;
}

/** Annotate a fully-qualified type with a known protocol name when recognized. */
export function annotateType(type: string): string {
  const addr = type.split('::')[0];
  const name = labelFor(addr);
  return name ? `${type}  ${dim(`(${name})`)}` : type;
}

function renderOwner(owner?: RawObject['owner']): string {
  if (!owner) return 'unknown';
  const kind = OWNER_KINDS[owner.kind ?? 0] ?? `kind ${owner.kind}`;
  if (owner.kind === 3) return `${kind} (initial v${owner.version})`;
  if (owner.address) return `${kind} ${owner.address}`;
  return kind;
}

function renderFields(fields: Plain, indent = 2): string[] {
  const lines: string[] = [];
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    lines.push(' '.repeat(indent) + toJson(fields));
    return lines;
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || typeof v !== 'object') {
      lines.push(kv(k, String(v), indent));
    } else {
      lines.push(' '.repeat(indent) + dim(k + ':'));
      lines.push(
        toJson(v)
          .split('\n')
          .map((l) => ' '.repeat(indent + 2) + l)
          .join('\n'),
      );
    }
  }
  return lines;
}

export async function inspectObject(
  sui: Sui,
  cache: Cache,
  opts: GlobalOptions,
  objectId: string,
): Promise<void> {
  const obj = (await cache.through<RawObject>(
    'object',
    objectId,
    { noCache: opts.noCache, ttlMs: opts.cacheTtlMs },
    () => sui.getObject(objectId) as Promise<RawObject>,
  )) as RawObject;

  const fields = decodeValue(obj.json as never);

  if (opts.json) {
    console.log(
      toJson({
        objectId: obj.objectId,
        version: obj.version,
        digest: obj.digest,
        type: obj.objectType,
        owner: obj.owner,
        hasPublicTransfer: obj.hasPublicTransfer,
        previousTransaction: obj.previousTransaction,
        storageRebate: obj.storageRebate,
        fields,
      }),
    );
    return;
  }

  console.log(header('Object ' + obj.objectId));
  console.log(kv('type', annotateType(obj.objectType ?? 'unknown'), 2));
  console.log(kv('version', String(obj.version), 2));
  console.log(kv('digest', String(obj.digest), 2));
  console.log(kv('owner', renderOwner(obj.owner), 2));
  if (obj.previousTransaction) console.log(kv('last tx', obj.previousTransaction, 2));
  if (obj.storageRebate) console.log(kv('storage rebate', String(obj.storageRebate), 2));
  console.log();
  console.log(c.bold('Fields'));
  for (const line of renderFields(fields)) console.log(line);
}
