import { Module, type FunctionDef, type Instruction } from './model.ts';

const VIS: Record<string, string> = { Public: 'public ', Friend: 'public(friend) ', Private: '' };

function opAndArg(ins: Instruction): { op: string; arg: unknown } {
  if (typeof ins === 'string') return { op: ins, arg: undefined };
  const op = Object.keys(ins)[0]!;
  return { op, arg: (ins as Record<string, unknown>)[op] };
}

/** Render a single instruction with resolved references. */
export function renderInstruction(mod: Module, ins: Instruction): string {
  const { op, arg } = opAndArg(ins);
  const a = arg as number;
  switch (op) {
    case 'LdConst':
      return `LdConst ${mod.constant(a)}`;
    case 'Call':
      return `Call ${mod.funcName(a)}`;
    case 'CallGeneric':
      return `CallGeneric ${mod.funcInstName(a)}`;
    case 'Pack':
      return `Pack ${mod.structName(a)}`;
    case 'Unpack':
      return `Unpack ${mod.structName(a)}`;
    case 'PackGeneric':
      return `PackGeneric ${mod.structInstName(a)}`;
    case 'UnpackGeneric':
      return `UnpackGeneric ${mod.structInstName(a)}`;
    case 'MutBorrowField':
      return `MutBorrowField .${mod.fieldName(a)}`;
    case 'ImmBorrowField':
      return `ImmBorrowField .${mod.fieldName(a)}`;
    case 'MutBorrowFieldGeneric':
      return `MutBorrowFieldGeneric .${mod.fieldInstName(a)}`;
    case 'ImmBorrowFieldGeneric':
      return `ImmBorrowFieldGeneric .${mod.fieldInstName(a)}`;
    case 'CopyLoc':
    case 'MoveLoc':
    case 'StLoc':
    case 'MutBorrowLoc':
    case 'ImmBorrowLoc':
      return `${op} loc${a}`;
    case 'BrTrue':
    case 'BrFalse':
    case 'Branch':
      return `${op} @${a}`;
    case 'LdU8':
    case 'LdU16':
    case 'LdU32':
    case 'LdU64':
    case 'LdU128':
    case 'LdU256':
      return `${op} ${a}`;
    case 'VecPack':
    case 'VecUnpack': {
      const [sigIdx, num] = arg as [number, number];
      const el = mod.signature(sigIdx)[0];
      return `${op} <${el ? mod.renderToken(el) : '?'}> ${num}`;
    }
    case 'VecLen':
    case 'VecImmBorrow':
    case 'VecMutBorrow':
    case 'VecPushBack':
    case 'VecPopBack':
    case 'VecSwap': {
      const el = mod.signature(a)[0];
      return `${op} <${el ? mod.renderToken(el) : '?'}>`;
    }
    default:
      return arg === undefined ? op : `${op} ${JSON.stringify(arg)}`;
  }
}

/** Branch targets referenced anywhere in a code block (for labelling). */
function branchTargets(code: Instruction[]): Set<number> {
  const t = new Set<number>();
  for (const ins of code) {
    const { op, arg } = opAndArg(ins);
    if (op === 'BrTrue' || op === 'BrFalse' || op === 'Branch') t.add(arg as number);
  }
  return t;
}

export function functionSignature(mod: Module, def: FunctionDef): string {
  const fh = mod.functionHandles[def.function]!;
  const name = mod.ident(fh.name);
  const vis = VIS[def.visibility] ?? '';
  const entry = def.is_entry ? 'entry ' : '';
  const tparams = fh.type_parameters.length
    ? `<${fh.type_parameters.map((_, i) => `T${i}`).join(', ')}>`
    : '';
  const params = mod.renderSignature(fh.parameters);
  const ret = mod.renderSignature(fh.return_);
  const retStr = ret ? `: ${ret}` : '';
  return `${vis}${entry}fun ${name}${tparams}(${params})${retStr}`;
}

export function disassembleFunction(mod: Module, def: FunctionDef): string[] {
  const lines: string[] = [functionSignature(mod, def) + (def.code ? ' {' : ' /* native */')];
  if (!def.code) return lines;
  const locals = mod.signature(def.code.locals).map((t) => mod.renderToken(t));
  if (locals.length) lines.push(`  locals: ${locals.join(', ')}`);
  const code = def.code.code;
  const targets = branchTargets(code);
  code.forEach((ins, i) => {
    const label = targets.has(i) ? `>${String(i).padStart(3)}` : ` ${String(i).padStart(3)}`;
    lines.push(`  ${label}: ${renderInstruction(mod, ins)}`);
  });
  lines.push('}');
  return lines;
}
