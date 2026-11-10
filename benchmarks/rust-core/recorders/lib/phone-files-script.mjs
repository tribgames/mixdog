// The script of the phone's "Files and editor" and "Project list" calls (unit PH-2). One script drives the Node recording
// (record-phone-files.mjs, the real remote methods over the real desktop operations at b6f10295a) and the replay of the adapter
// against a built mixdogd; both play it with `play`, so the two traces are made of the same steps.
//
// A step is `{op:'call', name, params}` (a phone call; a `{ $grant: name }` param is the token a `grant` step minted), `{op:'grant', as,
// path}` (a one-file permission the phone holds for a path outside every project), `{op:'host', on}` (the PC's desktop window is
// there or not: Electron-only work such as the OS trash runs in it), `{op:'pin', path, ms}` (a file's modification time, fixed so the
// answers that name it are the same on every run), and `{op:'write'|'remove'|'mkdir', ...}` (the world changing under the phone).
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const ROOT = 'D:\\mixdog-build\\tmp\\ph2-files';
/** The modification time every file of the world starts with. */
const EPOCH_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
/** The virtual clock both worlds run on: Node's `Date.now()` in the recording, the core's backup clock in the replay (`MIXDOG_FIXED_NOW_MS`). */
export const FIXED_NOW_MS = Date.UTC(2026, 5, 7, 8, 9, 10);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export function filesWorld(root = ROOT) {
  const project = join(root, 'proj');
  const second = join(root, 'proj2');
  const outside = join(root, 'outside');
  const files = {
    [join(project, 'README.md')]: 'hello\n',
    [join(project, 'src', 'a.ts')]: 'export const a = 1;\nexport function twice(n: number) { return n * 2; }\n',
    [join(project, 'src', 'b.ts')]: "import { a, twice } from './a';\nexport const b = twice(a);\n",
    [join(project, 'src', 'util', 'deep.txt')]: 'needle in a haystack\nsecond needle\n',
    [join(project, 'notes.txt')]: 'one\r\ntwo\r\nthree\r\n',
    [join(project, 'Beta.txt')]: 'B',
    [join(project, 'beta.txt')]: 'b',
    [join(project, 'alpha.txt')]: 'a',
    [join(project, 'Zeta.txt')]: 'z',
    [join(project, 'résumé.txt')]: 'r',
    [join(project, 'file10.txt')]: '10',
    [join(project, 'file2.txt')]: '2',
    [join(project, '_under.txt')]: '_',
    [join(project, '.hidden')]: 'h',
    [join(project, '.gitignore')]: 'ignored.txt\nbuild/\n',
    [join(project, 'ignored.txt')]: 'needle ignored\n',
    [join(project, 'build', 'out.js')]: 'needle built\n',
    [join(project, 'node_modules', 'dep', 'index.js')]: 'needle dep\n',
    [join(project, 'page.html')]: '<!doctype html><link rel="stylesheet" href="s.css"><h1>page</h1>\n',
    [join(project, 's.css')]: 'h1 { color: red }\n',
    [join(project, '.vscode', 'settings.json')]: '{ "editor.tabSize": 3, "files.eol": "\\r\\n" }\n',
    [join(second, 'two.txt')]: 'two\n',
    [join(outside, 'granted.txt')]: 'granted text\n',
    [join(outside, 'other.txt')]: 'other\n',
  };
  const binary = {
    [join(project, 'bin.dat')]: Buffer.from([0, 255, 1, 2, 0, 3]),
    [join(project, 'img.png')]: PNG,
    [join(project, 'utf16.txt')]: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide\n', 'utf16le')]),
    [join(project, 'big.txt')]: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
    [join(project, 'toolong.txt')]: Buffer.alloc(1024 * 1024 + 1, 0x62),
  };
  return {
    root,
    project,
    second,
    outside,
    userData: join(root, 'userdata'),
    workspaceDir: join(root, 'workspaces'),
    /** Makes the folder anew; every file gets the same modification time. */
    build() {
      rmSync(root, { recursive: true, force: true });
      for (const dir of [this.userData, this.workspaceDir, join(project, 'sub')]) mkdirSync(dir, { recursive: true });
      for (const [path, data] of [...Object.entries(files), ...Object.entries(binary)]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data);
        utimesSync(path, EPOCH_MS / 1000, EPOCH_MS / 1000);
      }
      // A folder's own time is when its last entry came; the world's folders carry the same time as its files.
      const pinFolders = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) pinFolders(join(dir, entry.name));
        utimesSync(dir, EPOCH_MS / 1000, EPOCH_MS / 1000);
      };
      pinFolders(root);
    },
  };
}

