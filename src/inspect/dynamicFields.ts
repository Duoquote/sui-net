import type { Sui } from '../client/grpc.ts';
import type { GlobalOptions } from '../types.ts';
import { normalizeAddress, shortAddress } from '../util/address.ts';
import { header, dim, c } from '../render/format.ts';

const KIND = ['unknown', 'field', 'object'];

interface DynField {
  kind?: number; // 1 FIELD, 2 OBJECT
  fieldId?: string;
  name?: { name?: string; value?: Uint8Array };
  valueType?: string;
}

function shortType(type?: string): string {
  return type ? type.replace(/0x[0-9a-fA-F]+::/g, '') : '?';
}

/** Best-effort render of a dynamic-field key's BCS value, using its type. */
function renderKeyValue(value?: Uint8Array, keyType?: string): string {
  if (!value || value.length === 0) return '';
  if (/::(string::String|ascii::String)$/.test(keyType ?? '')) {
    // BCS string: a 1-byte ULEB length prefix when it matches the remaining length.
    const body = value[0] === value.length - 1 ? value.subarray(1) : value;
    const s = new TextDecoder().decode(body);
    return JSON.stringify(s.length > 40 ? s.slice(0, 38) + '…' : s);
  }
  if (value.length === 32) return shortAddress('0x' + Buffer.from(value).toString('hex'));
  if (value.length <= 16) {
    let v = 0n;
    for (let i = value.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(value[i]!);
    return v.toString();
  }
  const hex = '0x' + Buffer.from(value).toString('hex');
  return hex.length > 26 ? hex.slice(0, 24) + '…' : hex;
}

export async function inspectFields(
  sui: Sui,
  _cache: unknown,
  opts: GlobalOptions,
  parentId: string,
  limit = 50,
): Promise<void> {
  const id = normalizeAddress(parentId);
  // Dynamic field listings are mutable, so always fetch fresh.
  const r = await sui.listDynamicFields(id, {
    pageSize: limit,
    paths: ['field_id', 'name', 'value_type', 'kind'],
  });
  const fields = (r.dynamicFields ?? []) as DynField[];

  if (opts.json) {
    console.log(
      JSON.stringify(
        fields.map((f) => ({
          kind: KIND[f.kind ?? 0],
          fieldId: f.fieldId,
          nameType: f.name?.name,
          nameValue: f.name?.value ? '0x' + Buffer.from(f.name.value).toString('hex') : undefined,
          valueType: f.valueType,
        })),
        null,
        2,
      ),
    );
    return;
  }

  console.log(header('Dynamic fields of ' + id));
  const more = r.nextPageToken ? c.dim(` (showing first ${fields.length}, more available)`) : '';
  console.log('  ' + dim(`${fields.length} field(s)`) + more);
  if (fields.length === 0) {
    console.log('  ' + dim('— none —'));
    return;
  }
  console.log();
  fields.forEach((f, i) => {
    const kind = KIND[f.kind ?? 0]!;
    const key = shortType(f.name?.name);
    const keyVal = renderKeyValue(f.name?.value, f.name?.name);
    const valType = shortType(f.valueType);
    console.log(
      `  ${dim('[' + i + ']')} ${c.yellow(kind)} ${c.bold(key)}${keyVal ? dim(' = ' + keyVal) : ''}`,
    );
    console.log(`       ${dim('→ ' + valType)}  ${dim(shortAddress(f.fieldId ?? ''))}`);
  });
}
