// Decode the protobuf `Value` (google.protobuf.Value style, as emitted by the
// Sui gRPC `json` field) into plain JS. Move u64/u128/u256 arrive as strings,
// which we keep as-is to preserve precision.

type ProtoValue = {
  kind?: {
    oneofKind?: string;
    structValue?: { fields?: Record<string, ProtoValue> };
    listValue?: { values?: ProtoValue[] };
    stringValue?: string;
    numberValue?: number;
    boolValue?: boolean;
    nullValue?: unknown;
  };
};

export type Plain =
  | string
  | number
  | boolean
  | null
  | Plain[]
  | { [k: string]: Plain };

export function decodeValue(v: ProtoValue | undefined): Plain {
  const kind = v?.kind;
  if (!kind || !kind.oneofKind) return null;
  switch (kind.oneofKind) {
    case 'structValue': {
      const out: Record<string, Plain> = {};
      const fields = kind.structValue?.fields ?? {};
      for (const [k, val] of Object.entries(fields)) out[k] = decodeValue(val);
      return out;
    }
    case 'listValue':
      return (kind.listValue?.values ?? []).map(decodeValue);
    case 'stringValue':
      return kind.stringValue ?? '';
    case 'numberValue':
      return kind.numberValue ?? 0;
    case 'boolValue':
      return kind.boolValue ?? false;
    case 'nullValue':
      return null;
    default:
      return null;
  }
}

/** JSON.stringify replacer that renders bigint and Uint8Array safely. */
export function safeReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  return value;
}

export function toJson(value: unknown, indent = 2): string {
  return JSON.stringify(value, safeReplacer, indent);
}
