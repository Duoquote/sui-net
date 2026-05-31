#!/usr/bin/env bun
// Regenerate src/registry/packages.json from the label→address dumps in data/*.txt.
//
// The dumps are explorer exports of the form "<label>    <address>", but lines
// are frequently concatenated by copy-paste. So instead of splitting on lines we
// scan for every 0x+64hex address and take the text preceding it as its label.
// Labels are mapped to a canonical protocol name + coarse category. Protocols
// ship many package addresses (upgrades + per-product packages); all map to the
// same name. Run: bun run scripts/build-registry.ts

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const OUT = join(import.meta.dir, '..', 'src', 'registry', 'packages.json');

interface Entry { name: string; kind: string; }

// Some dumps are single-protocol exports whose per-asset labels (e.g. Scallop's
// market coins "sCETUS"/"sHAEDAL") collide with other protocols' substrings. For
// those files the protocol is fixed by the filename and the label only informs
// the category. Entries from a forced file are authoritative (they override).
const FILE_PROTOCOL: Record<string, string> = {
  'scallop.txt': 'Scallop',
};

// Map a raw explorer label to a protocol. Returns null to skip unrecognized labels.
function protocolOf(label: string): string | null {
  const l = label.toLowerCase();
  const has = (s: string) => l.includes(s);
  if (has('@cetuspackages') || has('cetus')) return 'Cetus';
  if (has('@aftermath') || has('aftermath')) return 'Aftermath';
  if (has('@deepbook') || has('deepbook')) return 'DeepBook';
  if (has('@suilend') || has('steamm') || /\bbtoken\b/.test(l) || /\bbika\b/.test(l)) return 'STEAMM';
  if (has('@magma') || has('magma')) return 'Magma';
  if (has('@mmt') || has('momentum')) return 'Momentum';
  if (has('@pkg/fullsail') || has('full sail') || has('fullsail') || l === 'sail' || has('presail')) return 'FullSail';
  if (has('@typus') || has('typus') || has('tails by typus')) return 'Typus';
  if (has('kriya') || has('kdx') || l.startsWith('kc_')) return 'Kriya';
  if (has('turbos')) return 'Turbos';
  if (has('bluemove') || has('blue move')) return 'BlueMove';
  if (has('ferra')) return 'Ferra';
  if (has('suiswap') || has('sui swap')) return 'Suiswap';
  if (has('bayswap')) return 'BaySwap';
  if (has('animeswap')) return 'AnimeSwap';
  if (has('flowx') || has('flow x')) return 'FlowX';
  if (has('interest protocol') || has('@interest')) return 'Interest Protocol';
  if (has('7k defi') || l.startsWith('7k')) return '7K Aggregator';
  if (has('@haedal') || has('haedal')) return 'Haedal';
  if (has('dipcoin')) return 'Dipcoin';
  if (has('bluefin')) return 'Bluefin';
  if (has('obric')) return 'Obric';
  return null;
}

// Coarse category, from label keywords, falling back to a per-protocol default.
function kindOf(label: string, name: string): string {
  const l = label.toLowerCase();
  const has = (s: string) => l.includes(s);
  // Scallop (lending) has its own taxonomy: a central market + per-asset sCoins,
  // an oracle, vote-escrow (veSCA), borrow incentives, and helper libraries.
  if (name === 'Scallop') {
    if (has('incentive')) return 'Farming';
    if (has('oracle') || has('pyth') || has('adapter')) return 'Oracle';
    if (has('lending') || has('margin')) return 'Lending';
    if (has('vesca') || has('escrow') || has('vote')) return 'veToken';
    if (has('registry') || has('whitelist') || has('query') || has('math') || has('utilit')) return 'Library';
    if (has('coin') || /(^|\s)s[A-Z0-9]/.test(label)) return 'Token';
    return 'Lending';
  }
  if (has('perps') || has('perp')) return 'Perps';
  if (has('dlmm')) return 'DLMM';
  if (has('clmm')) return 'CLMM';
  if (has('aggregator') || has('router') || has('zapper') || name === '7K Aggregator') return 'Aggregator';
  if (has('limit-order') || has('limit order')) return 'Limit Order';
  if (has('dca')) return 'DCA';
  if (has('options') || has('/dov') || has(' dov')) return 'Options';
  if (has('oracle')) return 'Oracle';
  if (has('farming') || has('farm')) return 'Farming';
  if (has('vault')) return 'Vault';
  if (has('nft') || has('badge') || has('egg') || has('medal') || has('ticket') || has('tails') || has('jacuzzi')) return 'NFT';
  if (has('margin') || has('lending')) return 'Lending';
  if (has(' amm') || l.endsWith('amm') || has('spot_dex') || has('swap amm')) return 'AMM';
  if (has('token') || has('coin') || /\blp\b/.test(l) || has('btoken') || has('_lp') || name === 'FullSail' && l === 'sail') return 'Token';
  const def: Record<string, string> = {
    DeepBook: 'CLOB', Typus: 'Options', '7K Aggregator': 'Aggregator',
    'Interest Protocol': 'DeFi', Haedal: 'LST', Obric: 'Oracle AMM',
  };
  return def[name] ?? 'DEX';
}

function clean(label: string): string {
  return label.replace(/\s+/g, ' ').trim();
}

const ADDR = /0x[0-9a-fA-F]{64}\b/g;

function main(): void {
  let files: string[];
  try {
    files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.txt'));
  } catch {
    console.error(`no data dir at ${DATA_DIR}`);
    process.exit(1);
  }
  const out: Record<string, Entry> = {};
  let total = 0;
  let skipped = 0;
  const byName = new Map<string, number>();

  for (const file of files) {
    const text = readFileSync(join(DATA_DIR, file), 'utf8');
    const forced = FILE_PROTOCOL[file];
    let m: RegExpExecArray | null;
    let prevEnd = 0;
    ADDR.lastIndex = 0;
    while ((m = ADDR.exec(text)) !== null) {
      const label = clean(text.slice(prevEnd, m.index));
      prevEnd = m.index + m[0].length;
      const addr = m[0].toLowerCase();
      const bare = addr.slice(2);
      total++;
      const name = forced ?? protocolOf(label);
      if (!name) { skipped++; continue; }
      if (out[bare] && !forced) continue; // first label wins; forced dumps override
      if (!out[bare]) byName.set(name, (byName.get(name) ?? 0) + 1);
      out[bare] = { name, kind: kindOf(label, name) };
    }
  }

  mkdirSync(join(import.meta.dir, '..', 'src', 'registry'), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(out).sort());
  writeFileSync(OUT, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`addresses seen: ${total}, recorded: ${Object.keys(out).length}, skipped(unmatched): ${skipped}`);
  console.log('per protocol:', [...byName.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}=${c}`).join(', '));
}

main();
