# Residual main-process files: verdict table (x-residual-verdicts)

Owner direction 14: a main-process file that does not handle an Electron object moves to Rust (the core); only code that handles Electron objects stays, and a stay carries a written reason naming the Electron object or a technical reason. Nothing is deferred: every move row is work of a batch task named in the last column.

## Scope and how it was computed

Non-test, non-`.d.ts` files under `apps/desktop/src/main` (821 files at `mig/int` base). A file is "named" when a task of `tasks-v2.json` (any field except the x-residual-verdicts entry itself) or a `staysElectron` bullet of a plan mentions its path, or its basename when that basename is unique in the folder tree. The files left over are the rows of this table: **275 files, 35325 lines** (216 stay, 59 move, 0 delete). The earlier critique counted 94 unnamed plus 248 inventory-only files; this table covers both groups because it also includes every file that only an inventory (not a task) named, and it uses the stricter naming rule above (a task naming a stem such as `tabs-display` without its extension does not count). Targets of stay rows cite the plan clause by 0-based index in that plan's `staysElectron` array; a stay no clause covers says "no plan clause" and rests on the reason in its row.

Read vs inferred: line counts are `wc -l`; the electron column is a scan for an `electron` import; verdicts come from reading the header comment, imports, exports and (for the ambiguous ones) the first 20 to 60 lines, not every line of the 8,000 lines of visualize or browser code. The pure browser helpers kept as stays are kept for the technical reason in their row (synchronous call from Electron-object code); the integrator may reverse any of them, and a reversal becomes a row of batch d.

## Verification

Save the block as `docs/internal/migration-residual-verdicts-verify.mjs` (not committed) or run it with `node --input-type=module` from the repository root; it recomputes the unnamed set and prints the rows missing from the table (the last line must read `0 rows missing`). After the lead adds the batch tasks the unnamed set only shrinks, so the check stays valid.

