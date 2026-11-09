// Node b6f10295a src/runtime/shared/markdown-frontmatter.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./i18n.test.0.recorded.json', import.meta.url), 'utf8'));
export const normalizeAgentPermission = replay(table, "normalizeAgentPermission");
export const normalizeAgentPermissionOrNone = replay(table, "normalizeAgentPermissionOrNone");
export const parseMarkdownFrontmatter = replay(table, "parseMarkdownFrontmatter");
export const readMarkdownDocument = replay(table, "readMarkdownDocument");
export const serializeFrontmatterDoc = replay(table, "serializeFrontmatterDoc");
