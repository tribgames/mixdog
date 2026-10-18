// Live ping-pong across providers.
// Basic suite (default): three turns - a forced read, a no-tool replay of that history,
// and two parallel reads.
// Extended suite (`--suite extended`): after those, tool error, file write, shell, a
// 3-step tool chain, image input, mid-stream cancel + follow-up. Per-turn usage is
// captured to report prompt-cache reads on turns 2+.
//
// Isolation (default): the runs use a fresh temp MIXDOG_HOME/MIXDOG_DATA_DIR, never the
// installed app's ~/.mixdog data, so no session, catalog or worker rows reach the real
// stores. Only the API-key secrets (`secrets/agent.<provider>.apiKey.dpapi`) and the
// `agent` section of mixdog-config.json are copied in. OAuth providers (`*-oauth`, whose
// refresh tokens could be rotated) are skipped unless `--real-data` is passed, which
// restores the old behaviour of running against the real data dir. The isolated dir is
// deleted at the end, after stopping only processes whose executable lives inside it.
// Usage: node scripts/provider-pingpong-live.mjs [--suite extended] [--real-data] [case-name ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const self = fileURLToPath(import.meta.url);
const TURN_TIMEOUT_MS = 150_000;

const textOf = (response) => {
  const content = response?.result?.content ?? response?.text ?? '';
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return String(content);
};

// Solid-colour PNG (8-bit RGB) built from scratch so no image dependency is needed.
function solidPng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const withTimeout = (promise, ms, onTimeout) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });

// Failures caused by the account (limits, billing, entitlement) rather than the provider code.
const ACCOUNT_RE =
  /quota|billing|\b(?:402|403|429)\b|rate.?limit|usage limit|insufficient|payment|credit|too many requests|exhaust|subscription|plan limit|not entitled|resource_exhausted/i;

