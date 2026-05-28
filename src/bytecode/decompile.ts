import { Module, type FunctionDef, type Instruction } from './model.ts';
import { functionSignature } from './disassemble.ts';

// A best-effort Move decompiler. It reconstructs expressions by simulating the
// Move stack machine linearly, recovers `assert!`, and renders control flow as
// labelled `if (...) goto` / `goto` when it cannot be fully structured. Output
// is approximate (in the spirit of Revela), not a byte-perfect source.

const BINOPS: Record<string, string> = {
  Add: '+', Sub: '-', Mul: '*', Div: '/', Mod: '%',
  BitOr: '|', BitAnd: '&', Xor: '^', Shl: '<<', Shr: '>>',
  Or: '||', And: '&&', Eq: '==', Neq: '!=', Lt: '<', Gt: '>', Le: '<=', Ge: '>=',
};
const CASTS: Record<string, string> = {
  CastU8: 'u8', CastU16: 'u16', CastU32: 'u32', CastU64: 'u64', CastU128: 'u128', CastU256: 'u256',
};

function opAndArg(ins: Instruction): { op: string; arg: unknown } {
  if (typeof ins === 'string') return { op: ins, arg: undefined };
  const op = Object.keys(ins)[0]!;
  return { op, arg: (ins as Record<string, unknown>)[op] };
}

export function decompileFunction(mod: Module, def: FunctionDef): string[] {
  const sig = functionSignature(mod, def);
  if (!def.code) return [sig + ' /* native */'];

  const fh = mod.functionHandles[def.function]!;
  const nParams = mod.signature(fh.parameters).length;
  const nRet = mod.signature(fh.return_).length;
  const code = def.code.code;

  // Branch targets get labels.
  const targets = new Set<number>();
  for (const ins of code) {
    const { op, arg } = opAndArg(ins);
    if (op === 'BrTrue' || op === 'BrFalse' || op === 'Branch') targets.add(arg as number);
  }

  const localName = (n: number) => (n < nParams ? `a${n}` : `v${n}`);
  const declared = new Set<number>();
  for (let i = 0; i < nParams; i++) declared.add(i);

  const stack: string[] = [];
  const out: string[] = [];
  const temps = { n: 0 };
  const push = (e: string) => stack.push(e);
  const pop = () => stack.pop() ?? '/* underflow */';
  const popN = (n: number) => {
    const xs: string[] = [];
    for (let i = 0; i < n; i++) xs.unshift(pop());
    return xs;
  };
  const emit = (s: string) => out.push(s);

  for (let i = 0; i < code.length; i++) {
    if (targets.has(i)) emit(`L${i}:`);

    // assert! pattern: BrTrue @ok ; <push code> ; Abort ; (ok == i+3)
    const cur = code[i]!;
    const { op, arg } = opAndArg(cur);
    if (op === 'BrTrue') {
      const a2 = code[i + 1] ? opAndArg(code[i + 1]!) : undefined;
      const a3 = code[i + 2] ? opAndArg(code[i + 2]!) : undefined;
      if (a2 && a3 && a3.op === 'Abort' && (arg as number) === i + 3) {
        const codeExpr =
          a2.op === 'LdConst' ? mod.constant(a2.arg as number)
          : a2.op.startsWith('LdU') ? String(a2.arg)
          : '?';
        emit(`assert!(${pop()}, ${codeExpr});`);
        i += 2;
        continue;
      }
      emit(`if (${pop()}) goto L${arg};`);
      continue;
    }

    if (op in BINOPS) {
      const [a, b] = popN(2);
      push(`(${a} ${BINOPS[op]} ${b})`);
      continue;
    }
    if (op in CASTS) {
      push(`(${pop()} as ${CASTS[op]})`);
      continue;
    }

    switch (op) {
      case 'LdTrue': push('true'); break;
      case 'LdFalse': push('false'); break;
      case 'LdU8': case 'LdU16': case 'LdU32': case 'LdU64': case 'LdU128': case 'LdU256':
        push(String(arg)); break;
      case 'LdConst': push(mod.constant(arg as number)); break;
      case 'CopyLoc': case 'MoveLoc': push(localName(arg as number)); break;
      case 'ImmBorrowLoc': push(`&${localName(arg as number)}`); break;
      case 'MutBorrowLoc': push(`&mut ${localName(arg as number)}`); break;
      case 'StLoc': {
        const n = arg as number;
        const v = pop();
        if (declared.has(n)) emit(`${localName(n)} = ${v};`);
        else { declared.add(n); emit(`let ${localName(n)} = ${v};`); }
        break;
      }
      case 'Pop': { const e = pop(); if (e.includes('(')) emit(`${e};`); break; } // keep only side-effecting (call) results
      case 'ReadRef': push(`*${pop()}`); break;
      case 'WriteRef': { const v = pop(); const r = pop(); emit(`*${r} = ${v};`); break; }
      case 'FreezeRef': break; // ref coercion, leave expr as-is
      case 'Not': push(`!${pop()}`); break;
      case 'ImmBorrowField': push(`&${pop()}.${mod.fieldName(arg as number)}`); break;
      case 'MutBorrowField': push(`&mut ${pop()}.${mod.fieldName(arg as number)}`); break;
      case 'ImmBorrowFieldGeneric': push(`&${pop()}.${mod.fieldInstName(arg as number)}`); break;
      case 'MutBorrowFieldGeneric': push(`&mut ${pop()}.${mod.fieldInstName(arg as number)}`); break;
      case 'Call': emitCall(mod.funcName(arg as number), callArity(mod, arg as number, false), stack, emit, temps); break;
      case 'CallGeneric': emitCall(mod.funcInstName(arg as number), callArity(mod, arg as number, true), stack, emit, temps); break;
      case 'Pack': { const { fields, name } = structInfo(mod, arg as number, false); push(packExpr(name, fields, popN(fields.length))); break; }
      case 'PackGeneric': { const { fields, name } = structInfo(mod, arg as number, true); push(packExpr(name, fields, popN(fields.length))); break; }
      case 'Unpack': case 'UnpackGeneric': {
        const { fields, name } = structInfo(mod, arg as number, op === 'UnpackGeneric');
        const tmp = popN(1)[0];
        const names = fields.map((f) => `${f}`);
        emit(`let ${name} { ${names.join(', ')} } = ${tmp};`);
        for (const n of names) push(n);
        break;
      }
      case 'VecPack': { const [sigIdx, num] = arg as [number, number]; void sigIdx; push(`vector[${popN(num).join(', ')}]`); break; }
      case 'VecLen': push(`vector::length(${pop()})`); break;
      case 'VecImmBorrow': { const idx = pop(); const v = pop(); push(`&${v}[${idx}]`); break; }
      case 'VecMutBorrow': { const idx = pop(); const v = pop(); push(`&mut ${v}[${idx}]`); break; }
      case 'VecPushBack': { const val = pop(); const v = pop(); emit(`vector::push_back(${v}, ${val});`); break; }
      case 'VecPopBack': push(`vector::pop_back(${pop()})`); break;
      case 'Branch': emit(`goto L${arg};`); break;
      case 'BrFalse': emit(`if (!(${pop()})) goto L${arg};`); break;
      case 'Abort': emit(`abort ${pop()};`); break;
      case 'Ret': {
        const vals = popN(nRet);
        emit(nRet === 0 ? 'return;' : `return ${vals.length > 1 ? '(' + vals.join(', ') + ')' : vals[0]};`);
        break;
      }
      case 'Nop': break;
      default:
        emit(`/* ${op}${arg !== undefined ? ' ' + JSON.stringify(arg) : ''} */`);
    }
  }

  // Drop a trailing bare `return;`.
  if (out[out.length - 1] === 'return;') out.pop();

  return [sig + ' {', ...out.map((l) => (l.endsWith(':') ? l : '  ' + l)), '}'];
}

