import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { cachedOfficePreview, renderOfficePreview } from './core/office-render-preview.mjs';
import { pptxVisualReviewAcknowledged } from './quality/design-review-critique.mjs';
import { executeOfficeTool } from './index.mjs';
import { sessions } from './core/office-core.mjs';
import { value, workspace } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

async function fixture(t) {
  const cwd = await workspace(t);
  const session = {
    id: 'preview', format: 'pptx', backend: 'microsoft-office-com',
    mode: 'background', ownership: 'owned', visible: false,
    target: join(cwd, 'deck.pptx'), snapshotVersion: 0, designState: {},
  };
  const calls = { exports: 0, rasters: 0 };
  const canvas = createCanvas(800, 450);
  const context = canvas.getContext('2d');
  context.fillStyle = '#f5f7fa';
  context.fillRect(0, 0, 800, 450);
  context.fillStyle = '#182c40';
  context.font = '32px Arial';
  context.fillText('Review fixture', 60, 100);
  const png = canvas.toBuffer('image/png');
  const adapters = {
    exportPreview: async (_, output) => { calls.exports++; await writeFile(output, 'export'); },
    rasterize: async (output, options) => {
      calls.rasters++;
      const pages = options.pages || [1, 2];
      const images = [];
      for (const page of pages) {
        const path = `${output}-${page}.png`;
        await writeFile(path, png);
        images.push({ page, path, width: 800, height: 450, mimeType: 'image/png', data: png.toString('base64') });
      }
      return {
        pageCount: 2, images,
        visualCoverage: { complete: pages.length === 2, reviewedPages: pages, reviewed: pages.length, total: 2 },
      };
    },
  };
  return { cwd, session, calls, adapters };
}

test('complete custom preview is reused without exporting and caller edits do not contaminate it', async (t) => {
  const { cwd, session, calls, adapters } = await fixture(t);
  const first = await renderOfficePreview(session, { output: 'chosen.pdf', maxWidth: 1600 }, cwd, adapters);
  const token = first.reviewToken;
  first._images.push({ page: 0 });
  first._images[0].page = 99;
  first.visualCoverage.complete = false;
  const reused = await renderOfficePreview(session, {}, cwd, { ...adapters, reuseLatest: true });
  assert.equal(reused.reused, true);
  assert.equal(reused.output, join(cwd, 'chosen.pdf'));
  assert.equal(reused.reviewToken, token);
  assert.deepEqual(reused._images.map((image) => image.page), [1, 2]);
  assert.equal(reused.visualCoverage.complete, true);
  assert.deepEqual(calls, { exports: 1, rasters: 1 });
  assert.equal(await cachedOfficePreview(session, { maxWidth: 800 }, cwd, { reuseLatest: true }), null);
  assert.equal(await cachedOfficePreview(session, { output: 'other.pdf' }, cwd, { reuseLatest: true }), null);
});

test('persisted images remain usable without the intermediate PDF but missing images require refresh', async (t) => {
  const { cwd, session, calls, adapters } = await fixture(t);
  const first = await renderOfficePreview(session, {}, cwd, adapters);
  await rm(first.output);
  const cached = await renderOfficePreview(session, {}, cwd, adapters);
  assert.equal(cached.reused, true);
  assert.equal(cached.exportAvailable, false);
  assert.deepEqual(calls, { exports: 1, rasters: 1 });
  await rm(first._images[0].path);
  const refreshed = await renderOfficePreview(session, {}, cwd, adapters);
  assert.equal(refreshed.exportAvailable, true);
  assert.equal(refreshed.reviewToken, first.reviewToken, 'identical restored pixels preserve the review identity');
  assert.deepEqual(calls, { exports: 2, rasters: 2 });
});

test('changed documents and partial previews cannot reuse complete-deck approval', async (t) => {
  const { cwd, session, adapters } = await fixture(t);
  const first = await renderOfficePreview(session, {}, cwd, adapters);
  session.snapshotVersion++;
  assert.equal(await cachedOfficePreview(session, {}, cwd, { reuseLatest: true }), null);
  const partial = await renderOfficePreview(session, { pages: [2] }, cwd, adapters);
  assert.notEqual(partial.reviewToken, first.reviewToken);
  assert.equal(await cachedOfficePreview(session, {}, cwd, { reuseLatest: true }), null);
  assert.equal(pptxVisualReviewAcknowledged({
    reviewed: true, providedToken: partial.reviewToken, expectedToken: partial.reviewToken,
    renderedVersion: 1, snapshotVersion: 1, critiqueOk: true, coverageComplete: false,
  }), false);
});

