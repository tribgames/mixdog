// read tool behaviors: windows, batches, images, and argument absorption.
import './_env.mjs';
import test from 'node:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './_env.mjs';
import { assertOk } from './_helpers.mjs';
import { executeBuiltinTool } from '../../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { readRowsForDisplay } from '../../src/runtime/shared/read-row-numbers.mjs';
import { validateBuiltinArgs } from '../../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';
import { normaliseReadLineWindowArgs } from '../../src/runtime/agent/orchestrator/tools/builtin/read-args.mjs';
import {
  _argShapeSig,
  _isToolArgShapeFailure,
} from '../../src/runtime/agent/orchestrator/session/loop/tool-classify.mjs';
import {
  contentHasImage,
  normalizeContentForAnthropic,
  normalizeContentForGeminiParts,
  normalizeContentForOpenAIChat,
  normalizeContentForOpenAIResponses,
} from '../../src/runtime/agent/orchestrator/providers/media-normalization.mjs';

import { makeTempDirSync } from '../lib/scoped-temp.mjs';
test('read windows and directory rejection', async () => {
  const readOut = await executeBuiltinTool(
    'read',
    {
      path: 'scripts/smoke.mjs',
      offset: 0,
      limit: 4,
    },
    root
  );
  assertOk('read', readOut, /spawnSync/);

  const readDirOut = await executeBuiltinTool(
    'read',
    {
      path: 'scripts',
    },
    root
  );
  if (!/^Error[\s:[]/.test(String(readDirOut)) || !/read expects a file/i.test(String(readDirOut))) {
    throw new Error(`read directory must be classified as Error:\n${readDirOut}`);
  }
});

// Two identical PNGs, a corrupt PNG, a text file and a binary file — the
// operands every batch assertion below reads.
function writeImageBatchFixture(imageBatchTmp) {
  const paths = {
    firstImage: join(imageBatchTmp, 'first.png'),
    secondImage: join(imageBatchTmp, 'second.png'),
    corruptImage: join(imageBatchTmp, 'corrupt.png'),
    textFile: join(imageBatchTmp, 'note.txt'),
    binaryFile: join(imageBatchTmp, 'sample.bin'),
    missingImage: join(imageBatchTmp, 'missing.png'),
  };
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII=',
    'base64'
  );
  writeFileSync(paths.firstImage, onePixelPng);
  writeFileSync(paths.secondImage, onePixelPng);
  writeFileSync(
    paths.corruptImage,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8Y5sAAAAASUVORK5CYII=',
      'base64'
    )
  );
  writeFileSync(paths.textFile, 'batch text body\n', 'utf8');
  writeFileSync(paths.binaryFile, Buffer.from([0x41, 0x00, 0x42, 0x43]));
  return paths;
}

async function assertBinaryHexPreview(binaryFile) {
  const binaryRead = await executeBuiltinTool('read', { path: binaryFile }, root);
  if (!/binary, 4 bytes/.test(String(binaryRead)) || !/41 00 42 43/.test(String(binaryRead))) {
    throw new Error(`binary read must retain async-probe hex preview contract: ${binaryRead}`);
  }
}

async function assertTwoImageBatchVisualBlocks(firstImage, secondImage) {
  const twoImageBatch = await executeBuiltinTool(
    'read',
    {
      path: [firstImage, secondImage],
    },
    root
  );
  const twoImageParts = Array.isArray(twoImageBatch?.content) ? twoImageBatch.content : [];
  const rawImageCount = twoImageParts.filter((part) => part?.type === 'image').length;
  const renderedText = twoImageParts
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
  if (!contentHasImage(twoImageBatch) || rawImageCount !== 2 || /read_hex|89504e47/i.test(renderedText)) {
    throw new Error(
      `read path[] must retain two visual image blocks instead of binary hex: ${JSON.stringify(twoImageBatch)}`
    );
  }
  return twoImageBatch;
}

async function assertCorruptImageRead(corruptImage) {
  const corruptImageRead = await executeBuiltinTool('read', { path: corruptImage }, root);
  const corruptParts = Array.isArray(corruptImageRead?.content) ? corruptImageRead.content : [];
  if (
    corruptImageRead?.isError !== true ||
    corruptParts.some((part) => part?.type === 'image') ||
    !/invalid or corrupt/.test(corruptParts.map((part) => part?.text || '').join('\n'))
  ) {
    throw new Error(`corrupt image must fail locally without an image payload: ${JSON.stringify(corruptImageRead)}`);
  }
}