function callArity(mod: Module, idx: number, generic: boolean): { nargs: number; nret: number } {
  const handle = generic
    ? (mod.m['function_instantiations'] as Array<{ handle: number }>)[idx]!.handle
    : idx;
  const fh = mod.functionHandles[handle]!;
  return { nargs: mod.signature(fh.parameters).length, nret: mod.signature(fh.return_).length };
}

function structInfo(mod: Module, idx: number, generic: boolean): { fields: string[]; name: string } {
  const defIdx = generic
    ? (mod.m['struct_def_instantiations'] as Array<{ def: number }>)[idx]!.def
    : idx;
  const sd = mod.structDefs[defIdx] as {
    struct_handle: number;
    field_information?: { Declared?: Array<{ name: number }> };
  };
  const fields = (sd.field_information?.Declared ?? []).map((f) => mod.ident(f.name));
  const name = generic ? mod.structInstName(idx) : mod.structName(idx);
  return { fields, name: name.split('<')[0]! };
}

function packExpr(name: string, fields: string[], args: string[]): string {
  const parts = fields.map((f, i) => `${f}: ${args[i] ?? '?'}`);
  return `${name} { ${parts.join(', ')} }`;
}

function emitCall(
  name: string,
  arity: { nargs: number; nret: number },
  stack: string[],
  emit: (s: string) => void,
  temps: { n: number },
): void {
  const args: string[] = [];
  for (let i = 0; i < arity.nargs; i++) args.unshift(stack.pop() ?? '/* underflow */');
  const call = `${name}(${args.join(', ')})`;
  if (arity.nret === 0) emit(`${call};`);
  else if (arity.nret === 1) stack.push(call);
  else {
    // Multiple returns: bind to fresh temps so each can be referenced.
    const base = `t${temps.n++}`;
    const names = Array.from({ length: arity.nret }, (_, i) => `${base}_${i}`);
    emit(`let (${names.join(', ')}) = ${call};`);
    for (const n of names) stack.push(n);
  }
}
