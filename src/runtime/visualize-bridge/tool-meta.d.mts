export declare const VISUALIZE_OWNER_META_CODE: 'visualize_owner';
export declare function visualizeOwnerMetaSessionId(value: unknown): string;
export declare function visualizeOwnerToolMeta(
  ownerSessionId: unknown
): { code: typeof VISUALIZE_OWNER_META_CODE; missing: string[]; ownerSessionId: string } | undefined;
