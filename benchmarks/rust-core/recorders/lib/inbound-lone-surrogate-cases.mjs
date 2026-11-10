// The frames of the inbound lone-surrogate recording (record-inbound-lone-surrogate.mjs) and its replay against the core: what a
// paired phone seals and sends, step by step, over one world. A JSON string escape of an unpaired UTF-16 surrogate (`\ud800`) is
// what JSON.stringify writes for text cut inside an emoji; JSON.parse gives the lone code unit back.
//
// A `call` step is a phone call by its Node name and params: Node gets `{id, method, params}` (remote-methods.ts executeRemoteFrame),
// the core gets what the phone's own adapter sends for it (apps/desktop/src/renderer/remote-protocol-files.ts). The strings carry
// their escapes into both frames. A `raw` step is a frame sealed as it stands (raw-frame-bytes.mjs `frame`), for frames that are not
// a request of either protocol: Node refuses them, and so must the core, with what the phone is told.
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bom, byte } from './raw-frame-bytes.mjs';

/** The world both sides run on: one project folder with one text file, at a fixed path (it is in the answers). */
export const ROOT = 'D:\\mixdog-build\\tmp\\inbound-lone-surrogate-world';
export const PROJECT = join(ROOT, 'project');
export const NOTES = 'notes.txt';
export const NOTES_BEFORE = 'old\n';
const NOTES_MTIME_S = 1_700_000_000;
/** A file whose text holds a real U+FFFD, for the searches. */
const REPLACED = 'replaced.txt';

export function buildWorld() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, NOTES), NOTES_BEFORE);
  writeFileSync(join(PROJECT, REPLACED), 'a\ufffdb\n');
  // Files whose names hold a real U+FFFD: what a name holding a lone surrogate opens once converted to UTF-8.
  writeFileSync(join(PROJECT, 'l\ufffd.txt'), 'hi\n');
  writeFileSync(join(PROJECT, 'p\ufffd.png'), 'png!');
  for (const name of ['l\ufffd.txt', 'p\ufffd.png']) utimesSync(join(PROJECT, name), NOTES_MTIME_S, NOTES_MTIME_S);
  // A read answers the file's mtime: pinned, so it is the same in every run and on both sides.
  utimesSync(join(PROJECT, NOTES), NOTES_MTIME_S, NOTES_MTIME_S);
}

const P = PROJECT;
const HIGH = '\ud83d';
const LOW = '\ude00';

