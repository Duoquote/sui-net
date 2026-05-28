export const MAINNET_GRPC = 'https://fullnode.mainnet.sui.io:443';

export interface GlobalOptions {
  json: boolean;
  noCache: boolean;
  /** TTL in milliseconds for serving mutable objects from cache (0 = always refetch). */
  cacheTtlMs: number;
  /** Override the gRPC base URL (e.g. a paid mainnet provider). */
  rpc?: string;
}
