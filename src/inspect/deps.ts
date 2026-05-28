import type { Sui, BytecodePackage, LinkageEntry } from '../client/grpc.ts';
import type { Cache } from '../cache/repo.ts';
import type { GlobalOptions } from '../types.ts';
import { deserialize, selfModule, referencedModules } from '../bytecode/deserialize.ts';
import { normalizeAddress, shortAddress, bareAddress } from '../util/address.ts';
import { lookupKnown } from '../registry/known.ts';
import { header, dim, c } from '../render/format.ts';

interface Dependency {
  address: string; // normalized 0x..
  label: string;
  kind: string;
  modules: string[];
  upgradedVersion?: string;
}

export async function buildDeps(
  sui: Sui,
  cache: Cache,
  opts: GlobalOptions,
  packageId: string,
): Promise<{ packageId: string; ownModules: string[]; dependencies: Dependency[] }> {
  const id = normalizeAddress(packageId);
  const pkg = await cache.through<BytecodePackage>(
    'pkg-bytecode',
    id,
    { immutable: true, noCache: opts.noCache },
    () => sui.getPackageBytecode(id),
  );

  const linkageByOriginal = new Map<string, LinkageEntry>();
  for (const l of pkg.linkage ?? []) linkageByOriginal.set(bareAddress(l.originalId), l);

  const selfAddrs = new Set<string>();
  const ownModules: string[] = [];
  const modulesByAddr = new Map<string, Set<string>>();

  const compiled = await Promise.all(pkg.modules.map((m) => deserialize(m.contents)));
  for (const cm of compiled) {
    selfAddrs.add(selfModule(cm).address);
    ownModules.push(selfModule(cm).name);
  }
  for (const cm of compiled) {
    for (const ref of referencedModules(cm)) {
      if (selfAddrs.has(ref.address)) continue;
      const set = modulesByAddr.get(ref.address) ?? new Set<string>();
      set.add(ref.module);
      modulesByAddr.set(ref.address, set);
    }
  }

  const dependencies: Dependency[] = [...modulesByAddr.entries()].map(([bareAddr, mods]) => {
    const known = lookupKnown(bareAddr);
    const link = linkageByOriginal.get(bareAddr);
    return {
      address: normalizeAddress(bareAddr),
      label: known?.name ?? '',
      kind: known?.kind ?? '',
      modules: [...mods].sort(),
      upgradedVersion: link ? String(link.upgradedVersion) : undefined,
    };
  });

  // Labeled deps first (by name), then unknown by address.
  dependencies.sort((a, b) => {
    if (!!a.label !== !!b.label) return a.label ? -1 : 1;
    return (a.label || a.address).localeCompare(b.label || b.address);
  });

  return { packageId: id, ownModules: ownModules.sort(), dependencies };
}

export async function inspectDeps(
  sui: Sui,
  cache: Cache,
  opts: GlobalOptions,
  packageId: string,
): Promise<void> {
  const result = await buildDeps(sui, cache, opts, packageId);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(header('Package ' + result.packageId));
  console.log('  ' + dim('modules: ') + result.ownModules.join(', '));
  console.log();
  const totalModules = result.dependencies.reduce((n, d) => n + d.modules.length, 0);
  console.log(c.bold(`Dependencies (${result.dependencies.length} packages, ${totalModules} modules)`));
  console.log();

  const labelWidth = Math.min(
    16,
    Math.max(0, ...result.dependencies.map((d) => d.label.length)),
  );
  for (const d of result.dependencies) {
    const labelCell = d.label ? c.green(d.label.padEnd(labelWidth)) : dim('—'.padEnd(labelWidth));
    const ver = d.upgradedVersion ? dim(` v${d.upgradedVersion}`) : '';
    console.log(`  ${labelCell}  ${shortAddress(d.address)}${ver}`);
    console.log(`  ${' '.repeat(labelWidth)}  ${dim(d.modules.join(', '))}`);
  }
}
