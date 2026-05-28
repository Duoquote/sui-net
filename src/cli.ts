#!/usr/bin/env bun
import type { GlobalOptions } from './types.ts';
import { Sui } from './client/grpc.ts';
import { Cache } from './cache/repo.ts';
import { inspectObject } from './inspect/object.ts';
import { inspectDeps } from './inspect/deps.ts';
import { inspectPackage } from './inspect/package.ts';
import { inspectTx } from './inspect/tx.ts';
import { inspectPool } from './inspect/pool.ts';
import { inspectFields } from './inspect/dynamicFields.ts';
import { inspectWallet } from './inspect/wallet.ts';
import { inspectDisasm } from './inspect/disasm.ts';
import { extractPools } from './inspect/poolsInTx.ts';
import { c } from './render/format.ts';

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const name = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  const command = positionals.shift();
  return { command, positionals, flags };
}

function toGlobalOptions(flags: Record<string, string | boolean>): GlobalOptions {
  const ttlSec = flags['cache-ttl'] !== undefined ? Number(flags['cache-ttl']) : 0;
  return {
    json: flags.json === true,
    noCache: flags['no-cache'] === true,
    cacheTtlMs: Number.isFinite(ttlSec) ? ttlSec * 1000 : 0,
    rpc: typeof flags.rpc === 'string' ? flags.rpc : undefined,
  };
}

interface Command {
  usage: string;
  describe: string;
  run: (
    args: string[],
    sui: Sui,
    cache: Cache,
    opts: GlobalOptions,
    flags: Record<string, string | boolean>,
  ) => Promise<void>;
}

const COMMANDS: Record<string, Command> = {
  object: {
    usage: 'object <objectId>',
    describe: 'Inspect any on-chain object and render its parsed Move fields.',
    run: async (args, sui, cache, opts) => {
      const id = args[0];
      if (!id) throw new Error('usage: object <objectId>');
      await inspectObject(sui, cache, opts, id);
    },
  },
  deps: {
    usage: 'deps <packageId>',
    describe: 'Show a package\'s cross-package dependency tree (the `use` graph).',
    run: async (args, sui, cache, opts) => {
      const id = args[0];
      if (!id) throw new Error('usage: deps <packageId>');
      await inspectDeps(sui, cache, opts, id);
    },
  },
  package: {
    usage: 'package <packageId>',
    describe: 'List a package\'s modules, structs, and function signatures.',
    run: async (args, sui, cache, opts) => {
      const id = args[0];
      if (!id) throw new Error('usage: package <packageId>');
      await inspectPackage(sui, cache, opts, id);
    },
  },
  tx: {
    usage: 'tx <digest>',
    describe: 'Explain a transaction: protocols, balance changes, events, and PTB commands.',
    run: async (args, sui, cache, opts) => {
      const d = args[0];
      if (!d) throw new Error('usage: tx <digest>');
      await inspectTx(sui, cache, opts, d);
    },
  },
  pool: {
    usage: 'pool <objectId>',
    describe: 'Summarize a DEX pool: protocol, kind, reserves, spot price, fees.',
    run: async (args, sui, cache, opts) => {
      const id = args[0];
      if (!id) throw new Error('usage: pool <objectId>');
      await inspectPool(sui, cache, opts, id);
    },
  },
  pools: {
    usage: 'pools <txDigest>',
    describe: 'Extract every pool a transaction touched, grouped by protocol.',
    run: async (args, sui, cache, opts) => {
      const d = args[0];
      if (!d) throw new Error('usage: pools <txDigest>');
      await extractPools(sui, cache, opts, d);
    },
  },
  fields: {
    usage: 'fields <parentId> [--limit N]',
    describe: 'List the dynamic fields attached to an object.',
    run: async (args, sui, cache, opts, flags) => {
      const id = args[0];
      if (!id) throw new Error('usage: fields <parentId>');
      const limit = flags.limit !== undefined ? Number(flags.limit) : 50;
      await inspectFields(sui, cache, opts, id, limit);
    },
  },
  wallet: {
    usage: 'wallet <address>',
    describe: 'Show a wallet: token balances, owned objects by type, recent activity.',
    run: async (args, sui, cache, opts) => {
      const a = args[0];
      if (!a) throw new Error('usage: wallet <address>');
      await inspectWallet(sui, cache, opts, a);
    },
  },
  disasm: {
    usage: 'disasm <packageId> [module | module::fn | fn]',
    describe: 'Disassemble Move bytecode: resolved instruction listings per function.',
    run: async (args, sui, cache, opts) => {
      const id = args[0];
      if (!id) throw new Error('usage: disasm <packageId> [module::fn]');
      await inspectDisasm(sui, cache, opts, id, args[1], 'disasm');
    },
  },
  decompile: {
    usage: 'decompile <packageId> [module | module::fn | fn]',
    describe: 'Decompile Move bytecode to source-like Move (approximate).',
    run: async (args, sui, cache, opts) => {
      const id = args[0];
      if (!id) throw new Error('usage: decompile <packageId> [module::fn]');
      await inspectDisasm(sui, cache, opts, id, args[1], 'decompile');
    },
  },
};

function printHelp(): void {
  console.log(c.bold('sui-net') + ' — inspect the Sui mainnet (gRPC)\n');
  console.log('Usage: sui-net <command> [args] [flags]\n');
  console.log(c.bold('Commands'));
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(10)} ${cmd.describe}`);
    console.log(`  ${' '.repeat(10)} ${c.dim(cmd.usage)}`);
  }
  console.log('\n' + c.bold('Global flags'));
  console.log('  --rpc <url>     override the gRPC base URL (e.g. a paid provider)');
  console.log('  --json          machine-readable JSON output');
  console.log('  --no-cache      bypass the local SQLite cache');
  console.log('  --cache-ttl <s> serve mutable objects from cache within <s> seconds');
}

async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));

  if (!command || command === 'help' || flags.help === true || flags.h === true) {
    printHelp();
    return;
  }

  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
  }

  const opts = toGlobalOptions(flags);
  const sui = new Sui(opts.rpc);
  const cache = new Cache();
  await cmd.run(positionals, sui, cache, opts, flags);
}

main().catch((err) => {
  console.error(c.red('error: ') + (err?.message ?? String(err)));
  process.exit(1);
});
