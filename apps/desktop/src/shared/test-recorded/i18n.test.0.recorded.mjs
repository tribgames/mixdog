// Node b6f10295a2f698afc85332467192de28500bd146 (tree 332679f9c46ead536c500ab57a7580c0fb28d550) src/runtime/shared/markdown-frontmatter.mjs, recorded from apps/desktop/src/renderer/i18n.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./i18n.test.0.recorded.json', import.meta.url), 'utf8'));
export const normalizeAgentPermission = replay(table, "normalizeAgentPermission");
export const normalizeAgentPermissionOrNone = replay(table, "normalizeAgentPermissionOrNone");
export const parseMarkdownFrontmatter = replay(table, "parseMarkdownFrontmatter");
export const readMarkdownDocument = replay(table, "readMarkdownDocument");
export const serializeFrontmatterDoc = replay(table, "serializeFrontmatterDoc");
