// Regenerates src/renderer/seti-icons.ts and src/renderer/seti.woff from the
// VS Code built-in "theme-seti" extension (which packages Seti UI, (c) 2014
// Jesse Weed — MIT; see THIRD-PARTY-NOTICES.txt).
//
//   node scripts/generate-seti-icons.mjs [path-to-theme-seti]
//
// Only the dark-theme glyph/colour set is emitted. VS Code resolves the theme's
// languageIds through every built-in language contribution, so those derived
// extensions/file names must be folded back in alongside explicit overrides.
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2] || 'C:/Project/refs/vscode/extensions/theme-seti');
const theme = JSON.parse(readFileSync(join(source, 'icons/vs-seti-icon-theme.json'), 'utf8'));

const escapeChar = (definition) =>
  '\\u' + definition.fontCharacter.replace(/^\\/, '').toUpperCase().padStart(4, '0');

const used = new Map();
const claim = (id) => {
  const definition = theme.iconDefinitions[id];
  if (!definition?.fontCharacter) return false;
  if (!used.has(id)) used.set(id, [escapeChar(definition), definition.fontColor || '']);
  return true;
};
const mapOf = (record) => {
  const rows = {};
  for (const [key, id] of Object.entries(record || {})) {
    if (claim(id)) rows[key.toLowerCase()] = id;
  }
  return rows;
};
const languageAssociations = () => {
  const derivedExtensions = {};
  const derivedNames = {};
  const extensionsRoot = dirname(source);
  const entries = readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const packagePath = join(extensionsRoot, entry.name, 'package.json');
    if (!existsSync(packagePath)) continue;
    const extension = JSON.parse(readFileSync(packagePath, 'utf8'));
    for (const language of extension?.contributes?.languages || []) {
      const id = theme.languageIds?.[language.id];
      if (!id || !claim(id)) continue;
      for (const raw of language.extensions || []) {
        const key = String(raw).replace(/^\./, '').toLowerCase();
        if (key && !derivedExtensions[key]) derivedExtensions[key] = id;
      }
      for (const raw of language.filenames || []) {
        const key = String(raw).toLowerCase();
        if (key && !derivedNames[key]) derivedNames[key] = id;
      }
    }
  }
  return { extensions: derivedExtensions, names: derivedNames };
};
const language = languageAssociations();
// Explicit Seti associations are exceptions to the language-derived icon and
// therefore win, matching VS Code's generated theme resolution.
const extensions = { ...language.extensions, ...mapOf(theme.fileExtensions) };
const names = { ...language.names, ...mapOf(theme.fileNames) };
claim(theme.file);

const defsSource = [...used.entries()]
  .map(([id, [glyph, color]]) => `  ${JSON.stringify(id)}: ["${glyph}", ${JSON.stringify(color)}],`)
  .join('\n');
const recordSource = (record) => Object.entries(record)
  .map(([key, id]) => `  ${JSON.stringify(key)}: ${JSON.stringify(id)},`)
  .join('\n');

const output = [
  '// GENERATED FILE — do not edit by hand: run scripts/generate-seti-icons.mjs.',
  '// Glyph/colour tables from the VS Code built-in Seti file icon theme',
  '// (extensions/theme-seti), which packages Seti UI (c) 2014 Jesse Weed — MIT.',
  '// See THIRD-PARTY-NOTICES.txt. Dark-theme colour set.',
  '',
  `export const SETI_DEFAULT_ID = ${JSON.stringify(theme.file)};`,
  '',
  'export const SETI_ICON_DEFS: Record<string, readonly [string, string]> = {',
  defsSource,
  '};',
  '',
  'export const SETI_FILE_EXTENSIONS: Record<string, string> = {',
  recordSource(extensions),
  '};',
  '',
  'export const SETI_FILE_NAMES: Record<string, string> = {',
  recordSource(names),
  '};',
  '',
  'export interface SetiIcon { glyph: string; color: string; }',
  '',
  '/** VS Code fileIconTheme resolution: exact file name, then every dotted',
  ' *  suffix ("a.test.ts" -> "test.ts" -> "ts"), then the generic file icon. */',
  'export function setiIconFor(fileName: string): SetiIcon {',
  "  const lower = String(fileName || '').toLowerCase();",
  '  let id = SETI_FILE_NAMES[lower];',
  '  if (!id) {',
  "    const parts = lower.split('.');",
  '    for (let index = 1; index < parts.length && !id; index += 1) {',
  "      id = SETI_FILE_EXTENSIONS[parts.slice(index).join('.')];",
  '    }',
  '  }',
  '  const definition = SETI_ICON_DEFS[id || SETI_DEFAULT_ID] || SETI_ICON_DEFS[SETI_DEFAULT_ID];',
  '  return { glyph: definition[0], color: definition[1] };',
  '}',
  '',
].join('\n');

writeFileSync(join(here, '../src/renderer/seti-icons.ts'), output);
copyFileSync(join(source, 'icons/seti.woff'), join(here, '../src/renderer/seti.woff'));
console.log(`seti-icons.ts: ${used.size} definitions, `
  + `${Object.keys(extensions).length} extensions, ${Object.keys(names).length} names`);