if (process.argv[2] === '--child') {
  const spec = JSON.parse(process.argv[3]);
  const extended = spec.suite === 'extended';
  const { resolvePluginData } = await import('../src/runtime/shared/plugin-paths.mjs');
  if (spec.dataDir && path.resolve(resolvePluginData()) !== path.resolve(spec.dataDir)) {
    console.log(
      `RESULT ${JSON.stringify({ name: spec.name, error: `refusing to run: data dir ${resolvePluginData()} is not the isolated ${spec.dataDir}` })}`
    );
    process.exit(0);
  }
  const { createMixdogSessionRuntime } = await import('../src/session-runtime/runtime-core.mjs');
  const { materializePromptSubmission } = await import('../src/runtime/attachments/store.mjs');
  const { getModelMetadataSync } = await import('../src/runtime/shared/llm/model-catalog.mjs');
  let runtime;
  const out = {
    name: spec.name,
    provider: spec.provider,
    model: spec.model,
    effort: spec.effort,
    turns: {},
    order: [],
  };
  const readDisk = (file) => {
    try {
      return fs.readFileSync(path.join(spec.cwd, file), 'utf8');
    } catch {
      return null;
    }
  };

  // Runs one ask() and records calls/text/usage under `key`. Errors are recorded, not thrown,
  // so later scenarios still run; an ACCOUNT error stops the case (everything after would fail alike).
  const turn = async (key, prompt, options = {}) => {
    const rec = {
      calls: [],
      text: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 },
      models: [],
    };
    out.turns[key] = rec;
    out.order.push(key);
    const startedAt = Date.now();
    try {
      const response = await withTimeout(
        runtime.ask(prompt, {
          ...options,
          onAssistantToolCallObserved: (call) => rec.calls.push(call.name || call.tool),
          onUsageDelta: (d) => {
            rec.usage.events++;
            rec.usage.input += d.deltaInput || 0;
            rec.usage.output += d.deltaOutput || 0;
            rec.usage.cacheRead += d.deltaCachedRead || 0;
            rec.usage.cacheWrite += d.deltaCacheWrite || 0;
            if (d.model && !rec.models.includes(d.model)) rec.models.push(d.model);
          },
        }),
        TURN_TIMEOUT_MS,
        () => runtime.abort('pingpong-timeout')
      );
      rec.text = textOf(response).trim().slice(0, 300);
    } catch (error) {
      rec.error = String(error?.message || error).slice(0, 400);
      if (ACCOUNT_RE.test(rec.error)) out.stopped = 'account';
    }
    rec.ms = Date.now() - startedAt;
    return rec;
  };

  try {
    runtime = await createMixdogSessionRuntime({
      provider: spec.provider,
      model: spec.model,
      ...(spec.effort ? { effort: spec.effort } : {}),
      cwd: spec.cwd,
      toolMode: 'full',
      autoWakeCompletions: false,
    });
    const steps = [
      ['t1', 'Use the read tool on package.json, then reply with only the value of "name".'],
      ['t2', 'Without using tools, reply with only that same name in uppercase.'],
      [
        't3',
        'Read a.txt and b.txt with two read calls issued together in one step, then reply with only their two contents joined by "+".',
      ],
    ];
    for (const [key, prompt] of steps) {
      await turn(key, prompt);
      if (out.stopped) break;
    }

    if (extended && !out.stopped) {
      await turn(
        'er',
        'Use the read tool on does-not-exist.txt. Whatever happens, then tell me in one short sentence whether that file exists.'
      );
    }
    if (extended && !out.stopped) {
      const rec = await turn(
        'wr',
        'Using the file edit/write tool (not the shell), create a new file c.txt in the working directory containing exactly the text gamma. Reply "done" when finished.'
      );
      rec.disk = readDisk('c.txt');
    }
    if (extended && !out.stopped) {
      await turn('sh', 'Use the shell tool to run exactly: node -e "console.log(6*7)" and reply with only its output.');
    }
    if (extended && !out.stopped) {
      const rec = await turn(
        'ml',
        'Do these in order, each as its own tool call, one after another: (1) read a.txt, (2) create a new file d.txt using the file edit/write tool containing the contents of a.txt with its characters reversed and no trailing newline, (3) read d.txt. Then reply with only the text in d.txt.'
      );
      rec.disk = readDisk('d.txt');
    }
    if (extended && !out.stopped) {
      const vision = getModelMetadataSync(spec.model, spec.provider)?.supportsVision;
      if (vision === false) {
        out.turns.im = { skipped: 'catalog says no vision', calls: [], text: '' };
        out.order.push('im');
      } else {
        const png = solidPng(64, 64, [255, 0, 0]).toString('base64');
        // Same intake the session service applies before runtime.ask: inline image
        // parts become content-addressed attachment references.
        const intake = materializePromptSubmission([
          { type: 'text', text: 'What single colour fills this image? Reply with only the colour name in English.' },
          { type: 'image', data: png, mimeType: 'image/png' },
        ]);
        const rec = await turn('im', intake.prompt, intake.options);
        rec.visionFlag = vision === undefined ? 'unknown' : 'true';
      }
    }
    if (extended && !out.stopped) {
      // Real cancel path: runtime.abort() -> abortRuntime -> turn controller + mgr.abortSessionTurn.
      const rec = {
        calls: [],
        text: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 },
        models: [],
      };
      out.turns.ca = rec;
      out.order.push('ca');
      let deltas = 0;
      let abortResult;
      let aborted = false;
      const doAbort = () => {
        if (aborted) return;
        aborted = true;
        abortResult = runtime.abort('user-cancel');
      };
      const fallback = setTimeout(doAbort, 30_000);
      const onDelta = () => {
        if (++deltas >= 5) doAbort();
      };
      const startedAt = Date.now();
      const pending = runtime
        .ask(
          'Write a very long numbered list from 1 to 300, one item per line, each item a full sentence about a different animal. Do not use tools.',
          {
            onTextDelta: onDelta,
            onUsageDelta: (d) => {
              rec.usage.events++;
              rec.usage.input += d.deltaInput || 0;
              rec.usage.output += d.deltaOutput || 0;
              rec.usage.cacheRead += d.deltaCachedRead || 0;
              rec.usage.cacheWrite += d.deltaCacheWrite || 0;
            },
          }
        )
        .then(
          (r) => ({ ok: true, text: textOf(r).trim() }),
          (e) => ({ ok: false, error: String(e?.message || e) })
        );
      const settled = await Promise.race([pending, new Promise((r) => setTimeout(() => r({ hang: true }), 120_000))]);
      clearTimeout(fallback);
      rec.ms = Date.now() - startedAt;
      rec.deltas = deltas;
      rec.abortResult = abortResult;
      rec.abortedAfterMs = rec.ms;
      if (settled.hang) rec.settle = 'hang';
      else rec.settle = settled.ok ? 'resolved' : 'rejected';
      rec.text = String(settled.text || '').slice(0, 120);
      rec.error = settled.error ? settled.error.slice(0, 300) : undefined;
      rec.chars = String(settled.text || '').length;
      if (settled.hang) out.stopped = 'hang';
      else if (rec.error && ACCOUNT_RE.test(rec.error) && !aborted) out.stopped = 'account';
      if (!out.stopped) await turn('fu', 'Reply with only the word READY.');
    }
  } catch (error) {
    out.error = String(error?.message || error).slice(0, 400);
  } finally {
    await runtime?.close('provider-pingpong-live').catch(() => {});
  }
  console.log(`RESULT ${JSON.stringify(out)}`);
  process.exit(0);
}

