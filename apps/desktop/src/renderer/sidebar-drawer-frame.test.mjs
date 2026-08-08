import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('responsive panels suppress layout motion and keep click catchers undimmed', async () => {
  const [app, bottomPanel, styles, paneStyles] = await Promise.all([
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./BottomPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    readFile(new URL('./pane-layout.css', import.meta.url), 'utf8'),
  ]);

  assert.match(app,
    /<div className="sidebar-drawer-frame"[\s\S]*?<ActivityRail[\s\S]*?sidebarTreeMounted && <SessionSidebar[\s\S]*?<\/SessionSidebar>}/,
    'the frame must physically contain both moving surfaces');
  assert.match(app,
    /applySidebarOpen\(false, "instant"\)/,
    'the responsive breakpoint fold must request an instant close');
  assert.match(app,
    /root\.classList\.add\("mx-window-resizing"\)[\s\S]*?root\.classList\.remove\("mx-window-resizing"\)[\s\S]*?window\.addEventListener\("resize", onResize\)/,
    'window dragging must arm motion suppression before breakpoint effects settle');
  assert.match(app,
    /data-motion=\{sidebarMotion\}/,
    'the frame must receive the close-motion reason');
  assert.match(styles,
    /@media \(max-width:\s*760px\)[\s\S]*\.sidebar-drawer-frame\s*\{[^}]*position:\s*fixed;[^}]*display:\s*flex;[^}]*transform:\s*translateX\(-100%\);[^}]*transition:\s*transform var\(--mx-sheet-motion\), visibility var\(--mx-sheet-motion\);/s,
    'manual closes must slide the shared frame back out');
  assert.match(styles,
    /html\.mx-open-sidebar \.sidebar-drawer-frame\[data-state="open"\]\s*\{[^}]*animation:\s*sidebar-slide-in var\(--mx-sheet-motion\);/s,
    'only an explicit open should slide the shared frame into view');
  assert.match(styles,
    /\.sidebar-drawer-frame\[data-motion="instant"\]\s*\{[^}]*transition:\s*none;/s,
    'responsive folds must bypass the manual close transition');
  assert.match(styles,
    /\.sidebar-drawer-frame::after\s*\{[^}]*inset:\s*0;[^}]*box-shadow:\s*inset 0 0 0 1px var\(--mx-border-muted\);/s,
    'the shared frame must paint its ring above both child surfaces');
  assert.match(styles,
    /\.sidebar-drawer-frame::before\s*\{[^}]*top:\s*0;[^}]*bottom:\s*0;[^}]*left:\s*47px;[^}]*width:\s*1px;[^}]*background:\s*var\(--mx-border-muted\);/s,
    'the shared frame must preserve the full-height divider between rail and list');
  assert.match(styles,
    /\.sidebar-drawer-frame\[data-state="open"\]\s*\{[^}]*transform:\s*none;[^}]*visibility:\s*visible;/s);
  assert.match(styles,
    /\.sidebar-drawer-frame > \.sidebar\.session-sidebar,[\s\S]*?transition:\s*none;/s,
    'the nested panel must not run a second transition clock');
  assert.match(styles,
    /\.sidebar-backdrop\s*\{[^}]*background:\s*transparent;/s,
    'the left side tab outside-click layer must not dim the workspace');
  assert.match(styles,
    /\.dock-backdrop,\s*\.panel-backdrop\s*\{\s*background:\s*transparent;\s*\}/,
    'the right and bottom outside-click layers must not dim the workspace');
  assert.match(app,
    /bottomPanel\.setOpen\(false, "instant"\)/,
    'the 940px responsive fold must close the bottom panel instantly');
  assert.match(app,
    /motion=\{wasBottomSheetBand\.current !== bottomSheetBand[\s\S]*?\? "instant"[\s\S]*?: bottomPanel\.motion\}/,
    'the crossing render itself must suppress bottom-panel motion');
  assert.match(app,
    /entering=\{dockSettled \|\| wasBottomSheetBand\.current !== bottomSheetBand\}/,
    'the crossing render itself must suppress right-Dock sheet motion');
  assert.match(bottomPanel,
    /data-settled=\{settled \? "true" : undefined\} data-motion=\{motion\}/,
    'the bottom panel must expose its explicit motion reason');
  assert.match(paneStyles,
    /\.bottom-panel\[data-motion="instant"\]\s*\{[^}]*animation:\s*none;/s,
    'responsive bottom-panel transitions must bypass both opening animations');
  assert.match(styles,
    /html\.mx-window-resizing \.sidebar-drawer-frame,[\s\S]*?html\.mx-window-resizing \.utility-dock,[\s\S]*?html\.mx-window-resizing \.bottom-panel,[\s\S]*?\{[^}]*animation:\s*none !important;[^}]*transition:\s*none !important;/s,
    'the resize event guard must suppress left, right, and bottom panel motion');
});
