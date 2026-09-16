import assert from 'node:assert/strict';
import test from 'node:test';
import { editorFileOpener } from './file-preview.ts';

test('Office documents and unsupported safe media default to external apps', () => {
  for (const extension of ['pptx', 'ppt', 'docx', 'doc', 'dotx', 'xlsx', 'xls', 'rtf', 'odt', 'ods', 'odp', 'tif', 'tiff', 'mkv']) {
    assert.equal(editorFileOpener(`output/report.${extension}`), 'os', extension);
    assert.equal(editorFileOpener(`C:\\Project\\Report.${extension.toUpperCase()}`), 'os', extension);
  }
});

test('native previews and editable files stay inside Mixdog', () => {
  for (const extension of ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'pdf', 'mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'mp4', 'm4v', 'webm', 'ogv', 'mov', 'md', 'txt', 'ts', 'json', 'csv']) {
    assert.equal(editorFileOpener(`file.${extension}`), 'editor', extension);
  }
});

test('executable, macro-enabled and unknown files never auto-launch', () => {
  for (const name of ['payload.exe', 'run.bat', 'run.cmd', 'run.ps1', 'run.js', 'run.vbs', 'shortcut.lnk', 'link.url', 'app.appref-ms', 'shell.scf', 'deck.pptm', 'report.docm', 'budget.xlsm', 'archive.zip', 'data.bin', 'Dockerfile', 'deck.pptx.exe']) {
    assert.equal(editorFileOpener(name), 'editor', name);
  }
});