```js
// Recomputes the set of non-test main files that no task of tasks-v2.json and no staysElectron of a plan names,
// and prints every one that has no row in the table below. Run from the repository root:
//   node docs/internal/migration-residual-verdicts-verify.mjs   (the block below, saved as a file; or paste with node -e)
//   env PLAN_DIR (default D:/mixdog-build/tmp/ft-run/mig)
import fs from 'node:fs';
import path from 'node:path';
const planDir = process.env.PLAN_DIR ?? 'D:/mixdog-build/tmp/ft-run/mig';
const root = 'apps/desktop/src/main';
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const files = walk(root).filter((f) => /\.(ts|tsx|mjs|js|cjs|mts)$/.test(f) && !/\.d\.(ts|mts|cts)$/.test(f) && !/\.(slow\.)?test\.|\.bench\./.test(f)).map((f) => f.slice(root.length + 1));
const plan = JSON.parse(fs.readFileSync(`${planDir}/tasks-v2.json`, 'utf8'));
const text = plan.tasks
  .filter((t) => t.id !== 'x-residual-verdicts')
  .map((t) => JSON.stringify([t.ownsFiles, t.createsFiles, t.title, t.work, t.interfacesAdded, t.interfacesConsumed, t.source, t.doneWhen, t.verify, t.risk]))
  .join('\n') + '\n' + ['s1', 's2a', 's2b', 's3', 's4', 'x'].flatMap((k) => JSON.parse(fs.readFileSync(`${planDir}/plan-${k}.json`, 'utf8')).staysElectron).join('\n');
const count = {};
for (const f of files) count[path.basename(f)] = (count[path.basename(f)] ?? 0) + 1;
const esc = (s) => [...s].map((c) => ('.*+?^${}()|[]'.includes(c) || c === String.fromCharCode(92) ? String.fromCharCode(92) : '') + c).join('');
const unnamed = files.filter((f) => {
  const b = path.basename(f);
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${esc(f)}` + (count[b] > 1 ? '' : `|(^|[^A-Za-z0-9_./-])${esc(b)}`));
  return !re.test(text);
});
const doc = fs.readFileSync('docs/internal/migration-residual-verdicts.md', 'utf8');
const rows = new Set([...doc.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]));
const missing = unnamed.filter((f) => !rows.has(f));
const gone = [...rows].filter((r) => !files.includes(r));
console.log(`non-test main files ${files.length}, unnamed ${unnamed.length}, table rows ${rows.size}`);
for (const f of missing) console.log('MISSING', f);
for (const r of gone) console.log('NO SUCH FILE', r);
console.log(`${missing.length} rows missing`);
process.exitCode = missing.length || gone.length ? 1 : 0;
```

## Summary

| verdict | files | lines |
|---|---|---|
| stay (Electron object or stated technical reason) | 216 | 27533 |
| move to Rust | 59 | 7792 |
| delete | 0 | 0 |

Of the stays, 86 files do not import electron; each carries its technical reason (dev or test code, runs before the core exists, called synchronously by Electron-object code, sealed-secret unit, or a plan clause of the plan that owns it).

The twelve candidates named by the critique: session-attachments, transcript-file-links, workflow-config, system-fonts are already moved by x-residual-moves / x-residual-moves-client (they are named there, so they are not rows here). The other eight (local-file-links, model-bootstrap, mixy-first, agent-memory, launch-version, conversation-import-progress, login-shell-environment, attachment-thumbnail) are move rows in batch x-residual-moves-b.

## Visualize split

Logic (move, batches c1 to c5): 34 files, 5834 lines. Pane-frame code (stay): 11 files, 1616 lines (host.ts, host-*.ts that touch BrowserWindow/WebContents/screen, export-render.ts, offscreen-origins.ts, plus bridge-server.ts bound to the loopback bridge). The move batches take the pane host as an injected dependency, as service.ts already does today.

## Move batches (for the integrator)

x-residual-moves-b caps at about 1,500 lines; the excess is listed as further batches (each with a core task and a `-client` task) to be added before G9 starts, as that task's text says. The file lists below are the ownsFiles of the matching client tasks (none of these files is owned by another task: they are the unnamed set).

### s4-engine-reply (2 files, 158 lines)

Already a source of s4-engine-reply; these two rows only record the verdict (no new batch).

- `apps/desktop/src/main/browser/tabs-close-result.ts`
- `apps/desktop/src/main/browser/tabs.ts`

### x-residual-moves-b (19 files, 1174 lines)

Top-level pure logic (core: x-residual-moves-b; the 8 named candidates first, then the small ones; client half: x-residual-moves-b-client).

- `apps/desktop/src/main/agent-memory.ts`
- `apps/desktop/src/main/approval-grant-change.ts`
- `apps/desktop/src/main/attachment-files.ts`
- `apps/desktop/src/main/attachment-thumbnail.ts`
- `apps/desktop/src/main/child-environment.ts`
- `apps/desktop/src/main/conversation-import-progress.ts`
- `apps/desktop/src/main/feedback-client.ts`
- `apps/desktop/src/main/git-contract.mjs`
- `apps/desktop/src/main/ipc-control-chars.ts`
- `apps/desktop/src/main/launch-version.ts`
- `apps/desktop/src/main/linux-input-access.ts`
- `apps/desktop/src/main/local-file-links.ts`
- `apps/desktop/src/main/login-shell-environment.ts`
- `apps/desktop/src/main/mixy-first.ts`
- `apps/desktop/src/main/model-bootstrap.ts`
- `apps/desktop/src/main/native-runtime-cache-gc.mjs`
- `apps/desktop/src/main/network-watch.ts`
- `apps/desktop/src/main/session-sidebar-actions.ts`
- `apps/desktop/src/main/user-file-write.ts`

### x-residual-moves-c1 (7 files, 1494 lines)

Visualize logic, part 1: request parsing, act steps, export (further batch).

- `apps/desktop/src/main/visualize/act-steps.ts`
- `apps/desktop/src/main/visualize/agent-export.ts`
- `apps/desktop/src/main/visualize/export-actions.ts`
- `apps/desktop/src/main/visualize/export-offscreen.ts`
- `apps/desktop/src/main/visualize/export.ts`
- `apps/desktop/src/main/visualize/result-text.ts`
- `apps/desktop/src/main/visualize/targets.ts`

### x-residual-moves-c2 (11 files, 1282 lines)

Visualize logic, part 2: versions, history, thumbnails, reloads (further batch).

- `apps/desktop/src/main/visualize/history.ts`
- `apps/desktop/src/main/visualize/host-file-watch.ts`
- `apps/desktop/src/main/visualize/pane-source.ts`
- `apps/desktop/src/main/visualize/reloads.ts`
- `apps/desktop/src/main/visualize/tab-versions.ts`
- `apps/desktop/src/main/visualize/thumbnails.ts`
- `apps/desktop/src/main/visualize/version-eviction.ts`
- `apps/desktop/src/main/visualize/version-restore.ts`
- `apps/desktop/src/main/visualize/version-select.ts`
- `apps/desktop/src/main/visualize/version-thumbnails.ts`
- `apps/desktop/src/main/visualize/versions.ts`

### x-residual-moves-c3 (9 files, 1330 lines)

Visualize logic, part 3: tab model, session views, lease guard, problems (further batch).

- `apps/desktop/src/main/visualize/context.ts`
- `apps/desktop/src/main/visualize/lease-guard.ts`
- `apps/desktop/src/main/visualize/page-problems.ts`
- `apps/desktop/src/main/visualize/panel-commands.ts`
- `apps/desktop/src/main/visualize/panes.ts`
- `apps/desktop/src/main/visualize/problem-tracker.ts`
- `apps/desktop/src/main/visualize/session-views.ts`
- `apps/desktop/src/main/visualize/tab-state.ts`
- `apps/desktop/src/main/visualize/tabs.ts`

### x-residual-moves-c4 (5 files, 1230 lines)

Visualize logic, part 4: open/read actions, turn hold, gestures (further batch).

- `apps/desktop/src/main/visualize/gestures.ts`
- `apps/desktop/src/main/visualize/open-actions.ts`
- `apps/desktop/src/main/visualize/overlay-script.ts`
- `apps/desktop/src/main/visualize/read-actions.ts`
- `apps/desktop/src/main/visualize/turn-hold.ts`

### x-residual-moves-c5 (2 files, 498 lines)

Visualize logic, part 5: the service composition and the inline page files (further batch).

- `apps/desktop/src/main/visualize/inline-page.ts`
- `apps/desktop/src/main/visualize/service.ts`

### x-residual-moves-d (4 files, 626 lines)

Browser pure logic with no Electron object (further batch, core x-residual-moves-d and x-residual-moves-d-client).

- `apps/desktop/src/main/browser/chrome-uia.ts`
- `apps/desktop/src/main/browser/favicon-fetch.ts`
- `apps/desktop/src/main/browser/page-preview.ts`
- `apps/desktop/src/main/browser/profile-import-history.ts`

## Table

Columns: path under `apps/desktop/src/main`, lines (`wc -l`), imports electron (y/n), verdict, reason, target task or plan clause.

| path | lines | electron | verdict | reason | target |
|---|---|---|---|---|---|
| `agent-awake.ts` | 122 | n | stay | Holds an Electron powerSaveBlocker while the engine reports live work. | s2a staysElectron[5] (core observers: keep-awake) |
| `agent-memory.ts` | 65 | n | move | Pure list/delete of an agent profile memory pool on disk; no Electron object. | x-residual-moves-b |
| `approval-grant-change.ts` | 20 | n | move | After a tool approval stored a standing grant, announces the permissions settings change; belongs to the core answer path. | x-residual-moves-b |
| `attachment-files.ts` | 18 | n | move | Writes a data: attachment under the temp dir; node fs only. | x-residual-moves-b |
| `attachment-thumbnail.ts` | 74 | n | move | Thumbnail read of stored attachment images; the decoder is injected (nativeImage in the caller), so the Rust port brings its own decoder. | x-residual-moves-b |
| `background-window.ts` | 28 | n | stay | Wraps a BrowserWindow whose close hides it instead of quitting. | s2b staysElectron[0] (window bodies) |
| `boot-timeline.ts` | 40 | n | stay | Orders boot diagnostics before the log exists; runs before the core is up, so it cannot depend on it. | no plan clause (main boot; reason in this row) |
| `bounded-wait.mjs` | 14 | n | stay | Test helper for the Electron-driven node tests; no runtime code. | no plan clause (dev or test helper; reason in this row) |
| `browser/actionability.integration.ts` | 84 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/background-reclaim.ts` | 161 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/browser-session-store.ts` | 245 | y | stay | Profile import feeds Electron Session cookies and safeStorage; its state files and readers are one unit with the sealed store. | s4 staysElectron[8] (profile import and sealed stores) |
| `browser/cdp-lifecycle.integration.ts` | 82 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/chrome-uia.ts` | 209 | n | move | UIA/MSAA/OCR element model and Chrome setup control rules for Computer Use; data and string rules only. | x-residual-moves-d |
| `browser/cookie-jar.integration.ts` | 119 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/credential-fill-host.ts` | 40 | y | stay | Secret path of decision 12: unsealed values exist only in main memory (safeStorage, WebContents); totp seeds and the vault file are sealed and read by one unit, and generating or storing them in the core would move the secret over the protocol. | s4 staysElectron[7] (secret and sign-in paths) |
| `browser/credential-vault-file.ts` | 74 | n | stay | Secret path of decision 12: unsealed values exist only in main memory (safeStorage, WebContents); totp seeds and the vault file are sealed and read by one unit, and generating or storing them in the core would move the secret over the protocol. | s4 staysElectron[7] (secret and sign-in paths) |
| `browser/credential-vault.ts` | 683 | y | stay | Secret path of decision 12: unsealed values exist only in main memory (safeStorage, WebContents); totp seeds and the vault file are sealed and read by one unit, and generating or storing them in the core would move the secret over the protocol. | s4 staysElectron[7] (secret and sign-in paths) |
| `browser/display-capture.ts` | 60 | y | stay | Display capture, textures or frame geometry from the page surface (NativeImage, WebContents, screen); frame-transform is a flag read by the same code. | s4 staysElectron[1] (display/frame pixels) |
| `browser/display-png.ts` | 66 | y | stay | Display capture, textures or frame geometry from the page surface (NativeImage, WebContents, screen); frame-transform is a flag read by the same code. | s4 staysElectron[1] (display/frame pixels) |
| `browser/display-stream.ts` | 115 | y | stay | Display capture, textures or frame geometry from the page surface (NativeImage, WebContents, screen); frame-transform is a flag read by the same code. | s4 staysElectron[1] (display/frame pixels) |
| `browser/display-texture.integration.ts` | 97 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/display-textures.ts` | 109 | y | stay | Display capture, textures or frame geometry from the page surface (NativeImage, WebContents, screen); frame-transform is a flag read by the same code. | s4 staysElectron[1] (display/frame pixels) |
| `browser/display-tracking.ts` | 95 | y | stay | Display capture, textures or frame geometry from the page surface (NativeImage, WebContents, screen); frame-transform is a flag read by the same code. | s4 staysElectron[1] (display/frame pixels) |
| `browser/document-checkpoint.integration.ts` | 149 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/favicon-fetch.ts` | 100 | n | move | Network fetch of a declared site icon with URL checks; no Electron object (callers pass the bytes on). | x-residual-moves-d |
| `browser/frame-pixels.ts` | 25 | y | stay | Display capture, textures or frame geometry from the page surface (NativeImage, WebContents, screen); frame-transform is a flag read by the same code. | s4 staysElectron[1] (display/frame pixels) |
| `browser/frame-transform.ts` | 8 | n | stay | Display capture, textures or frame geometry from the page surface (NativeImage, WebContents, screen); frame-transform is a flag read by the same code. | s4 staysElectron[1] (display/frame pixels) |
| `browser/guest-background-pages.ts` | 200 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/guest-initialize.ts` | 88 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/guest-session-restore.ts` | 153 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/harness-frame.ts` | 41 | n | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/host-page-identity.ts` | 42 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/input-dispatch.ts` | 125 | y | stay | Input executors that dispatch to WebContents; input.ts only composes them. | s4 staysElectron[3] (input executors) |
| `browser/input-primitives.ts` | 60 | y | stay | Input executors that dispatch to WebContents; input.ts only composes them. | s4 staysElectron[3] (input executors) |
| `browser/input-surface-diagnostics.ts` | 74 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/input-surface-errors.ts` | 112 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/input-surface-ime.ts` | 82 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/input-surface-latency.ts` | 70 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/input-surface-load.ts` | 170 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/input-surface-performance.ts` | 92 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/input-surface-prompts.ts` | 66 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/input-surface-tabs.ts` | 186 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/input-surface-viewport.ts` | 92 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/input-surface.integration.ts` | 424 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/input.ts` | 44 | n | stay | Input executors that dispatch to WebContents; input.ts only composes them. | s4 staysElectron[3] (input executors) |
| `browser/leave-confirmation.ts` | 114 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/linked-sign-in-store.ts` | 186 | y | stay | Secret path of decision 12: unsealed values exist only in main memory (safeStorage, WebContents); totp seeds and the vault file are sealed and read by one unit, and generating or storing them in the core would move the secret over the protocol. | s4 staysElectron[7] (secret and sign-in paths) |
| `browser/live-regressions.integration.ts` | 164 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/local-prompts.ts` | 162 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/login-persistence.integration.ts` | 172 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/login-popup.integration.ts` | 189 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/login-popup.ts` | 432 | y | stay | Secret path of decision 12: unsealed values exist only in main memory (safeStorage, WebContents); totp seeds and the vault file are sealed and read by one unit, and generating or storing them in the core would move the secret over the protocol. | s4 staysElectron[7] (secret and sign-in paths) |
| `browser/mouse-dispatch-probe.ts` | 87 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/mouse-focus-probe.ts` | 49 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/native-view.ts` | 160 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/new-tab-waiters.ts` | 68 | n | stay | In-process rules called synchronously by the page lifecycle and tab strip code that holds the WebContents; a core hop per call would add latency for no gain. | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-fault-diagnostics.ts` | 38 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-faults.ts` | 71 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-fullscreen.ts` | 78 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-geometry.ts` | 29 | y | stay | Display capture, textures or frame geometry from the page surface (NativeImage, WebContents, screen); frame-transform is a flag read by the same code. | s4 staysElectron[1] (display/frame pixels) |
| `browser/page-identity-capture.ts` | 109 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-identity-file.ts` | 75 | n | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-identity.ts` | 255 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-json-viewer.ts` | 85 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-left.ts` | 18 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-owner.ts` | 122 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-power.ts` | 108 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-preview.ts` | 224 | n | move | Fetches and parses a page card fallback (markup, image); network and parsing only. | x-residual-moves-d |
| `browser/page-report.integration.ts` | 145 | n | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/page-reveal.ts` | 67 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-scrollbar-css.ts` | 28 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-surface-control.ts` | 345 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-surface-frame.ts` | 302 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-surface-state.ts` | 88 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-surface.ts` | 119 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-window.ts` | 73 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/page-zoom.ts` | 49 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/panel-fold.ts` | 124 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/parallel-latency-scenarios.ts` | 60 | n | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/permissions.ts` | 545 | y | stay | Session permission handlers and preload path (Electron session/app). | s4 staysElectron[9] (partition, permissions) |
| `browser/popup-focus.ts` | 74 | n | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/popup-opening.ts` | 88 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/preload-path.ts` | 12 | y | stay | Session permission handlers and preload path (Electron session/app). | s4 staysElectron[9] (partition, permissions) |
| `browser/presentation-reads.ts` | 83 | n | stay | In-process rules called synchronously by the page lifecycle and tab strip code that holds the WebContents; a core hop per call would add latency for no gain. | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/profile-host-methods.ts` | 153 | n | stay | Profile import feeds Electron Session cookies and safeStorage; its state files and readers are one unit with the sealed store. | s4 staysElectron[8] (profile import and sealed stores) |
| `browser/profile-import-approval.ts` | 18 | n | stay | Profile import feeds Electron Session cookies and safeStorage; its state files and readers are one unit with the sealed store. | s4 staysElectron[8] (profile import and sealed stores) |
| `browser/profile-import-auto.ts` | 435 | n | stay | Profile import feeds Electron Session cookies and safeStorage; its state files and readers are one unit with the sealed store. | s4 staysElectron[8] (profile import and sealed stores) |
| `browser/profile-import-cookies.integration.ts` | 179 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/profile-import-cookies.ts` | 241 | n | stay | Profile import feeds Electron Session cookies and safeStorage; its state files and readers are one unit with the sealed store. | s4 staysElectron[8] (profile import and sealed stores) |
| `browser/profile-import-history.ts` | 93 | n | move | Copies a Chrome History database through a private snapshot and merges entries; node:sqlite and fs only. | x-residual-moves-d |
| `browser/profile-import-key.ts` | 131 | n | stay | Profile import feeds Electron Session cookies and safeStorage; its state files and readers are one unit with the sealed store. | s4 staysElectron[8] (profile import and sealed stores) |
| `browser/profile-import-native.ts` | 52 | n | stay | Profile import feeds Electron Session cookies and safeStorage; its state files and readers are one unit with the sealed store. | s4 staysElectron[8] (profile import and sealed stores) |
| `browser/profile-import-persistence.integration.ts` | 130 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/profile-import.integration.ts` | 504 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/profile-import.ts` | 989 | y | stay | Profile import feeds Electron Session cookies and safeStorage; its state files and readers are one unit with the sealed store. | s4 staysElectron[8] (profile import and sealed stores) |
| `browser/remote-drive.ts` | 93 | y | stay | Phone live view host side: screencast, frame and input drive on WebContents; its pure helpers run per frame in the same process. | s4 staysElectron[10] (phone live view host side) |
| `browser/remote-frame.ts` | 73 | y | stay | Phone live view host side: screencast, frame and input drive on WebContents; its pure helpers run per frame in the same process. | s4 staysElectron[10] (phone live view host side) |
| `browser/remote-geometry.ts` | 90 | n | stay | Phone live view host side: screencast, frame and input drive on WebContents; its pure helpers run per frame in the same process. | s4 staysElectron[10] (phone live view host side) |
| `browser/remote-guest-drive.ts` | 43 | y | stay | Phone live view host side: screencast, frame and input drive on WebContents; its pure helpers run per frame in the same process. | s4 staysElectron[10] (phone live view host side) |
| `browser/remote-input.ts` | 40 | y | stay | Phone live view host side: screencast, frame and input drive on WebContents; its pure helpers run per frame in the same process. | s4 staysElectron[10] (phone live view host side) |
| `browser/remote-jpeg-size.ts` | 17 | n | stay | Phone live view host side: screencast, frame and input drive on WebContents; its pure helpers run per frame in the same process. | s4 staysElectron[10] (phone live view host side) |
| `browser/remote-screencast.ts` | 155 | y | stay | Phone live view host side: screencast, frame and input drive on WebContents; its pure helpers run per frame in the same process. | s4 staysElectron[10] (phone live view host side) |
| `browser/remote-tabs.ts` | 93 | n | stay | Phone live view host side: screencast, frame and input drive on WebContents; its pure helpers run per frame in the same process. | s4 staysElectron[10] (phone live view host side) |
| `browser/restore-pages.ts` | 22 | n | stay | In-process rules called synchronously by the page lifecycle and tab strip code that holds the WebContents; a core hop per call would add latency for no gain. | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/scale-follower.ts` | 38 | y | stay | Display capture, textures or frame geometry from the page surface (NativeImage, WebContents, screen); frame-transform is a flag read by the same code. | s4 staysElectron[1] (display/frame pixels) |
| `browser/screenshot-clip.ts` | 44 | n | stay | Screenshot engines and their byte/crop rules run in the host next to NativeImage and WebContents.capturePage; the budget check is called synchronously from the capture path. | s4 staysElectron[6] (screenshot engines) |
| `browser/screenshot-element.ts` | 91 | y | stay | Screenshot engines and their byte/crop rules run in the host next to NativeImage and WebContents.capturePage; the budget check is called synchronously from the capture path. | s4 staysElectron[6] (screenshot engines) |
| `browser/screenshot-engines.ts` | 106 | y | stay | Screenshot engines and their byte/crop rules run in the host next to NativeImage and WebContents.capturePage; the budget check is called synchronously from the capture path. | s4 staysElectron[6] (screenshot engines) |
| `browser/screenshot-full-page.ts` | 47 | y | stay | Screenshot engines and their byte/crop rules run in the host next to NativeImage and WebContents.capturePage; the budget check is called synchronously from the capture path. | s4 staysElectron[6] (screenshot engines) |
| `browser/screenshot-image.integration.ts` | 29 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/screenshot-image.ts` | 29 | n | stay | Screenshot engines and their byte/crop rules run in the host next to NativeImage and WebContents.capturePage; the budget check is called synchronously from the capture path. | s4 staysElectron[6] (screenshot engines) |
| `browser/screenshot-policy.ts` | 117 | n | stay | Screenshot engines and their byte/crop rules run in the host next to NativeImage and WebContents.capturePage; the budget check is called synchronously from the capture path. | s4 staysElectron[6] (screenshot engines) |
| `browser/screenshot-tiles.ts` | 139 | y | stay | Screenshot engines and their byte/crop rules run in the host next to NativeImage and WebContents.capturePage; the budget check is called synchronously from the capture path. | s4 staysElectron[6] (screenshot engines) |
| `browser/screenshot.ts` | 119 | y | stay | Screenshot engines and their byte/crop rules run in the host next to NativeImage and WebContents.capturePage; the budget check is called synchronously from the capture path. | s4 staysElectron[6] (screenshot engines) |
| `browser/secret-fill-core.test-helper.mjs` | 21 | n | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/secret-storage-notice.ts` | 21 | n | stay | Secret path of decision 12: unsealed values exist only in main memory (safeStorage, WebContents); totp seeds and the vault file are sealed and read by one unit, and generating or storing them in the core would move the secret over the protocol. | s4 staysElectron[7] (secret and sign-in paths) |
| `browser/session-tab-strip.ts` | 76 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/signed-in-sites.ts` | 96 | n | stay | Profile import feeds Electron Session cookies and safeStorage; its state files and readers are one unit with the sealed store. | s4 staysElectron[8] (profile import and sealed stores) |
| `browser/tab-policy.ts` | 137 | n | stay | In-process rules called synchronously by the page lifecycle and tab strip code that holds the WebContents; a core hop per call would add latency for no gain. | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/tabs-close-result.ts` | 90 | n | move | Tab strip text and close result: named as a source of s4-engine-reply (byte-exact golden texts). | s4-engine-reply |
| `browser/tabs-contract.ts` | 28 | y | stay | Page, tab, guest, popup or prompt code that holds WebContents, BrowserWindow or WebContentsView (page-identity-file is the store of page-identity.ts). | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/tabs-display.ts` | 93 | n | stay | In-process rules called synchronously by the page lifecycle and tab strip code that holds the WebContents; a core hop per call would add latency for no gain. | s4 staysElectron[0] (views, tabs, page lifecycle) |
| `browser/tabs.ts` | 68 | n | move | Tab strip text and close result: named as a source of s4-engine-reply (byte-exact golden texts). | s4-engine-reply |
| `browser/task-lifecycle.integration.ts` | 100 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/test-fixtures/display-texture-preload.ts` | 17 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/test-fixtures/input-surface-preload.ts` | 21 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/test-fixtures/page-zoom.ts` | 145 | y | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/totp.ts` | 93 | n | stay | Secret path of decision 12: unsealed values exist only in main memory (safeStorage, WebContents); totp seeds and the vault file are sealed and read by one unit, and generating or storing them in the core would move the secret over the protocol. | s4 staysElectron[7] (secret and sign-in paths) |
| `browser/trace-compare.ts` | 55 | n | stay | Test infrastructure for the in-process Electron browser suites (windows, probes, scenarios, helpers); not product code. | s4 staysElectron[14] (test infrastructure) |
| `browser/turn-memory.ts` | 56 | n | stay | Secret path of decision 12: unsealed values exist only in main memory (safeStorage, WebContents); totp seeds and the vault file are sealed and read by one unit, and generating or storing them in the core would move the secret over the protocol. | s4 staysElectron[7] (secret and sign-in paths) |
| `browser/user-takes-page.ts` | 103 | y | stay | Person input on the pane and the page lease, on WebContents. | s4 staysElectron[11] (person input and page lease) |
| `child-environment.ts` | 27 | n | move | Re-exports the runtime env scrub for child processes; the scrub is core logic. | x-residual-moves-b |
| `computer/harness/scenario-fixture-html.ts` | 227 | y | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/harness/scenario-fixtures.ts` | 231 | y | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/harness/scenario-focus-input.ts` | 290 | n | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/harness/scenario-focus-lock.ts` | 607 | y | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/harness/scenario-ids.ts` | 28 | n | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/harness/scenario-ocr.ts` | 91 | n | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/harness/scenario-types.ts` | 106 | n | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/harness/scenarios-external.ts` | 79 | n | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/harness/scenarios-observation.ts` | 468 | y | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/harness/scenarios-performance.ts` | 188 | y | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/harness/scenarios-real-apps.ts` | 440 | y | stay | Dev-only live harness scenario or fixture code (Electron windows and clipboard where it imports electron), re-pointed to the core by s3. | s3 staysElectron[10] (live harness fixtures) |
| `computer/overlay/content-styles.ts` | 52 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/controls.ts` | 96 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/cursor-art.ts` | 68 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/cursor-diagnostics.ts` | 46 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/cursor-glide.ts` | 83 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/cursor-render.ts` | 197 | y | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/cursor-surface.ts` | 182 | y | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/cursor-tail.ts` | 77 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/font-asset.ts` | 8 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/gnome-indicator.ts` | 89 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/ipc-controls.ts` | 79 | y | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/overlay-fade.ts` | 68 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/overlay-layout.ts` | 61 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/overlay-presence.ts` | 26 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/overlay-windows.ts` | 229 | y | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/render-windows.ts` | 30 | y | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/stop-turns.ts` | 25 | n | stay | Overlay window family (pill, banner, cursor): render inputs and window geometry consumed inside the overlay BrowserWindows; s3 keeps the family and mirrors state from the core (computer/presence/mirror.ts). | s3 staysElectron[0] (computer/overlay/*) |
| `computer/overlay/test-fixtures/cursor-art.ts` | 131 | y | stay | Fixture window or helper for the overlay live checks (dev only). | s3 staysElectron[10] (live harness fixtures) |
| `computer/overlay/test-fixtures/cursor-lifecycle.ts` | 194 | y | stay | Fixture window or helper for the overlay live checks (dev only). | s3 staysElectron[10] (live harness fixtures) |
| `computer/overlay/test-fixtures/electron-recovery.ts` | 110 | y | stay | Fixture window or helper for the overlay live checks (dev only). | s3 staysElectron[10] (live harness fixtures) |
| `computer/overlay/test-fixtures/electron-resume.ts` | 294 | y | stay | Fixture window or helper for the overlay live checks (dev only). | s3 staysElectron[10] (live harness fixtures) |
| `computer/overlay/test-fixtures/native-click.ts` | 133 | n | stay | Fixture window or helper for the overlay live checks (dev only). | s3 staysElectron[10] (live harness fixtures) |
| `computer/overlay/test-fixtures/pill-motion.ts` | 77 | y | stay | Fixture window or helper for the overlay live checks (dev only). | s3 staysElectron[10] (live harness fixtures) |
| `computer/overlay/test-fixtures/process-output.ts` | 6 | n | stay | Fixture window or helper for the overlay live checks (dev only). | s3 staysElectron[10] (live harness fixtures) |
| `computer/overlay/test-fixtures/require-env.ts` | 6 | n | stay | Fixture window or helper for the overlay live checks (dev only). | s3 staysElectron[10] (live harness fixtures) |
| `context-menu.ts` | 64 | y | stay | Electron Menu, clipboard and shell for the context menu. | x staysElectron[2] (OS presentation) |
| `conversation-import-progress.ts` | 82 | n | move | Polls the runtime job list on a timer and publishes progress; no Electron object. | x-residual-moves-b |
| `crash-handler-watch.ts` | 139 | n | stay | Watches the Chromium Crashpad handler process of this Electron app through its registration pipe. | no plan clause (main boot; reason in this row) |
| `deferred-desktop-services.ts` | 90 | y | stay | Starts desktop services after the first window shows; reads BrowserWindow/webContents state. | s2a staysElectron[4] (main protocol connection) |
| `desktop-diagnostics.ts` | 77 | n | stay | Desktop log writer used before and without the core (it must never become a failure path). | no plan clause (main boot; reason in this row) |
| `desktop-identity.ts` | 12 | n | stay | AUMID string handed to app.setAppUserModelId and Windows notification branding. | x staysElectron[2] (OS presentation) |
| `dialog-folder-memory.ts` | 20 | n | stay | Works around the Electron 43 dialog default folder; feeds Electron dialog defaultPath. | s1 staysElectron[3] (native dialogs) |
| `feedback-client.ts` | 42 | n | move | HTTP POST of validated feedback to the relay; no Electron object (relay URL resolution moves with s2b remote-relay-device). | x-residual-moves-b |
| `file-launch.ts` | 19 | n | stay | Launch confirmation flow ending in the injected shell.openPath; the confirmation exists today and is kept as is. | s1 staysElectron[3] (OS hand-off, file-launch confirmation) |
| `git-contract.mjs` | 12 | n | move | Argument validation (repository cwd) wrapped from shared/git-contract; validators have a core twin (s2a-core-val-*); the wrapper goes with its callers. | x-residual-moves-b |
| `gpu-recovery.ts` | 108 | n | stay | Chromium GPU fallback switches set before app ready (app.commandLine); no core exists yet. | no plan clause (main boot; reason in this row) |
| `host-display-preferences.ts` | 31 | n | stay | Reads theme and language by webContents.executeJavaScript on the host window. | s2a staysElectron[0] (preload host surface) |
| `host-harness-poll.ts` | 56 | n | stay | Bounded polling shared by the desktop host harnesses (tests). | no plan clause (dev or test helper; reason in this row) |
| `host/lifecycle.ts` | 92 | n | stay | Host-role module: answers host/* methods the core calls into this Electron app. | x staysElectron[8] (host/* modules) |
| `host/system-proxy.ts` | 30 | n | stay | Host-role module: answers host/* methods the core calls into this Electron app. | x staysElectron[8] (host/* modules) |
| `host/visualize.ts` | 62 | n | stay | Host-role module: answers host/* methods the core calls into this Electron app. | x staysElectron[8] (host/* modules) |
| `idle-reclaim.ts` | 119 | n | stay | Main half of renderer memory reclaim: window focus and renderer cache purge hooks. | s2a staysElectron[0] (preload host surface) |
| `ipc-control-chars.ts` | 11 | n | move | Control-character predicate of the IPC validators; validators move to the core (s2a-core-val-*). | x-residual-moves-b |
| `ipc-pane-layout.ts` | 33 | y | stay | ipcMain handler for the pane layout file of an Electron window. | x staysElectron[1] (pane-layout.json in userData) |
| `jitter-probe-entry.ts` | 644 | y | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-fixtures.ts` | 87 | n | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-keys.ts` | 249 | y | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-metrics.ts` | 188 | y | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-real-mouse.ts` | 115 | n | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-sash.ts` | 137 | y | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-selection.ts` | 515 | y | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-session.ts` | 121 | y | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-stream.ts` | 457 | y | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-switch.ts` | 732 | y | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-width-scripts.ts` | 243 | n | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe-width.ts` | 246 | y | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `jitter-probe.ts` | 132 | y | stay | Dev-only jitter probe: drives Electron windows (or is its fixtures/scripts); loaded dynamically and excluded from the package by x-jitter-dev-split. | x-jitter-dev-split |
| `launch-version.ts` | 97 | n | move | Launch/update record file in the profile; atomic fs plus semver only. | x-residual-moves-b |
| `linux-input-access.ts` | 116 | n | move | Linux /dev/uinput access request (pkexec script); child_process only, no Electron object. | x-residual-moves-b |
| `local-file-links.ts` | 89 | n | move | Allowlist and open decision for a local file link; the final shell.openPath stays in the s1 OS hand-off (file-launch.ts) as an injected callback. | x-residual-moves-b |
| `login-shell-environment.ts` | 182 | n | move | Reads the login shell environment (child_process); it runs before the core is spawned, so the Rust port lives on the launcher side (mixdog-spawn / daemon start) and desktop keeps only the call that passes the result on. | x-residual-moves-b |
| `media-source.ts` | 61 | n | stay | Resolution cache behind the Electron mixdog-media:// protocol handler and the relay media lane. | s1 staysElectron[4] (media-protocol.ts) |
| `menu.ts` | 79 | y | stay | Electron Menu and shell. | x staysElectron[2] (OS presentation) |
| `mixy-first.ts` | 132 | n | move | First-run representative-agent status and greetings file store; fs only. | x-residual-moves-b |
| `model-bootstrap.ts` | 60 | n | move | Persisted model route for the first snapshot; pure fs plus config presets. Needs a fast path in the core for first paint (risk noted for the port). | x-residual-moves-b |
| `native-i18n.ts` | 26 | y | stay | Applies the UI language to app/window native strings. | x staysElectron[2] (OS presentation) |
| `native-runtime-cache-gc.mjs` | 30 | n | move | Garbage-collects superseded native tool caches under the profile; fs only. | x-residual-moves-b |
| `network-watch.ts` | 40 | n | move | Polls os.networkInterfaces for an address-set signature; no Electron object. | x-residual-moves-b |
| `pane-layout-file.ts` | 58 | n | stay | Pane layout file of the Electron window, read on every drag; same reason as window-state*.json. | x staysElectron[1] (pane-layout.json in userData) |
| `permission-policy.ts` | 9 | n | stay | Predicate used synchronously by the Electron session permission handler. | s4 staysElectron[9] (partition, permissions) |
| `protocol/defaults-separation.ts` | 13 | n | stay | Main-side client of the core protocol (connection object, notification routes); holds no logic the core can host. | s2a staysElectron[4] (main protocol connection) |
| `protocol/discovery.ts` | 33 | n | stay | Main-side client of the core protocol (connection object, notification routes); holds no logic the core can host. | s2a staysElectron[4] (main protocol connection) |
| `protocol/open-requested.ts` | 72 | n | stay | Main-side client of the core protocol (connection object, notification routes); holds no logic the core can host. | s2a staysElectron[4] (main protocol connection) |
| `protocol/screen-sessions-publish.ts` | 59 | n | stay | Main-side client of the core protocol (connection object, notification routes); holds no logic the core can host. | s2a staysElectron[4] (main protocol connection) |
| `protocol/section-capability-lane.ts` | 81 | n | stay | Main-side client of the core protocol (connection object, notification routes); holds no logic the core can host. | s2a staysElectron[4] (main protocol connection) |
| `protocol/visualize-publish.ts` | 15 | n | stay | Main-side client of the core protocol (connection object, notification routes); holds no logic the core can host. | s2a staysElectron[4] (main protocol connection) |
| `quit-sequence.ts` | 74 | n | stay | Orders window hiding and daemon stop on quit; operates on QuitWindow (BrowserWindow) objects. | no plan clause (main boot; reason in this row) |
| `remote-webrtc/sender-window.integration.ts` | 121 | y | stay | Integration test of the Electron WebRTC sender window; its fate follows x-del-remote-webrtc. | x-del-remote-webrtc |
| `renderer-recovery.ts` | 153 | n | stay | Decides renderer reload or recovery on render-process-gone; has to work when the core is unavailable. | no plan clause (main boot; reason in this row) |
| `session-device.ts` | 21 | n | stay | Stamps the name of the machine running this Electron host; the core may run on another machine. | s2a staysElectron[4] (main protocol connection) |
| `session-sidebar-actions.ts` | 47 | n | move | Argument validation then a call to the desktop service (favorite, archive, project); validation moves to the core handlers. | x-residual-moves-b |
| `test-support/session-protocol-actions.recorded.mjs` | 6 | n | stay | Recorded constants of the Node implementation, read by the parity tests. | no plan clause (test infrastructure; reason in this row) |
| `test-support/worktree-contract.recorded.mjs` | 7 | n | stay | Recorded constants of the Node implementation, read by the parity tests. | no plan clause (test infrastructure; reason in this row) |
| `user-file-write.ts` | 30 | n | move | In-place flushed write that keeps inode/ACL/mode of a user file; node fs only. | x-residual-moves-b |
| `viewport-guard.ts` | 91 | y | stay | BrowserWindow viewport guard. | s2a staysElectron[0] (window chrome) |
| `visualize/act-steps.ts` | 456 | n | move | Visualize request parsing, act steps and export logic: pure parsing, bounds and file writes. | x-residual-moves-c1 |
| `visualize/agent-export.ts` | 64 | n | move | Visualize request parsing, act steps and export logic: pure parsing, bounds and file writes. | x-residual-moves-c1 |
| `visualize/bridge-server.ts` | 22 | n | stay | Thin binding of the visualize bridge name onto bridge/loopback-bridge-server.ts, which stays until s3-bridge-forward/s4-bridge-forward. | s1 staysElectron[6] (loopback bridges) |
| `visualize/context.ts` | 68 | n | move | Visualize tab model, session views, lease guard and problem tracking: state and policy. | x-residual-moves-c3 |
| `visualize/export-actions.ts` | 173 | n | move | Visualize request parsing, act steps and export logic: pure parsing, bounds and file writes. | x-residual-moves-c1 |
| `visualize/export-offscreen.ts` | 171 | n | move | Visualize request parsing, act steps and export logic: pure parsing, bounds and file writes. | x-residual-moves-c1 |
| `visualize/export-render.ts` | 411 | y | stay | Pane-frame side of visualize: BrowserWindow, WebContents, screen, session or protocol handlers of the visualize panes. | s2a staysElectron[0] (visualize preload surface, decision 4) |
| `visualize/export.ts` | 156 | n | move | Visualize request parsing, act steps and export logic: pure parsing, bounds and file writes. | x-residual-moves-c1 |
| `visualize/gestures.ts` | 80 | n | move | Visualize open/read actions, turn hold and gesture tokens: orchestration over injected host callbacks. | x-residual-moves-c4 |
| `visualize/history.ts` | 65 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `visualize/host-feedback.ts` | 59 | y | stay | Pane-frame side of visualize: BrowserWindow, WebContents, screen, session or protocol handlers of the visualize panes. | s2a staysElectron[0] (visualize preload surface, decision 4) |
| `visualize/host-file-watch.ts` | 25 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `visualize/host-frames.ts` | 178 | y | stay | Pane-frame side of visualize: BrowserWindow, WebContents, screen, session or protocol handlers of the visualize panes. | s2a staysElectron[0] (visualize preload surface, decision 4) |
| `visualize/host-gesture-watch.ts` | 69 | y | stay | Pane-frame side of visualize: BrowserWindow, WebContents, screen, session or protocol handlers of the visualize panes. | s2a staysElectron[0] (visualize preload surface, decision 4) |
| `visualize/host-page-observer.ts` | 122 | y | stay | Pane-frame side of visualize: BrowserWindow, WebContents, screen, session or protocol handlers of the visualize panes. | s2a staysElectron[0] (visualize preload surface, decision 4) |
| `visualize/host-page-ops.ts` | 139 | y | stay | Pane-frame side of visualize: BrowserWindow, WebContents, screen, session or protocol handlers of the visualize panes. | s2a staysElectron[0] (visualize preload surface, decision 4) |
| `visualize/host-pane-frame.ts` | 54 | y | stay | Pane-frame side of visualize: BrowserWindow, WebContents, screen, session or protocol handlers of the visualize panes. | s2a staysElectron[0] (visualize preload surface, decision 4) |
| `visualize/host-zoom-input.ts` | 90 | y | stay | Pane-frame side of visualize: BrowserWindow, WebContents, screen, session or protocol handlers of the visualize panes. | s2a staysElectron[0] (visualize preload surface, decision 4) |
| `visualize/host.ts` | 399 | y | stay | Pane-frame side of visualize: BrowserWindow, WebContents, screen, session or protocol handlers of the visualize panes. | s2a staysElectron[0] (visualize preload surface, decision 4) |
| `visualize/inline-page.ts` | 31 | n | move | Visualize service composition: per-session tabs and the agent tool entry; takes the pane host as injected dependency. | x-residual-moves-c5 |
| `visualize/lease-guard.ts` | 126 | n | move | Visualize tab model, session views, lease guard and problem tracking: state and policy. | x-residual-moves-c3 |
| `visualize/offscreen-origins.ts` | 73 | y | stay | Pane-frame side of visualize: BrowserWindow, WebContents, screen, session or protocol handlers of the visualize panes. | s2a staysElectron[0] (visualize preload surface, decision 4) |
| `visualize/open-actions.ts` | 483 | n | move | Visualize open/read actions, turn hold and gesture tokens: orchestration over injected host callbacks. | x-residual-moves-c4 |
| `visualize/overlay-script.ts` | 9 | n | move | Visualize open/read actions, turn hold and gesture tokens: orchestration over injected host callbacks. | x-residual-moves-c4 |
| `visualize/page-problems.ts` | 148 | n | move | Visualize tab model, session views, lease guard and problem tracking: state and policy. | x-residual-moves-c3 |
| `visualize/pane-source.ts` | 24 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `visualize/panel-commands.ts` | 115 | n | move | Visualize tab model, session views, lease guard and problem tracking: state and policy. | x-residual-moves-c3 |
| `visualize/panes.ts` | 42 | n | move | Visualize tab model, session views, lease guard and problem tracking: state and policy. | x-residual-moves-c3 |
| `visualize/problem-tracker.ts` | 179 | n | move | Visualize tab model, session views, lease guard and problem tracking: state and policy. | x-residual-moves-c3 |
| `visualize/read-actions.ts` | 369 | n | move | Visualize open/read actions, turn hold and gesture tokens: orchestration over injected host callbacks. | x-residual-moves-c4 |
| `visualize/reloads.ts` | 183 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `visualize/result-text.ts` | 31 | n | move | Visualize request parsing, act steps and export logic: pure parsing, bounds and file writes. | x-residual-moves-c1 |
| `visualize/service.ts` | 467 | n | move | Visualize service composition: per-session tabs and the agent tool entry; takes the pane host as injected dependency. | x-residual-moves-c5 |
| `visualize/session-views.ts` | 225 | n | move | Visualize tab model, session views, lease guard and problem tracking: state and policy. | x-residual-moves-c3 |
| `visualize/tab-state.ts` | 292 | n | move | Visualize tab model, session views, lease guard and problem tracking: state and policy. | x-residual-moves-c3 |
| `visualize/tab-versions.ts` | 71 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `visualize/tabs.ts` | 135 | n | move | Visualize tab model, session views, lease guard and problem tracking: state and policy. | x-residual-moves-c3 |
| `visualize/targets.ts` | 443 | n | move | Visualize request parsing, act steps and export logic: pure parsing, bounds and file writes. | x-residual-moves-c1 |
| `visualize/thumbnails.ts` | 139 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `visualize/turn-hold.ts` | 289 | n | move | Visualize open/read actions, turn hold and gesture tokens: orchestration over injected host callbacks. | x-residual-moves-c4 |
| `visualize/version-eviction.ts` | 65 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `visualize/version-restore.ts` | 76 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `visualize/version-select.ts` | 115 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `visualize/version-thumbnails.ts` | 63 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `visualize/versions.ts` | 456 | n | move | Visualize version history, thumbnails, history and file reload logic: fs and bookkeeping. | x-residual-moves-c2 |
| `whats-new-acknowledge.ts` | 54 | n | stay | ipcMain listener that checks the sender frame of the main window (webContents.mainFrame). | s2a staysElectron[0] (preload host surface) |
| `window-state.ts` | 155 | y | stay | Persisted bounds of BrowserWindows. | x staysElectron[1] (window-state*.json in userData) |
