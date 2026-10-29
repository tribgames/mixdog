#!/usr/bin/env node
// Read-only inventory of a project's test files across JS/TS, Python, Go and
// Rust: lane, area, risk markers and skip records. Prints Markdown, or JSON
// with --json. Never writes files, never follows links, never runs anything.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  'target',
  'vendor',
  'third_party',
  'venv',
  '.venv',
  'site-packages',
  '__pycache__',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.runtime',
  'coverage',
  '.gradle',
]);
const MAX_FILES = 20_000;
const MAX_DIRS = 50_000;
const MAX_DEPTH = 40;
const MAX_BYTES = 1 << 20;
const LIST_LIMIT = 200;

const JS_EXT = '(?:m?[jt]s|c[jt]s|[jt]sx)';
const JS_TEST = new RegExp(`(?:\\.(?:test|spec)\\.${JS_EXT}|-test\\.m?js)$`);
const JS_FILE = new RegExp(`\\.${JS_EXT}$`);
const TYPES_FILE = /\.d\.[cm]?ts$/;
const RUST_TEST = /#\[\s*(?:cfg\(\s*test\s*\)|test|tokio::test|rstest)\b/;

// `skip: cond && 'reason'` keeps the reason after the last `&&`.
const JS_SKIP_REASON = /\bskip\s*(?::|\()\s*(?:[^\n]*?&&\s*)?(['"`])((?:(?!\1).)*)\1/g;
const JS_SKIP_BARE = /\b(?:(?:it|test|describe)\.skip|x(?:it|test|describe))\b|\.skip\s*\(\s*\)|\bskip\s*:\s*true\b/;
const JS_SKIP_IF = /\.skipIf\s*\(/;
const PY_SKIP =
  /\b(?:pytest\.mark\.(skipif|skip|xfail)|unittest\.(skipIf|skipUnless|skip|expectedFailure)|pytest\.(importorskip|skip))\b/;
const PY_CONDITIONAL = new Set(['skipif', 'skipIf', 'skipUnless', 'importorskip']);
const GO_SKIP = /\.Skip(?:f|Now)?\s*\(/;
const RUST_IGNORE = /#\[\s*ignore\s*(?:=\s*(['"])((?:(?!\1).)*)\1)?\s*(?:\(.*?\))?\s*\]/;
const RUST_CFG_IGNORE = /#\[\s*cfg_attr\([^\]]*\bignore\b/;

const LANGS = {
  js: {
    comment: '//',
    fake: /mock\.timers\.enable|useFakeTimers|installFakeClock|vi\.setSystemTime|jest\.setSystemTime/,
    markers: {
      timer: /\b(setTimeout|setInterval|sleep|delay)\s*\(/,
      spawn: /\b(spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/,
      port: /\.listen\(\s*[1-9]\d{2,4}\b/,
      clock: /Date\.now\(\)|new Date\(\s*\)/,
      'source-text': /readFile(Sync)?\([^)]*\.(m?js|tsx?|jsx)['"`]/,
    },
  },
  python: {
    comment: '#',
    fake: /freezegun|freeze_time|time_machine|time-machine|monkeypatch\.setattr\([^)]*time|mock\.patch\([^)]*time/,
    markers: {
      timer: /\b(?:time|asyncio)\.sleep\(|\bsleep\(/,
      spawn:
        /\bsubprocess\.(?:run|Popen|call|check_output|check_call)\(|\bos\.(?:system|popen)\(|\bmultiprocessing\.Process\(/,
      port: /\.bind\(\s*\([^)]*,\s*[1-9]\d{2,4}\s*\)|\bport\s*=\s*[1-9]\d{3,4}\b/,
      clock: /\bdatetime\.(?:now|utcnow)\(|\bdate\.today\(|\btime\.time\(\)/,
      'source-text': /inspect\.getsource\(|(?:open|Path)\(\s*['"][^'"]*\.(?:py|js|ts)['"]/,
    },
  },
  go: {
    comment: '//',
    fake: /clockwork|benbjohnson\/clock|synctest/,
    markers: {
      timer: /\btime\.(?:Sleep|After|NewTimer|NewTicker|Tick)\(/,
      spawn: /\bexec\.Command(?:Context)?\(/,
      port: /(?:net\.Listen|ListenAndServe)\(\s*(?:"tcp[46]?"\s*,\s*)?"[^"]*:[1-9]\d{2,4}"/,
      clock: /\btime\.Now\(\)/,
      'source-text': /os\.ReadFile\(\s*"[^"]*\.go"|parser\.ParseFile\(/,
    },
  },
  rust: {
    comment: '//',
    fake: /tokio::time::pause|start_paused/,
    markers: {
      timer: /\bsleep\(/,
      spawn: /\b(?:std::)?process::Command\b|\bCommand::new\(/,
      port: /\bbind\(\s*"[^"]*:[1-9]\d{2,4}"/,
      clock: /\b(?:SystemTime|Instant|Utc|Local)::now\(\)/,
      'source-text': /include_str!\([^)]*\.rs"|read_to_string\([^)]*\.rs"/,
    },
  },
};

// A reason naming a missing capability of the host (platform, privilege,
// tool, build) is a capability skip; anything else reads as a defect skip.
const CAPABILITY =
  /\bonly\b|unavailable|unsupported|not (available|permitted|enforced|built|supported|configured|granted|installed)|requires?\b|needs?\b|missing|denied|refused|does not (support|grant|allow)|insensitive|not found|has no|not run on|\bno local\b|\bno display\b|\bposix\b|\bno [\w ]+ (available|configured|is configured|installed)/i;
const TRACKED = /#\d+/;
const UNTIL = /until (\d{4}-\d{2}-\d{2})/;

export function laneOf(file) {
  const tag = /\.(slow|live|electron|e2e|integration)\.(?:test|spec)\./.exec(file);
  return tag ? tag[1] : 'fast';
}

export function areaOf(rel) {
  const dirs = rel.split(sep).join('/').split('/').slice(0, -1);
  if (dirs[0] === 'src') dirs.shift();
  return dirs.slice(0, 2).join('/') || '.';
}

// Returns 'js' | 'python' | 'go' | 'rust' | 'rust?' (a .rs file whose text decides) | null.
function langOf(rel, name) {
  if (JS_FILE.test(name) && !TYPES_FILE.test(name) && (JS_TEST.test(name) || `/${rel}`.includes('/__tests__/')))
    return 'js';
  if (/^test_.+\.py$|_test\.py$/.test(name)) return 'python';
  if (name.endsWith('_test.go')) return 'go';
  if (name.endsWith('.rs')) return `/${rel}`.includes('/tests/') ? 'rust' : 'rust?';
  return null;
}

// Links are never followed: a dangling or looping link cannot break the walk.
function walk(root) {
  const found = [];
  let dirs = 0;
  const visit = (dir, depth) => {
    if (depth > MAX_DEPTH)
      throw new Error(`directories nested deeper than ${MAX_DEPTH} under ${root}; narrow the root`);
    if (++dirs > MAX_DIRS) throw new Error(`more than ${MAX_DIRS} directories under ${root}; narrow the root`);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(full, depth + 1);
      } else if (entry.isFile()) {
        const rel = relative(root, full).split(sep).join('/');
        const lang = langOf(rel, entry.name);
        if (!lang) continue;
        found.push({ full, rel, lang });
        if (found.length > MAX_FILES)
          throw new Error(`more than ${MAX_FILES} test files under ${root}; narrow the root`);
      }
    }
  };
  visit(root, 0);
  return found;
}

function readHead(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(statSync(path).size, MAX_BYTES));
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
}

// The call's text from `from` to its closing parenthesis, across up to 6 lines.
function callText(lines, index, from) {
  let text = lines[index].slice(from);
  for (let next = index + 1; next < Math.min(lines.length, index + 6); next += 1) {
    const open = (text.match(/\(/g) || []).length;
    if (open > 0 && (text.match(/\)/g) || []).length >= open) break;
    text += ` ${lines[next].trim()}`;
  }
  return text;
}

function skipSites(lines, lang) {
  const sites = [];
  lines.forEach((line, index) => {
    const add = (reason, conditional) => sites.push({ index, reason, conditional });
    if (lang === 'js') {
      const reasons = [...line.matchAll(JS_SKIP_REASON)];
      for (const match of reasons) add(match[2], false);
      if (!reasons.length) {
        if (JS_SKIP_IF.test(line)) add('', true);
        else if (JS_SKIP_BARE.test(line)) add('', false);
      }
    } else if (lang === 'python') {
      const match = PY_SKIP.exec(line);
      if (!match || /^\s*#/.test(line)) return;
      const conditional = PY_CONDITIONAL.has(match[1] || match[2] || match[3]);
      const call = callText(lines, index, match.index);
      const keyword = /\breason\s*=\s*(['"])((?:(?!\1).)*)\1/.exec(call);
      const positional = conditional
        ? /,\s*(['"])((?:(?!\1).)*)\1\s*\)?\s*$/.exec(call)
        : /\(\s*(['"])((?:(?!\1).)*)\1/.exec(call);
      add((keyword || positional)?.[2] || '', conditional);
    } else if (lang === 'go') {
      const match = GO_SKIP.exec(line);
      if (match && !/^\s*\/\//.test(line))
        add(/(['"`])((?:(?!\1).)*)\1/.exec(line.slice(match.index))?.[2] || '', false);
    } else {
      const match = RUST_IGNORE.exec(line);
      if (match) add(match[2] || '', false);
      else if (RUST_CFG_IGNORE.test(line)) add('', true);
    }
  });
  return sites;
}

function commentOf(line, token) {
  const at = line.indexOf(token);
  return at < 0 ? '' : line.slice(at + token.length).trim();
}

function classify(reason, today, conditional) {
  const until = UNTIL.exec(reason)?.[1] || '';
  if (until && until < today) return 'expired';
  if (TRACKED.test(reason)) return 'tracked';
  if (!reason.trim()) return conditional ? 'capability' : 'untracked';
  return CAPABILITY.test(reason) ? 'capability' : 'untracked';
}

export function scanText(text, today, lang = 'js') {
  const spec = LANGS[lang];
  const fakeClock = spec.fake.test(text);
  const markers = Object.entries(spec.markers)
    .filter(([name, pattern]) => pattern.test(text) && !(fakeClock && (name === 'timer' || name === 'clock')))
    .map(([name]) => name);
  const lines = text.split(/\r?\n/);
  const skips = skipSites(lines, lang).map(({ index, reason, conditional }) => {
    const before =
      index > 0 && lines[index - 1].trim().startsWith(spec.comment) ? commentOf(lines[index - 1], spec.comment) : '';
    const note = [commentOf(lines[index], spec.comment), before].filter(Boolean).join(' ');
    const full = [reason, note].filter(Boolean).join(' ');
    return { line: index + 1, reason: reason || note, kind: classify(full, today, conditional) };
  });
  return { markers, skips };
}

export function inventory(root, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${root}`);
  const files = [];
  for (const { full, rel, lang } of walk(root)) {
    const text = readHead(full);
    if (lang === 'rust?' && !RUST_TEST.test(text)) continue;
    const language = lang === 'rust?' ? 'rust' : lang;
    files.push({ file: rel, lang: language, lane: laneOf(rel), area: areaOf(rel), ...scanText(text, today, language) });
  }
  const areas = new Map();
  for (const entry of files) {
    const row = areas.get(entry.area) || {
      area: entry.area,
      files: 0,
      fast: 0,
      slow: 0,
      other: 0,
      langs: {},
      markers: {},
      skips: {},
    };
    row.files += 1;
    if (entry.lane === 'fast') row.fast += 1;
    else if (entry.lane === 'slow') row.slow += 1;
    else row.other += 1;
    row.langs[entry.lang] = (row.langs[entry.lang] || 0) + 1;
    for (const marker of entry.markers) row.markers[marker] = (row.markers[marker] || 0) + 1;
    for (const skip of entry.skips) row.skips[skip.kind] = (row.skips[skip.kind] || 0) + 1;
    areas.set(entry.area, row);
  }
  const attention = files.flatMap((entry) =>
    entry.skips.filter((skip) => skip.kind !== 'capability').map((skip) => ({ file: entry.file, ...skip }))
  );
  const fastRisk = files.filter(
    (entry) => entry.lane === 'fast' && entry.markers.includes('timer') && entry.markers.includes('spawn')
  );
  return {
    root,
    today,
    files: files.length,
    areas: [...areas.values()].sort((a, b) => b.files - a.files || a.area.localeCompare(b.area)),
    attentionTotal: attention.length,
    attention: attention.slice(0, LIST_LIMIT),
    fastRiskTotal: fastRisk.length,
    fastRisk: fastRisk.slice(0, LIST_LIMIT).map((entry) => entry.file),
  };
}

function markdown(report) {
  const cell = (counts) =>
    Object.entries(counts)
      .map(([key, count]) => `${key} ${count}`)
      .join(', ') || '-';
  const more = (total, shown) => (total > shown ? [`- … ${total - shown} more (use --json)`] : []);
  const out = [`# Test inventory: ${report.root}`, '', `${report.files} test files, ${report.today}.`, ''];
  out.push('| Area | Files | Fast | Slow | Other | Languages | Markers | Skips |', '|---|---|---|---|---|---|---|---|');
  for (const row of report.areas) {
    out.push(
      `| ${row.area} | ${row.files} | ${row.fast} | ${row.slow} | ${row.other} | ${cell(row.langs)} | ${cell(row.markers)} | ${cell(row.skips)} |`
    );
  }
  out.push('', `## Skips needing action (${report.attentionTotal})`, '');
  for (const item of report.attention)
    out.push(`- ${item.kind}: \`${item.file}:${item.line}\` — ${item.reason || '(no reason)'}`);
  out.push(...more(report.attentionTotal, report.attention.length));
  out.push('', `## Fast-lane files with timers and real processes (${report.fastRiskTotal})`, '');
  for (const file of report.fastRisk) out.push(`- \`${file}\``);
  out.push(...more(report.fastRiskTotal, report.fastRisk.length));
  return out.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--json');
  const root = args.find((arg) => !arg.startsWith('--'));
  if (!root || unknown) {
    console.error(`${unknown ? `unknown option ${unknown}; ` : ''}usage: inventory.mjs <project-root> [--json]`);
    process.exit(2);
  }
  try {
    const report = inventory(root);
    console.log(json ? JSON.stringify(report, null, 2) : markdown(report));
  } catch (error) {
    console.error(`inventory: ${error.message}`);
    process.exit(1);
  }
}
