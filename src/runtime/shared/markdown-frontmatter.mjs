const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const AGENT_PERMISSION_ALIASES = new Map([
  ['none', 'none'],
  ['readonly', 'read'],
  ['read-only', 'read'],
  ['read', 'read'],
  ['write', 'read-write'],
  ['readwrite', 'read-write'],
  ['read_write', 'read-write'],
  ['read-write', 'read-write'],
  ['mcp', 'mcp'],
  ['full', 'full'],
]);

function clean(value) {
  return String(value ?? '').trim();
}

function unquote(value) {
  return clean(value).replace(/^['"]|['"]$/g, '').trim();
}

export function parseMarkdownFrontmatter(markdown) {
  const match = String(markdown || '').match(FRONTMATTER_RE);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!kv) continue;
    meta[kv[1]] = unquote(kv[2]);
  }
  return meta;
}

function stripMarkdownFrontmatter(markdown) {
  return String(markdown || '').replace(FRONTMATTER_RE, '').trim();
}

export function readMarkdownDocument(markdown) {
  return {
    frontmatter: parseMarkdownFrontmatter(markdown),
    body: stripMarkdownFrontmatter(markdown),
  };
}

// Serialize a single-file frontmatter markdown document:
//   ---
//   key: value
//   ---
//
//   <body>
// Values are stringified as-is (enabled:false -> "false"); the reader casts
// types back. Mirrors the WORKFLOW.md / SKILL.md single-file convention,
// where `name` and `description` lead the frontmatter.
export function serializeFrontmatterDoc(meta = {}, body = '') {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${String(body || '').trim()}\n`;
}

export function normalizeAgentPermission(value) {
  const key = clean(value).toLowerCase();
  return AGENT_PERMISSION_ALIASES.get(key) || null;
}

export function normalizeAgentPermissionOrNone(value) {
  const raw = clean(value);
  if (!raw) return null;
  return normalizeAgentPermission(raw) || 'none';
}
