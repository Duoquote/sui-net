import type { Sui } from '../client/grpc.ts';
import type { Cache } from '../cache/repo.ts';
import type { GlobalOptions } from '../types.ts';
import { decodeValue, toJson } from '../util/value.ts';
import { labelFor, isFramework } from '../registry/known.ts';
import { shortAddress } from '../util/address.ts';
import { fromUnits, header, dim, c } from '../render/format.ts';

interface Argument {
  kind?: number; // 1 GAS, 2 INPUT, 3 RESULT
  input?: number;
  result?: number;
  subresult?: number;
}
interface MoveCall {
  package: string;
  module: string;
  function: string;
  typeArguments?: string[];
  arguments?: Argument[];
}
interface Command {
  command?: {
    oneofKind?: string;
    moveCall?: MoveCall;
    splitCoins?: { coin: Argument; amounts: Argument[] };
    mergeCoins?: { coin: Argument; coinsToMerge: Argument[] };
    transferObjects?: { objects: Argument[]; address: Argument };
    makeMoveVector?: { elementType?: string; elements: Argument[] };
  };
}
interface Input {
  kind?: number; // 1 PURE, 2 IMM_OR_OWNED, 3 SHARED, ...
  pure?: Uint8Array;
  objectId?: string;
}
interface BalanceChange {
  address: string;
  coinType: string;
  amount: string | bigint;
}
interface Ev {
  module: string;
  eventType: string;
  json?: unknown;
}
interface ExecutedTx {
  digest: string;
  transaction?: {
    sender?: string;
    kind?: { data?: { oneofKind?: string; programmableTransaction?: { inputs: Input[]; commands: Command[] } } };
  };
  effects?: { status?: { success?: boolean; error?: unknown }; gasUsed?: Record<string, string | bigint> };
  events?: { events?: Ev[] };
  balanceChanges?: BalanceChange[];
  timestamp?: { seconds?: string | bigint };
}

/** Drop `addr::module::` prefixes so type args read as bare type names. */
function shortTypes(types?: string[]): string {
  if (!types || types.length === 0) return '';
  const clean = (t: string) => t.replace(/0x[0-9a-fA-F]+::[A-Za-z0-9_]+::/g, '');
  return types.map(clean).join(', ');
}

function lastSeg(coinType: string): string {
  return coinType.split('::').pop() ?? coinType;
}

function decodePure(bytes: Uint8Array): string {
  const hex = '0x' + Buffer.from(bytes).toString('hex');
  if (bytes.length === 32) return shortAddress(hex);
  if (bytes.length === 8 || bytes.length === 16) {
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
    return v.toString();
  }
  if (bytes.length === 1) return String(bytes[0]);
  return hex.length > 22 ? hex.slice(0, 20) + '…' : hex;
}

function makeArgRenderer(inputs: Input[]) {
  return function arg(a: Argument): string {
    switch (a.kind) {
      case 1:
        return c.yellow('Gas');
      case 2: {
        const inp = inputs[a.input ?? -1];
        if (inp?.pure) return dim(decodePure(inp.pure));
        if (inp?.objectId) return dim(shortAddress(inp.objectId));
        return dim(`In#${a.input}`);
      }
      case 3:
        return c.cyan(a.subresult != null ? `→[${a.result}.${a.subresult}]` : `→[${a.result}]`);
      default:
        return '?';
    }
  };
}

function renderCommand(cmd: Command, arg: (a: Argument) => string): string {
  const cc = cmd.command;
  switch (cc?.oneofKind) {
    case 'moveCall': {
      const mc = cc.moveCall!;
      const lbl = labelFor(mc.package);
      const pkg = (lbl ? c.green(lbl) + ' ' : '') + dim(shortAddress(mc.package));
      const types = mc.typeArguments?.length ? `<${shortTypes(mc.typeArguments)}>` : '';
      const args = (mc.arguments ?? []).map(arg).join(', ');
      return `${dim('call')} ${pkg}${dim('::' + mc.module + '::')}${c.bold(mc.function)}${types}(${args})`;
    }
    case 'splitCoins': {
      const s = cc.splitCoins!;
      return `${c.magenta('SplitCoins')}(${arg(s.coin)} → [${s.amounts.map(arg).join(', ')}])`;
    }
    case 'mergeCoins': {
      const m = cc.mergeCoins!;
      return `${c.magenta('MergeCoins')}(${arg(m.coin)} ← [${m.coinsToMerge.map(arg).join(', ')}])`;
    }
    case 'transferObjects': {
      const t = cc.transferObjects!;
      return `${c.magenta('TransferObjects')}([${t.objects.map(arg).join(', ')}] → ${arg(t.address)})`;
    }
    case 'makeMoveVector': {
      const v = cc.makeMoveVector!;
      return `${c.magenta('MakeMoveVec')}([${v.elements.map(arg).join(', ')}])`;
    }
    case 'publish':
      return c.magenta('Publish');
    case 'upgrade':
      return c.magenta('Upgrade');
    default:
      return cc?.oneofKind ?? 'unknown';
  }
}

