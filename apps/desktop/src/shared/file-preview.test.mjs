import assert from 'node:assert/strict';
import test from 'node:test';
import { documentPreviewFormatForPath, editorFileOpener, filePreviewTypeForPath } from './file-preview.ts';
import { localFileMimeTypeForPath, localFileOpener, localLinkKind } from './local-files.ts';

test('Office documents, SVG and unsupported safe media default to external apps', () => {
  for (const extension of [
    'pptx',
    'ppt',
    'docx',
    'doc',
    'dotx',
    'xlsx',
    'xls',
    'rtf',
    'odt',
    'ods',
    'odp',
    'tif',
    'tiff',
    'mkv',
    'svg',
  ]) {
    assert.equal(editorFileOpener(`output/report.${extension}`), 'os', extension);
    assert.equal(editorFileOpener(`C:\\Project\\Report.${extension.toUpperCase()}`), 'os', extension);
  }
});

test('native previews and editable files stay inside Mixdog', () => {
  for (const extension of [
    'png',
    'jpg',
    'jpeg',
    'jfif',
    'gif',
    'webp',
    'avif',
    'bmp',
    'ico',
    'pdf',
    'mp3',
    'wav',
    'ogg',
    'oga',
    'opus',
    'm4a',
    'aac',
    'flac',
    'mp4',
    'm4v',
    'webm',
    'ogv',
    'mov',
    'md',
    'txt',
    'ts',
    'json',
    'csv',
  ]) {
    assert.equal(editorFileOpener(`file.${extension}`), 'editor', extension);
  }
});

test('SVG links open externally while image previews remain available for thumbnails', () => {
  for (const path of ['output/chart.svg', 'C:\\Project\\Chart.SVG']) {
    assert.equal(localFileOpener(path), 'os');
    assert.deepEqual(filePreviewTypeForPath(path), { kind: 'image', mime: 'image/svg+xml' });
  }
});

test('installers, application packages and archives open with the OS like a double-click', () => {
  for (const name of [
    'setup.exe',
    'C:\\Downloads\\Setup.EXE',
    'installer.msi',
    'app.msix',
    'app.msixbundle',
    'app.appx',
    'app.appxbundle',
    'image.dmg',
    'installer.pkg',
    '/Applications/Tool.app',
    'archive.zip',
    'archive.7z',
    'archive.rar',
    'disk.iso',
  ]) {
    assert.equal(localFileOpener(name), 'os', name);
    assert.equal(editorFileOpener(name), 'os', name);
  }
});

test('scripts, shortcuts, macro-enabled and unknown files never auto-launch', () => {
  for (const name of [
    'run.bat',
    'run.cmd',
    'run.ps1',
    'run.js',
    'run.vbs',
    'shortcut.lnk',
    'link.url',
    'app.appref-ms',
    'shell.scf',
    'deck.pptm',
    'report.docm',
    'budget.xlsm',
    'data.bin',
    'Dockerfile',
  ]) {
    assert.equal(editorFileOpener(name), 'editor', name);
  }
});

test('file consumers classify only the final filename extension across path styles', () => {
  for (const path of ['image.PNG', 'C:\\Project\\image.PNG', '/project/image.PNG', '.png']) {
    assert.deepEqual(filePreviewTypeForPath(path), { kind: 'image', mime: 'image/png' });
    assert.equal(localFileMimeTypeForPath(path), 'image/png');
    assert.equal(localFileOpener(path), 'os');
    assert.equal(localLinkKind(path), 'file');
  }
  for (const path of ['', 'README', 'image.', '/folder.png/README', 'C:\\folder.png\\README']) {
    assert.equal(filePreviewTypeForPath(path), null);
    assert.equal(documentPreviewFormatForPath(path), '');
    assert.equal(localFileMimeTypeForPath(path), 'application/octet-stream');
    assert.equal(localFileOpener(path), 'editor');
    assert.equal(localLinkKind(path), 'unknown');
  }
  for (const path of ['/folder.png/', 'C:\\folder.png\\']) {
    assert.equal(filePreviewTypeForPath(path), null);
    assert.equal(localFileMimeTypeForPath(path), 'application/octet-stream');
    assert.equal(localLinkKind(path), 'folder');
  }
  assert.equal(documentPreviewFormatForPath('C:\\Project\\report.DOCX'), 'docx');
  assert.equal(documentPreviewFormatForPath('report.docx.exe'), '');
  assert.equal(filePreviewTypeForPath('image.png?query'), null);
  assert.equal(localFileMimeTypeForPath('image.png?query'), 'application/octet-stream');
});
