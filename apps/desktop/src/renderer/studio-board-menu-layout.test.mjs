import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const css = readFileSync(new URL('./desktop/19-studio.css', import.meta.url), 'utf8');

// The board icon is a span slot like the label; when both grew, the board
// rows' names sat ~70px right of "No board" (whose grid glyph is a bare svg).
test('only the board-picker label grows, so every item label starts after a 16px glyph', () => {
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>
    <div class="studio-board-menu" role="menu">
      <button class="studio-board-menu-item"><svg width="16" height="16"></svg><span class="studio-board-menu-label">No board</span></button>
      <button class="studio-board-menu-item"><span class="session-row-slot studio-board-icon"><svg width="16" height="16"></svg></span><span class="studio-board-menu-label">Board</span></button>
    </div></body></html>`);
  try {
    const { document, getComputedStyle } = dom.window;
    const [none, board] = document.querySelectorAll('.studio-board-menu-item');
    const grows = (node) => Number.parseFloat(getComputedStyle(node).flexGrow) > 0;
    assert.equal(grows(board.querySelector('.studio-board-icon')), false, 'the icon slot keeps its 16px');
    assert.equal(grows(none.querySelector('.studio-board-menu-label')), true);
    assert.equal(grows(board.querySelector('.studio-board-menu-label')), true);
  } finally {
    dom.window.close();
  }
});