/** The PC's window: the OS trash, the snapshot and the local page server live in it. Its answers are scripted (the Node recording and the
 *  replay's stand-in window both use these); what it was asked is part of the trace. */
export const windowAnswers = {
  trashItem: (path) => {
    if (!existsSync(path)) throw new Error('The item cannot be moved to the trash.');
    rmSync(path, { recursive: true, force: true });
  },
  captureFileSnapshot: () => ({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mtimeMs: 1, size: 8 }),
  localPageUrl: (_root, rel, scope) => `http://127.0.0.1:41000/${scope}/${encodeURIComponent(rel)}`,
};

const grant = (as) => ({ $grant: as });

export function filesScript(world = filesWorld()) {
  const { project: P, second: P2, outside: O, root } = world;
  const call = (name, params, note) => ({ op: 'call', name, params, ...(note ? { note } : {}) });
  const ws = join(world.workspaceDir, 'team.code-workspace');
  return {
    world,
    ops: [
      // ── the project list ──
      call('listProjects', []),
      call('addProject', [P]),
      call('addProject', [P2]),
      call('addProject', [P]),
      call('addProject', [join(root, 'missing')]),
      call('addProject', [join(P, 'README.md')]),
      call('addProject', [42]),
      call('addProject', ['']),
      call('listProjects', []),
      call('renameProject', [P2, '  Second  ']),
      call('renameProject', [P2, 'x'.repeat(121)]),
      call('renameProject', [P2, 7]),
      call('renameProject', [join(root, 'nope'), 'a']),
      call('listProjects', []),
      call('renameProject', [P2, '']),
      // ── browsing ──
      call('listHostDirectories', [root]),
      call('listHostDirectories', [P]),
      call('listHostDirectories', [join(P, 'README.md')]),
      call('listHostDirectories', [join(root, 'missing')]),
      call('listHostDirectories', ['relative/path']),
      call('listHostDirectories', [7]),
      call('listHostDirectories', ['x'.repeat(5000)]),
      call('listProjectDir', [P, '']),
      call('listProjectDir', [P, 'src']),
      call('listProjectDir', [P, 'src/util']),
      call('listProjectDir', [P, 'README.md']),
      call('listProjectDir', [P, 'nope']),
      call('listProjectDir', [P, '../outside']),
      call('listProjectDir', [P, 5]),
      call('listProjectDir', [P, '/']),
      call('listProjectDir', [123, '']),
      // ── reading ──
      call('readProjectFile', [P, 'README.md', null]),
      call('readProjectFile', [P, 'src/a.ts', null]),
      call('readProjectFile', [P, 'notes.txt', null]),
      call('readProjectFile', [P, 'bin.dat', null]),
      call('readProjectFile', [P, 'utf16.txt', null]),
      call('readProjectFile', [P, 'toolong.txt', null]),
      call('readProjectFile', [P, 'big.txt', null]),
      call('readProjectFile', [P, 'src', null]),
      call('readProjectFile', [P, 'nope.txt', null]),
      call('readProjectFile', [P, '../outside/granted.txt', null]),
      call('readProjectFile', [P, '', null]),
      call('readProjectFile', [P, 'README.md']),
      call('readProjectFile', [7, 'README.md', null]),
      call('readProjectFile', [P, 'x'.repeat(5000), null]),
      call('statProjectFile', [P, 'README.md', null]),
      call('statProjectFile', [P, 'src', null]),
      call('statProjectFile', [P, 'nope.txt', null]),
      call('statProjectFile', [P, '../outside', null]),
      // ── writing (a save never creates the file) ──
      call('writeProjectFile', [P, 'new.txt', 'created\n', '', null, null]),
      call('createProjectEntry', [P, '', 'new.txt', false]),
      call('writeProjectFile', [P, 'new.txt', 'created\n', '', null, null]),
      call('writeProjectFile', [P, 'new.txt', 'created\n', '', null, null]),
      call('writeProjectFile', [P, 'README.md', 'changed\n', 'wrong\n', null, null]),
      call('writeProjectFile', [P, 'README.md', 'changed\n', 'hello\n', null, null]),
      call('writeProjectFile', [P, 'notes.txt', 'one\r\nTWO\r\nthree\r\n', 'one\r\ntwo\r\nthree\r\n', null, null]),
      call('writeProjectFile', [P, 'utf16.txt', 'wide2\n', 'wide\n', null, 'utf16le']),
      call('writeProjectFile', [P, 'src/a.ts', 'x', 'y', null, 'latin9']),
      call('writeProjectFile', [P, 'src/a.ts', 5, '', null, null]),
      call('writeProjectFile', [P, 'src/a.ts', '', 5, null, null]),
      call('writeProjectFile', [P, 'src/a.ts', 'x'.repeat(4 * 1024 * 1024 + 1), '', null, null]),
      call('writeProjectFile', [P, 'bin.dat', 'text', '', null, null]),
      call('writeProjectFile', [P, 'no/such/dir/f.txt', 'x', '', null, null]),
      call('writeProjectFile', [P, '../escape.txt', 'x', '', null, null]),
      { op: 'pin', path: join(P, 'new.txt'), ms: EPOCH_MS },
      { op: 'pin', path: join(P, 'README.md'), ms: EPOCH_MS },
      call('statProjectFile', [P, 'new.txt', null]),
      call('readProjectFile', [P, 'README.md', null]),
      // ── entries ──
      call('createProjectEntry', [P, '', 'made.txt', false]),
      call('createProjectEntry', [P, '', 'made.txt', false]),
      call('createProjectEntry', [P, 'src', 'folder', true]),
      call('createProjectEntry', [P, 'src', 'folder', true]),
      call('createProjectEntry', [P, 'nope', 'x.txt', false]),
      call('createProjectEntry', [P, '', '../escape.txt', false]),
      call('createProjectEntry', [P, '', 'a/b.txt', false]),
      call('createProjectEntry', [P, '', '', false]),
      call('createProjectEntry', [P, 5, 'five.txt', false]),
      call('renameProjectEntry', [P, 'made.txt', 'renamed.txt']),
      call('renameProjectEntry', [P, 'renamed.txt', 'README.md']),
      call('renameProjectEntry', [P, 'renamed.txt', 'bad/name']),
      call('renameProjectEntry', [P, '', 'root']),
      call('renameProjectEntry', [P, 'nope.txt', 'x.txt']),
      call('moveProjectEntry', [P, 'renamed.txt', 'src/folder']),
      call('moveProjectEntry', [P, 'src/folder/renamed.txt', 'src/folder']),
      call('moveProjectEntry', [P, 'src/folder', 'src/folder/sub']),
      call('moveProjectEntry', [P, 'src/a.ts', 'README.md']),
      call('moveProjectEntry', [P, '', 'src']),
      call('moveProjectEntry', [P, 'src/folder/renamed.txt', 5]),
      call('copyProjectEntry', [P, 'src/a.ts', 'src/folder']),
      call('copyProjectEntry', [P, 'src/a.ts', 'src/folder']),
      call('copyProjectEntry', [P, 'src/a.ts', 'src/folder']),
      call('copyProjectEntry', [P, 'src/util', 'src/folder']),
      call('copyProjectEntry', [P, 'src/util', 'src/util/deeper']),
      call('copyProjectEntry', [P, '', 'src']),
      call('copyProjectEntry', [P, 'src/a.ts', 'README.md']),
      call('listProjectDir', [P, 'src/folder']),
      // The OS trash lives in the PC's window.
      call('trashProjectEntry', [P, 'src/folder/a copy.ts']),
      { op: 'host', on: true },
      call('trashProjectEntry', [P, 'src/folder/a copy.ts']),
      call('trashProjectEntry', [P, 'src/folder/nope.ts']),
      call('trashProjectEntry', [P, '']),
      call('trashProjectEntry', [P, '../x']),
      { op: 'host', on: false },
      call('listProjectDir', [P, 'src/folder']),
      // ── the editor's own storage ──
      call('readEditorSettings', [P, 'src/a.ts', null]),
      call('readEditorSettings', [P, 'README.md', null]),
      call('readEditorSettings', [P, '', null]),
      call('readEditorSettings', [P, 'src/a.ts', join(world.workspaceDir, 'team.code-workspace')]),
      call('readEditorSettings', [7, 'src/a.ts', null]),
      call('readEditorBackup', [P, 'src/a.ts', null]),
      call('writeEditorBackup', [P, 'src/a.ts', 'draft\n', 'export const a = 1;\n', null]),
      call('readEditorBackup', [P, 'src/a.ts', null]),
      // Unsaved text outlives the app: a draft is written, the PC's app restarts, and the draft is read back (and stays on disk).
      call('writeEditorBackup', [P, 'src/b.ts', 'unsaved draft\n', 'export const b = 2;\n', null]),
      { op: 'restart' },
      call('readEditorBackup', [P, 'src/b.ts', null]),
      call('writeEditorBackup', [P, 'src/a.ts', 5, '', null]),
      call('deleteEditorBackup', [P, 'src/a.ts', null]),
      call('deleteEditorBackup', [P, 'src/a.ts', null]),
      call('readEditorBackup', [P, 'src/a.ts', null]),
      call('saveWorkspace', [ws, [{ path: P }, { path: P2, name: '  Two  ' }]]),
      call('saveWorkspace', [ws, [{ path: P }]]),
      call('saveWorkspace', [null, [{ path: P }]]),
      call('saveWorkspace', [ws, []]),
      call('saveWorkspace', [ws, [P]]),
      call('saveWorkspace', [ws, [{ path: P }, { path: P.toUpperCase() }]]),
      call('saveWorkspace', [join(world.workspaceDir, 'plain.json'), [{ path: P }]]),
      // ── search ──
      call('searchWorkspaceText', [P, { query: 'needle' }]),
      call('searchWorkspaceText', [P, { query: 'NEEDLE', matchCase: true }]),
      call('searchWorkspaceText', [P, { query: 'need.e', regex: true }]),
      call('searchWorkspaceText', [P, { query: 'needle', wholeWord: true, maxResults: 1 }]),
      call('searchWorkspaceText', [P, { query: 'needle', include: 'src/**', exclude: '**/folder/**' }]),
      call('searchWorkspaceText', [P, { query: '' }]),
      call('searchWorkspaceText', [P, 5]),
      call('replaceWorkspaceText', [P, { query: 'needle' }, 'pin', ['src/util/deep.txt']]),
      { op: 'pin', path: join(P, 'src', 'util', 'deep.txt'), ms: EPOCH_MS },
      call('readProjectFile', [P, 'src/util/deep.txt', null]),
      call('replaceWorkspaceText', [P, { query: 'pin' }, 'needle']),
      call('replaceWorkspaceText', [P, { query: 'zzz-nothing' }, 'x']),
      // The file list the app left out, as the page sends it (`relPaths ?? null`).
      call('replaceWorkspaceText', [P, { query: 'zzz-nothing' }, 'x', null]),
      call('replaceWorkspaceText', [P, { query: 'needle' }, 5]),
      call('replaceWorkspaceText', [P, { query: 'needle' }, 'x', 'not-a-list']),
      call('searchProjectFiles', [P, 'a', 20, false, false]),
      call('searchProjectFiles', [P, 'a', 20, false, true]),
      call('searchProjectFiles', [P, 'needle', 20, true, false]),
      call('searchProjectFiles', [P, 'ignored', 20, true, false]),
      call('searchProjectFiles', [P, '', 5, false, false]),
      call('searchProjectFiles', [P, 'deep', null, false, false]),
      call('searchProjectFiles', [P, 'a', 0, false, false]),
      call('searchProjectFiles', [P, 'a', 201, false, false]),
      call('searchProjectFiles', [P, 'x'.repeat(1025), 5, false, false]),
      call('searchProjectFiles', [7, 'a', 5, false, false]),
      call('codeGraphQuery', [P, 'bad', 'x']),
      call('codeGraphQuery', [P, 'symbols', 'src/a.ts']),
      call('codeGraphQuery', [P, 'find_symbol', 'twice']),
      call('codeGraphQuery', [P, 'references', 'twice']),
      call('codeGraphQuery', [P, 'find_symbol', '']),
      call('codeGraphQuery', [P, 'symbols', 'x'.repeat(1025)]),
      // ── the language server ──
      call('lspDocument', [{ kind: 'open', projectPath: P, relPath: 'a.xyz', languageId: 'plaintext', content: 'x', version: 1 }]),
      call('lspDocument', [{ kind: 'bogus', projectPath: P, relPath: 'a.xyz', languageId: 'plaintext', content: 'x', version: 1 }]),
      call('lspDocument', [5]),
      call('lspRequest', [{ projectPath: P, relPath: 'a.xyz', languageId: 'plaintext', method: 'textDocument/hover', params: { position: { line: 0, character: 0 } } }]),
      call('lspRequest', [{ projectPath: P, relPath: 'a.xyz', languageId: 'plaintext', method: 'workspace/executeCommand', params: {} }]),
      call('lspRequest', [{ projectPath: P, relPath: 'a.xyz', languageId: 'plaintext', method: 'textDocument/hover', params: 5 }]),
      call('lspApplyWorkspaceEdit', [P, [{ relPath: 'src/b.ts', content: 'edited b\n', expectedContent: "import { a, twice } from './a';\nexport const b = twice(a);\n" }]]),
      { op: 'pin', path: join(P, 'src', 'b.ts'), ms: EPOCH_MS },
      call('lspApplyWorkspaceEdit', [P, [{ relPath: 'src/b.ts', content: 'again\n', expectedContent: 'stale\n' }]]),
      call('lspApplyWorkspaceEdit', [P, []]),
      call('lspApplyWorkspaceEdit', [P, [{ relPath: 'src/b.ts', content: 'a', expectedContent: 'b' }, { relPath: 'src/b.ts', content: 'a', expectedContent: 'b' }]]),
      call('lspApplyWorkspaceEdit', [P, [{ relPath: '../x.txt', content: 'a', expectedContent: '' }]]),
      call('readProjectFile', [P, 'src/b.ts', null]),
      // ── previews ──
      call('previewProjectFile', [P, 'img.png', null]),
      call('previewProjectFile', [P, 'README.md', null]),
      call('previewProjectFile', [P, 'nope.png', null]),
      call('previewProjectFileRange', [P, 'img.png', null, 0, 16]),
      call('previewProjectFileRange', [P, 'img.png', null, 8, 1000]),
      call('previewProjectFileRange', [P, 'img.png', null, 1000, 16]),
      call('previewProjectFileRange', [P, 'page.html', null, 0, 100]),
      call('previewProjectFileRange', [P, 's.css', null, 0, 100]),
      call('previewProjectFileRange', [P, 'README.md', null, 0, 100]),
      call('previewProjectFileRange', [P, 'img.png', null, -1, 16]),
      call('previewProjectFileRange', [P, 'img.png', null, 0, 0]),
      call('previewProjectFileRange', [P, 'img.png', null, 0, 5 * 1024 * 1024]),
      call('previewProjectFileRange', [P, 'img.png', null, 1.5, 16]),
      call('previewProjectFileRange', [P, 'src', null, 0, 16]),
      call('previewDocumentPages', [P, 'README.md', null, null]),
      call('previewDocumentPages', [P, 'nope.docx', null, null]),
      call('previewDocumentPages', [P, 'img.png', null, { pages: [] }]),
      call('captureFileSnapshot', [P, 'page.html', null]),
      call('localPageUrl', [P, 'page.html', null]),
      { op: 'host', on: true },
      call('captureFileSnapshot', [P, 'page.html', null]),
      call('captureFileSnapshot', [P, 'nope.html', null]),
      call('localPageUrl', [P, 'page.html', null]),
      call('localPageUrl', [P, 'nope.html', null]),
      { op: 'host', on: false },
      // ── removing a project ──
      call('removeProject', [P2]),
      call('removeProject', [P2]),
      call('removeProject', [7]),
      call('listProjects', []),
      // ── a removed project and what would bring it back ──
      // Node keeps the removed path in the `hidden` list of desktop-projects.json and its alias in `aliases`; only `enter`/`register`
      // (re-adding it) undo the tombstone. Each step lists the projects, so any visible effect of the tombstone shows.
      call('addProject', [P2]),
      call('renameProject', [P2, 'Second again']),
      call('listProjects', []),
      call('removeProject', [P2]),
      call('listProjects', []),
      call('renameProject', [P2, 'again']),
      call('listProjects', []),
      call('addProject', [P2]),
      call('listProjects', []),
      call('removeProject', [P2]),
      call('listProjects', []),
    ],
  };
}

