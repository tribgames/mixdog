export interface NativeRuntimeCacheGcFailure {
  kind: string;
  error: unknown;
}

export interface NativeRuntimeCacheGcResult {
  removed: string[];
  failed: NativeRuntimeCacheGcFailure[];
}

export function gcSupersededNativeToolCaches(
  dataDir: string,
  bundledKinds: string[],
): Promise<NativeRuntimeCacheGcResult>;