// [name, provider, model, effort]; each route runs at a low and a high reasoning setting.
const routes = [
  ['openrouter-claude', 'openrouter', 'anthropic/claude-haiku-5.5', ['low', 'max']],
  ['openrouter-gpt', 'openrouter', 'openai/gpt-6-luna', ['none', 'xhigh']],
  ['openrouter-gemini', 'openrouter', 'google/gemini-3.5-flash-lite', ['minimal', 'high']],
  ['openrouter-deepseek', 'openrouter', 'deepseek/deepseek-v4.1-flash', ['low', 'max']],
  ['deepseek', 'deepseek', 'deepseek-flash', ['low', 'max']],
  ['deepseek-pro', 'deepseek', 'deepseek-v4-pro', ['high']],
  ['opencode-go-gemini', 'opencode-go-oauth', 'gemini-4-argon-contributor', ['low', 'high']],
  ['opencode-go-deepseek', 'opencode-go-oauth', 'deepseek-v4.1-flash', ['low', 'max']],
  ['opencode-go-claude', 'opencode-go-oauth', 'claude-haiku-5-5', ['low', 'max']],
  ['opencode-go-gpt', 'opencode-go-oauth', 'gpt-6-luna', ['none', 'xhigh']],
  ['opencode-go-glm', 'opencode-go-oauth', 'glm-5.3-flash', ['low', 'max']],
  ['opencode-go-qwen', 'opencode-go-oauth', 'qwen3.8-flash', ['low', 'xhigh']],
  ['opencode-go-kimi', 'opencode-go-oauth', 'kimi-k3', ['max']],
  ['opencode-go-minimax', 'opencode-go-oauth', 'minimax-m3', [null]],
  ['opencode-go-grok', 'opencode-go-oauth', 'grok-4.7', ['low']],
  ['anthropic-api', 'anthropic', 'claude-haiku-5-5', ['low', 'max']],
  ['gemini-api', 'gemini', 'gemini-3.5-flash-lite', ['minimal', 'high']],
  ['grok-oauth', 'grok-oauth', 'grok-4.7', ['low', 'xhigh']],
  ['openai-oauth', 'openai-oauth', 'gpt-6-luna', ['none', 'xhigh']],
  ['anthropic-oauth', 'anthropic-oauth', 'claude-haiku-5-5', ['low', 'max']],
  ['antigravity-oauth', 'antigravity-oauth', 'gemini-3.8-flash', ['low', 'high']],
  ['cursor-auto', 'cursor-oauth', 'auto', [null]],
  ['cursor-composer', 'cursor-oauth', 'composer-2.5', [null]],
  ['cursor-claude', 'cursor-oauth', 'claude-opus-5-5', [null]],
  ['cursor-grok', 'cursor-oauth', 'grok-4.7', [null]],
];
const cases = routes.flatMap(([name, provider, model, efforts]) =>
  efforts.map((effort) => [`${name}${effort ? `@${effort}` : ''}`, provider, model, effort])
);
const args = process.argv.slice(2);
const suiteAt = args.findIndex((a) => a === '--suite' || a.startsWith('--suite='));
let suite = 'basic';
if (suiteAt >= 0) suite = args[suiteAt].includes('=') ? args[suiteAt].split('=')[1] : args[suiteAt + 1];
const extended = suite === 'extended';
const realData = args.includes('--real-data');
const only = args.filter(
  (a, i) =>
    a !== '--real-data' &&
    !a.startsWith('--suite') &&
    !(suiteAt >= 0 && i === suiteAt + 1 && args[suiteAt] === '--suite')
);
const chosen = only.length ? cases.filter(([name]) => only.includes(name)) : cases;
// Refresh-capable OAuth logins are never exercised from an isolated copy.
const isOauth = ([, provider]) => /-oauth$/.test(provider);
const selected = realData ? chosen : chosen.filter((c) => !isOauth(c));
for (const c of chosen)
  if (!selected.includes(c))
    console.log(`SKIP ${c[0]} (OAuth provider; pass --real-data to run against the real data dir)`);