/** What only a paired phone meets: it is held to the registered projects, and it opens a file outside them through a one-file permission. */
export function filesRelayScript(world = filesWorld()) {
  const { project: P, second: P2, outside: O, root } = world;
  const call = (name, params) => ({ op: 'call', name, params });
  const gone = join(root, 'unregistered');
  return {
    world,
    ops: [
      call('addProject', [P]),
      call('addProject', [P2]),
      call('listProjectDir', [gone, '']),
      call('readProjectFile', [gone, 'a.txt', null]),
      call('searchWorkspaceText', [gone, { query: 'x' }]),
      call('searchProjectFiles', [gone, 'a', 5, false, false]),
      call('writeProjectFile', [gone, 'a.txt', 'x', '', null, null]),
      call('removeProject', [P2]),
      call('readProjectFile', [P2, 'two.txt', null]),
      // A removed project stays out of the phone's reach until it is added again (the tombstone is not a registration).
      call('listProjectDir', [P2, '']),
      call('listProjects', []),
      call('addProject', [P2]),
      call('listProjectDir', [P2, '']),
      call('readProjectFile', [P2, 'two.txt', null]),
      { op: 'grant', as: 'granted', path: join(O, 'granted.txt') },
      call('readProjectFile', [O, 'granted.txt', grant('granted')]),
      call('readProjectFile', [O, 'other.txt', grant('granted')]),
      call('readProjectFile', [O, 'granted.txt', 'no-such-token']),
      call('statProjectFile', [O, 'granted.txt', grant('granted')]),
      call('readProjectFile', [O, 'granted.txt', null]),
      call('writeProjectFile', [O, 'granted.txt', 'granted edit\n', 'granted text\n', grant('granted'), null]),
      { op: 'pin', path: join(O, 'granted.txt'), ms: EPOCH_MS },
      call('readProjectFile', [O, 'granted.txt', grant('granted')]),
      call('writeEditorBackup', [O, 'granted.txt', 'draft granted\n', 'granted edit\n', grant('granted')]),
      call('readEditorBackup', [O, 'granted.txt', grant('granted')]),
      call('deleteEditorBackup', [O, 'granted.txt', grant('granted')]),
      call('readEditorBackup', [O, 'granted.txt', grant('granted')]),
      // The editor's backups and the document preview name a project file or a granted one only: a file outside every project
      // without its token, and an entry beyond a project, are refused before anything is read or written.
      call('writeEditorBackup', [O, 'other.txt', 'planted\n', 'other\n', null]),
      call('readEditorBackup', [O, 'other.txt', null]),
      call('deleteEditorBackup', [O, 'other.txt', null]),
      call('writeEditorBackup', [P, '../outside/other.txt', 'planted\n', 'other\n', null]),
      call('readEditorBackup', [P, '../outside/other.txt', null]),
      call('deleteEditorBackup', [P, '../outside/other.txt', null]),
      call('previewDocumentPages', [O, 'other.txt', null, { pages: [1] }]),
      call('previewDocumentPages', [P, '../outside/other.txt', null, { pages: [1] }]),
      // A project file's backup over the relay: written, read back and deleted as on the desktop.
      call('writeEditorBackup', [P, 'src/a.ts', 'relay draft\n', 'export const a = 1;\n', null]),
      call('readEditorBackup', [P, 'src/a.ts', null]),
      call('deleteEditorBackup', [P, 'src/a.ts', null]),
      call('readEditorBackup', [P, 'src/a.ts', null]),
      call('previewProjectFile', [O, 'granted.txt', grant('granted')]),
      call('previewProjectFileRange', [O, 'granted.txt', grant('granted'), 0, 8]),
      call('previewDocumentPages', [O, 'granted.txt', grant('granted'), { pages: [] }]),
      call('captureFileSnapshot', [O, 'granted.txt', grant('granted')]),
      call('localPageUrl', [O, 'granted.txt', grant('granted')]),
      { op: 'host', on: true },
      call('captureFileSnapshot', [O, 'granted.txt', grant('granted')]),
      call('localPageUrl', [O, 'granted.txt', grant('granted')]),
      { op: 'host', on: false },
    ],
  };
}
/**
 * Plays the ops against a driver and returns the trace.
 * driver: call(name, params) -> { frame, hostCalls }, grant(path) -> token, host(on), pin(path, ms), write(path, text), remove(path), mkdir(path).
 */
