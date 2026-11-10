import { fileURLToPath } from 'node:url';

export const BUNDLED_PATCH_MANIFEST_PATH = fileURLToPath(new URL('./patch-manifest.json', import.meta.url));
