# sui-net

A command-line tool for inspecting the **Sui mainnet** in human-meaningful ways:
pools, dynamic fields, packages and their cross-package dependencies, wallet
activity, readable transaction breakdowns, and Move bytecode
disassembly/decompilation.

Built with [Bun](https://bun.sh) + TypeScript. Talks to the network over
**gRPC** (Sui JSON-RPC is deprecated and shuts off July 2026), with a local
`bun:sqlite` cache.

## Requirements

- [Bun](https://bun.sh) 1.3+
- Network access to a Sui mainnet full node (defaults to the public endpoint;
  override with `--rpc`)

## Install

```sh
bun install
```

Run a command:

```sh
bun run src/cli.ts <command> [args] [flags]
```

(Optionally `bun link` to expose a global `sui-net` binary.)

## Commands

| Command | Description |
| --- | --- |
| `object <objectId>` | Any on-chain object + its parsed Move fields |
| `pool <objectId>` | DEX pool summary: protocol, kind, reserves, spot price, fees |
| `fields <parentId> [--limit N]` | Dynamic fields attached to an object, with decoded keys |
| `deps <packageId>` | Cross-package dependency tree (the `use` graph) |
| `package <packageId>` | Modules, structs, and function signatures |
| `tx <digest>` | Explain a transaction: protocols, balance changes, events, PTB commands |
| `wallet <address>` | Balances, owned objects by type, recent activity |
| `pools <txDigest>` | Every pool a transaction touched, grouped by protocol |
| `disasm <packageId> [module \| module::fn \| fn]` | Resolved Move bytecode instruction listings |
| `decompile <packageId> [module \| module::fn \| fn]` | Source-like Move (approximate) |

### Global flags

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable JSON output |
| `--no-cache` | Bypass the local SQLite cache |
| `--cache-ttl <s>` | Serve mutable objects from cache within `<s>` seconds |
| `--rpc <url>` | Override the gRPC base URL (e.g. a paid provider) |

## Examples

Inspect a pool — protocol and mechanism are detected automatically:

```sh
bun run src/cli.ts pool 0x15dbcac854b1fc68fc9467dbd9ab34270447aabd8cc0e04a5864d95ccb86b74a
```

```
Pool 0x15dbcac8…  [SUI-USDC]
  protocol: Bluefin
  kind:     CLMM — concentrated liquidity (Uniswap-v3 style sqrt price + ticks)
  coin A:   SUI
  coin B:   USDC
Holdings
  2,162,677.57 SUI
  2,211,207.37 USDC
Spot price (from sqrt_price, approximate)
  ≈ 0.9153 USDC per SUI
```

Explain a transaction (the aggregator swap that fans out across DEXs):

```sh
bun run src/cli.ts tx 8cVABcQP5G5indWP7vgjez5i5TGfQzC2nGxGN1SdFaEn
```

Shows the protocols involved, the sender's net balance change, events, and the
full programmable-transaction-block command list with resolved
`package::module::function` calls and reconstructed arguments.

Extract every pool a transaction routed through:

```sh
bun run src/cli.ts pools AN6W29PooNfZfSVgjHKXgBzPYy3cStMAuZkEJXfdwrnn
```

See a package's dependency graph and contents:

```sh
bun run src/cli.ts deps    0x93af8d29e93194a22f11901afec814f82987e830875ac4d231c81d3b6b316eab
bun run src/cli.ts package 0x93af8d29e93194a22f11901afec814f82987e830875ac4d231c81d3b6b316eab
```

Disassemble / decompile a single function:

```sh
bun run src/cli.ts disasm    0x93af8d29…b316eab jk::ca
bun run src/cli.ts decompile 0x93af8d29…b316eab jk::ca
```

## How it works

- **Data layer (`src/client/grpc.ts`)** — wraps `@mysten/sui`'s `SuiGrpcClient`.
  Objects, dynamic fields, packages (incl. raw module bytecode via the
  `package` read mask), transactions, balances, and owned objects all come from
  the full node over gRPC.
- **Cache (`src/cache/`)** — `bun:sqlite` at `~/.sui-net/cache.sqlite`.
  Immutable data (packages, module bytecode, finalized transactions) is cached
  permanently; mutable objects use a TTL (`--cache-ttl`).
- **Pool-kind classifier (`src/inspect/poolKind.ts`)** — determines a pool's
  mechanism structurally from its fields, independent of the registry, so even
  unknown protocols are classified: **DLMM** (bins / `LBPair`), **CLMM**
  (sqrt price + ticks), **Oracle AMM**, **Stable**, **AMM (quoter)** (reads the
  STEAMM quoter type), and constant-product **AMM**.
- **Bytecode (`src/bytecode/`)** — `@mysten/move-bytecode-template` (WASM)
  deserializes module bytecode; from there we resolve dependencies, disassemble
  instructions, and decompile to source-like Move.

## Protocol registry

`sui-net` labels package addresses with a curated registry
(`src/registry/known.ts`):

- A small, hand-curated **CORE** map (framework packages + entries
  cross-confirmed by on-chain object types), which always takes precedence.
- A larger **generated** map (`src/registry/packages.json`) produced from raw
  explorer dumps in `data/*.txt`.

A protocol typically spans many package addresses (upgraded versions plus
separate packages for CLMM/AMM/DLMM/aggregator/vaults/tokens); the registry maps
all of them to one name.

To extend it, drop a new dump into `data/` (lines of `label  0x<address>`) and
regenerate:

```sh
bun run scripts/build-registry.ts
```

The parser extracts every `0x`+64-hex address with its preceding label, maps the
label to a protocol + category, and rewrites `packages.json`.

## Limitations

- **Mainnet only.**
- **Decompiler is approximate.** Expression reconstruction (calls, structs,
  field access, references, arithmetic, multi-value returns) is solid and
  straight-line functions read cleanly; `assert!` is recovered. Full
  control-flow structuring (nested `if`/`else`/loops) is not done — branchy code
  renders as correct, condition-reconstructed `if (...) goto` form rather than
  nested blocks. Always verify against `disasm` when it matters.
- **Spot prices are approximate** (display-only), derived from `sqrt_price`
  (CLMM) or reserves (AMM).
- **No historical wallet transaction feed.** A full node serves current state +
  transactions by digest; a full activity history would require an indexer.
  `wallet` shows current holdings plus a recent-activity proxy.

## Project layout

```
src/
  cli.ts              entry + command dispatch
  client/grpc.ts      SuiGrpcClient wrapper
  cache/              bun:sqlite cache
  bytecode/           deserialize / disassemble / decompile + model
  inspect/            object, pool, poolKind, dynamicFields, deps, package,
                      tx, wallet, poolsInTx, coins
  registry/           known.ts (CORE) + packages.json (generated)
  render/format.ts    terminal formatting
  util/               address + protobuf value helpers
scripts/
  build-registry.ts   regenerate packages.json from data/*.txt
data/                 raw label→address dumps (registry source)
```
