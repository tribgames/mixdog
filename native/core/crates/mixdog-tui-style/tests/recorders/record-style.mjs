// Records the Node golden for the Rust crate mixdog-tui-style, and generates src/palette.rs from the
// theme modules. Read-only on the tree it is pointed at.
//
//   node record-style.mjs --tree C:/Project/mixdog --out    <golden.json>     record the golden
//   node record-style.mjs --tree C:/Project/mixdog --check  <golden.json>     compare a fresh recording with it
//                                                                             (and src/palette.rs with the generator)
//   node record-style.mjs --tree C:/Project/mixdog --emit-palette <palette.rs> write the generated palette module
//
// What is recorded: every palette, the list order and aliases, set-theme results (for every id, alias and
// invalid ones) with the OSC 11 text they write, the statusline colour helpers under each environment
// (a child process per environment: the module reads it at import), rgbToAnsi256 over a 52x52x52 grid and the
// channel edges, the statusline bridge over recorded footer strings under all 15 themes, spinner meta and
// verbs, the time formatters, chalk's supports-color over an environment matrix and what Ink's colorize
// writes at chalk levels 0-3 (one child per level).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

// ---------------------------------------------------------------------------------------------------------------
// Child processes: each reads {tree, ...} from stdin, prints one JSON document.
// ---------------------------------------------------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const importFrom = (tree, path) => import(pathToFileURL(join(tree, path)).href);

async function workerSupports(input) {
  process.argv = [process.argv[0], process.argv[1], ...input.argv];
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, input.env);
  Object.defineProperty(process, 'platform', { value: input.platform });
  const os = (await import('node:os')).default;
  os.release = () => input.release;
  const mod = await importFrom(input.tree, 'node_modules/chalk/source/vendor/supports-color/index.js');
  const found = mod.createSupportsColor({ isTTY: input.tty });
  return found ? found.level : 0;
}

async function workerInk(input) {
  // FORCE_COLOR=1 or 2 reaches the level only off Windows (there the build number decides), so the child runs as Linux.
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const { default: colorize } = await importFrom(input.tree, 'node_modules/ink/build/colorize.js');
  const chalk = (await importFrom(input.tree, 'node_modules/chalk/source/index.js')).default;
  const out = { level: chalk.level, painted: [] };
  for (const [text, color, type] of input.cases) {
    out.painted.push(colorize(text, color, type));
  }
  return out;
}

async function workerAnsi(input) {
  const ansi = await importFrom(input.tree, 'src/runtime/shared/statusline/ansi.mjs');
  const samples = ['x', '', 'a\x1b[0mb', 'two\nlines', '\x1b[1mbold\x1b[0m tail'];
  const out = { enabled: ansi.colorEnabled(), styles: {}, rgb: [], sgr: [] };
  const names = [
    'bold', 'dim', 'italic', 'underline', 'inverse', 'strike', 'black', 'red', 'green', 'yellow', 'blue',
    'magenta', 'cyan', 'white', 'gray', 'grey', 'brightGreen',
  ];
  for (const name of names) out.styles[name] = samples.map((s) => ansi[name](s));
  for (const [r, g, b] of [[215, 119, 87], [0, 0, 0], [255, 255, 255], [1.5, 2.25, 3], [-4, 300, 7], [128, 128, 128]]) {
    out.rgb.push({ args: [r, g, b], painted: samples.map((s) => ansi.rgb(r, g, b)(s)) });
  }
  for (const [r, g, b] of [[215, 119, 87], [0, 0, 0], [3, 3, 3], [1.5, 2.25, 3], [-4, 300, 7], [255, 255, 255], ['12', '34', '56']]) {
    out.sgr.push({ args: [r, g, b], fg: ansi.rgbSgr(r, g, b), bg: ansi.rgbSgr(r, g, b, true) });
  }
  out.strip = samples.map((s) => ansi.stripAnsi(s));
  out.width = samples.concat(['\x1b[38;2;1;2;3m한국\x1b[0m', '😀x']).map((s) => ansi.visibleWidth(s));
  out.compose = samples.map((s) => ansi.compose(ansi.bold, ansi.red)(s));
  out.composeNone = samples.map((s) => ansi.compose()(s));
  return out;
}

