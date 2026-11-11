#!/usr/bin/env node
// Recording of computer-bridge/capture-size.test.mjs (b6f10295a): computerCaptureSize for the screen sizes the test fits and the
// geometry error, and whether the Anthropic image preparation (prepareAnthropicImages) rescales an already bound computer frame.
// The frame is a real jpeg made by sharp from the fitted size; only its decoded dimensions are recorded (the bytes are an encoder's).
//
//   node benchmarks/rust-core/recorders/record-capture-size-cases.mjs --tree <export of b6f10295a with node_modules>
import sharp from 'sharp';
import { openSet } from './lib/case-set.mjs';

const set = openSet('capture-size-cases', import.meta.url);
const { computerCaptureSize } = await set.load('src/runtime/computer-bridge/capture-size.mjs');
const { prepareAnthropicImages } = await set.load('src/runtime/agent/orchestrator/providers/lib/anthropic-image-input.mjs');

await set.run('captures fit both encoder budgets before their coordinate frame is registered', () => {
  const screens = [[1275, 2274], [2560, 1440], [3840, 2160], [1080, 3840], [800, 600], [1, 3000], [1280, 720]];
  let geometry;
  try { computerCaptureSize(0, 100); geometry = { returned: true }; } catch (e) { geometry = { name: e?.name ?? null, message: String(e?.message ?? e) }; }
  return { fits: screens.map(([width, height]) => ({ width, height, image: computerCaptureSize(width, height) })), invalidGeometry: { width: 0, height: 100, ...geometry } };
});
await set.run('provider preparation does not rescale an already bound computer frame', async () => {
  const frame = computerCaptureSize(1275, 2274);
  const pixels = await sharp({ create: { ...frame, channels: 3, background: { r: 40, g: 80, b: 120 } } }).jpeg({ quality: 55 }).toBuffer();
  const messages = await prepareAnthropicImages([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pixels.toString('base64') } }] }]);
  const image = messages[0].content.find((part) => part.type === 'image');
  const sent = await sharp(Buffer.from(image.source.data, 'base64')).metadata();
  return { frame, frameImage: '3-channel jpeg quality 55, background rgb(40,80,120)', sentMediaType: image.source.media_type, sent: { width: sent.width, height: sent.height }, partTypes: messages[0].content.map((part) => part.type), hasMultiplyCoordinatesNote: messages[0].content.some((part) => part.type === 'text' && /Multiply coordinates/.test(part.text)) };
});

await set.finish({
  entry: { runs: 'computer-bridge/capture-size.mjs computerCaptureSize; providers/lib/anthropic-image-input.mjs prepareAnthropicImages over a sharp-made jpeg', notRun: 'no capture, no provider call' },
  replay: { entry: 'mixdog-computer capture size fit: compare each fitted size and the geometry error; the provider preparation case compares the sent dimensions and the absence of the rescale note', normalised: {} },
});
process.exit(0);