export async function inspectTx(
  sui: Sui,
  cache: Cache,
  opts: GlobalOptions,
  digest: string,
): Promise<void> {
  const tx = (await cache.through<ExecutedTx>(
    'tx',
    digest,
    { immutable: true, noCache: opts.noCache },
    () => sui.getTransaction(digest) as Promise<ExecutedTx>,
  )) as ExecutedTx;

  const pt = tx.transaction?.kind?.data?.programmableTransaction;
  const balances = tx.balanceChanges ?? [];
  const events = tx.events?.events ?? [];

  // Resolve coin metadata for everything referenced in balance changes.
  const coinTypes = [...new Set(balances.map((b) => b.coinType))];
  const meta = new Map<string, { symbol: string; decimals: number }>();
  await Promise.all(
    coinTypes.map(async (ct) => {
      const m = await cache.through<{ symbol: string; decimals: number } | undefined>(
        'coin-meta',
        ct,
        { immutable: true, noCache: opts.noCache },
        () => sui.getCoinMeta(ct),
      );
      meta.set(ct, m ?? { symbol: lastSeg(ct), decimals: 0 });
    }),
  );
  const fmtAmount = (ct: string, raw: string | bigint) => {
    const m = meta.get(ct)!;
    return `${fromUnits(raw, m.decimals)} ${m.symbol}`;
  };

  if (opts.json) {
    console.log(toJson(tx));
    return;
  }

  // Header.
  const status = tx.effects?.status?.success ? c.green('success') : c.red('FAILED');
  console.log(header('Transaction ' + tx.digest));
  console.log('  ' + dim('status: ') + status);
  if (tx.transaction?.sender) console.log('  ' + dim('sender: ') + tx.transaction.sender);
  if (tx.timestamp?.seconds) {
    const d = new Date(Number(tx.timestamp.seconds) * 1000);
    console.log('  ' + dim('time:   ') + d.toISOString().replace('T', ' ').replace('.000Z', ' UTC'));
  }
  const gas = tx.effects?.gasUsed;
  if (gas) {
    const net =
      BigInt(gas.computationCost ?? 0) +
      BigInt(gas.storageCost ?? 0) -
      BigInt(gas.storageRebate ?? 0);
    const gasStr =
      net < 0n
        ? `${fromUnits(-net, 9)} SUI rebated ${dim('(net)')}`
        : `${fromUnits(net, 9)} SUI ${dim('(net)')}`;
    console.log('  ' + dim('gas:    ') + gasStr);
  }

  // Protocols involved: distinct non-framework packages called, with how many
  // calls each, labeled where known and shown by address otherwise.
  const callCounts = new Map<string, number>();
  for (const cmd of pt?.commands ?? []) {
    const mc = cmd.command?.moveCall;
    if (mc && !isFramework(mc.package)) callCounts.set(mc.package, (callCounts.get(mc.package) ?? 0) + 1);
  }
  if (callCounts.size) {
    console.log('\n' + c.bold('Protocols involved'));
    const sorted = [...callCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [pkg, n] of sorted) {
      const lbl = labelFor(pkg);
      const who = lbl ? `${c.green(lbl)} ${dim(shortAddress(pkg))}` : dim(shortAddress(pkg));
      console.log(`  ${who} ${dim(`×${n}`)}`);
    }
  }

  // Sender net effect (spent vs received).
  const sender = tx.transaction?.sender;
  const senderChanges = balances.filter((b) => b.address === sender);
  if (senderChanges.length) {
    console.log('\n' + c.bold('Sender net'));
    for (const b of senderChanges) {
      const amt = BigInt(b.amount);
      const sign = amt < 0n ? c.red('spent  ') : c.green('received');
      console.log(`  ${sign} ${fmtAmount(b.coinType, amt < 0n ? -amt : amt)}`);
    }
  }

  // All balance changes grouped by address.
  if (balances.length) {
    const byAddr = new Map<string, BalanceChange[]>();
    for (const b of balances) {
      const arr = byAddr.get(b.address) ?? [];
      arr.push(b);
      byAddr.set(b.address, arr);
    }
    console.log('\n' + c.bold('Balance changes'));
    for (const [addr, arr] of byAddr) {
      const who = addr === sender ? `${shortAddress(addr)} ${dim('(sender)')}` : shortAddress(addr);
      console.log('  ' + who);
      for (const b of arr) {
        const amt = BigInt(b.amount);
        const s = amt < 0n ? c.red('-') : c.green('+');
        console.log(`    ${s}${fmtAmount(b.coinType, amt < 0n ? -amt : amt)}`);
      }
    }
  }

  // Events.
  if (events.length) {
    console.log('\n' + c.bold(`Events (${events.length})`));
    for (const e of events) {
      const short = e.eventType.split('::').slice(-2).join('::');
      console.log('  ' + c.cyan(short));
      const j = decodeValue(e.json as never);
      if (j && typeof j === 'object') {
        const oneLine = toJson(j).replace(/\s+/g, ' ');
        console.log('    ' + dim(oneLine.length > 140 ? oneLine.slice(0, 138) + '…' : oneLine));
      }
    }
  }

  // PTB commands.
  if (pt) {
    const arg = makeArgRenderer(pt.inputs);
    console.log(
      '\n' + c.bold(`Programmable transaction — ${pt.commands.length} commands, ${pt.inputs.length} inputs`),
    );
    pt.commands.forEach((cmd, i) => {
      console.log(`  ${dim('[' + i + ']')} ${renderCommand(cmd, arg)}`);
    });
  }
}
