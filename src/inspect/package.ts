import type { Sui, NormalizedPackage } from '../client/grpc.ts';
import type { Cache } from '../cache/repo.ts';
import type { GlobalOptions } from '../types.ts';
import { normalizeAddress } from '../util/address.ts';
import { labelFor } from '../registry/known.ts';
import { header, dim, c } from '../render/format.ts';

// Enum maps (from @mysten/sui/grpc GrpcTypes).
const ABILITY = ['?', 'copy', 'drop', 'store', 'key'];
const VISIBILITY = ['?', '', 'public ', 'public(friend) ']; // PRIVATE renders as ''
const PRIM = ['?', 'address', 'bool', 'u8', 'u16', 'u32', 'u64', 'u128', 'u256'];
const TYPE = { VECTOR: 9, DATATYPE: 10, TYPE_PARAM: 11 } as const;
const REF = ['', '&', '&mut '];

interface SigBody {
  type: number;
  typeName?: string;
  typeParameter?: number;
  typeParameterInstantiation?: SigBody[];
}
interface OpenSig {
  reference?: number;
  body: SigBody;
}
interface TypeParam {
  constraints?: number[];
  isPhantom?: boolean;
}
interface Datatype {
  name: string;
  module: string;
  kind: number; // 1 struct, 2 enum
  abilities?: number[];
  typeParameters?: TypeParam[];
  fields?: Array<{ name: string; type: SigBody }>;
  variants?: Array<{ name: string; fields?: Array<{ name: string; type: SigBody }> }>;
}
interface FunctionDesc {
  name: string;
  visibility?: number;
  isEntry?: boolean;
  typeParameters?: TypeParam[];
  parameters?: OpenSig[];
  returns?: OpenSig[];
}

function shortType(typeName?: string): string {
  if (!typeName) return '?';
  const parts = typeName.split('::');
  if (parts.length >= 3) return `${parts[1]}::${parts[2]}`;
  return typeName;
}

function renderBody(b: SigBody): string {
  if (b.type < PRIM.length) return PRIM[b.type]!;
  if (b.type === TYPE.VECTOR) {
    const inner = b.typeParameterInstantiation?.[0];
    return `vector<${inner ? renderBody(inner) : '?'}>`;
  }
  if (b.type === TYPE.TYPE_PARAM) return `T${b.typeParameter ?? 0}`;
  if (b.type === TYPE.DATATYPE) {
    const generics = b.typeParameterInstantiation ?? [];
    const g = generics.length ? `<${generics.map(renderBody).join(', ')}>` : '';
    return `${shortType(b.typeName)}${g}`;
  }
  return '?';
}

function renderParam(p: OpenSig): string {
  return `${REF[p.reference ?? 0] ?? ''}${renderBody(p.body)}`;
}

function renderTypeParams(tps?: TypeParam[]): string {
  if (!tps || tps.length === 0) return '';
  const items = tps.map((tp, i) => `${tp.isPhantom ? 'phantom ' : ''}T${i}`);
  return `<${items.join(', ')}>`;
}

function renderDatatype(d: Datatype): string[] {
  const kind = d.kind === 2 ? 'enum' : 'struct';
  const abil = (d.abilities ?? []).map((a) => ABILITY[a]).filter(Boolean);
  const abilStr = abil.length ? ` has ${abil.join(', ')}` : '';
  const head = `  ${c.yellow(kind)} ${c.bold(d.name)}${renderTypeParams(d.typeParameters)}${dim(abilStr)}`;
  const lines = [head];
  if (d.kind === 2) {
    for (const v of d.variants ?? []) {
      const fields = (v.fields ?? []).map((f) => `${f.name}: ${renderBody(f.type)}`).join(', ');
      lines.push(`      ${v.name}${fields ? `(${fields})` : ''}`);
    }
  } else {
    for (const f of d.fields ?? []) lines.push(`      ${dim(f.name + ':')} ${renderBody(f.type)}`);
  }
  return lines;
}

function renderFunction(f: FunctionDesc): string {
  const vis = VISIBILITY[f.visibility ?? 1] ?? '';
  const entry = f.isEntry ? 'entry ' : '';
  const params = (f.parameters ?? []).map(renderParam).join(', ');
  const rets = (f.returns ?? []).map(renderParam);
  const retStr = rets.length === 0 ? '' : rets.length === 1 ? `: ${rets[0]}` : `: (${rets.join(', ')})`;
  return `  ${dim(vis + entry + 'fun')} ${c.bold(f.name)}${renderTypeParams(f.typeParameters)}(${params})${retStr}`;
}

export async function inspectPackage(
  sui: Sui,
  cache: Cache,
  opts: GlobalOptions,
  packageId: string,
): Promise<void> {
  const id = normalizeAddress(packageId);
  const pkg = await cache.through<NormalizedPackage>(
    'pkg-normalized',
    id,
    { immutable: true, noCache: opts.noCache },
    () => sui.getPackageNormalized(id),
  );

  if (opts.json) {
    console.log(JSON.stringify(pkg, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }

  const label = labelFor(id);
  console.log(header('Package ' + id) + (label ? '  ' + dim(`(${label})`) : ''));
  console.log(
    '  ' +
      dim(`original: ${pkg.originalId}  version: ${pkg.version}  modules: ${pkg.modules.length}`),
  );

  for (const mod of pkg.modules) {
    const datatypes = (mod.datatypes ?? []) as Datatype[];
    const functions = (mod.functions ?? []) as FunctionDesc[];
    console.log();
    console.log(
      c.cyan(c.bold('module ' + mod.name)) +
        dim(`  (${datatypes.length} types, ${functions.length} functions)`),
    );
    for (const d of datatypes) for (const line of renderDatatype(d)) console.log(line);
    if (datatypes.length && functions.length) console.log();
    // Public/entry functions first for readability.
    const sorted = [...functions].sort((a, b) => {
      const ap = a.visibility === 2 || a.isEntry ? 0 : 1;
      const bp = b.visibility === 2 || b.isEntry ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    });
    for (const f of sorted) console.log(renderFunction(f));
  }
}
