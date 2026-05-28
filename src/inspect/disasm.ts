import type { Sui, BytecodePackage } from '../client/grpc.ts';
import type { Cache } from '../cache/repo.ts';
import type { GlobalOptions } from '../types.ts';
import { deserialize } from '../bytecode/deserialize.ts';
import { Module, type FunctionDef } from '../bytecode/model.ts';
import { disassembleFunction } from '../bytecode/disassemble.ts';
import { decompileFunction } from '../bytecode/decompile.ts';
import { normalizeAddress } from '../util/address.ts';
import { header, dim, c } from '../render/format.ts';

export async function inspectDisasm(
  sui: Sui,
  cache: Cache,
  opts: GlobalOptions,
  packageId: string,
  target?: string,
  mode: 'disasm' | 'decompile' = 'disasm',
): Promise<void> {
  const id = normalizeAddress(packageId);
  const pkg = await cache.through<BytecodePackage>(
    'pkg-bytecode',
    id,
    { immutable: true, noCache: opts.noCache },
    () => sui.getPackageBytecode(id),
  );

  // target can be "module", "module::fn", or "fn".
  let modFilter: string | undefined;
  let fnFilter: string | undefined;
  if (target) {
    if (target.includes('::')) [modFilter, fnFilter] = target.split('::') as [string, string];
    else fnFilter = target;
  }

  const modules = await Promise.all(pkg.modules.map((m) => deserialize(m.contents)));
  const wrapped = modules.map((cm) => new Module(cm));

  const render = (mod: Module, def: FunctionDef) =>
    mode === 'decompile' ? decompileFunction(mod, def) : disassembleFunction(mod, def);

  console.log(header((mode === 'decompile' ? 'Decompiled ' : 'Disassembly ') + id));
  if (mode === 'decompile') console.log(dim('  approximate reconstruction — verify against disasm/source'));
  for (const mod of wrapped) {
    const self = mod.selfLabel();
    if (modFilter && self.name !== modFilter) continue;

    const defs = mod.functionDefs.filter((d) => {
      const name = mod.ident(mod.functionHandles[d.function]!.name);
      if (fnFilter) return name === fnFilter;
      return true;
    });
    if (defs.length === 0) continue;

    console.log('\n' + c.cyan(c.bold(`module ${self.name}`)) + dim(`  (${defs.length} function(s))`));
    for (const def of defs) {
      console.log();
      for (const line of render(mod, def)) console.log('  ' + line);
    }
  }
}