test('unrendered version zero and failed refresh do not retain approval', async (t) => {
  assert.equal(pptxVisualReviewAcknowledged({
    reviewed: true, providedToken: 'preview:0', expectedToken: 'preview:0',
    renderedVersion: null, snapshotVersion: 0, critiqueOk: true,
  }), false);
  const { cwd, session, adapters } = await fixture(t);
  await renderOfficePreview(session, {}, cwd, adapters);
  await assert.rejects(renderOfficePreview(session, { maxWidth: 700 }, cwd, {
    ...adapters, exportPreview: async () => { throw new Error('export failed'); },
  }), /export failed/);
  assert.equal(session.designState.renderedVersion, null);
  assert.equal(session.designState.reviewToken, '');
  assert.equal(await cachedOfficePreview(session, {}, cwd, { reuseLatest: true }), null);
});

test('visible and attached documents refresh instead of using owned-session caches', async (t) => {
  const { cwd, session, calls, adapters } = await fixture(t);
  for (const change of [{ visible: true }, { ownership: 'attached', visible: false }, { ownership: 'owned', mode: 'attach' }]) {
    Object.assign(session, change);
    const first = await renderOfficePreview(session, {}, cwd, adapters);
    const second = await renderOfficePreview(session, {}, cwd, adapters);
    assert.equal(second.reviewToken, first.reviewToken, 'unchanged visible pixels can still be finalized');
    assert.equal(second.reused, undefined);
  }
  assert.deepEqual(calls, { exports: 6, rasters: 6 });
  const previousToken = session.designState.reviewToken;
  const changed = await renderOfficePreview(session, {}, cwd, {
    ...adapters,
    rasterize: async (...args) => {
      const rendered = await adapters.rasterize(...args);
      const png = createCanvas(800, 450).toBuffer('image/png');
      await writeFile(rendered.images[0].path, png);
      rendered.images[0].data = png.toString('base64');
      return rendered;
    },
  });
  assert.notEqual(changed.reviewToken, previousToken, 'external visual changes invalidate approval without a batch revision');
});

test('cancelled reads do not hand back cached visual evidence', async (t) => {
  const { cwd, session, adapters } = await fixture(t);
  await renderOfficePreview(session, {}, cwd, adapters);
  session.activeSignal = AbortSignal.abort();
  await assert.rejects(renderOfficePreview(session, {}, cwd, adapters), { name: 'AbortError' });
});

test('finalize uses a complete custom preview and still validates the saved deck', async (t) => {
  const { cwd, adapters } = await fixture(t);
  const authored = value(await executeOfficeTool({
    action: 'author', path: join(cwd, 'finalize.pptx'), mode: 'portable', render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      for (const text of ['Planning', 'Delivery']) {
        p.addSlide().addText(text, { x: 1, y: 2, w: 10, h: 1, fontFace: 'Arial', fontSize: 32 });
      }
      await p.writeFile({ fileName: OUTPUT });`,
  }, { cwd }));
  const session = sessions.get(authored.session);
  const preview = await renderOfficePreview(session, { output: 'reviewed.pdf', maxWidth: 1600 }, cwd, adapters);
  const critique = [1, 2].map((slide) => ({
    slide, verdict: 'pass', hierarchy: 4, balance: 4, legibility: 4, cohesion: 4, evidence: 4,
    note: `Slide ${slide} has one distinct title with sufficient space around the primary statement.`,
    fixes: [],
  }));
  const finalized = value(await executeOfficeTool({
    action: 'finalize', session: session.id, render: false,
    design: { reviewed: true, reviewToken: preview.reviewToken, critique },
  }, { cwd }));
  assert.equal(finalized.finalized, true, JSON.stringify(finalized));
  assert.equal(finalized.review.preview.reused, true);
  assert.equal(finalized.review.preview.output, preview.output);
  assert.equal(finalized.validation.ok, true);
  assert.equal(finalized.saved, true);
  assert.equal(finalized.closed, true);
});