/** Every step, in order. `bytes` says what the case is about. */
export const STEPS = [
  { name: 'register-project', call: 'addProject', params: [P] },
  // ── echo and read back (the alias is stored and listed) ──
  { name: 'alias-high-at-end', call: 'renameProject', params: [P, `Trip ${HIGH}`] },
  { name: 'alias-high-at-end-listed', call: 'listProjects', params: [] },
  { name: 'alias-low-at-start', call: 'renameProject', params: [P, `${LOW} Trip`] },
  { name: 'alias-low-at-start-listed', call: 'listProjects', params: [] },
  { name: 'alias-reversed-pair', call: 'renameProject', params: [P, `a${LOW}${HIGH}b`] },
  { name: 'alias-reversed-pair-listed', call: 'listProjects', params: [] },
  // ── a length limit the surrogate's length decides (projectDisplayName: 120 UTF-16 units after trim) ──
  { name: 'alias-120-units-lone', call: 'renameProject', params: [P, `${'a'.repeat(119)}\ud800`] },
  { name: 'alias-120-units-lone-listed', call: 'listProjects', params: [] },
  { name: 'alias-121-units-lone', call: 'renameProject', params: [P, `${'a'.repeat(120)}\ud800`] },
  { name: 'alias-121-units-pair', call: 'renameProject', params: [P, `${'a'.repeat(119)}${HIGH}${LOW}`] },
  { name: 'alias-after-refusals-listed', call: 'listProjects', params: [] },
  // ── a nested value written to a file as text, and read back; a file name ──
  { name: 'file-content-lone', call: 'writeProjectFile', params: [P, NOTES, `x${HIGH}y\n${LOW}`, NOTES_BEFORE] },
  { name: 'file-content-read', call: 'readProjectFile', params: [P, NOTES] },
  { name: 'file-name-lone', call: 'createProjectEntry', params: [P, '', `n${LOW}.txt`, false] },
  { name: 'file-name-listed', call: 'listProjectDir', params: [P, ''] },
  // ── a save refused for its content's lone surrogate (project-files.ts:96, :744); and a real U+FFFD in the content beside a lone
  //    surrogate in another field of the same call (a file name: the file `n\ufffd.txt` exists) ──
  { name: 'batch-content-lone', call: 'lspApplyWorkspaceEdit', params: [P, [{ relPath: NOTES, content: `y${LOW}`, expectedContent: NOTES_BEFORE }]] },
  { name: 'replace-lone-replacement', call: 'replaceWorkspaceText', params: [P, { query: 'old' }, `new${HIGH}`] },
  {
    name: 'batch-real-replacement-lone-name',
    call: 'lspApplyWorkspaceEdit',
    params: [P, [{ relPath: NOTES, content: 'b\ufffd\n', expectedContent: NOTES_BEFORE }, { relPath: `n${LOW}.txt`, content: 'c', expectedContent: '' }]],
  },
  { name: 'batch-real-replacement', call: 'lspApplyWorkspaceEdit', params: [P, [{ relPath: NOTES, content: 'b\ufffd\n', expectedContent: NOTES_BEFORE }]] },
  // ── a file name holding a lone surrogate on the phone's file lanes (Node's authorized open refuses it,
  //    opened-file-authorization.ts:77; a stat is no authorized open), beside the same file named with a real U+FFFD ──
  { name: 'read-lone-name', call: 'readProjectFile', params: [P, `l${HIGH}.txt`] },
  { name: 'read-missing-lone-name', call: 'readProjectFile', params: [P, `m${HIGH}.txt`] },
  { name: 'read-real-replacement-name', call: 'readProjectFile', params: [P, 'l\ufffd.txt'] },
  { name: 'stat-lone-name', call: 'statProjectFile', params: [P, `l${LOW}.txt`] },
  { name: 'write-lone-name', call: 'writeProjectFile', params: [P, `l${HIGH}.txt`, 'z', 'hi\n'] },
  { name: 'preview-lone-name', call: 'previewProjectFile', params: [P, `p${HIGH}.png`] },
  { name: 'preview-range-lone-name', call: 'previewProjectFileRange', params: [P, `p${LOW}.png`, null, 0, 4] },
  { name: 'preview-range-real-replacement-name', call: 'previewProjectFileRange', params: [P, 'p\ufffd.png', null, 0, 4] },
  // ── a search for a lone surrogate, and for a real U+FFFD, in text that holds a real U+FFFD; a replace with a lone query ──
  { name: 'search-lone-query', call: 'searchWorkspaceText', params: [P, { query: HIGH }] },
  { name: 'search-real-replacement', call: 'searchWorkspaceText', params: [P, { query: '\ufffd' }] },
  { name: 'replace-lone-query', call: 'replaceWorkspaceText', params: [P, { query: `b${HIGH}` }, 'x'] },
  {
    name: 'search-regex-lone-query',
    call: 'searchWorkspaceText',
    params: [P, { query: `a${LOW}`, regex: true }],
    accepted: 'decisions.md "frame-lone-surrogate": a regex query holding a lone surrogate reads it as U+FFFD',
  },
  // ── in a key ──
  { name: 'key-lone', call: 'searchWorkspaceText', params: [P, { query: 'x', [HIGH]: true }] },
  // ── invalid UTF-8 and a BOM inside the sealed frame (Node decodes with a non-fatal TextDecoder, remote-e2ee.ts:9, :692) ──
  { name: 'alias-invalid-byte', call: 'renameProject', params: [P, `ab${byte('ff')}cd`] },
  { name: 'alias-invalid-byte-listed', call: 'listProjects', params: [] },
  { name: 'alias-truncated-sequence', call: 'renameProject', params: [P, `ab${byte('e2')}${byte('82')}cd`] },
  { name: 'alias-truncated-sequence-listed', call: 'listProjects', params: [] },
  { name: 'alias-bom-frame', call: 'renameProject', params: [P, `${bom}Trip`] },
  { name: 'alias-bom-frame-listed', call: 'listProjects', params: [] },
  // ── a method name (Node's answer echoes it; the core's method names are its own, so the core is asked for one of its own) ──
  { name: 'method-name-lone', call: `listProjects${HIGH}`, params: [], coreRaw: `{"id":900,"method":"project/list\\ud83d","params":{}}`, coreId: 900 },
  // ── frames Node refuses: what the phone is told ──
  { name: 'refused-truncated-json', raw: '{"id":7,"method":"listProjects","params":[' },
  { name: 'refused-truncated-json-lone', raw: '{"id":8,"method":"\\ud800' },
  { name: 'refused-invalid-byte-outside-strings', raw: `${byte('ff')}{"id":9,"method":"listProjects","params":[]}` },
  { name: 'refused-empty', raw: '' },
  // ── after every refusal a new phone is answered as before ──
  { name: 'listed-at-the-end', call: 'listProjects', params: [] },
];