function assertProviderImageNormalizers(twoImageBatch) {
  const providerImageCounts = {
    anthropic: normalizeContentForAnthropic(twoImageBatch).filter((part) => part?.type === 'image').length,
    openaiChat: normalizeContentForOpenAIChat(twoImageBatch).filter((part) => part?.type === 'image_url').length,
    openaiResponses: normalizeContentForOpenAIResponses(twoImageBatch).filter((part) => part?.type === 'input_image')
      .length,
    gemini: normalizeContentForGeminiParts(twoImageBatch).filter((part) =>
      part?.inlineData?.mimeType?.startsWith('image/')
    ).length,
  };
  if (Object.values(providerImageCounts).some((count) => count !== 2)) {
    throw new Error(
      `read path[] image blocks must survive every provider normalizer: ${JSON.stringify(providerImageCounts)}`
    );
  }
}

async function assertMixedBatchOutcomes(firstImage, textFile, missingImage) {
  const mixedBatch = await executeBuiltinTool(
    'read',
    {
      path: [firstImage, textFile, missingImage, firstImage],
    },
    root
  );
  const mixedParts = Array.isArray(mixedBatch?.content) ? mixedBatch.content : [];
  const mixedText = mixedParts
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
  if (
    mixedParts.filter((part) => part?.type === 'image').length !== 1 ||
    !/batch text body/.test(mixedText) ||
    // A conclusively missing entry is tagged `[absent]`, not `[error]`:
    // absence is the read's answer (absence-absorption.test.mjs), and the
    // entry header must agree with its `[path absent]` body.
    !/missing\.png \[absent\]/.test(mixedText) ||
    !/\[= entry #1, identical result omitted\]/.test(mixedText)
  ) {
    throw new Error(
      `mixed read batch must preserve text, per-entry errors, and rich duplicate elision: ${JSON.stringify(mixedBatch)}`
    );
  }
}

async function assertRejectPartialBatch(firstImage, missingImage) {
  const rejectedMixedBatch = await executeBuiltinTool(
    'read',
    {
      path: [firstImage, missingImage],
      reject_partial: true,
    },
    root
  );
  if (!/^Error: batch read rejected \(1 of 2 failed; reject_partial:true\)/.test(String(rejectedMixedBatch))) {
    throw new Error(`rich read batch reject_partial contract failed: ${rejectedMixedBatch}`);
  }
}

test('read image batches keep visual blocks and per-entry outcomes', async () => {
  const imageBatchTmp = makeTempDirSync('read-image-batch');
  try {
    const { firstImage, secondImage, corruptImage, textFile, binaryFile, missingImage } =
      writeImageBatchFixture(imageBatchTmp);
    await assertBinaryHexPreview(binaryFile);
    const twoImageBatch = await assertTwoImageBatchVisualBlocks(firstImage, secondImage);
    await assertCorruptImageRead(corruptImage);
    assertProviderImageNormalizers(twoImageBatch);
    await assertMixedBatchOutcomes(firstImage, textFile, missingImage);
    await assertRejectPartialBatch(firstImage, missingImage);
  } finally {
    rmSync(imageBatchTmp, { recursive: true, force: true });
  }
});

test('read region batches preserve every requested span', async () => {
  const readRegionBatchOut = await executeBuiltinTool(
    'read',
    {
      path: [
        { path: 'scripts/smoke.mjs', offset: 0, limit: 2 },
        { path: 'scripts/smoke.mjs', offset: 2, limit: 2 },
      ],
    },
    root
  );
  if (
    !/^read 2\b/m.test(String(readRegionBatchOut)) ||
    (String(readRegionBatchOut).match(/scripts\/smoke\.mjs \[ok\]/g) || []).length < 2 ||
    !/1→import \{ spawnSync \}/.test(readRowsForDisplay(String(readRegionBatchOut))) ||
    !/3→import \{ fileURLToPath \}/.test(readRowsForDisplay(String(readRegionBatchOut)))
  ) {
    throw new Error(`read region batch must preserve both requested spans:\n${readRegionBatchOut}`);
  }
});

test('read guard preserves explicit legacy window shapes', async () => {
  const readEchoedPathArgs = {
    path: 'scripts/smoke.mjs',
    offset: '307 ├──path──scripts/smoke.mjs',
    limit: '30usepath?scripts/smoke.mjs',
  };
  const readEchoedPathErr = validateBuiltinArgs('read', readEchoedPathArgs);
  if (readEchoedPathErr || readEchoedPathArgs.offset !== 307 || readEchoedPathArgs.limit !== 30) {
    throw new Error(
      `read guard must absorb exact echoed-path integer annotations: err=${readEchoedPathErr} args=${JSON.stringify(readEchoedPathArgs)}`
    );
  }
  if (
    _argShapeSig('grep', { path: 'a', mode: 'content' }) !== _argShapeSig('grep', { path: 'b', mode: 'files' }) ||
    _argShapeSig('read', { file_path: 'x', offset: 'bad' }) === _argShapeSig('read', { file_path: 'x', offset: 1 }) ||
    !_isToolArgShapeFailure('Error: grep requires pattern (or alias query/regex/needle) or glob.') ||
    _isToolArgShapeFailure('Error: path does not exist: missing')
  ) {
    throw new Error('repeat argument-shape guard classification contract failed');
  }

  // Absorb shape 1: region array + top-level offset/limit → top-level becomes
  // the default window for regions that lack their own; no hard error.
  const readRegionPlusTopLevelArgs = {
    path: [{ path: 'scripts/smoke.mjs', offset: 3, limit: 4 }, { path: 'scripts/smoke.mjs' }],
    offset: 0,
    limit: 2,
  };
  const readRegionPlusTopLevelErr = validateBuiltinArgs('read', readRegionPlusTopLevelArgs);
  if (
    readRegionPlusTopLevelErr ||
    'offset' in readRegionPlusTopLevelArgs ||
    'limit' in readRegionPlusTopLevelArgs ||
    readRegionPlusTopLevelArgs.path[0].offset !== 3 ||
    readRegionPlusTopLevelArgs.path[0].limit !== 4 ||
    readRegionPlusTopLevelArgs.path[1].offset !== 0 ||
    readRegionPlusTopLevelArgs.path[1].limit !== 2
  ) {
    throw new Error(
      `read guard must absorb region-array + top-level offset/limit: err=${readRegionPlusTopLevelErr} args=${JSON.stringify(readRegionPlusTopLevelArgs)}`
    );
  }

  // Absorb shape 2: parallel offset/limit as JSON-stringified arrays with path[]
  // → zipped into per-file region objects (pairwise recovery), no int error.
  const readZipWindowArgs = {
    path: ['scripts/smoke.mjs', 'scripts/smoke.mjs'],
    offset: '[0, 5]',
    limit: '[2, 3]',
  };
  const readZipWindowErr = validateBuiltinArgs('read', readZipWindowArgs);
  if (
    readZipWindowErr ||
    !Array.isArray(readZipWindowArgs.path) ||
    readZipWindowArgs.path[0].offset !== 0 ||
    readZipWindowArgs.path[0].limit !== 2 ||
    readZipWindowArgs.path[1].offset !== 5 ||
    readZipWindowArgs.path[1].limit !== 3 ||
    'offset' in readZipWindowArgs ||
    'limit' in readZipWindowArgs
  ) {
    throw new Error(
      `read guard must zip stringified offset/limit arrays onto path[]: err=${readZipWindowErr} args=${JSON.stringify(readZipWindowArgs)}`
    );
  }
});

test('read legacy line/context and negative-offset absorption', () => {
  const offsetReadWindow = {
    path: 'scripts/smoke.mjs',
    offset: 0,
    limit: 20,
  };
  const readWindowErr = validateBuiltinArgs('read', offsetReadWindow);
  if (readWindowErr) {
    throw new Error(
      `read offset/limit window guard failed: err=${readWindowErr} args=${JSON.stringify(offsetReadWindow)}`
    );
  }
  const readLineArgs = { path: 'scripts/smoke.mjs', line: 10, context: 2 };
  const readLineErr = validateBuiltinArgs('read', readLineArgs);
  if (
    readLineErr ||
    readLineArgs.offset !== 7 ||
    readLineArgs.limit !== 5 ||
    'line' in readLineArgs ||
    'context' in readLineArgs
  ) {
    throw new Error(
      `read guard must losslessly convert top-level legacy line/context args to offset/limit: err=${readLineErr} args=${JSON.stringify(readLineArgs)}`
    );
  }
  const batchedReadLineArgs = { path: [{ path: 'scripts/smoke.mjs', line: 10, context: 2 }] };
  const batchedReadLineErr = validateBuiltinArgs('read', batchedReadLineArgs);
  if (batchedReadLineErr || batchedReadLineArgs.path[0].offset !== 7 || batchedReadLineArgs.path[0].limit !== 5) {
    throw new Error(
      `read guard must losslessly convert batched legacy line/context args to offset/limit: err=${batchedReadLineErr} args=${JSON.stringify(batchedReadLineArgs)}`
    );
  }
  const negativeReadOffsetArgs = { path: 'scripts/smoke.mjs', offset: -80 };
  const negativeReadOffsetErr = validateBuiltinArgs('read', negativeReadOffsetArgs);
  if (
    negativeReadOffsetErr ||
    negativeReadOffsetArgs.mode !== 'tail' ||
    negativeReadOffsetArgs.n !== 80 ||
    'offset' in negativeReadOffsetArgs
  ) {
    throw new Error(
      `read guard must absorb negative offset as tail: err=${negativeReadOffsetErr} args=${JSON.stringify(negativeReadOffsetArgs)}`
    );
  }
  const negativeReadRegionArgs = { path: [{ path: 'scripts/smoke.mjs', offset: -80 }] };
  const negativeReadRegionErr = validateBuiltinArgs('read', negativeReadRegionArgs);
  if (
    negativeReadRegionErr ||
    negativeReadRegionArgs.path[0].mode !== 'tail' ||
    negativeReadRegionArgs.path[0].n !== 80 ||
    'offset' in negativeReadRegionArgs.path[0]
  ) {
    throw new Error(
      `read guard must absorb region negative offset as tail: err=${negativeReadRegionErr} args=${JSON.stringify(negativeReadRegionArgs)}`
    );
  }
  const pathLineWithLimit = normaliseReadLineWindowArgs({ path: 'scripts/smoke.mjs#L10', limit: 5 }, root);
  if (pathLineWithLimit.offset !== 9 || pathLineWithLimit.limit !== 5) {
    throw new Error(
      `read path#line compatibility must anchor offset when limit is explicit: ${JSON.stringify(pathLineWithLimit)}`
    );
  }
});

test('read batch cap counts distinct files and offsets are not capped like limits', async () => {
  const windows = [];
  for (let file = 0; file < 7; file++) {
    windows.push(
      { file_path: `f${file}.txt`, offset: 1, limit: 2 },
      { file_path: `f${file}.txt`, offset: 50, limit: 2 }
    );
  }
  const manyWindowsErr = validateBuiltinArgs('read', { file_path: windows });
  if (manyWindowsErr) throw new Error(`14 windows over 7 files must pass the batch cap: ${manyWindowsErr}`);
  const elevenFiles = Array.from({ length: 11 }, (_, index) => `f${index}.txt`);
  const elevenFilesArgs = { file_path: elevenFiles };
  const elevenFilesErr = validateBuiltinArgs('read', elevenFilesArgs);
  if (elevenFilesErr || elevenFilesArgs.skipped_files?.join() !== 'f10.txt') {
    throw new Error(
      `11 distinct files must keep 10 and skip the 11th: ${elevenFilesErr} ${JSON.stringify(elevenFilesArgs)}`
    );
  }
  const bigLimitErr = validateBuiltinArgs('read', { file_path: 'a.txt', limit: 100001 });
  if (!/limit an integer from 1 to 100000/.test(bigLimitErr || '')) {
    throw new Error(`limit above the window cap must stay rejected: ${bigLimitErr}`);
  }

  const dir = makeTempDirSync('read-deep-offset');
  try {
    const file = join(dir, 'deep.log');
    writeFileSync(file, Array.from({ length: 150_000 }, (_, index) => `line-${index + 1}`).join('\n'));
    const args = { file_path: file, offset: 120_000, limit: 2 };
    const argsErr = validateBuiltinArgs('read', args);
    if (argsErr) throw new Error(`offset past 100000 must pass validation: ${argsErr}`);
    const out = await executeBuiltinTool('read', args, root);
    assertOk('read deep offset', out, /line-120000\s*\n\s*line-120001/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
