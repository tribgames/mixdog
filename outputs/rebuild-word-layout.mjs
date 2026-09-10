import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { executeOfficeTool } from '../src/runtime/office/index.mjs';
import { docxBodyModel } from '../src/runtime/office/portable/portable-snapshot.mjs';
import { textNodes } from '../src/runtime/office/portable/portable-xml.mjs';

const cwd = process.cwd();
const output = 'outputs/아무것도_하지_않는_시간의_쓸모_개선본.docx';
const receipt = 'outputs/word-layout-review.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const call = async (args) => {
  const result = await executeOfficeTool(args, { cwd });
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
};
let session;
try {
  if (process.argv[2] === 'native') {
    const opened = await call({
      action: 'open', path: output, mode: 'background',
      output: 'outputs/word-layout-native-check.docx',
    });
    session = opened.session;
    if (opened.backend !== 'microsoft-office-com') throw new Error('Microsoft Word backend unavailable');
    const render = await call({ action: 'render', session, output: 'outputs/word-layout-native-check.pdf' });
    const validation = await call({ action: 'validate', session });
    if (!validation.ok) throw new Error(JSON.stringify(validation));
    console.log(JSON.stringify({
      backend: opened.backend, renderer: render.renderer, pageCount: render.pageCount,
      images: render.images, validation: validation.ok, foregroundActivated: opened.foregroundActivated,
      backgroundIsolation: opened.backgroundIsolation,
    }));
  } else if (process.argv[2] === 'finalize') {
    const baseline = JSON.parse(await readFile(receipt, 'utf8'));
    if (digest(await readFile(output)) !== baseline.fileHash) throw new Error('Document changed after visual review');
    ({ session } = await call({
      action: 'open', path: output,
      output: 'outputs/아무것도_하지_않는_시간의_쓸모_최종.docx', mode: 'portable',
    }));
    const render = await call({ action: 'render', session });
    const hashes = await Promise.all(render.images.map(async (image) => digest(await readFile(image.path))));
    if (JSON.stringify(hashes) !== JSON.stringify(baseline.imageHashes)) throw new Error('Rendered pages changed after visual review');
    const unreviewed = await call({ action: 'finalize', session, review: true });
    if (unreviewed.finalized || unreviewed.reason !== 'visual_review_required') throw new Error('Missing-review gate did not hold the document');
    const critique = JSON.parse(process.argv[3]);
    const result = await call({
      action: 'finalize', session, review: true,
      design: { reviewed: true, reviewToken: render.reviewToken, critique },
    });
    if (!result.finalized) throw new Error(JSON.stringify(result));
    session = null;
    await writeFile('outputs/word-layout-validation.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify({
      path: result.path, finalized: result.finalized, validation: result.validation.ok,
      visualReview: result.review.visualReview, renderer: render.renderer,
    }));
  } else {
    const zip = await JSZip.loadAsync(await readFile('outputs/아무것도_하지_않는_시간의_쓸모.docx'));
    const body = await zip.file('word/document.xml').async('string');
    const paragraphs = docxBodyModel(body).blocks.filter((block) => block.name === 'w:p')
      .map((block) => textNodes(block.xml, 'w:t').map((node) => node.text).join(''));
    const sections = [4, 9, 14, 19].map((index) => ({
      heading: paragraphs[index],
      paragraphs: paragraphs.slice(index + 1, index + 4),
      ...(index === 14 ? { pageBreak: true } : {}),
    }));
    ({ session } = await call({
      action: 'create', path: output, mode: 'portable', overwrite: true,
      operations: [{
        op: 'compose_document', title: paragraphs[0], subtitle: paragraphs[1],
        summary: paragraphs[2], language: 'ko-KR', nameEastAsia: 'Malgun Gothic',
        titleSize: 24, sections, pageNumbers: true,
      }],
    }));
    const render = await call({ action: 'render', session });
    const data = {
      output, renderer: render.renderer, pageCount: render.pageCount, images: render.images,
      fileHash: digest(await readFile(output)),
      imageHashes: await Promise.all(render.images.map(async (image) => digest(await readFile(image.path)))),
    };
    await writeFile(receipt, JSON.stringify(data, null, 2));
    console.log(JSON.stringify(data));
  }
} finally {
  if (session) await call({ action: 'close', session });
}