export async function play(script, driver) {
  const steps = [];
  const leases = new Map();
  const tokens = new Map();
  const resolve = (value) =>
    Array.isArray(value)
      ? value.map(resolve)
      : value && typeof value === 'object'
        ? value.$grant !== undefined
          ? tokens.get(value.$grant)
          : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]))
        : value;
  for (const op of script.ops) {
    if (op.op === 'call') {
      const params = resolve(op.params);
      const { frame, hostCalls } = await driver.call(op.name, params);
      // A write answers the mtime the file ended up with, which the OS stamps. `play` runs on both sides (the recording on Node, the
      // replay on the core), so each proves its answer equals its own file's mtime; the answer is then kept as `{$fileMtime}`.
      // The OS stamps it at the write, so no clock of ours can fix it; the value the answer carried is kept beside the step as
      // `fileMtimeMs` (Node's: project-files.ts:407 `handle.stat()` after the rewrite, :601 `stat(file)`), for the reader of the recording.
      let fileMtimeMs;
      if (op.name === 'writeProjectFile' && frame.ok) {
        // The invariant both sides prove: the answer is the mtime the file has right after the call (a different one is a failure, not a
        // difference to compare).
        const onDisk = statSync(join(params[0], params[1])).mtimeMs;
        if (frame.value?.mtimeMs !== onDisk) throw new Error(`writeProjectFile answered mtime ${frame.value?.mtimeMs}, the file has ${onDisk}`);
        fileMtimeMs = onDisk;
        frame.value.mtimeMs = { $fileMtime: true };
      }
      // Node's lease id is `randomUUID()` (media-leases.ts:35): v4 format, one fresh id per preview. The trace keeps the order they
      // were issued in; two answers sharing an id would share an index.
      if (op.name === 'previewProjectFile' && frame.ok && typeof frame.value?.mediaAssetId === 'string') {
        const id = frame.value.mediaAssetId;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error(`lease id ${id} is not a v4 uuid`);
        if (!leases.has(id)) leases.set(id, leases.size);
        frame.value.mediaAssetId = { $lease: leases.get(id) };
      }
      steps.push({ call: op.name, params: op.params, frame, ...(hostCalls.length ? { hostCalls } : {}), ...(fileMtimeMs === undefined ? {} : { fileMtimeMs }) });
    } else if (op.op === 'grant') {
      tokens.set(op.as, await driver.grant(op.path));
      steps.push({ grant: op.as, path: op.path });
    } else if (op.op === 'host') {
      await driver.host(op.on);
      steps.push({ host: op.on });
    } else if (op.op === 'pin') {
      driver.pin(op.path, op.ms);
    } else if (op.op === 'write') driver.write(op.path, op.text);
    else if (op.op === 'remove') driver.remove(op.path);
    else if (op.op === 'mkdir') driver.mkdir(op.path);
    else if (op.op === 'restart') await driver.restart();
  }
  return { steps };
}
/** A directory's files, whole: path, kind, size and content hash (the machine's file times are not part of what a call answers). */
export function treeOf(root, skip = () => false) {
  const rows = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).replaceAll('\\', '/');
      if (skip(rel)) continue;
      if (entry.isDirectory()) {
        rows.push({ path: rel, dir: true });
        walk(path);
      } else {
        const bytes = readFileSync(path);
        rows.push({ path: rel, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  };
  walk(root);
  return rows;
}