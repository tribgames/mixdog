// The frames of the inbound lone-surrogate recording (record-inbound-lone-surrogate.mjs) and its replay against the core: what a
// paired phone seals and sends, step by step, over one world. A JSON string escape of an unpaired UTF-16 surrogate (`\ud800`) is
// what JSON.stringify writes for text cut inside an emoji; JSON.parse gives the lone code unit back.
//
// A `call` step is a phone call by its Node name and params: Node gets `{id, method, params}` (remote-methods.ts executeRemoteFrame),
// the core gets what the phone's own adapter sends for it (apps/desktop/src/renderer/remote-protocol-files.ts). The strings carry
// their escapes into both frames. A `raw` step is a frame sealed as it stands (raw-frame-bytes.mjs `frame`), for frames that are not
// a request of either protocol: Node refuses them, and so must the core, with what the phone is told.
//
// A step marked `refused` holds a lone surrogate where no shipped client sends one (an identifier, a path, a selector, a key; the
// field the core names is `field`): the core refuses the frame whole before any service runs (mixdog-app-protocol free_text.rs,
// decisions.md "frame-lone-surrogate"). Node runs it too and its answer and effect on the project folder are recorded (the recorder
// then puts the folder back, so the later steps run on the world the core has): the recording shows the difference the decision makes.
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bom, byte } from './raw-frame-bytes.mjs';

/** The world both sides run on: one project folder with one text file, at a fixed path (it is in the answers). */
export const ROOT = 'D:\\mixdog-build\\tmp\\inbound-lone-surrogate-world';
export const PROJECT = join(ROOT, 'project');
export const NOTES = 'notes.txt';
export const NOTES_BEFORE = 'old\n';
const NOTES_MTIME_S = 1_700_000_000;
/** The workspace file a step writes into the project folder. */
export const WORKSPACE = 'trip.code-workspace';
/** What the phone is told when the core refuses a frame holding a lone surrogate outside free text at `field` (a pointer into the
 *  core's frame, `params/...`): the files adapter turns the core's invalidParams into a TypeError of its `expected` sentence, which
 *  names the field (remote-protocol-files.ts `failure`), with the core's JSON-RPC error as its cause (protocol-client `ClientFailure`
 *  detail: code, reason, message, data), the error `lone_refusal` writes (mixdog-app-server server.rs). Compared whole for every
 *  `refused` step. */
export function loneRefusal(field) {
  const expected = `text without unpaired surrogates (a lone \\ud800-\\udfff escape) in ${field}`;
  const data = { reason: 'invalidParams', path: field, expected };
  return { ok: false, error: expected, rpc: { kind: 'rpc', code: -32602, reason: 'invalidParams', message: 'invalidParams', data } };
}
/** A file whose text holds a real U+FFFD, for the searches. */
const REPLACED = 'replaced.txt';
const INVALID = 'invalid.txt';

export function buildWorld() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, NOTES), NOTES_BEFORE);
  writeFileSync(join(PROJECT, REPLACED), 'a\ufffdb\n');
  // A file whose bytes are not UTF-8: Node decodes it with replacement (`a\ufffdb\n`) and marks it not lossless
  // (project-files.ts:61), and its save guard refuses it (:319).
  writeFileSync(join(PROJECT, INVALID), Buffer.from([0x61, 0xff, 0x62, 0x0a]));
  // Files whose names hold a real U+FFFD: what a name holding a lone surrogate opens once converted to UTF-8.
  writeFileSync(join(PROJECT, 'l\ufffd.txt'), 'hi\n');
  writeFileSync(join(PROJECT, 'p\ufffd.png'), 'png!');
  for (const name of ['l\ufffd.txt', 'p\ufffd.png', INVALID]) utimesSync(join(PROJECT, name), NOTES_MTIME_S, NOTES_MTIME_S);
  // A read answers the file's mtime: pinned, so it is the same in every run and on both sides.
  utimesSync(join(PROJECT, NOTES), NOTES_MTIME_S, NOTES_MTIME_S);
}

const P = PROJECT;
const HIGH = '\ud83d';
const LOW = '\ude00';

