#!/usr/bin/env node
// Golden twin of the voice install progress hint: Node's real `toggleVoice` (voice-setup.mjs) with
// only its three imports stubbed (config, plugin paths, the runtime fetcher), driven through scripted
// download-progress events on a scripted clock. Records every `setProgressHint` call (text, tone,
// percent; `''` clears it) and the toggle's answer. Rust `voice::setup` must show the same hints.
//
//   node benchmarks/rust-core/recorders/record-voice-progress.mjs --tree <dir>
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const scratch = mkdtempSync(join(tmpdir(), 'voice-progress-'));
const BASE = 1_700_000_000_000;
const clock = { at: 0 };
Date.now = () => BASE + clock.at;

// The scenario under replay, read by the stubs.
const world = { events: {}, installed: {}, fail: null, voice: {}, writeFail: false, offDuring: false };
globalThis.__voiceWorld = world;
globalThis.__voiceOff = null;

writeFileSync(join(scratch, 'config-stub.mjs'), `
const w = () => globalThis.__voiceWorld;
export const readSection = () => w().voice;
export async function updateSectionAsync(_name, fn) {
  if (w().writeFail) throw new Error('config locked');
  w().voice = fn(w().voice);
}
`);
writeFileSync(join(scratch, 'paths-stub.mjs'), `export const resolvePluginData = () => 'data';\n`);
writeFileSync(join(scratch, 'fetcher-stub.mjs'), `
const w = () => globalThis.__voiceWorld;
const replay = async (key, onProgress) => {
  for (const event of w().events[key] ?? []) {
    globalThis.__voiceClock.at = event.at;
    onProgress?.({ phase: event.phase, downloaded: event.downloaded, total: event.total });
  }
  if (w().fail === key) throw new Error(key + ' download failed');
};
export const selectVoiceModelId = () => 'm';
export const voiceRuntimeInfo = () => ({});
export const resolveVoiceRuntime = () => {
  const i = w().installed;
  return { installed: Boolean(i.whisper && i.model && i.ffmpeg), binary: Boolean(i.whisper), serverCmd: Boolean(i.whisper), model: Boolean(i.model), ffmpeg: Boolean(i.ffmpeg), modelId: 'm', stale: false };
};
export async function ensureWhisperRuntime(_dir, onProgress) { await replay('whisper', onProgress); w().installed.whisper = true; }
export async function ensureWhisperModel(_dir, onProgress) { await replay('model', onProgress); w().installed.model = true; }
export async function ensureFfmpegRuntime(_dir, onProgress) {
  await replay('ffmpeg', onProgress);
  if (w().offDuring) await globalThis.__voiceOff();
  if (!w().incomplete) w().installed.ffmpeg = true;
}
`);
globalThis.__voiceClock = clock;
const source = readFileSync(join(tree, 'src', 'runtime', 'channels', 'lib', 'voice-setup.mjs'), 'utf8')
  .replace(`'../../shared/config.mjs'`, `'./config-stub.mjs'`)
  .replace(`'../../shared/plugin-paths.mjs'`, `'./paths-stub.mjs'`)
  .replace(`'./voice-runtime-fetcher.mjs'`, `'./fetcher-stub.mjs'`);
writeFileSync(join(scratch, 'voice-setup.mjs'), source);
const { toggleVoice } = await import(pathToFileURL(join(scratch, 'voice-setup.mjs')).href);
globalThis.__voiceOff = () => toggleVoice({ enabled: false });

