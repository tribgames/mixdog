// Regenerates titles.json: the desktop's own generatedSessionTitle / normalizeSessionTitle
// applied to every title and name of the electron-profile corpus plus curated cases.
//
//   node generate.mjs <mixdog repo root> <migration-corpus root> > titles.json
//
// Expected values come from the Node functions the desktop runs, never from the Rust port.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, corpus] = process.argv.slice(2);
const { generatedSessionTitle, normalizeSessionTitle } = await import(
  pathToFileURL(join(repo, 'apps/desktop/src/shared/session-title.mjs')).href
);

const metadata = JSON.parse(readFileSync(join(corpus, 'electron-profile/desktop-session-metadata.json'), 'utf8'));
const fromCorpus = [...Object.values(metadata.titles ?? {}), ...Object.values(metadata.names ?? {})];

const curated = [
  '',
  '   ',
  'hello',
  '  hello \n world  ',
  'alpha beta gamma delta epsilon zeta eta theta iota',
  'x'.repeat(120),
  'word '.repeat(40),
  '한글 제목이 아주 길어지면 어떻게 잘리는지 확인하는 긴 문장입니다 정말로 길어요',
  '😀'.repeat(40),
  'a😀 b😀 c😀 d😀 e😀 f😀 g😀 h😀 i😀 j😀',
  '[mixdog-runtime] restarted',
  '[truncated]',
  '[Request interrupted by user for tool use]',
  'A previous model worked on this task and produced the compacted handoff summary below',
  'Re-attached after compaction: files',
  'Reference files: a.txt',
  'The async agent task finished',
  '# Permission request',
  'permission: granted',
  'cwd: /work',
  '<system-reminder>only</system-reminder>',
  'before <system-reminder>x</system-reminder> after',
  'before <skill name="a">body</skill> after </event> tail',
  'cut <system-reminder>never closed',
  'user typed <event> as prose',
  '# Session\nCwd: /w\nModel: m\nWorkflow: w\n\nfix the build',
  '# Session Cwd: /w Model: m Workflow: w do the thing',
  '# Session Cwd: /w do the thing',
  '[Image: shot.png 800x600]',
  '[Image: just a note]',
  '[Video source: a.mp4]',
  '[Video: 12s duration 00:12]',
  '[Image #3]',
  '[Image #3: a.png]',
  'look [Image #2: a.png] at this',
  '[PDF #1: report.pdf]',
  '[File #2: notes.md] [File #3: b.md]',
  '[Pasted text #1 +20 lines] explain this',
  '<file name="a">content</file> read it',
  'shot.png 800x600, displayed at 400x300 fix the layout',
  'clip.mp4 1280x720 …',
  'photo.jpg 10x10',
  '확인 [2026-07-01 10:20] quoted text that is long… 이거 고쳐줘',
  '[2026-07-01 10:20] 안녕',
  '[2026-07-01 10:20] quote... 그거 해줘',
  '[2026-07-01 10:20] only a quote…',
  '!!!',
  '...',
  '12345',
  'ÿ',
  'Reference files: x\nreal text',
];

const inputs = [...new Set([...fromCorpus, ...curated])];
const out = inputs.map((input) => ({
  input,
  generated: generatedSessionTitle(input, ''),
  name: normalizeSessionTitle(input, ''),
}));
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
