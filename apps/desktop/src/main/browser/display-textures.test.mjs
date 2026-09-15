import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createBrowserDisplayTextures } from './display-textures.ts';

function fixture() {
  const guest = Object.assign(new EventEmitter(), { id: 1 });
  let document = 'p1:1';
  const sends = [];
  const frames = createBrowserDisplayTextures({
    document: () => document,
    importTexture: (texture, released) => ({ release: released, texture }),
    send: async (texture, session, id) => { sends.push({ texture, session, id }); },
  });
  frames.attach(guest);
  return {
    guest, frames, sends,
    navigate() { document = 'p1:2'; guest.emit('did-start-navigation', {}, 'new', false, true); },
    paint(width = 600, widgetType = 'frame') {
      const texture = {
        releases: 0,
        release() { this.releases++; },
        textureInfo: { widgetType, visibleRect: { width, height: 400 } },
      };
      guest.emit('paint', { texture });
      return texture;
    },
  };
}

test('replaced textures live until their display lease and GPU transfer are released', async () => {
  const f = fixture();
  const first = f.paint();
  const lease = f.frames.acquire(f.guest, 'p1:1', 600, 400);
  assert.ok(lease);
  const next = f.paint();
  assert.equal(first.releases, 0);
  await lease.send('s');
  assert.equal(f.sends[0].id, lease.id);
  assert.equal(f.sends[0].session, 's');
  assert.equal(first.releases, 0);
  lease.release();
  lease.release();
  assert.equal(first.releases, 1);
  f.guest.emit('destroyed');
  assert.equal(next.releases, 1);
  assert.equal(f.guest.listenerCount('paint'), 0);
});

test('navigation, dimensions and popup textures cannot lend stale page pixels', () => {
  const f = fixture();
  const first = f.paint();
  assert.equal(f.frames.acquire(f.guest, 'p1:1', 700, 400), undefined);
  assert.equal(f.frames.acquire(f.guest, 'p1:2', 600, 400), undefined);
  f.navigate();
  assert.equal(first.releases, 1);
  assert.equal(f.frames.acquire(f.guest, 'p1:2', 600, 400), undefined);
  const popup = f.paint(600, 'popup');
  assert.equal(popup.releases, 1);
  assert.equal(f.frames.acquire(f.guest, 'p1:2', 600, 400), undefined);
  f.guest.emit('destroyed');
});