const ev = (phase, at, downloaded, total) => ({ phase, at, downloaded, total });
const SCENARIOS = [
  { name: 'throttle-edges', events: {
    whisper: [ev('runtime', 0, 1, 100), ev('runtime', 499, 2, 100), ev('runtime', 500, 3, 100), ev('runtime', 999, 4, 100), ev('runtime', 1000, 5, 100), ev('extra', 1400, 6, 100), ev('extra', 1500, 7, 100)],
    model: [ev('model', 1501, 8, 100), ev('model', 2000, 9, 100), ev('model', 2499, 10, 100), ev('model', 2500, 11, 100)],
    ffmpeg: [ev('ffmpeg', 2501, 12, 100), ev('ffmpeg', 3000, 13, 100), ev('ffmpeg', 3001, 100, 100)] } },
  { name: 'rounding', events: {
    whisper: [ev('runtime', 0, 1, 8), ev('runtime', 500, 3, 8), ev('runtime', 1000, 100, 1200), ev('runtime', 1500, 1, 12), ev('runtime', 2000, 5, 12)],
    model: [ev('model', 2500, 1, 4), ev('model', 3000, 3, 4), ev('model', 3500, 1, 2), ev('model', 4000, 1, 3), ev('model', 4500, 2, 3)],
    ffmpeg: [ev('ffmpeg', 5000, 7, 40), ev('ffmpeg', 5500, 39, 40), ev('ffmpeg', 6000, 0, 40)] } },
  { name: 'unknown-total-and-clamps', events: {
    whisper: [ev('runtime', 0, 12345, 0), ev('runtime', 500, 5, 0), ev('extra', 1000, 0, 0)],
    model: [ev('model', 1500, 300, 200), ev('model', 2000, 0, 200)],
    ffmpeg: [ev('ffmpeg', 2500, 200, 200), ev('other', 3000, 50, 100)] } },
  { name: 'install-fails', fail: 'model', events: {
    whisper: [ev('runtime', 0, 50, 100)], model: [ev('model', 600, 10, 100)], ffmpeg: [ev('ffmpeg', 1200, 10, 100)] } },
  { name: 'install-incomplete', incomplete: true, events: {
    whisper: [ev('runtime', 0, 50, 100)], model: [], ffmpeg: [ev('ffmpeg', 600, 100, 100)] } },
  { name: 'turned-off-during-install', offDuring: true, events: {
    whisper: [ev('runtime', 0, 50, 100)], model: [ev('model', 700, 20, 100)], ffmpeg: [ev('ffmpeg', 1400, 30, 100)] } },
  { name: 'config-write-fails', writeFail: true, events: {
    whisper: [ev('runtime', 0, 50, 100)], model: [], ffmpeg: [] } },
  { name: 'no-progress-events', events: { whisper: [], model: [], ffmpeg: [] } },
];

const cases = [];
for (const scenario of SCENARIOS) {
  Object.assign(world, { events: scenario.events, installed: {}, fail: scenario.fail ?? null, voice: {}, writeFail: Boolean(scenario.writeFail), offDuring: Boolean(scenario.offDuring), incomplete: Boolean(scenario.incomplete) });
  clock.at = 0;
  const hints = [];
  const notices = [];
  const result = await toggleVoice({
    enabled: true,
    pushNotice: (text, level) => notices.push([text, level]),
    setProgressHint: (...args) => hints.push(args.map((a) => (a === undefined ? null : a))),
  });
  cases.push({ name: scenario.name, events: scenario.events, fail: scenario.fail ?? null, incomplete: Boolean(scenario.incomplete), offDuring: Boolean(scenario.offDuring), writeFail: Boolean(scenario.writeFail), hints, result: result ?? null });
}
// The setup path passes no hint line: progress goes nowhere (media-api.mjs).
{
  Object.assign(world, { events: SCENARIOS[0].events, installed: {}, fail: null, voice: {}, writeFail: false, offDuring: false, incomplete: false });
  clock.at = 0;
  const notices = [];
  const result = await toggleVoice({ enabled: true, pushNotice: (text, level) => notices.push([text, level]) });
  cases.push({ name: 'setup-path-without-hint-line', events: SCENARIOS[0].events, fail: null, incomplete: false, offDuring: false, writeFail: false, hints: [], noticeCount: notices.filter(([, level]) => level === 'info').length > 0, result: result ?? null });
}

writeJson(join(FIXTURES_ROOT, 'services', 'voice-progress-twin.json'), { domain: 'voice-progress-twin', recorder: 'benchmarks/rust-core/recorders/record-voice-progress.mjs', cases });
rmSync(scratch, { recursive: true, force: true });
console.log(`recorded ${cases.length} scenarios`);
process.exit(0);