if (!selected.length) {
  console.log('nothing to run');
  process.exit(0);
}

// Isolated MIXDOG_HOME for the child runtimes: a fresh temp dir holding only the API-key
// secrets of the selected providers and the `agent` section of the real config.
let isolated = null;
if (!realData) {
  const realDataDir =
    process.env.MIXDOG_DATA_DIR || path.join(process.env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog'), 'data');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-pp-home-'));
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(path.join(dataDir, 'secrets'), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(realDataDir, 'mixdog-config.json'), 'utf8'));
  fs.writeFileSync(path.join(dataDir, 'mixdog-config.json'), JSON.stringify({ agent: config.agent ?? {} }, null, 2));
  for (const provider of new Set(selected.map(([, p]) => p))) {
    const secret = `agent.${provider}.apiKey.dpapi`;
    const from = path.join(realDataDir, 'secrets', secret);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dataDir, 'secrets', secret));
    else console.log(`WARN no ${secret} in the real data dir; ${provider} cases will fail to authenticate`);
  }
  isolated = {
    home,
    dataDir,
    env: { MIXDOG_HOME: home, MIXDOG_DATA_DIR: dataDir, MIXDOG_RUNTIME_ROOT: path.join(home, 'runtime-root') },
  };
}

// Stops only processes whose executable path is inside `root` (e.g. the isolated memory
// postgres), then removes the dir. Windows-only lookup, like the DPAPI secrets.
const removeIsolated = () => {
  if (!isolated) return;
  const { home } = isolated;
  isolated = null;
  if (process.platform === 'win32') {
    const root = home.replace(/'/g, "''");
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$root='${root}\\'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: 'ignore' }
    );
  }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
};

// One fixture dir per case: concurrent children write c.txt/d.txt and must not collide.
const tempDirs = new Set();
const removeTemp = () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  removeIsolated();
};
process.on('exit', removeTemp);
const makeCwd = (name) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `mixdog-pingpong-${name.replace(/[^a-z0-9]+/gi, '-')}-`));
  tempDirs.add(cwd);
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'pingpong-probe', version: '1.0.0' }, null, 2)
  );
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(cwd, 'b.txt'), 'beta\n');
  return cwd;
};

const runOne = ([name, provider, model, effort]) =>
  new Promise((resolve) => {
    const cwd = makeCwd(name);
    const child = spawn(
      process.execPath,
      [
        self,
        '--child',
        JSON.stringify({
          name,
          provider,
          model,
          effort,
          cwd,
          dataDir: isolated?.dataDir,
          suite: extended ? 'extended' : 'basic',
        }),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...isolated?.env } }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), extended ? 900_000 : 240_000);
    child.on('close', () => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      tempDirs.delete(cwd);
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
      resolve(
        line ? JSON.parse(line.slice(7)) : { name, provider, model, effort, error: `no result: ${stderr.slice(-300)}` }
      );
    });
  });

