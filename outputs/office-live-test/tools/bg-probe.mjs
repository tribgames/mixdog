// Prints what the portable snapshot says each slide's background and text colours are, for a two-slide deck whose
// cover alone has a dark background.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const value = (r) => JSON.parse(r.content[0].text);
const dir = await mkdtemp(join(tmpdir(), 'bg-'));
const script = `const pptxgen = require('pptxgenjs'); const pres = new pptxgen(); pres.layout = 'LAYOUT_WIDE';
const cover = pres.addSlide(); cover.background = { color: '1E2761' };
cover.addText('Retention rose', { x: 0.8, y: 2.4, w: 11.5, h: 1.4, fontFace: 'Arial', fontSize: 40, bold: true, color: 'FFFFFF' });
const content = pres.addSlide();
content.addText('Week-4 retention', { x: 0.8, y: 0.6, w: 11.5, h: 0.9, fontFace: 'Arial', fontSize: 36, bold: true, color: '1E2761' });
await pres.writeFile({ fileName: OUTPUT });`;
const authored = value(await executeOfficeTool({ action: 'author', path: join(dir, 'd.pptx'), script, mode: 'portable', render: false, audit: false }, { cwd }));
const snap = value(await executeOfficeTool({ action: 'snapshot', session: authored.session }, { cwd }));
for (const slide of snap.document.slides) console.log(slide.index, JSON.stringify(slide.background), slide.shapes.map((s) => `${s.text?.slice(0, 12)}:${s.font?.color}`).join(' | '));
await executeOfficeTool({ action: 'close', session: authored.session }, { cwd });
