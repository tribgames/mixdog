import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const css = readFileSync(new URL('./desktop/19-studio.css', import.meta.url), 'utf8');

test('an open Studio detail viewer hides the composer dock; closing it brings the dock back', () => {
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>
    <div class="studio-shell"><div class="studio-dock"><div class="studio-composer"></div></div></div>
    </body></html>`);
  try {
    const { document, getComputedStyle } = dom.window;
    const shell = document.querySelector('.studio-shell');
    const dock = document.querySelector('.studio-dock');
    assert.equal(getComputedStyle(dock).visibility, 'visible');
    const viewer = document.createElement('div');
    viewer.className = 'studio-detail';
    shell.append(viewer);
    assert.equal(getComputedStyle(dock).visibility, 'hidden', 'the composer and model line cannot show through');
    viewer.remove();
    assert.equal(getComputedStyle(dock).visibility, 'visible');
  } finally {
    dom.window.close();
  }
});
