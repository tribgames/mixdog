// Generate the file-path language resolver used by both the Monaco PANE and
// scoped editor settings. The editor language contributions are the authority;
// Monaco-native ids are retained, compatible ids are translated, and every
// remaining language is explicitly classified instead of silently falling
// through to plaintext.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const languageSourceRoot = process.argv[2] || process.env.MIXDOG_EDITOR_LANGUAGE_SOURCE || '';
if (!languageSourceRoot) {
  throw new Error('Pass the editor language-contribution root as argv[2] (or set MIXDOG_EDITOR_LANGUAGE_SOURCE).');
}
const extensionsRoot = resolve(languageSourceRoot);
const monacoRoot = resolve(process.argv[3]
  || join(here, '../node_modules/monaco-editor/esm/vs'));
const outputPath = join(here, '../src/shared/editor-languages.ts');

const COMPATIBLE_LANGUAGE_IDS = {
  'chatagent': 'markdown',
  'cuda-cpp': 'cpp',
  'dockercompose': 'yaml',
  'dotenv': 'ini',
  'groovy': 'java',
  'hlsl': 'cpp',
  'instructions': 'markdown',
  'javascriptreact': 'javascript',
  'jade': 'pug',
  'jsonc': 'json',
  'jsonl': 'json',
  'juliamarkdown': 'markdown',
  'makefile': 'shell',
  'objective-cpp': 'cpp',
  'prompt': 'markdown',
  'properties': 'ini',
  'raku': 'perl',
  'shaderlab': 'cpp',
  'shellscript': 'shell',
  'skill': 'markdown',
  'snippets': 'json',
  'typescriptreact': 'typescript',
  'xsl': 'xml',
};
const CUSTOM_LANGUAGE_IDS = { log: 'log' };

const walk = (root) => readdirSync(root, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? walk(join(root, entry.name))
    : [join(root, entry.name)]);

const monacoLanguageIds = new Set(['json', 'plaintext']);
const contributionRoot = join(monacoRoot, 'basic-languages');
for (const path of walk(contributionRoot).filter((entry) => entry.endsWith('.contribution.js'))) {
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(
    /registerLanguage\s*\(\s*\{[\s\S]*?\bid:\s*["']([^"']+)["'][\s\S]*?\}\s*\)/g,
  )) {
    monacoLanguageIds.add(match[1]);
  }
}

const sourceLanguages = new Map();
const pushUnique = (rows, value) => {
  if (!rows.includes(value)) rows.push(value);
};
const extensionEntries = readdirSync(extensionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name));
for (const entry of extensionEntries) {
  const packagePath = join(extensionsRoot, entry.name, 'package.json');
  if (!existsSync(packagePath)) continue;
  const extension = JSON.parse(readFileSync(packagePath, 'utf8'));
  for (const language of extension?.contributes?.languages || []) {
    const id = String(language.id || '');
    if (!id) continue;
    const row = sourceLanguages.get(id) || {
      id,
      extensions: [],
      filenames: [],
      patterns: [],
    };
    for (const value of language.extensions || []) pushUnique(row.extensions, String(value));
    for (const value of language.filenames || []) pushUnique(row.filenames, String(value));
    for (const value of language.filenamePatterns || []) pushUnique(row.patterns, String(value));
    sourceLanguages.set(id, row);
  }
}

const decisions = {};
for (const id of [...sourceLanguages.keys()].sort()) {
  if (monacoLanguageIds.has(id)) {
    decisions[id] = { target: id, classification: 'native' };
  } else if (CUSTOM_LANGUAGE_IDS[id]) {
    decisions[id] = { target: CUSTOM_LANGUAGE_IDS[id], classification: 'custom' };
  } else if (COMPATIBLE_LANGUAGE_IDS[id]) {
    decisions[id] = { target: COMPATIBLE_LANGUAGE_IDS[id], classification: 'compatible' };
  } else {
    decisions[id] = { target: 'plaintext', classification: 'plaintext' };
  }
}

