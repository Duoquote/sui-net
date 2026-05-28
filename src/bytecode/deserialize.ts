import init, * as tpl from '@mysten/move-bytecode-template';

let ready = false;
async function ensureInit(): Promise<void> {
  if (!ready) {
    await init();
    ready = true;
  }
}

// Indices reference the pools below (module_handles, identifiers, etc.).
export interface ModuleHandle {
  address: number; // index into address_identifiers
  name: number; // index into identifiers
}

export interface StructHandle {
  module: number; // index into module_handles
  name: number; // index into identifiers
  abilities?: unknown;
  type_parameters?: unknown[];
}

export interface FunctionHandle {
  module: number;
  name: number;
  parameters: number; // signature index
  return_: number; // signature index
  type_parameters?: unknown[];
}

export interface CompiledModule {
  version: number;
  self_module_handle_idx: number;
  module_handles: ModuleHandle[];
  struct_handles: StructHandle[];
  function_handles: FunctionHandle[];
  identifiers: string[];
  address_identifiers: string[];
  signatures: unknown[];
  constant_pool: unknown[];
  struct_defs?: unknown[];
  function_defs?: unknown[];
  // remaining fields kept opaque until the decompiler needs them
  [k: string]: unknown;
}

export async function deserialize(bytes: Uint8Array): Promise<CompiledModule> {
  await ensureInit();
  return tpl.deserialize(bytes) as unknown as CompiledModule;
}

/** The fully-qualified self id of a module: addr (bare hex) + name. */
export function selfModule(m: CompiledModule): { address: string; name: string } {
  const mh = m.module_handles[m.self_module_handle_idx]!;
  return { address: m.address_identifiers[mh.address]!, name: m.identifiers[mh.name]! };
}

/** All modules referenced by this module (the `use` set), as { addr, module }. */
export function referencedModules(m: CompiledModule): Array<{ address: string; module: string }> {
  return m.module_handles.map((mh) => ({
    address: m.address_identifiers[mh.address]!,
    module: m.identifiers[mh.name]!,
  }));
}