if (process.argv.includes('--worker')) {
  const kind = process.argv[process.argv.indexOf('--worker') + 1];
  const input = await readStdin();
  const run = { supports: workerSupports, ink: workerInk, ansi: workerAnsi }[kind];
  process.stdout.write(JSON.stringify(await run(input)));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------
// Parent.
// ---------------------------------------------------------------------------------------------------------------

const tree = resolve(option('--tree') || 'C:/Project/mixdog');

function child(kind, input, env) {
  const base = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ...env };
  for (const key of Object.keys(base)) if (base[key] === undefined) delete base[key];
  const run = spawnSync(process.execPath, [self, '--worker', kind], {
    input: JSON.stringify({ tree, ...input }),
    env: base,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`worker ${kind} failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

const themes = await importFrom(tree, 'src/tui/themes/index.mjs');
const themeRuntime = await importFrom(tree, 'src/tui/theme.mjs');
const figures = await importFrom(tree, 'src/tui/figures.mjs');
const bridge = await importFrom(tree, 'src/tui/statusline-ansi-bridge.mjs');
const meta = await importFrom(tree, 'src/tui/spinner-meta.mjs');
const verbs = await importFrom(tree, 'src/tui/spinner-verbs.mjs');
const timeFormat = await importFrom(tree, 'src/tui/time-format.mjs');
const ansiMod = await importFrom(tree, 'src/runtime/shared/statusline/ansi.mjs');

// ---- palettes ----------------------------------------------------------------------------------------------------

const RGB = /^rgb\((\d+),(\d+),(\d+)\)$/;
const keys = Object.keys(themes.basePalette);
const ids = themes.THEME_ORDER.filter((id) => themes.THEME_REGISTRY[id]);
if (JSON.stringify(Object.keys(themes.THEME_REGISTRY)) !== JSON.stringify(ids)) {
  throw new Error('the registry order and THEME_ORDER differ: palette.rs assumes one order');
}
const parseColor = (value) => {
  if (value === 'transparent') return 'transparent';
  const m = RGB.exec(value);
  if (!m || m.slice(1).some((n) => Number(n) > 255)) throw new Error(`palette value outside Rgb/Transparent: ${value}`);
  return value;
};
const paletteOf = (palette) => {
  if (JSON.stringify(Object.keys(palette)) !== JSON.stringify(keys)) throw new Error('a palette key set differs from the base');
  return keys.map((key) => parseColor(palette[key]));
};
const palettes = {
  keys,
  base: paletteOf(themes.basePalette),
  themes: ids.map((id) => {
    const entry = themes.THEME_REGISTRY[id];
    if (entry.id !== id) throw new Error(`registry id ${id} differs from its entry id`);
    return { id, label: entry.label, description: entry.description, palette: paletteOf(entry.palette) };
  }),
  order: themes.THEME_ORDER,
  aliases: themes.THEME_ALIASES,
  defaultId: themes.DEFAULT_THEME_ID,
  basicIsDefaultSeed: JSON.stringify(paletteOf(themes.basicPalette)) === JSON.stringify(paletteOf(themes.THEME_REGISTRY.basic.palette)),
};

// ---- theme runtime -----------------------------------------------------------------------------------------------

function capturedWrite(run) {
  const real = process.stdout.write.bind(process.stdout);
  const wasTty = process.stdout.isTTY;
  let written = '';
  process.stdout.isTTY = true;
  process.stdout.write = (chunk) => {
    written += String(chunk);
    return true;
  };
  try {
    run();
  } finally {
    process.stdout.write = real;
    process.stdout.isTTY = wasTty;
  }
  return written;
}

const themeIds = [
  ...ids, 'basicIndigo', '', ' ', '  nord  ', ' basicIndigo ', 'Nord', 'NORD', 'unknown', 'light\n', '\tdracula', '\u00a0teal\u00a0',
  'basic ', 'ONEDARK', 'tokyo night', 'null', 'undefined',
];
const setTheme = [];
let lastVersion = themeRuntime.getThemeVersion();
const initial = {
  id: themeRuntime.getThemeSetting(),
  version: lastVersion,
  list: themeRuntime.listThemes(),
  theme: paletteOf(themeRuntime.theme),
};
for (const id of themeIds) {
  let result;
  const osc = capturedWrite(() => {
    result = themeRuntime.setThemeSetting(id, { persist: false });
  });
  const version = themeRuntime.getThemeVersion();
  setTheme.push({
    input: id,
    result,
    osc,
    versionDelta: version - lastVersion,
    active: themeRuntime.getThemeSetting(),
    list: themeRuntime.listThemes().filter((row) => row.current).map((row) => row.id),
    theme: paletteOf(themeRuntime.theme),
  });
  lastVersion = version;
}
themeRuntime.setThemeSetting('basic', { persist: false });
const oscInputs = [
  'rgb(1,2,3)', 'rgb( 1, 2, 3 )', 'rgb(255,255,255)', 'rgb(300,2,3)', 'transparent', '', 'rgb(1,2,3,4)', 'rgb(1,2)', 'RGB(1,2,3)',
  '  rgb(0,0,0)  ', 'rgb(10,20,30)extra', '#ffffff', 'rgb(-1,2,3)',
];
const background = oscInputs.map((input) => ({
  input,
  osc: capturedWrite(() => themeRuntime.emitTerminalBackground(input)),
}));
const glyphs = {
  turnMarker: themeRuntime.TURN_MARKER,
  agentCall: themeRuntime.AGENT_CALL_MARKER,
  agentResponse: themeRuntime.AGENT_RESPONSE_MARKER,
  resultGutter: themeRuntime.RESULT_GUTTER,
  resultGutterCont: themeRuntime.RESULT_GUTTER_CONT,
  figures: Object.fromEntries(Object.entries(figures)),
  platform: process.platform,
};

// ---- rgbToAnsi256 ------------------------------------------------------------------------------------------------

const GRID = Array.from({ length: 52 }, (_, i) => i * 5); // 0,5,...,255
let gridHex = '';
for (const r of GRID) for (const g of GRID) for (const b of GRID) gridHex += ansiMod.rgbToAnsi256(r, g, b).toString(16).padStart(2, '0');
const EDGE_TAGS = [-1000, -1, 0, 0.4, 0.5, 1, 7, 7.5, 8, 8.4999, 127.5, 128, 254.5, 255, 255.4, 255.5, 256, 1e9, 'NaN', 'Infinity', '-Infinity'];
const edgeValue = (tag) => (tag === 'NaN' ? NaN : tag === 'Infinity' ? Infinity : tag === '-Infinity' ? -Infinity : tag);
const edges = [];
for (const r of EDGE_TAGS) for (const g of EDGE_TAGS) for (const b of EDGE_TAGS) {
  edges.push([r, g, b, ansiMod.rgbToAnsi256(edgeValue(r), edgeValue(g), edgeValue(b))]);
}
const ansi256 = { gridStep: 5, gridCount: 52, gridHex, edges };

// ---- statusline helpers under each environment -------------------------------------------------------------------

const ansiEnvironments = [
  { name: 'forced', env: { FORCE_COLOR: '1' } },
  { name: 'forced-apple-terminal', env: { FORCE_COLOR: '1', TERM_PROGRAM: 'Apple_Terminal' } },
  { name: 'forced-apple-terminal-padded', env: { FORCE_COLOR: '1', TERM_PROGRAM: '  apple_TERMINAL ' } },
  { name: 'forced-other-terminal', env: { FORCE_COLOR: '1', TERM_PROGRAM: 'vscode' } },
  { name: 'no-color', env: { NO_COLOR: '1', FORCE_COLOR: '1' } },
  { name: 'no-color-empty-is-ignored', env: { NO_COLOR: '', FORCE_COLOR: '1' } },
  { name: 'force-zero', env: { FORCE_COLOR: '0' } },
  { name: 'force-empty', env: { FORCE_COLOR: '' } },
  { name: 'force-two', env: { FORCE_COLOR: '2' } },
  { name: 'piped', env: {} },
];
const ansiCases = ansiEnvironments.map((c) => ({ ...c, recorded: child('ansi', {}, c.env) }));

// ---- supports-color matrix ---------------------------------------------------------------------------------------

const supportsCases = [];
const addSupport = (c) => supportsCases.push({ env: {}, argv: [], platform: 'linux', release: '6.1.0', tty: true, ...c });
addSupport({ tty: false });
addSupport({});
addSupport({ env: { TERM: 'dumb' } });
addSupport({ env: { TERM: 'dumb', FORCE_COLOR: '2' } });
addSupport({ env: { TERM: 'dumb', FORCE_COLOR: '1' }, tty: false });
for (const value of ['', '0', '1', '2', '3', '4', '9', 'true', 'false', 'abc', '-1', '2x', ' 3', '0x2', '1.9', 'TRUE']) {
  for (const tty of [true, false]) addSupport({ env: { FORCE_COLOR: value }, tty });
  addSupport({ env: { FORCE_COLOR: value, TERM: 'xterm-256color' } });
  addSupport({ env: { FORCE_COLOR: value, TERM: 'dumb' } });
}
for (const flag of [
  '--color', '--colors', '--no-color', '--no-colors', '--color=false', '--color=never', '--color=true', '--color=always',
  '--color=16m', '--color=full', '--color=truecolor', '--color=256', '--color=1', '--colour',
]) {
  for (const tty of [true, false]) addSupport({ argv: [flag], tty });
  addSupport({ argv: [flag], env: { TERM: 'xterm' } });
  addSupport({ argv: [flag], env: { FORCE_COLOR: '2' } });
  addSupport({ argv: [flag, '--color=256'] });
  addSupport({ argv: ['--', flag], tty: true, env: { TERM: 'xterm' } });
  addSupport({ argv: [flag, '--'], tty: true, env: { TERM: 'xterm' } });
}
addSupport({ env: { TF_BUILD: 'True', AGENT_NAME: 'a' }, tty: false });
addSupport({ env: { TF_BUILD: 'True' }, tty: false });
addSupport({ env: { TF_BUILD: 'True' }, tty: true });
addSupport({ env: { TF_BUILD: 'True', AGENT_NAME: 'a', FORCE_COLOR: '0' } });
for (const ci of ['GITHUB_ACTIONS', 'GITEA_ACTIONS', 'CIRCLECI', 'TRAVIS', 'APPVEYOR', 'GITLAB_CI', 'BUILDKITE', 'DRONE']) {
  addSupport({ env: { CI: 'true', [ci]: '1' } });
  addSupport({ env: { CI: 'true', [ci]: '1', TERM: 'xterm-256color' } });
  addSupport({ env: { [ci]: '1', TERM: 'xterm-256color' } });
}
addSupport({ env: { CI: '1', CI_NAME: 'codeship' } });
addSupport({ env: { CI: '1', CI_NAME: 'other' } });
addSupport({ env: { CI: '1' } });
addSupport({ env: { CI: '1', FORCE_COLOR: '2' } });
addSupport({ env: { CI: '', COLORTERM: 'truecolor' } });
for (const v of ['9.0.1.', '9.1.', '9.0.0.', '9.00.1.', '8.1.', '10.', '2020.1.', '1.', '9.01.2.', '', '9.', '9.0.', '100.1.2', '9.10.']) {
  addSupport({ env: { TEAMCITY_VERSION: v } });
  addSupport({ env: { TEAMCITY_VERSION: v, COLORTERM: 'truecolor' } });
}
for (const v of ['truecolor', '24bit', '1', '', 'yes']) {
  addSupport({ env: { COLORTERM: v } });
  addSupport({ env: { COLORTERM: v, TERM: 'xterm' } });
  addSupport({ env: { COLORTERM: v, TERM: 'xterm-256color' } });
}
for (const term of ['xterm-kitty', 'xterm-ghostty', 'wezterm']) addSupport({ env: { TERM: term } });
for (const program of ['iTerm.app', 'Apple_Terminal', 'vscode', 'WezTerm', 'iterm.app']) {
  for (const version of [undefined, '2.9', '3.0.1', '3', '10.1', '', 'abc', '-3']) {
    const env = { TERM_PROGRAM: program };
    if (version !== undefined) env.TERM_PROGRAM_VERSION = version;
    addSupport({ env });
    addSupport({ env: { ...env, TERM: 'xterm-256color' } });
  }
}
for (const term of [
  'xterm-256color', 'screen-256color', 'XTERM-256COLOR', 'rxvt-256color', 'foo-256', 'foo-256color', 'foo-256colorx', 'linux', 'ansi',
  'cygwin', 'vt100', 'vt220', 'vt102', 'rxvt-unicode', 'xterm', 'screen', 'myterm-color', 'COLOR', 'tmux', 'tmux-256color', 'weird',
  'alacritty', 'Eterm', 'konsole', '',
]) {
  addSupport({ env: { TERM: term } });
  addSupport({ env: { TERM: term }, tty: false });
}
for (const release of ['10.0.26300', '10.0.14931', '10.0.14930', '10.0.10586', '10.0.10585', '6.3.9600', '10.0', '11.0.20000', '10.0.abc', '9.0.99999', '10.1.14931']) {
  addSupport({ platform: 'win32', release });
  addSupport({ platform: 'win32', release, tty: false });
  addSupport({ platform: 'win32', release, env: { TERM: 'dumb' } });
  addSupport({ platform: 'win32', release, env: { FORCE_COLOR: '2' } });
  addSupport({ platform: 'win32', release, env: { FORCE_COLOR: '0' } });
  addSupport({ platform: 'win32', release, env: { CI: '1', GITHUB_ACTIONS: '1' } });
  addSupport({ platform: 'win32', release, argv: ['--color=256'] });
}
addSupport({ platform: 'darwin', env: { TERM: 'xterm-256color' } });
addSupport({ platform: 'darwin', env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.4.0' } });
for (const c of supportsCases) {
  c.level = child('supports', c, {});
}

// ---- Ink colorize at chalk levels ---------------------------------------------------------------------------------

const probes = [];
const addProbe = (text, color, type) => probes.push([text, color, type]);
const CHANNELS = [0, 1, 7, 8, 9, 47, 48, 100, 127, 128, 200, 247, 248, 249, 254, 255];
const colorTexts = ['x', '', 'two\nlines', 'cr\r\nlf', 'a\x1b[39mb', 'a\x1b[49mb', '\x1b[1mbold\x1b[22m'];
const colors = [
  '#ff8800', '#f80', '#FF8800', '#GGGGGG', '#abcdefg', '#12', '#', '#xyz123', '#1234', '#12345', '#0', '#000000', '#ffffff',
  'rgb(97,175,239)', 'rgb( 1, 2, 3 )', 'rgb(1,2,3', 'rgb(1, 2,3)', 'rgb(1,  2,3)', 'rgb(300,2,3)', 'rgb(0,0,0)', 'rgb(255,255,255)',
  'rgb(128,128,128)', 'rgb(1,2)', 'rgb()', 'rgba(1,2,3,4)', 'RGB(1,2,3)',
  'ansi256(200)', 'ansi256( 5 )', 'ansi256(0)', 'ansi256(255)', 'ansi256(300)', 'ansi256(x)', 'ansi256', 'ansi256(1',
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'black', 'gray', 'grey', 'blackBright', 'redBright', 'greenBright',
  'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
  'transparent', 'orange', 'Red', '', 'notacolor', 'rgb', '#',
];
for (const color of colors) for (const type of ['foreground', 'background']) addProbe('x', color, type);
for (const text of colorTexts) {
  for (const color of ['#ff8800', 'rgb(1,2,3)', 'ansi256(7)', 'red']) {
    for (const type of ['foreground', 'background']) addProbe(text, color, type);
  }
}
for (const name of ['bold', 'dim', 'italic', 'underline', 'overline', 'inverse', 'hidden', 'strikethrough', 'reset', 'visible']) {
  addProbe('x', name, 'foreground');
  addProbe('', name, 'foreground');
}
const gridStart = probes.length;
for (const r of CHANNELS) for (const g of CHANNELS) for (const b of CHANNELS) addProbe('x', `rgb(${r},${g},${b})`, 'foreground');
const inkLevels = [0, 1, 2, 3].map((level) => ({
  level,
  recorded: child('ink', { cases: probes }, { FORCE_COLOR: String(level) }),
}));
const ink = {
  probes: probes.slice(0, gridStart),
  grid: { channels: CHANNELS, start: gridStart },
  levels: inkLevels.map((row) => ({
    level: row.level,
    chalkLevel: row.recorded.level,
    painted: row.recorded.painted.slice(0, gridStart),
    gridPainted: row.recorded.painted.slice(gridStart),
  })),
};

// ---- bridge --------------------------------------------------------------------------------------------------------

const RESET = '\x1b[0m';
const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const fg256 = (r, g, b) => `\x1b[38;5;${ansiMod.rgbToAnsi256(r, g, b)}m`;
const CANON = {
  statusText: [198, 198, 198], subtle: [136, 136, 136], success: [0, 170, 75], successBright: [0, 185, 88],
  warning: [255, 193, 7], warningBright: [255, 210, 80], error: [220, 70, 88],
};
const footers = [
  '',
  'plain text',
  `${fg(...CANON.statusText)}model${RESET} ${fg(...CANON.subtle)}│${RESET} ${fg(...CANON.success)}ok${RESET}`,
  `${fg256(...CANON.statusText)}model${RESET} ${fg256(...CANON.subtle)}│${RESET} ${fg256(...CANON.error)}err${RESET}`,
  `${fg(...CANON.successBright)}up${RESET} ${fg(...CANON.warningBright)}warn${RESET} ${fg(...CANON.warning)}w${RESET} ${fg(...CANON.error)}e${RESET}`,
  `${fg256(...CANON.successBright)}up${RESET} ${fg256(...CANON.warningBright)}warn${RESET}`,
  `\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m \x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m \x1b[33myellow\x1b[0m \x1b[36mcyan\x1b[0m \x1b[90mgrey\x1b[0m`,
  `◆ ${fg(...CANON.statusText)}Mixdog${RESET}`,
  `${fg(...CANON.statusText)}◆${RESET} Mixdog`,
  `\x1b[1m\x1b[2m◆\x1b[0m   spaced`,
  `◆\u00a0nbsp`,
  `◆`,
  `x◆ not leading`,
  `ctx ${RESET} 45% used ${RESET} 100% ${RESET} 7.5%${RESET} 12.5% x`,
  `ctx ${RESET} 45%`,
  `${RESET} 45%x ${RESET} 100`,
  `${fg(...CANON.subtle)}Credit${RESET} $1.23`,
  `${fg(...CANON.subtle)}Credit${RESET}   $1.23 ${fg(...CANON.subtle)}used${RESET}\x1b[31m/limit`,
  `${fg(...CANON.subtle)}Credit${RESET}\x1b[1mbold`,
  `${RESET}${RESET} x${RESET}`,
  `a ${fg(...CANON.subtle)}│${RESET} b ${fg(...CANON.subtle)}│${RESET} c`,
  `a${RESET} ${fg(...CANON.subtle)}│${RESET} b`,
  `trailing newlines\n\n`,
  `middle\nnewline\n`,
  `${fg(...CANON.statusText)}L1${RESET}\n${fg(...CANON.success)}L2${RESET}\n`,
  `${fg(...CANON.statusText)}한글 모델${RESET} ${fg(...CANON.subtle)}│${RESET} 😀`,
];
const colorOfTheme = (rgb) => {
  const m = RGB.exec(String(rgb || '').replace(/\s+/g, ''));
  return m ? fg(m[1], m[2], m[3]) : undefined;
};
const bridgeCases = [];
for (const id of ids) {
  themeRuntime.setThemeSetting(id, { persist: false });
  const t = themeRuntime.theme;
  const colors = {
    STATUS: colorOfTheme(t.statusText) ?? fg(198, 198, 198),
    SUBTLE: colorOfTheme(t.statusSubtle) ?? fg(136, 136, 136),
    SUCCESS: colorOfTheme(t.success) ?? fg(0, 170, 75),
    WARNING: colorOfTheme(t.warning) ?? fg(255, 193, 7),
    ERROR: colorOfTheme(t.error) ?? fg(220, 70, 88),
  };
  bridgeCases.push({
    theme: id,
    colors,
    normalized: footers.map((text) => bridge.normalizeStatuslineAnsi(text, colors)),
    customReset: footers.slice(0, 20).map((text) => bridge.normalizeStatuslineAnsi(text, colors, { reset: '\x1b[0;0m' })),
  });
}
themeRuntime.setThemeSetting('basic', { persist: false });
const identityArgs = (over = {}) => ({
  sessionId: 's1', provider: 'p', model: 'm', effort: 'high', fast: false, ultra: false, contextWindow: 200000,
  rawContextWindow: 200000, displayContextWindow: 200000, compactBoundaryTokens: 1, autoCompactTokenLimit: 2,
  stats: { currentContextTokens: 5, currentEstimatedContextTokens: 5, inputTokens: 5, latestInputTokens: 5, promptTokens: 5, turns: 2 },
  agentRevision: 1,
  ...over,
});
const resetStats = { currentContextTokens: 0, currentEstimatedContextTokens: 0, inputTokens: 0, latestInputTokens: 0, promptTokens: 0, turns: 0 };
const identityPairs = [
  [null, null], [undefined, identityArgs()], [identityArgs(), null], [identityArgs(), undefined], [identityArgs(), identityArgs()],
  [identityArgs({ sessionId: 's2' }), identityArgs()], [identityArgs({ provider: 'q' }), identityArgs()],
  [identityArgs({ model: 'n' }), identityArgs()], [identityArgs({ effort: 'low' }), identityArgs()],
  [identityArgs({ fast: true }), identityArgs()], [identityArgs({ ultra: true }), identityArgs()],
  [identityArgs({ contextWindow: 1 }), identityArgs()], [identityArgs({ rawContextWindow: 1 }), identityArgs()],
  [identityArgs({ displayContextWindow: 1 }), identityArgs()], [identityArgs({ compactBoundaryTokens: 9 }), identityArgs()],
  [identityArgs({ autoCompactTokenLimit: 9 }), identityArgs()], [identityArgs({ agentRevision: 2 }), identityArgs()],
  [identityArgs({ stats: resetStats }), identityArgs()], [identityArgs({ stats: resetStats }), identityArgs({ stats: resetStats })],
  [identityArgs(), identityArgs({ stats: resetStats })], [identityArgs({ stats: undefined }), identityArgs()],
  [identityArgs({ stats: null }), identityArgs()], [identityArgs({ stats: { turns: '0' } }), identityArgs()],
  [identityArgs({ stats: { turns: 'x', inputTokens: null } }), identityArgs({ stats: resetStats })],
  [identityArgs({ stats: [] }), identityArgs()], [{ sessionId: 's1' }, { sessionId: 's1' }], [{}, {}], [{}, { model: 'x' }],
  [{ model: 'x' }, {}], [identityArgs({ contextWindow: undefined }), identityArgs({ contextWindow: null })],
  [identityArgs({ effort: '' }), identityArgs({ effort: undefined })], [identityArgs({ stats: { turns: 1 } }), identityArgs({ stats: resetStats })],
  [0, identityArgs()], ['text', identityArgs()], [identityArgs(), 0], [identityArgs(), ''],
].map(([a, b]) => ({ args: a === undefined ? '__undefined__' : a, lastArgs: b === undefined ? '__undefined__' : b, changed: bridge.statuslineFooterIdentityChanged(a, b) }));
const bridgeRecord = { footers, cases: bridgeCases, identity: identityPairs };

// ---- spinner meta ----------------------------------------------------------------------------------------------------

const tokenValues = [
  0, 1, 5, 99, 340, 499.5, 999, 999.4, 999.5, 1000, 1001, 1049, 1050, 1051, 1234, 1250, 1350, 1949, 1950, 9949, 9950, 9999, 10000, 10049,
  10050, 12000, 12345, 99949, 99950, 99999, 100000, 123456, 999499, 999500, 999999, 1000000, 1049999, 1050000, 1500000, 12345678, 999949999,
  999950000, 1000000000, 2500000000, 999949999999, 999950000000, 1e12, 1.5e12, 12345678901234, 1e15, 123456789012345680, 1000.5, 1e21, -5, -2000,
  0.4, 0.5, 1.5,
];
const effortValues = [undefined, '', 'auto', 'Auto', ' AUTO ', 'default', 'off', 'none', 'high', ' High ', 'LOW', 'medium', 'xhigh', 'minimal', 'x'];
const metaCases = [];
const metaPush = (input) => {
  metaCases.push({ input, output: meta.buildSpinnerMeta(input) });
};
for (const outputTokens of tokenValues) metaPush({ outputTokens });
for (const effort of effortValues) {
  metaPush({ thinking: true, effort });
  metaPush({ thinkingSince: 5, effort });
  metaPush({ thinking: false, thinkingSince: 0, thinkingMs: 12400, effort });
}
for (const thinkingMs of [0, 1, 400, 999, 1000, 1499, 1500, 2500, 12400, 59999, 3600000, -5]) metaPush({ thinkingMs });
for (const thinkingSince of [0, -1, 1, 1700000000000]) metaPush({ thinkingSince, thinkingMs: 5000 });
const NOW = 1_700_000_000_000;
for (const quiet of [
  null, {}, { since: 0 }, { since: NOW - 1000 }, { since: NOW - 119999, wait: 'provider' }, { since: NOW - 120000, wait: 'provider' },
  { since: NOW - 125000, wait: 'thinking' }, { since: NOW - 180000, wait: 'model' }, { since: NOW - 240000, wait: 'tool', tool: 'bash' },
  { since: NOW - 240000, wait: 'tool' }, { since: NOW - 240000, wait: 'tool', tool: 7 }, { since: NOW - 300000, wait: 'slot' },
  { since: NOW - 300000, wait: 'cancel' }, { since: NOW - 300000, wait: 'weird' }, { since: NOW - 300000 }, { since: NOW - 300000, wait: '' },
  { since: NOW - 600000, wait: 'provider', warnMs: 300000 }, { since: NOW - 200000, wait: 'provider', warnMs: 300000 },
  { since: NOW - 300000, wait: 'provider', warnMs: 300000 }, { since: NOW - 300000, wait: 'provider', warnMs: 0 },
  { since: NOW - 300000, wait: 'provider', warnMs: -1 }, { since: NOW + 5000, wait: 'provider' }, { since: NOW - 3_600_000, wait: 'tool', tool: 'a b' },
  { since: '1700000000000', wait: 'provider' }, { since: NOW - 130000, wait: 'tool', tool: '' },
]) {
  metaPush({ quiet, now: NOW, outputTokens: 12 });
  metaPush({ quiet, now: NOW, thinking: true, effort: 'high' });
}
metaPush({});
metaPush({ elapsedMs: 5, verbose: true, outputTokens: 3 });
const reducedMotion = [undefined, '', '1', 'true', 'TRUE', ' on ', 'yes', 'YES', '0', 'false', 'off', 'no', 'x', ' 1 ', '\t1\n'].map((value) => ({
  value: value === undefined ? null : value,
  reduced: meta.isReducedMotion(value === undefined ? {} : { MIXDOG_REDUCED_MOTION: value }),
}));
const spinnerMeta = { cases: metaCases, reducedMotion };

// ---- spinner verbs -------------------------------------------------------------------------------------------------------

const starts = [
  0, -5, 1, 1000, 1700000000000, 1700000000500, 1700000001000, 1234567890123, 1_000_000_000_000, 2_500_000_000_000, 4_294_967_296_000,
  8_000_000_000_000, 1e15, 86_400_000, 3 * 86_400_000,
];
const offsets = [
  0, 1, 29999, 30000, 30001, 59999, 60000, 90000, 119999, 120000, 150000, 179999, 180000, 210000, 600000, 3_600_000, 86_400_000,
  4096 * 30000, 4096 * 30000 + 30000, 4097 * 30000, 4100 * 30000, 10_000 * 30000, 200_000 * 30000,
];
const verbCases = [];
for (const startedAt of starts) {
  const row = { startedAt, now: [] };
  for (const offset of offsets) {
    const now = startedAt + offset;
    row.now.push([now, verbs.spinnerVerbFor(startedAt, now)]);
  }
  verbCases.push(row);
}
// A few inputs where `now` is before the start, zero or missing.
const oddVerbs = [
  [1700000000000, 1699999999999], [1700000000000, 0], [0, 1700000000000], [0, 0], [-1, 5000000], [1700000000000.7, 1700000090000.2],
].map(([startedAt, now]) => ({ startedAt, now, verb: verbs.spinnerVerbFor(startedAt, now) }));
const customPools = [
  { pool: ['a', 'b', 'c'], startedAt: 1700000000000, offsets: [0, 30000, 60000, 100000, 400000] },
  { pool: ['only'], startedAt: 5000, offsets: [0, 100000] },
  { pool: [], startedAt: 1700000000000, offsets: [0, 100000] },
].map((c) => ({ ...c, verbs: c.offsets.map((o) => verbs.spinnerVerbFor(c.startedAt, c.startedAt + o, c.pool)) }));
const spinnerVerbs = {
  verbs: verbs.SPINNER_VERBS,
  frames: verbs.SPINNER_FRAMES,
  overrides: verbs.SPINNER_MODE_OVERRIDE_VERBS,
  cases: verbCases,
  odd: oddVerbs,
  customPools,
};

// ---- time format -----------------------------------------------------------------------------------------------------------

const durations = [
  0, 1, 999, 1000, 1999, 59000, 59999, 60000, 61000, 119999, 3_599_999, 3_600_000, 3_601_000, 3_660_000, 3_661_000, 86_399_999, 86_400_000,
  86_460_000, 90_000_000, 93_784_000, 172_800_000, 31_536_000_000, -5, 1.5e3, 12345.678,
];
const optionSets = [{}, { mostSignificantOnly: true }, { hideTrailingZeros: true }, { mostSignificantOnly: true, hideTrailingZeros: true }];
const timeRecord = {
  duration: optionSets.map((options) => ({
    options,
    rows: durations.map((ms) => [ms, timeFormat.formatDuration(ms, options)]),
  })),
  nonFinite: ['NaN', 'Infinity', '-Infinity'].map((tag) => ({
    tag,
    duration: timeFormat.formatDuration(Number(tag === 'NaN' ? NaN : tag === 'Infinity' ? Infinity : -Infinity)),
    elapsed: timeFormat.formatElapsed(Number(tag === 'NaN' ? NaN : tag === 'Infinity' ? Infinity : -Infinity)),
  })),
  elapsed: durations.map((ms) => [ms, timeFormat.formatElapsed(ms)]),
};

// ---- assemble -------------------------------------------------------------------------------------------------------------

const recording = {
  palettes,
  theme: { initial, setTheme, background, glyphs },
  ansi256,
  ansi: ansiCases,
  supportsColor: supportsCases,
  ink,
  bridge: bridgeRecord,
  spinnerMeta,
  spinnerVerbs,
  timeFormat: timeRecord,
};

// ---- palette.rs ---------------------------------------------------------------------------------------------------------

const pascal = (key) => key[0].toUpperCase() + key.slice(1);
const colorRust = (value) => {
  if (value === 'transparent') return 'Color::Transparent';
  const m = RGB.exec(value);
  return `Color::Rgb(${m[1]}, ${m[2]}, ${m[3]})`;
};
const rustString = (text) => JSON.stringify(text).replace(/[\u007f-\uffff]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);
function paletteRs() {
  const out = [];
  out.push('//! The fifteen palettes of the TUI themes (the base and the fourteen registry entries), generated by');
  out.push('//! `tests/recorders/record-style.mjs --emit-palette` from `src/tui/themes/*.mjs` after the registry applied its');
  out.push('//! typography softening. Do not edit by hand: `record-style.mjs --check` fails when this file and the');
  out.push('//! themes differ.');
  out.push('');
  out.push('use crate::theme::{Color, Palette, ThemeEntry};');
  out.push('');
  out.push(`/// How many keys a palette has: every palette carries the whole key set of the base (One Dark).`);
  out.push(`pub const KEY_COUNT: usize = ${keys.length};`);
  out.push('');
  out.push('/// A palette key, in the order of the base palette.');
  out.push('#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]');
  out.push('pub enum Key {');
  for (const key of keys) out.push(`    ${pascal(key)},`);
  out.push('}');
  out.push('');
  out.push('impl Key {');
  out.push('    /// Every key, in palette order.');
  out.push('    pub const ALL: [Key; KEY_COUNT] = [');
  for (const key of keys) out.push(`        Key::${pascal(key)},`);
  out.push('    ];');
  out.push('');
  out.push('    /// The key as the Node palette spells it (`mdDiffAddedBg`).');
  out.push('    pub const fn name(self) -> &\'static str {');
  out.push('        match self {');
  for (const key of keys) out.push(`            Key::${pascal(key)} => "${key}",`);
  out.push('        }');
  out.push('    }');
  out.push('}');
  out.push('');
  const emit = (name, doc, palette) => {
    out.push(`/// ${doc}`);
    out.push(`pub const ${name}: Palette = Palette([`);
    for (const value of palette) out.push(`    ${colorRust(value)},`);
    out.push(']);');
    out.push('');
  };
  emit('BASE', 'One Dark, the full key set every other palette spreads.', palettes.base);
  out.push(`/// The default theme id.`);
  out.push(`pub const DEFAULT_THEME_ID: &str = ${rustString(palettes.defaultId)};`);
  out.push('');
  out.push('/// Ids accepted from older persisted configs, with the id they stand for.');
  out.push(`pub const THEME_ALIASES: [(&str, &str); ${Object.keys(palettes.aliases).length}] = [`);
  for (const [alias, id] of Object.entries(palettes.aliases)) out.push(`    (${rustString(alias)}, ${rustString(id)}),`);
  out.push('];');
  out.push('');
  out.push('/// The registry in display order.');
  out.push(`pub static THEMES: [ThemeEntry; ${palettes.themes.length}] = [`);
  for (const theme of palettes.themes) {
    out.push('    ThemeEntry {');
    out.push(`        id: ${rustString(theme.id)},`);
    out.push(`        label: ${rustString(theme.label)},`);
    out.push(`        description: ${rustString(theme.description)},`);
    out.push('        palette: Palette([');
    for (const value of theme.palette) out.push(`            ${colorRust(value)},`);
    out.push('        ]),');
    out.push('    },');
  }
  out.push('];');
  out.push('');
  return out.join('\n');
}

const rendered = paletteRs();
const goldenText = `${JSON.stringify(recording)}\n`;
const emitPath = option('--emit-palette');
if (emitPath) writeFileSync(emitPath, rendered);
const outPath = option('--out');
if (outPath) writeFileSync(outPath, goldenText);
const checkPath = option('--check');
if (checkPath) {
  const stored = JSON.parse(readFileSync(checkPath, 'utf8'));
  const fresh = JSON.parse(goldenText);
  const bad = Object.keys({ ...stored, ...fresh }).filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(fresh[key]));
  const palettePath = join(dirname(checkPath), '..', '..', 'src', 'palette.rs');
  let paletteStale = false;
  try {
    paletteStale = readFileSync(palettePath, 'utf8') !== rendered;
  } catch {
    paletteStale = true;
  }
  if (bad.length || paletteStale) {
    if (bad.length) console.error(`golden differs in: ${bad.join(', ')}`);
    if (paletteStale) console.error(`${palettePath} differs from the generated palette module`);
    process.exit(1);
  }
  console.log('style golden and palette.rs match the tree');
}
if (!emitPath && !outPath && !checkPath) {
  console.error('pass --out <file>, --check <file> or --emit-palette <file>');
  process.exit(2);
}