const extensions = {};
const names = {};
const patterns = [];
const patternKeys = new Set();
const setFirst = (record, key, value) => {
  if (key && !Object.prototype.hasOwnProperty.call(record, key)) record[key] = value;
};
const addPattern = (pattern, languageId) => {
  const normalized = String(pattern || '').replace(/\\/g, '/').toLowerCase();
  const key = `${normalized}\0${languageId}`;
  if (!normalized || patternKeys.has(key)) return;
  patternKeys.add(key);
  patterns.push({
    pattern: normalized,
    scope: normalized.includes('/') ? 'path' : 'name',
    languageId,
  });
};
for (const language of sourceLanguages.values()) {
  const target = decisions[language.id].target;
  for (const rawValue of language.extensions) {
    const raw = rawValue.replace(/\\/g, '/').toLowerCase();
    if (/[*?]/.test(raw)) addPattern(raw, target);
    else if (raw.startsWith('.')) setFirst(extensions, raw.slice(1), target);
    else setFirst(names, raw, target);
  }
  for (const raw of language.filenames) setFirst(names, raw.toLowerCase(), target);
  for (const raw of language.patterns) addPattern(raw, target);
}

const globRegexSource = (pattern) => {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += '\\^$+?.()|{}[]'.includes(character) ? `\\${character}` : character;
    }
  }
  return `${source}$`;
};
const recordSource = (record) => Object.entries(record)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  .join('\n');
const decisionSource = Object.entries(decisions)
  .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  .join('\n');
const patternSource = patterns
  .map((row) => `  { pattern: ${JSON.stringify(row.pattern)}, scope: ${JSON.stringify(row.scope)}, `
    + `languageId: ${JSON.stringify(row.languageId)}, regex: new RegExp(${JSON.stringify(globRegexSource(row.pattern))}, "i") },`)
  .join('\n');
const uniqueSourceCount = (property) => new Set(
  [...sourceLanguages.values()].flatMap((language) =>
    language[property].map((value) => String(value).toLowerCase())),
).size;
const classificationCounts = Object.values(decisions).reduce((counts, decision) => {
  counts[decision.classification] = (counts[decision.classification] || 0) + 1;
  return counts;
}, {});

const output = `// GENERATED FILE — do not edit by hand: run scripts/generate-editor-languages.mjs.
// Editor language contributions resolved onto Monaco PANE languages.

export type EditorLanguageClassification = "native" | "compatible" | "custom" | "plaintext";
export interface EditorLanguageDecision {
  target: string;
  classification: EditorLanguageClassification;
}
export interface EditorLanguagePattern {
  pattern: string;
  scope: "name" | "path";
  languageId: string;
  regex: RegExp;
}

export const EDITOR_LANGUAGE_AUDIT = ${JSON.stringify({
  sourceLanguageIds: sourceLanguages.size,
  sourceExtensions: uniqueSourceCount('extensions'),
  sourceFileNames: uniqueSourceCount('filenames'),
  sourcePatterns: uniqueSourceCount('patterns'),
  runtimeExtensionKeys: Object.keys(extensions).length,
  runtimeFileNames: Object.keys(names).length,
  runtimePatternRules: patterns.length,
  classifications: classificationCounts,
}, null, 2)} as const;

export const EDITOR_LANGUAGE_DECISIONS: Readonly<Record<string, EditorLanguageDecision>> = {
${decisionSource}
};

export const EDITOR_LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
${recordSource(extensions)}
};

export const EDITOR_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
${recordSource(names)}
};

export const EDITOR_LANGUAGE_PATTERNS: readonly EditorLanguagePattern[] = [
${patternSource}
];

export function explicitEditorLanguageIdForPath(path: string): string | undefined {
  const normalized = String(path || "").replace(/\\\\/g, "/").toLowerCase();
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const named = EDITOR_LANGUAGE_NAMES[base];
  if (named) return named;
  for (const rule of EDITOR_LANGUAGE_PATTERNS) {
    const candidate = rule.scope === "path" ? normalized : base;
    if (rule.regex.test(candidate)) return rule.languageId;
  }
  const parts = base.split(".");
  for (let index = 0; index < parts.length; index += 1) {
    const suffix = parts.slice(index).join(".").replace(/^\\./, "");
    const languageId = EDITOR_LANGUAGE_EXTENSIONS[suffix];
    if (languageId) return languageId;
  }
  return undefined;
}

export function editorLanguageIdForPath(path: string): string {
  return explicitEditorLanguageIdForPath(path) || "plaintext";
}
`;

writeFileSync(outputPath, output);
console.log(`editor-languages.ts: ${sourceLanguages.size} source ids, `
  + `${Object.keys(extensions).length} extensions, ${Object.keys(names).length} names, `
  + `${patterns.length} patterns`);
