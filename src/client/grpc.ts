import { SuiGrpcClient } from '@mysten/sui/grpc';
import { MAINNET_GRPC } from '../types.ts';
import { normalizeAddress } from '../util/address.ts';

const DEFAULT_OBJECT_PATHS = [
  'object_id',
  'version',
  'digest',
  'owner',
  'object_type',
  'has_public_transfer',
  'previous_transaction',
  'storage_rebate',
  'json',
];

const PACKAGE_PATHS = ['object_id', 'version', 'object_type', 'owner', 'package'];

const TX_PATHS = ['digest', 'transaction', 'effects', 'events', 'balance_changes', 'timestamp'];

export interface LinkageEntry {
  originalId: string;
  upgradedId: string;
  upgradedVersion: string | bigint;
}

/** Package fetched with raw module bytecode (for deps + decompilation). */
export interface BytecodePackage {
  modules: Array<{ name: string; contents: Uint8Array }>;
  typeOrigins?: unknown[];
  linkage?: LinkageEntry[];
}

/** Package fetched in normalized form (structs + function signatures). */
export interface NormalizedPackage {
  storageId: string;
  originalId: string;
  version: string | bigint;
  modules: Array<{ name: string; datatypes: unknown[]; functions: unknown[] }>;
  typeOrigins?: unknown[];
  linkage?: LinkageEntry[];
}

export class Sui {
  readonly client: SuiGrpcClient;

  constructor(rpcOverride?: string) {
    this.client = new SuiGrpcClient({
      network: 'mainnet',
      baseUrl: rpcOverride ?? MAINNET_GRPC,
    });
  }

  /** Fetch an object with a chosen field mask (defaults include parsed `json`). */
  async getObject(objectId: string, paths: string[] = DEFAULT_OBJECT_PATHS) {
    const r = await this.client.ledgerService.getObject({
      objectId: normalizeAddress(objectId),
      readMask: { paths },
    });
    return (r.response as { object?: unknown }).object;
  }

  /** Fetch a package's raw module bytecode (for deps + decompilation). */
  async getPackageBytecode(packageId: string): Promise<BytecodePackage> {
    const r = await this.client.ledgerService.getObject({
      objectId: normalizeAddress(packageId),
      readMask: { paths: PACKAGE_PATHS },
    });
    const obj = (r.response as { object?: { package?: BytecodePackage } }).object;
    if (!obj?.package) {
      throw new Error(`${packageId} is not a Move package (no package data returned)`);
    }
    return obj.package;
  }

  /** Fetch a package in normalized form (structs + function signatures). */
  async getPackageNormalized(packageId: string): Promise<NormalizedPackage> {
    const r = await this.client.movePackageService.getPackage({
      packageId: normalizeAddress(packageId),
    });
    const pkg = (r.response as { package?: NormalizedPackage }).package;
    if (!pkg) throw new Error(`${packageId} is not a Move package`);
    return pkg;
  }

  async getTransaction(digest: string, paths: string[] = TX_PATHS) {
    const r = await this.client.ledgerService.getTransaction({
      digest,
      readMask: { paths },
    });
    return (r.response as { transaction?: unknown }).transaction;
  }

  /** Coin symbol/decimals/name, or undefined if not a registered coin. */
  async getCoinMeta(
    coinType: string,
  ): Promise<{ symbol: string; decimals: number; name: string } | undefined> {
    try {
      const r = await this.client.core.getCoinMetadata({ coinType });
      const m = (r as { coinMetadata?: { symbol: string; decimals: number; name: string } })
        .coinMetadata;
      return m ? { symbol: m.symbol, decimals: m.decimals, name: m.name } : undefined;
    } catch {
      return undefined;
    }
  }

  async listDynamicFields(
    parentId: string,
    opts: { pageSize?: number; pageToken?: Uint8Array; paths?: string[] } = {},
  ) {
    const r = await this.client.stateService.listDynamicFields({
      parent: normalizeAddress(parentId),
      ...(opts.pageSize ? { pageSize: opts.pageSize } : {}),
      ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
      ...(opts.paths ? { readMask: { paths: opts.paths } } : {}),
    });
    return r.response as { dynamicFields?: unknown[]; nextPageToken?: Uint8Array };
  }

  async listOwnedObjects(
    owner: string,
    opts: { pageSize?: number; pageToken?: Uint8Array; paths?: string[] } = {},
  ) {
    const r = await this.client.stateService.listOwnedObjects({
      owner: normalizeAddress(owner),
      ...(opts.pageSize ? { pageSize: opts.pageSize } : {}),
      ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
      ...(opts.paths ? { readMask: { paths: opts.paths } } : {}),
    });
    return r.response as { objects?: unknown[]; nextPageToken?: Uint8Array };
  }

  async listBalances(owner: string) {
    const r = await this.client.stateService.listBalances({ owner: normalizeAddress(owner) });
    return r.response as { balances?: unknown[] };
  }
}