// Bounded concurrency keeps per-provider rate limits from masking real failures.
const results = [];
const queue = [...selected];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (queue.length) results.push(await runOne(queue.shift()));
  })
);
results.sort((a, b) => a.name.localeCompare(b.name));

const has = (t, re) => re.test(t?.text || '');
const called = (t, name) => (t?.calls || []).includes(name);
const wroteVia = (t) => (t?.calls || []).some((c) => /edit|write|patch/i.test(c));
// [key, label, check(turn, result)] ; check returns true/false.
const scenarios = [
  ['t1', 't1', (t) => called(t, 'read') && has(t, /pingpong-probe/i)],
  ['t2', 't2', (t) => has(t, /PINGPONG-PROBE/)],
  ['t3', 't3', (t) => (t.calls || []).filter((c) => c === 'read').length >= 1 && has(t, /alpha/i) && has(t, /beta/i)],
  // The reply language follows the user's profile (may be Korean), so the wording check is bilingual.
  [
    'er',
    'err',
    (t) =>
      called(t, 'read') &&
      has(
        t,
        /missing|not exist|doesn.?t exist|does not|no such|not found|nonexistent|isn.?t|cannot|can.?t|존재하지|없|찾을 수|않/i
      ),
  ],
  ['wr', 'wr', (t) => wroteVia(t) && String(t.disk ?? '').trim() === 'gamma'],
  ['sh', 'sh', (t) => called(t, 'shell') && has(t, /42/)],
  [
    'ml',
    'ml',
    (t) => {
      const c = t.calls || [];
      const firstRead = c.indexOf('read');
      const write = c.findIndex((n, i) => i > firstRead && /edit|write|patch/i.test(n));
      const lastRead = c.lastIndexOf('read');
      return (
        firstRead >= 0 &&
        write > firstRead &&
        lastRead > write &&
        String(t.disk ?? '').trim() === 'ahpla' &&
        has(t, /ahpla/)
      );
    },
  ],
  ['im', 'img', (t) => has(t, /red/i)],
  ['ca', 'can', (t) => t.settle && t.settle !== 'hang' && t.abortResult === true],
  ['fu', 'fu', (t) => has(t, /READY/i)],
];

const short = (s, n = 60) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .slice(0, n);
const evidence = (key, t) => {
  if (!t) return 'no turn';
  if (t.error && key !== 'ca') return `error: ${short(t.error, 90)}`;
  const base = `[${(t.calls || []).join(',')}] "${short(t.text)}"`;
  if (key === 'wr' || key === 'ml') return `${base} disk=${JSON.stringify(short(t.disk ?? null, 20))}`;
  if (key === 'ca')
    return `abort=${t.abortResult} settle=${t.settle} deltas=${t.deltas} chars=${t.chars} ${t.error ? `err="${short(t.error, 70)}"` : ''}`;
  return base;
};

