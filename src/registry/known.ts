import { bareAddress } from '../util/address.ts';
import generated from './packages.json' with { type: 'json' };

export interface KnownPackage {
  name: string;
  /** Protocol category, e.g. "CLMM", "AMM", "DLMM", "CLOB", "Aggregator", "Token", "Framework". */
  kind: string;
}

// Generated from data/*.txt via scripts/build-registry.ts (hundreds of addresses
// across protocol versions). The hand-curated CORE map below takes precedence.
const GENERATED = generated as Record<string, KnownPackage>;

// Hand-curated CORE registry (cross-confirmed by on-chain object types / module
// sets). Takes precedence over the generated map. `kind` is the protocol
// category; the actual pool mechanism per object is determined structurally
// (see inspect/poolKind.ts).
const CORE: Record<string, KnownPackage> = {
  '0000000000000000000000000000000000000000000000000000000000000001': { name: 'MoveStdlib', kind: 'Framework' },
  '0000000000000000000000000000000000000000000000000000000000000002': { name: 'Sui Framework', kind: 'Framework' },
  '0000000000000000000000000000000000000000000000000000000000000003': { name: 'Sui System', kind: 'Framework' },
  // DEXes — concentrated liquidity (CLMM):
  '91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1': { name: 'Turbos', kind: 'CLMM' },
  '25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d': { name: 'FlowX', kind: 'CLMM' },
  '1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb': { name: 'Cetus', kind: 'CLMM' },
  '3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267': { name: 'Bluefin', kind: 'CLMM' },
  '70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860': { name: 'Momentum', kind: 'CLMM' },
  'e74104c66dd9f16b3096db2cc00300e556aa92edc871be4bc052b5dfb80db239': { name: 'FullSail', kind: 'CLMM' },
  // DEXes — constant-product / AMM:
  'b24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9': { name: 'BlueMove', kind: 'AMM' },
  '361dd589b98e8fcda9a7ee53b85efabef3569d00416640d2faa516e3801d7ffc': { name: 'Suiswap', kind: 'AMM' },
  'dae28ab9ab072c647c4e8f2057a8f17dcc4847e42d6a8258df4b376ae183c872': { name: 'Dipcoin', kind: 'AMM' },
  'a0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66': { name: 'Kriya', kind: 'AMM' },
  'efe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c': { name: 'Aftermath', kind: 'AMM' },
  // DEXes — other mechanisms:
  '4fb1cf45dffd6230305f1d269dd1816678cc8e3ba0b747a813a556921219f261': { name: 'STEAMM', kind: 'AMM (quoter)' },
  '5a5c1d10e4782dbbdec3eb8327ede04bd078b294b97cfdba447b11b846b383ac': { name: 'Ferra', kind: 'DLMM' },
  // CLOB:
  '2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809': { name: 'DeepBook', kind: 'CLOB' },
  // Aggregator + tokens. NOTE: 0xc263… is FlowX's universal_router aggregator
  // (per the explorer dump), not NAVI — the NAVX token is merely routed through.
  'c263060d3cbb4155057f0010f92f63ca56d5121c298d01f7a33607342ec299b0': { name: 'FlowX', kind: 'Aggregator' },
  'a99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5': { name: 'NAVX', kind: 'Token' },
  'deeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270': { name: 'DEEP', kind: 'Token' },
};

const FRAMEWORK = new Set([
  '0000000000000000000000000000000000000000000000000000000000000001',
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0000000000000000000000000000000000000000000000000000000000000003',
]);

export function isFramework(addr: string): boolean {
  return FRAMEWORK.has(bareAddress(addr));
}

export function lookupKnown(addr: string): KnownPackage | undefined {
  const k = bareAddress(addr);
  return CORE[k] ?? GENERATED[k];
}

/** Returns a human label for an address, e.g. "Cetus" or the short address. */
export function labelFor(addr: string): string {
  const k = lookupKnown(addr);
  return k ? k.name : '';
}
