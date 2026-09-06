import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { executeOfficeTool } from './index.mjs';
import { sessions } from './core/office-core.mjs';
import { renderOfficePreview } from './core/office-render-preview.mjs';
import { pptxPageSignatures } from './core/pptx-page-cache.mjs';
import { snapshotPortableOoxml } from './portable/portable-snapshot.mjs';
import { loadPackage, savePackage, zipText } from './portable/portable-opc.mjs';
import { value, workspace } from './office-test-support.mjs';

async function fixture(t) {
  const cwd = await workspace(t);
  const office = async (args) => {
    const raw = await executeOfficeTool(args, { cwd });
    if (raw.isError) throw new Error(raw.content[0].text);
    return value(raw);
  };
  const authored = await office({
    action: 'author', path: join(cwd, 'incremental.pptx'), mode: 'portable', render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      for (const text of ['Revenue', 'Growth', 'Spending']) {
        const s = p.addSlide();
        s.addText(text, {x:1,y:1,w:8,h:1,fontSize:32});
        s.addText('Details', {x:1,y:3,w:8,h:1,fontSize:20});
      }
      await p.writeFile({fileName:OUTPUT});`,
  });
  const session = sessions.get(authored.session);
  t.after(async () => { if (sessions.has(session.id)) await office({ action: 'close', session: session.id }); });
  let exports = 0;
  const rasterCalls = [];
  const adapters = {
    exportPreview: async (_, output) => { exports++; await writeFile(output, 'pdf'); },
    rasterize: async (output, { pages }) => {
      rasterCalls.push(pages);
      const images = [];
      for (const page of pages || [1, 2, 3]) {
        const canvas = createCanvas(40, 30);
        const context = canvas.getContext('2d');
        context.fillStyle = `rgb(${page * 50},${session.snapshotVersion * 30},50)`;
        context.fillRect(0, 0, 40, 30);
        const data = canvas.toBuffer('image/png');
        const path = `${output}-${page}.png`;
        await writeFile(path, data);
        images.push({ page, path, width: 40, height: 30, mimeType: 'image/png', data: data.toString('base64') });
      }
      return { pageCount: 3, images };
    },
  };
  return { cwd, office, session, adapters, rasterCalls, exportCount: () => exports };
}

test('one stable-ID edit rasterizes only its page; detail reads restore complete coverage without another export', async (t) => {
  const f = await fixture(t);
  const first = await renderOfficePreview(f.session, {}, f.cwd, f.adapters);
  const snapshot = await snapshotPortableOoxml(f.session.target, 'pptx');
  const slide = snapshot.slides[1];
  await f.office({ action: 'batch', session: f.session.id, operations: [
    { op: 'set_text', slideId: slide.slideId, shapeId: slide.shapes[0].shapeId, text: 'Updated growth' },
  ] });
  assert.equal(f.session.designState.renderedVersion, null);
  const changed = await renderOfficePreview(f.session, { pages: [2] }, f.cwd, f.adapters);
  assert.deepEqual(changed.changedPages, [2]);
  assert.equal(changed.visualCoverage.complete, false);
  const full = await renderOfficePreview(f.session, {}, f.cwd, f.adapters);
  assert.deepEqual(full.changedPages, []);
  assert.deepEqual(full.reusedPages, [1, 2, 3]);
  assert.equal(full.visualCoverage.complete, true);
  assert.notEqual(full.reviewToken, first.reviewToken);
  assert.equal(full._images[0].data, first._images[0].data);
  assert.deepEqual(f.rasterCalls, [[1, 2, 3], [2]]);
  assert.equal(f.exportCount(), 2);
});

test('stable IDs survive reordering, reject conflicts, and transaction rollback restores original content', async (t) => {
  const f = await fixture(t);
  const before = await snapshotPortableOoxml(f.session.target, 'pptx');
  const target = before.slides[1];
  await f.office({ action: 'begin', session: f.session.id });
  await f.office({ action: 'batch', session: f.session.id, operations: [
    { op: 'move_slide', slide: 2, index: 1 },
    { op: 'set_text', slideId: target.slideId, shapeId: target.shapes[0].shapeId, text: 'Selected by ID' },
  ] });
  const after = await snapshotPortableOoxml(f.session.target, 'pptx');
  assert.equal(after.slides[0].slideId, target.slideId);
  assert.equal(after.slides[0].shapes[0].text, 'Selected by ID');
  await assert.rejects(f.office({ action: 'batch', session: f.session.id, operations: [
    { op: 'set_text', slide: 3, slideId: target.slideId, shapeId: target.shapes[0].shapeId, text: 'Wrong' },
  ] }), /different pages/);
  await f.office({ action: 'rollback', session: f.session.id });
  const restored = await snapshotPortableOoxml(f.session.target, 'pptx');
  assert.deepEqual(restored.slides.map((slide) => slide.text), before.slides.map((slide) => slide.text));
});

test('shared resource changes invalidate all page signatures and failed refresh clears reusable visual state', async (t) => {
  const f = await fixture(t);
  const before = await pptxPageSignatures(f.session.target);
  await renderOfficePreview(f.session, {}, f.cwd, f.adapters);
  const zip = await loadPackage(f.session.target);
  zip.file('ppt/theme/theme1.xml', (await zipText(zip, 'ppt/theme/theme1.xml')).replace(/\bname="[^"]*"/, 'name="Changed Theme"'));
  await savePackage(zip, f.session.target);
  const after = await pptxPageSignatures(f.session.target);
  assert.ok(after.every((page, i) => page.signature !== before[i].signature));
  f.session.snapshotVersion++;
  await assert.rejects(renderOfficePreview(f.session, {}, f.cwd, {
    ...f.adapters, rasterize: async () => { throw new Error('raster failed'); },
  }), /raster failed/);
  assert.equal(f.session.designState.renderedVersion, null);
  assert.equal(f.session.renderCache, null);
  assert.equal(f.session.pageRenderCache, null);
});

test('opening an existing deck uses an owned copy and leaves the source intact during partial editing', async (t) => {
  const f = await fixture(t);
  const original = await snapshotPortableOoxml(f.session.target, 'pptx');
  const opened = await f.office({ action: 'open', path: f.session.target, output: join(f.cwd, 'copy.pptx'), mode: 'portable' });
  const copy = sessions.get(opened.session);
  assert.equal(copy.ownership, 'owned');
  await renderOfficePreview(copy, {}, f.cwd, f.adapters);
  await f.office({ action: 'batch', session: copy.id, operations: [
    { op: 'set_text', slideId: original.slides[1].slideId, shapeId: original.slides[1].shapes[0].shapeId, text: 'Changed copy only' },
  ] });
  const rendered = await renderOfficePreview(copy, {}, f.cwd, f.adapters);
  assert.deepEqual(rendered.changedPages, [2]);
  assert.deepEqual(rendered.reusedPages, [1, 3]);
  assert.deepEqual((await snapshotPortableOoxml(f.session.target, 'pptx')).slides.map((slide) => slide.text), original.slides.map((slide) => slide.text));
  await f.office({ action: 'close', session: copy.id });
});