// Steps added after the first recording, with frame ids of their own (from 1001), so every other step keeps the bytes it was
// recorded with.
const ADDED = [
  // ── a lone unit where text is compared with what is on disk (replaced.txt holds `a\ufffdb\n`, l\ufffd.txt holds `hi\n`): an
  //    expected content (file text: refused as stale, it equals no file Node would save over) is compared with Node's; a selector,
  //    a path or a name is refused by the core; a file-name query (free text) matches nothing ──
  { name: 'expected-content-lone', call: 'writeProjectFile', params: [P, 'replaced.txt', 'new\n', `a${HIGH}b\n`] },
  { name: 'batch-expected-content-lone', call: 'lspApplyWorkspaceEdit', params: [P, [{ relPath: 'replaced.txt', content: 'new\n', expectedContent: `a${LOW}b\n` }]] },
  { name: 'search-include-lone', refused: true, field: 'projectFs/searchText.params/options/include', call: 'searchWorkspaceText', params: [P, { query: 'hi', include: `l${HIGH}.txt` }] },
  { name: 'search-exclude-lone', refused: true, field: 'projectFs/searchText.params/options/exclude', call: 'searchWorkspaceText', params: [P, { query: 'hi', exclude: `l${HIGH}.txt` }] },
  { name: 'replace-include-lone', refused: true, field: 'projectFs/replaceText.params/options/include', call: 'replaceWorkspaceText', params: [P, { query: 'hi', include: `l${HIGH}.txt` }, 'yo'] },
  { name: 'replace-rel-paths-lone', refused: true, field: 'projectFs/replaceText.params/relPaths/0', call: 'replaceWorkspaceText', params: [P, { query: 'hi' }, 'yo', [`l${HIGH}.txt`]] },
  { name: 'file-search-lone', call: 'searchProjectFiles', params: [P, HIGH, 50, false, false] },
  { name: 'file-search-real-replacement', call: 'searchProjectFiles', params: [P, '\ufffd', 50, false, false] },
  { name: 'rename-case-only-lone', refused: true, field: 'projectFs/rename.params/newName', call: 'renameProjectEntry', params: [P, 'l\ufffd.txt', `L${HIGH}.txt`] },
  { name: 'rename-case-only-lone-listed', call: 'listProjectDir', params: [P, ''] },
  // ── escape forms, sent as these exact bytes to Node (`json`: the params' JSON text); the phone holds the string Node parsed and
  //    its adapter writes the core's frame from it ──
  { name: 'alias-high-then-escape', call: 'renameProject', json: `["${P.replaceAll('\\', '\\\\')}","a\\ud83d\\u0041"]` },
  { name: 'alias-high-then-escape-listed', call: 'listProjects', params: [] },
  { name: 'alias-two-highs-then-low', call: 'renameProject', json: `["${P.replaceAll('\\', '\\\\')}","\\ud83d\\ud83d\\ude00"]` },
  { name: 'alias-two-highs-then-low-listed', call: 'listProjects', params: [] },
  { name: 'alias-upper-hex', call: 'renameProject', json: `["${P.replaceAll('\\', '\\\\')}","\\uD83D x"]` },
  { name: 'alias-upper-hex-listed', call: 'listProjects', params: [] },
  { name: 'alias-literal-backslash-u', call: 'renameProject', json: `["${P.replaceAll('\\', '\\\\')}","\\\\ud83d"]` },
  { name: 'alias-literal-backslash-u-listed', call: 'listProjects', params: [] },
  { name: 'alias-escaped-pair', call: 'renameProject', json: `["${P.replaceAll('\\', '\\\\')}","\\ud83d\\ude00"]` },
  { name: 'alias-escaped-pair-listed', call: 'listProjects', params: [] },
  // A key twice in one object: JSON.parse keeps the last value, and the search finds what that one asks for.
  { name: 'search-duplicated-key', call: 'searchWorkspaceText', json: `["${P.replaceAll('\\', '\\\\')}",{"query":"zzz","query":"hi"}]` },
  // ── a free-text field the fifth review listed that a phone reaches: a workspace folder's display name, written into the
  //    workspace file (compared with the project folder at the end) ──
  { name: 'workspace-folder-name-lone', call: 'saveWorkspace', params: [join(P, WORKSPACE), [{ path: P, name: `Trip ${HIGH}` }]] },
  // ── an expected content holding a lone unit against (a) a clean file holding a real U+FFFD (above, `expected-content-lone`), (b) a
  //    file whose bytes decode with replacement (invalid.txt reads `a\ufffdb\n`), (c) the same with the content holding one; and
  //    the expected text the replaced file reads as, which must not make the guard match a file Node refuses ──
  { name: 'expected-content-lone-invalid-file', call: 'writeProjectFile', params: [P, INVALID, 'new\n', `a${HIGH}b\n`] },
  { name: 'expected-content-lone-invalid-file-lone-content', call: 'writeProjectFile', params: [P, INVALID, `n${LOW}\n`, `a${HIGH}b\n`] },
  { name: 'expected-content-lone-lone-content', call: 'writeProjectFile', params: [P, 'replaced.txt', `n${LOW}\n`, `a${HIGH}b\n`] },
  { name: 'expected-content-replaced-reading-invalid-file', call: 'writeProjectFile', params: [P, INVALID, 'new\n', 'a\ufffdb\n'] },
  { name: 'batch-expected-content-lone-invalid-file', call: 'lspApplyWorkspaceEdit', params: [P, [{ relPath: INVALID, content: 'new\n', expectedContent: `a${LOW}b\n` }]] },
].map((step, index) => ({ ...step, id: 1001 + index }));

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
  { name: 'file-name-lone', refused: true, field: 'projectFs/create.params/name', call: 'createProjectEntry', params: [P, '', `n${LOW}.txt`, false] },
  { name: 'file-name-listed', call: 'listProjectDir', params: [P, ''] },
  // ── a save refused for its content's lone surrogate (project-files.ts:96, :744); and a real U+FFFD in the content beside a lone
  //    surrogate in another field of the same call (a file name: the file `n\ufffd.txt` exists) ──
  { name: 'batch-content-lone', call: 'lspApplyWorkspaceEdit', params: [P, [{ relPath: NOTES, content: `y${LOW}`, expectedContent: NOTES_BEFORE }]] },
  { name: 'replace-lone-replacement', call: 'replaceWorkspaceText', params: [P, { query: 'old' }, `new${HIGH}`] },
  {
    name: 'batch-real-replacement-lone-name', refused: true, field: 'projectFs/writeTextBatch.params/files/1/relPath',
    call: 'lspApplyWorkspaceEdit',
    params: [P, [{ relPath: NOTES, content: 'b\ufffd\n', expectedContent: NOTES_BEFORE }, { relPath: `n${LOW}.txt`, content: 'c', expectedContent: '' }]],
  },
  { name: 'batch-real-replacement', call: 'lspApplyWorkspaceEdit', params: [P, [{ relPath: NOTES, content: 'b\ufffd\n', expectedContent: NOTES_BEFORE }]] },
  // ── a file name holding a lone surrogate on the phone's file lanes (Node's authorized open refuses it,
  //    opened-file-authorization.ts:77; a stat is no authorized open), beside the same file named with a real U+FFFD ──
  { name: 'read-lone-name', refused: true, field: 'projectFs/readText.params/rel', call: 'readProjectFile', params: [P, `l${HIGH}.txt`] },
  { name: 'read-missing-lone-name', refused: true, field: 'projectFs/readText.params/rel', call: 'readProjectFile', params: [P, `m${HIGH}.txt`] },
  { name: 'read-real-replacement-name', call: 'readProjectFile', params: [P, 'l\ufffd.txt'] },
  { name: 'stat-lone-name', refused: true, field: 'projectFs/stat.params/rel', call: 'statProjectFile', params: [P, `l${LOW}.txt`] },
  { name: 'write-lone-name', refused: true, field: 'projectFs/writeText.params/rel', call: 'writeProjectFile', params: [P, `l${HIGH}.txt`, 'z', 'hi\n'] },
  { name: 'preview-lone-name', refused: true, field: 'projectFs/previewFile.params/rel', call: 'previewProjectFile', params: [P, `p${HIGH}.png`] },
  { name: 'preview-range-lone-name', refused: true, field: 'projectFs/previewRange.params/rel', call: 'previewProjectFileRange', params: [P, `p${LOW}.png`, null, 0, 4] },
  { name: 'preview-range-real-replacement-name', call: 'previewProjectFileRange', params: [P, 'p\ufffd.png', null, 0, 4] },
  // ── a search for a lone surrogate, and for a real U+FFFD, in text that holds a real U+FFFD; a replace with a lone query ──
  { name: 'search-lone-query', call: 'searchWorkspaceText', params: [P, { query: HIGH }] },
  { name: 'search-real-replacement', call: 'searchWorkspaceText', params: [P, { query: '\ufffd' }] },
  { name: 'replace-lone-query', call: 'replaceWorkspaceText', params: [P, { query: `b${HIGH}` }, 'x'] },
  {
    name: 'search-regex-lone-query',
    call: 'searchWorkspaceText',
    params: [P, { query: `a${LOW}`, regex: true }],
    // The one answer accepted in place of Node's: Node's own answer to the same query with a real U+FFFD (the step below).
    accepted: {
      decision: 'decisions.md "frame-lone-surrogate": a regex query holding a lone surrogate reads it as U+FFFD',
      standIn: 'search-regex-real-replacement-query',
    },
  },
  // The stand-in of the step above, on the folder that step searched: a search writes nothing, and nothing runs between the two. Its
  // own frame id keeps the frames of the later steps the bytes they were recorded with.
  { name: 'search-regex-real-replacement-query', call: 'searchWorkspaceText', params: [P, { query: 'a\ufffd', regex: true }], id: 1000 },
  // ── in a key ──
  // The phone's own argument check refuses the unknown key before any frame is sent (shared/remote-files-arguments.ts:58), on
  // Node's side as on the core's.
  { name: 'key-lone', call: 'searchWorkspaceText', params: [P, { query: 'x', [HIGH]: true }] },
  ...ADDED,
  // ── invalid UTF-8 and a BOM inside the sealed frame (Node decodes with a non-fatal TextDecoder, remote-e2ee.ts:9, :692) ──
  { name: 'alias-invalid-byte', call: 'renameProject', params: [P, `ab${byte('ff')}cd`] },
  { name: 'alias-invalid-byte-listed', call: 'listProjects', params: [] },
  { name: 'alias-truncated-sequence', call: 'renameProject', params: [P, `ab${byte('e2')}${byte('82')}cd`] },
  { name: 'alias-truncated-sequence-listed', call: 'listProjects', params: [] },
  { name: 'alias-bom-frame', call: 'renameProject', params: [P, `${bom}Trip`] },
  { name: 'alias-bom-frame-listed', call: 'listProjects', params: [] },
  // ── a method name (Node's answer echoes it). No Node counterpart: the core's method names are its own. The core's answer is
  //    compared whole with its own refusal of a method name that does not exist (the same name with a real U+FFFD), and the
  //    connection must answer the next frame ──
  {
    name: 'method-name-lone',
    call: `listProjects${HIGH}`,
    params: [],
    coreRaw: '{"id":900,"method":"project/list\\ud83d","params":{}}',
    coreId: 900,
    coreNext: { raw: '{"id":901,"method":"project/list","params":{}}', id: 901 },
  },
  // ── frames Node refuses: what the phone is told ──
  { name: 'refused-truncated-json', raw: '{"id":7,"method":"listProjects","params":[' },
  { name: 'refused-truncated-json-lone', raw: '{"id":8,"method":"\\ud800' },
  { name: 'refused-invalid-byte-outside-strings', raw: `${byte('ff')}{"id":9,"method":"listProjects","params":[]}` },
  { name: 'refused-empty', raw: '' },
  // ── after every refusal a new phone is answered as before ──
  { name: 'listed-at-the-end', call: 'listProjects', params: [] },
];