const details = [];
for (const r of results) {
  const marks = [];
  const evid = [];
  let anyFail = false;
  let anyAccount = false;
  for (const [key, label, check] of scenarios) {
    if (!extended && !['t1', 't2', 't3'].includes(key)) continue;
    const t = r.turns?.[key];
    // A cancelled turn is expected to reject, so only 'ca' tolerates an error.
    const ok = t && (key === 'ca' || !t.error) && check(t, r);
    const accountish = t
      ? ACCOUNT_RE.test(t.error || t.text || '')
      : r.stopped === 'account' || ACCOUNT_RE.test(r.error || '');
    let mark;
    if (t?.skipped) mark = '-';
    else if (ok) mark = '✓';
    else if (accountish) mark = 'A';
    // The catalog is silent on vision for this model: a wrong answer may just be a text-only
    // model, so it is flagged for manual review instead of counted as a failure.
    else if (key === 'im' && t?.visionFlag === 'unknown') mark = '?';
    else mark = '✗';
    marks.push(`${label}${mark}`);
    if (mark === '✗') anyFail = true;
    if (mark === 'A') anyAccount = true;
    if (mark !== '✓' && mark !== '-') {
      evid.push(`${label}${mark}: ${evidence(key, t)}`);
      details.push({ r, key, label, mark, t });
    }
  }
  const turns = Object.entries(r.turns || {});
  const later = (r.order || [])
    .slice(1)
    .map((k) => r.turns[k])
    .filter((t) => t?.usage);
  const sum = (f) => later.reduce((n, t) => n + f(t.usage), 0);
  const events = (r.order || []).reduce((n, k) => n + (r.turns[k]?.usage?.events || 0), 0);
  const cache =
    !turns.length || !events
      ? 'cache=NO-USAGE'
      : `cache r=${sum((u) => u.cacheRead)} w=${sum((u) => u.cacheWrite)} in=${sum((u) => u.input)} cr/turn=[${later.map((t) => t.usage.cacheRead).join(',')}]`;
  let verdict = 'PASS';
  if (r.error && !turns.length) verdict = ACCOUNT_RE.test(r.error) ? 'ACCOUNT' : 'FAIL';
  else if (anyFail) verdict = 'FAIL';
  else if (anyAccount) verdict = 'ACCOUNT';
  if (extended) {
    console.log(`${verdict.padEnd(7)} ${r.name.padEnd(30)} ${marks.join(' ')}  ${cache}`);
    if (r.error) console.log(`        error=${r.error}`);
    for (const e of evid) console.log(`        ${e}`);
  } else {
    const turn = (key, label) => {
      const t = r.turns?.[key];
      const ok = t && !t.error && scenarios.find((s) => s[0] === key)[2](t, r);
      return `${label}${ok ? '✓' : '✗'} ${t?.ms}ms [${t?.calls}] "${short(t?.text)}"`;
    };
    const pass = !r.error && verdict === 'PASS';
    let label = 'FAIL';
    if (pass) label = 'PASS';
    else if (verdict === 'ACCOUNT') label = 'ACCOUNT';
    console.log(
      `${label} ${r.name.padEnd(30)} ` +
        (r.error ? `error=${r.error}` : `${turn('t1', 't1')} | ${turn('t2', 't2')} | ${turn('t3', 't3')}`)
    );
  }
}

if (extended) {
  // Oddities worth a manual look: model identity, usage presence, notices mixed into answers.
  console.log('\n--- NON-PASS DETAILS (raw) ---');
  const markNames = { A: 'ACCOUNT', '?': 'UNVERIFIED' };
  for (const { r, label, mark, t } of details) {
    console.log(
      `[${markNames[mark] ?? 'FAIL'}] ${r.provider}/${r.model} effort=${r.effort ?? '-'} ${label}: ` +
        `error=${JSON.stringify(t?.error ?? null)} text=${JSON.stringify(t?.text ?? null)} calls=${JSON.stringify(t?.calls ?? null)} disk=${JSON.stringify(t?.disk ?? null)}`
    );
  }
  console.log('\n--- ODDITIES ---');
  for (const r of results) {
    for (const key of r.order || []) {
      const t = r.turns[key];
      if (
        t?.models?.length &&
        !t.models.some((m) => m === r.model || m.endsWith(`/${r.model}`) || m.includes(r.model) || r.model.includes(m))
      )
        console.log(`${r.name} ${key}: served model ${JSON.stringify(t.models)} != requested ${r.model}`);
      if (/notice|overloaded|retrying|fallback|server error|temporarily/i.test(t?.text || ''))
        console.log(`${r.name} ${key}: notice-like text ${JSON.stringify(t.text)}`);
      if (t && !t.skipped && !t.error && t.usage && t.usage.events === 0)
        console.log(`${r.name} ${key}: no usage events`);
    }
  }
}
removeTemp();
