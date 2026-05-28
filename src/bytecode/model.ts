import type { CompiledModule } from './deserialize.ts';

export type SigToken =
  | string // "Bool" | "U8".."U256" | "Address" | "Signer"
  | { Reference: SigToken }
  | { MutableReference: SigToken }
  | { Vector: SigToken }
  | { Datatype: number }
  | { DatatypeInstantiation: [number, SigToken[]] }
  | { TypeParameter: number };

export type Instruction = string | Record<string, unknown>;

export interface CodeUnit {
  locals: number;
  code: Instruction[];
  jump_tables?: unknown[];
}
export interface FunctionDef {
  function: number;
  visibility: string;
  is_entry: boolean;
  code?: CodeUnit;
}
export interface DatatypeHandle {
  module: number;
  name: number;
  abilities: number;
  type_parameters: Array<{ constraints: number; is_phantom: boolean }>;
}
export interface FunctionHandle {
  module: number;
  name: number;
  parameters: number;
  return_: number;
  type_parameters: number[];
}

const PRIMS: Record<string, string> = {
  Bool: 'bool',
  U8: 'u8',
  U16: 'u16',
  U32: 'u32',
  U64: 'u64',
  U128: 'u128',
  U256: 'u256',
  Address: 'address',
  Signer: 'signer',
};

/** Typed, name-resolving wrapper over a deserialized CompiledModule. */
export class Module {
  constructor(public m: CompiledModule) {}

  private get<T>(key: string): T[] {
    return (this.m[key] as T[]) ?? [];
  }
  ident(i: number): string {
    return this.m.identifiers[i] ?? `id#${i}`;
  }
  addr(i: number): string {
    return this.m.address_identifiers[i] ?? `addr#${i}`;
  }

  get functionDefs(): FunctionDef[] {
    return this.get<FunctionDef>('function_defs');
  }
  get structDefs() {
    return this.get<{ struct_handle: number; field_information: unknown }>('struct_defs');
  }
  get datatypeHandles(): DatatypeHandle[] {
    return this.get<DatatypeHandle>('datatype_handles');
  }
  get functionHandles(): FunctionHandle[] {
    return this.get<FunctionHandle>('function_handles');
  }
  signature(i: number): SigToken[] {
    return (this.get<SigToken[]>('signatures')[i] as SigToken[]) ?? [];
  }

  /** module name for a module-handle index (qualified only when external). */
  moduleLabel(modHandleIdx: number): { addr: string; name: string; isSelf: boolean } {
    const mh = this.m.module_handles[modHandleIdx]!;
    const isSelf = modHandleIdx === this.m.self_module_handle_idx;
    return { addr: this.addr(mh.address), name: this.ident(mh.name), isSelf };
  }

  datatypeName(idx: number): string {
    const dh = this.datatypeHandles[idx];
    if (!dh) return `datatype#${idx}`;
    const ml = this.moduleLabel(dh.module);
    const n = this.ident(dh.name);
    return ml.isSelf ? n : `${ml.name}::${n}`;
  }

  /** Render a SignatureToken into Move-like text. */
  renderToken(t: SigToken): string {
    if (typeof t === 'string') return PRIMS[t] ?? t.toLowerCase();
    if ('Reference' in t) return '&' + this.renderToken(t.Reference);
    if ('MutableReference' in t) return '&mut ' + this.renderToken(t.MutableReference);
    if ('Vector' in t) return `vector<${this.renderToken(t.Vector)}>`;
    if ('TypeParameter' in t) return `T${t.TypeParameter}`;
    if ('Datatype' in t) return this.datatypeName(t.Datatype);
    if ('DatatypeInstantiation' in t) {
      const [idx, args] = t.DatatypeInstantiation;
      return `${this.datatypeName(idx)}<${args.map((a) => this.renderToken(a)).join(', ')}>`;
    }
    return '?';
  }

  renderSignature(sigIdx: number): string {
    return this.signature(sigIdx).map((t) => this.renderToken(t)).join(', ');
  }

  /** Resolve a function-handle index to "module::name". */
  funcName(handleIdx: number): string {
    const fh = this.functionHandles[handleIdx];
    if (!fh) return `func#${handleIdx}`;
    const ml = this.moduleLabel(fh.module);
    const n = this.ident(fh.name);
    return ml.isSelf ? n : `${ml.name}::${n}`;
  }

  /** Resolve a function-instantiation index to "module::name<types>". */
  funcInstName(instIdx: number): string {
    const fi = this.get<{ handle: number; type_parameters: number }>('function_instantiations')[instIdx];
    if (!fi) return `funcInst#${instIdx}`;
    const types = this.renderSignature(fi.type_parameters);
    return `${this.funcName(fi.handle)}<${types}>`;
  }

  structName(defIdx: number): string {
    const sd = this.structDefs[defIdx];
    return sd ? this.datatypeName(sd.struct_handle) : `struct#${defIdx}`;
  }
  structInstName(instIdx: number): string {
    const si = this.get<{ def: number; type_parameters: number }>('struct_def_instantiations')[instIdx];
    if (!si) return `structInst#${instIdx}`;
    return `${this.structName(si.def)}<${this.renderSignature(si.type_parameters)}>`;
  }

  /** Field name from a field-handle index. */
  fieldName(fhIdx: number): string {
    const fh = this.get<{ owner: number; field: number }>('field_handles')[fhIdx];
    if (!fh) return `field#${fhIdx}`;
    const sd = this.structDefs[fh.owner] as { field_information?: { Declared?: Array<{ name: number }> } };
    const decl = sd?.field_information?.Declared?.[fh.field];
    return decl ? this.ident(decl.name) : `field#${fhIdx}`;
  }
  fieldInstName(fiIdx: number): string {
    const fi = this.get<{ handle: number }>('field_instantiations')[fiIdx];
    return fi ? this.fieldName(fi.handle) : `fieldInst#${fiIdx}`;
  }

  /** Decode a constant-pool entry to a readable literal. */
  constant(idx: number): string {
    const cp = this.get<{ type_: SigToken; data: number[] }>('constant_pool')[idx];
    if (!cp) return `const#${idx}`;
    const t = cp.type_;
    const bytes = Uint8Array.from(cp.data);
    const leInt = () => {
      let v = 0n;
      for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
      return v;
    };
    if (t === 'Bool') return bytes[0] ? 'true' : 'false';
    if (t === 'U8') return String(bytes[0] ?? 0);
    if (t === 'U16' || t === 'U32' || t === 'U64' || t === 'U128' || t === 'U256') return leInt().toString();
    if (t === 'Address') return '0x' + Buffer.from(bytes).toString('hex');
    if (typeof t === 'object' && 'Vector' in t && t.Vector === 'U8') {
      // BCS vector<u8>: ULEB length + bytes. Show as string if printable.
      const body = bytes[0] === bytes.length - 1 ? bytes.subarray(1) : bytes;
      const s = Buffer.from(body).toString('utf8');
      return /^[\x20-\x7e]*$/.test(s) ? JSON.stringify(s) : '0x' + Buffer.from(bytes).toString('hex');
    }
    return '0x' + Buffer.from(bytes).toString('hex');
  }

  /** Self-package address + module name (e.g. for headers). */
  selfLabel(): { addr: string; name: string } {
    const ml = this.moduleLabel(this.m.self_module_handle_idx);
    return { addr: ml.addr, name: ml.name };
  }
}
