import type { Sui } from '../client/grpc.ts';
import type { Cache } from '../cache/repo.ts';
import type { GlobalOptions } from '../types.ts';
import { Coins } from './coins.ts';
import { labelFor } from '../registry/known.ts';
import { normalizeAddress, shortAddress } from '../util/address.ts';
import { header, dim, c } from '../render/format.ts';

interface Balance {
  coinType: string;
  balance: string | bigint;
}
interface OwnedObject {
  objectId?: string;
  objectType?: string;
  previousTransaction?: string;
}

/** Collapse a type to a display form, dropping addresses and labeling the package. */
function displayType(type: string): string {
  const pkg = type.split('::')[0] ?? '';
  const label = labelFor(pkg);
  const short = type.replace(/0x[0-9a-fA-F]+::/g, '');
  return label ? `${short} ${dim('(' + label + ')')}` : short;
}

export async function inspectWallet(
  sui: Sui,
  cache: Cache,
  opts: GlobalOptions,
  address: string,
): Promise<void> {
  const addr = normalizeAddress(address);
  const coins = new Coins(sui, cache, opts.noCache);

  const [balRes, objRes] = await Promise.all([
    sui.listBalances(addr),
    sui.listOwnedObjects(addr, {
      pageSize: 200,
      paths: ['object_id', 'object_type', 'previous_transaction'],
    }),
  ]);

  const balances = (balRes.balances ?? []) as Balance[];
  const objects = (objRes.objects ?? []) as OwnedObject[];

  // Resolve coin metadata, build display rows.
  const balRows = await Promise.all(
    balances
      .filter((b) => BigInt(b.balance) > 0n)
      .map(async (b) => ({
        text: await coins.format(b.coinType, b.balance),
        raw: BigInt(b.balance),
        coinType: b.coinType,
      })),
  );

  // Group owned objects by type.
  const byType = new Map<string, number>();
  for (const o of objects) {
    const t = o.objectType ?? 'unknown';
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  const typeRows = [...byType.entries()].sort((a, b) => b[1] - a[1]);

  // Recent activity proxy: distinct previous transactions of current objects.
  const recentTxs = [...new Set(objects.map((o) => o.previousTransaction).filter(Boolean))] as string[];

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          address: addr,
          balances: balances.map((b) => ({ coinType: b.coinType, balance: String(b.balance) })),
          ownedObjectsByType: Object.fromEntries(typeRows),
          recentTransactions: recentTxs,
          ownedObjectsTruncated: !!objRes.nextPageToken,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(header('Wallet ' + addr));

  console.log('\n' + c.bold(`Balances (${balRows.length})`));
  if (balRows.length === 0) console.log('  ' + dim('— none —'));
  for (const r of balRows) console.log('  ' + r.text + dim('  ' + r.coinType.replace(/0x[0-9a-fA-F]+::/g, '')));

  const more = objRes.nextPageToken ? '+' : '';
  console.log('\n' + c.bold(`Owned objects (${objects.length}${more}, ${typeRows.length} types)`));
  for (const [type, n] of typeRows) {
    console.log('  ' + dim('×' + n + ' ') + displayType(type));
  }

  if (recentTxs.length) {
    console.log(
      '\n' + c.bold('Recent transactions') + dim(' (txs that last touched current objects)'),
    );
    for (const d of recentTxs.slice(0, 15)) console.log('  ' + d);
    console.log('  ' + dim('inspect any with `tx <digest>`'));
  }
}
