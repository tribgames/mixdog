#!/usr/bin/env node
// Terminal smoke runner against a running core (mixdogd): the same checks on every shell profile the core lists, over the
// protocol only (packages/protocol-client, no Electron, no node-pty). It replaces the node-pty load check of the packaged Linux
// build (linux-pty-check.cjs) and drives the terminal release matrix (Windows powershell, pwsh, cmd, Git Bash, WSL; macOS; Linux).
//
//   node apps/desktop/scripts/core-terminal-smoke.mjs --endpoint ws://127.0.0.1:<port> --token-file <path> \
//     [--profile <id>] [--json out.json]
//
// --endpoint   the core's WebSocket (the path /rpc is added when the URL has none).
// --token-file the discovery token: a file holding the token itself, or the core's discovery JSON (endpoints.session.token).
// --profile    one profile id from terminal/profiles; without it every listed profile is run (the OS default when none is listed).
// --json       writes {profile, profiles:[{profile, checks}], checks:[{profile, name, ok, ms, detail}]} there.
// Exit 0 when every check of every profile passed, 1 when one failed, 2 on a bad command line or an unreachable core.
//
// Checks per profile (each profile gets its own tabs, all disposed at the end):
//   ensure+attach     terminal/ensure then terminal/attach: a replay and a subscription {id, mode, epoch, startSeq}.
//   input             terminal/input "echo <marker>": a line equal to the marker comes back on process:<tab>. The echo of the typed
//                     command is on the feed too, so only a line that is exactly the marker counts (the output of the command).
//   resize            terminal/resize with a claim: the terminalTabs section names this connection's size; the claim is released.
//   flood             ~5.8 MB of numbered lines; the reader pauses at 256 KiB of unprocessed output and resumes at 32 KiB, and the
//                     numbers arrive in order with none missing; the unprocessed backlog stays bounded (FLOOD_BACKLOG_LIMIT).
//   reconnect         a connection ends, output is produced while none reads, a new one attaches with resumeFrom the last stamp:
//                     the first frame is the next stamp, stamps are consecutive, the output arrives once and the old output not again.
//   second-connection two connections read a tab, the second pauses, the first closes: the tab still answers; resume delivers.
//   dispose           terminal/dispose: process/exited on the tab's feed within 5 s.
// The shell families the flood and the marker are written for are read from the profile (cmd.exe; PowerShell / pwsh; anything
// else is taken to be a POSIX shell, which also covers Git Bash, MSYS2, Cygwin and WSL).
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// The client library imports TypeScript from the workspace package @mixdog/protocol, which Node's own type stripping refuses
// under node_modules: tsx is loaded first, as scripts/test-tsx.mjs does for the tests.
await import('tsx');
const { connect } = await import('../../../packages/protocol-client/src/index.ts');
const { createWsConnector } = await import('../src/main/protocol/ws-connector.ts');

const KIB = 1024;
const MIB = 1024 * KIB;
const FLOOD_LINES = 80_000;
const FLOOD_PAD = 'x'.repeat(64);
const FLOOD_MIN_BYTES = 5 * MIB;
const PAUSE_AT = 256 * KIB;
const RESUME_AT = 32 * KIB;
/** What the unprocessed backlog may hold at its highest: the pause threshold plus what was already on its way when the pause
 *  was asked for. A reader that never paused would hold the whole flood. */
const FLOOD_BACKLOG_LIMIT = 3 * MIB;
/** The reader's speed in the flood check: slow enough that the backlog reaches the pause threshold. */
const READER_BYTES_PER_SECOND = 1 * MIB;
const FLOOD_TIMEOUT_MS = 240_000;
const MARKER_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 5_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (!['endpoint', 'token-file', 'profile', 'json'].includes(name)) throw new Error(`unknown option --${name}`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') throw new Error(`--${name} needs a value`);
    out[name] = value;
  }
  if (!out.endpoint) throw new Error('--endpoint is required');
  if (!out['token-file']) throw new Error('--token-file is required');
  return out;
}

async function readToken(file) {
  const text = (await readFile(file, 'utf8')).trim();
  try {
    const token = JSON.parse(text)?.endpoints?.session?.token;
    if (typeof token === 'string' && token) return token;
  } catch {
    // Not JSON: the file is the token.
  }
  if (!text) throw new Error(`${file} is empty`);
  return text;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const nonce = () => randomBytes(4).toString('hex');
const message = (error) => (error instanceof Error ? error.message : String(error));

async function waitFor(what, ms, probe) {
  const until = Date.now() + ms;
  for (;;) {
    const found = probe();
    if (found) return found;
    if (Date.now() >= until) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(20);
  }
}

// ───────────────────────────── output of one tab on one connection ─────────────────────────────

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]/g;

/** What one connection read of a tab's feed `process:<tab>`: the frames' stamps in order, the output as lines, and the exit. */
class Tap {
  constructor(tabId) {
    this.tabId = tabId;
    this.decoder = new TextDecoder();
    this.partial = '';
    this.lines = [];
    this.bytes = 0;
    this.stamps = [];
    this.violations = [];
    this.last = null;
    this.exited = false;
    this.onBytes = null;
  }

  /** Stamps must follow `after` (the stamp a resumed attach was asked to continue from). */
  continueFrom(stamp) {
    this.last = stamp;
  }

  frame(notification) {
    const stamp = notification.feed;
    if (notification.method === 'feed/snapshot') {
      this.last = null;
      return;
    }
    if (stamp && typeof stamp.seq === 'number') {
      const before = this.last;
      if (before && (stamp.epoch !== before.epoch || stamp.seq !== before.seq + 1)) {
        this.violations.push(`frame ${stamp.epoch}:${stamp.seq} after ${before.epoch}:${before.seq}`);
      }
      this.last = { epoch: stamp.epoch, seq: stamp.seq };
      this.stamps.push(stamp.seq);
    }
    if (notification.method === 'process/exited') {
      this.exited = true;
      return;
    }
    if (notification.method !== 'process/outputDelta') return;
    const { bytesB64, leadUnit, tailUnit } = notification.params ?? {};
    const raw = Buffer.from(String(bytesB64 ?? ''), 'base64');
    this.bytes += raw.length;
    // The core cannot hold half of a surrogate pair at a frame's edge: the unit is sent beside the bytes.
    const unit = (value) => (typeof value === 'number' ? String.fromCharCode(value) : '');
    this.partial += unit(leadUnit) + this.decoder.decode(raw, { stream: true }) + unit(tailUnit);
    const cut = this.partial.lastIndexOf('\n');
    if (cut >= 0) {
      for (const row of this.partial.slice(0, cut).split('\n')) {
        // A carriage return inside a row overwrites it: what stays is what follows the last one.
        const visible = row.replace(ANSI, '').replace(/\r+$/, '');
        this.lines.push(visible.slice(visible.lastIndexOf('\r') + 1));
      }
      this.partial = this.partial.slice(cut + 1);
    }
    this.onBytes?.(raw.length);
  }

  /** How many output lines read exactly `text` (the output of a command, not the echo of the typed line). */
  count(text) {
    return this.lines.filter((line) => line === text).length;
  }

  waitLine(text, ms = MARKER_TIMEOUT_MS) {
    return waitFor(`the line ${JSON.stringify(text)} (read ${this.lines.length} lines, ${this.bytes} bytes)`, ms, () => this.count(text) > 0);
  }
}

// ───────────────────────────── one connection ─────────────────────────────

class Link {
  constructor(client) {
    this.client = client;
    this.taps = new Map();
    this.off = client.on((event) => {
      if (event.type !== 'notification') return;
      const feed = event.notification.feed?.id;
      if (typeof feed === 'string' && feed.startsWith('process:')) this.taps.get(feed.slice('process:'.length))?.frame(event.notification);
    });
  }

  tap(tabId) {
    let tap = this.taps.get(tabId);
    if (!tap) this.taps.set(tabId, (tap = new Tap(tabId)));
    return tap;
  }

  ensure(options, tabId) {
    return this.client.call('terminal/ensure', { ...(tabId ? { tabId } : {}), options });
  }

  /** The tap exists before the attach is asked for: frames may be queued ahead of its answer. */
  async attach(tabId, resumeFrom) {
    const tap = this.tap(tabId);
    if (resumeFrom) tap.continueFrom(resumeFrom);
    const reply = await this.client.call('terminal/attach', { tabId, ...(resumeFrom ? { resumeFrom } : {}) });
    return { reply, tap };
  }

  input(tabId, data) {
    this.client.notify('terminal/input', { tabId, data });
  }

  async close() {
    this.off();
    await this.client.close().catch(() => undefined);
  }
}

// ───────────────────────────── shells ─────────────────────────────

/** The shell language a profile speaks, from its id and path. */
function familyOf(profile) {
  const text = `${profile?.id ?? ''} ${profile?.path ?? ''}`.toLowerCase();
  const base = String(profile?.path ?? '').toLowerCase().split(/[\\/]/).pop();
  if (profile?.id === 'cmd' || base === 'cmd.exe') return 'cmd';
  if (text.includes('pwsh') || text.includes('powershell')) return 'powershell';
  return 'posix';
}

/** `echo BEGIN`, the numbered lines and `echo END` as one line of the shell's own language. */
function floodCommand(family, mark) {
  const flood = {
    posix: `seq -f 'L%g-${FLOOD_PAD}' 1 ${FLOOD_LINES}`,
    powershell: `1..${FLOOD_LINES}|%{"L$_-${FLOOD_PAD}"}`,
    cmd: `for /L %i in (1,1,${FLOOD_LINES}) do @echo L%i-${FLOOD_PAD}`,
  }[family];
  const join = family === 'cmd' ? ' & ' : '; ';
  return [`echo FLOODBEGIN-${mark}`, flood, `echo FLOODEND-${mark}`].join(join);
}

// ───────────────────────────── the run ─────────────────────────────

async function run() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`core-terminal-smoke: ${message(error)}`);
    console.error('usage: core-terminal-smoke.mjs --endpoint ws://127.0.0.1:<port> --token-file <path> [--profile <id>] [--json out.json]');
    return 2;
  }
  const token = await readToken(args['token-file']).catch((error) => {
    console.error(`core-terminal-smoke: ${message(error)}`);
    return null;
  });
  if (!token) return 2;
  const url = new URL(args.endpoint);
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/rpc';
  const connector = createWsConnector(async () => ({ url: url.toString(), token }));

  // The core accepts exactly its own version; the first refusal names it.
  let version = '0.0.0';
  const dial = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await connect({
          target: { id: 'core' },
          connector,
          clientInfo: { name: 'mixdog-terminal-smoke', title: 'Terminal smoke', version, kind: 'cli' },
          capabilities: {},
          clock: { sleep },
          random: Math.random,
        });
        return new Link(client);
      } catch (error) {
        const detail = error?.detail;
        if (attempt === 0 && detail?.kind === 'versionRefused') {
          version = detail.serverVersion;
          continue;
        }
        throw error;
      }
    }
  };

  const results = [];
  let current = null;
  const check = async (name, run) => {
    const started = Date.now();
    let ok = true;
    let detail = '';
    try {
      detail = (await run()) ?? '';
    } catch (error) {
      ok = false;
      detail = message(error);
    }
    const row = { profile: current, name, ok, ms: Date.now() - started, detail };
    results.push(row);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${current ?? '(core)'} ${name} (${row.ms} ms)${detail ? ` ${detail}` : ''}`);
    return ok;
  };
  const skipped = (name, because) => {
    const row = { profile: current, name, ok: false, ms: 0, detail: `skipped: ${because}` };
    results.push(row);
    console.log(`FAIL ${current ?? '(core)'} ${name} ${row.detail}`);
  };

  let main;
  try {
    main = await dial();
  } catch (error) {
    console.error(`core-terminal-smoke: cannot connect to ${url}: ${message(error)}`);
    return 2;
  }

  let profiles = [];
  await check('profiles', async () => {
    const list = await main.client.call('terminal/profiles', {});
    if (!Array.isArray(list)) throw new Error(`terminal/profiles answered ${JSON.stringify(list)}`);
    profiles = list;
    return list.map((p) => p.id).join(', ') || 'none listed';
  });

  let wanted;
  if (args.profile) wanted = [profiles.find((p) => p.id === args.profile) ?? { id: args.profile }];
  else wanted = profiles.length ? profiles : [{ id: '', default: true }];
  if (args.profile && !profiles.some((p) => p.id === args.profile)) {
    await check('profile listed', async () => {
      throw new Error(`${args.profile} is not among the profiles the core lists`);
    });
  }

  const opened = [];
  const open = async () => {
    const link = await dial();
    opened.push(link);
    return link;
  };
  await main.client.subscribeApp().catch(() => undefined);

  for (const profile of wanted) {
    current = profile.id || '(default)';
    const family = familyOf(profile.id ? profile : (profiles.find((p) => p.default) ?? { id: process.platform === 'win32' ? 'powershell' : 'sh' }));
    const options = { cols: 80, rows: 24, ...(profile.id ? { profile: profile.id } : {}) };
    const tabs = [];
    const dispose = async (link, tabId) => {
      await link.client.call('terminal/dispose', { tabId }).catch(() => undefined);
    };

    // ── ensure + attach ──
    let tab = null;
    let tap = null;
    const ensured = await check('ensure+attach', async () => {
      const made = await main.ensure(options);
      if (!made || typeof made.id !== 'string' || !made.id) throw new Error(`terminal/ensure answered ${JSON.stringify(made)}`);
      tab = made.id;
      tabs.push(tab);
      const { reply, tap: read } = await main.attach(tab);
      tap = read;
      if (!reply || typeof reply.replay !== 'string') throw new Error(`terminal/attach answered ${JSON.stringify(reply)} (no replay)`);
      const sub = reply.subscription;
      if (!sub || typeof sub.id !== 'string' || typeof sub.mode !== 'string' || typeof sub.epoch !== 'string' || typeof sub.startSeq !== 'number') {
        throw new Error(`terminal/attach carried no subscription {id, mode, epoch, startSeq}: ${JSON.stringify(sub)}`);
      }
      return `${tab}, replay ${reply.replay.length} chars, ${sub.mode} from ${sub.epoch}:${sub.startSeq}, ${family}`;
    });

    if (ensured) {
      // ── input ──
      await check('input', async () => {
        const mark = `MK-${nonce()}`;
        main.input(tab, `echo ${mark}\r`);
        try {
          await tap.waitLine(mark);
        } catch (error) {
          const echoed = tap.lines.some((line) => line.includes(mark));
          throw new Error(`${message(error)}${echoed ? ' (the typed line was echoed, the command printed nothing back)' : ''}`);
        }
        return mark;
      });

      // ── resize ──
      await check('resize', async () => {
        const owned = () => {
          const rows = main.client.store.section('terminalTabs')?.value;
          return Array.isArray(rows) ? (rows.find((row) => row?.id === tab)?.sizeOwner ?? null) : null;
        };
        main.client.notify('terminal/resize', { tabId: tab, cols: 100, rows: 30, claim: true });
        const owner = await waitFor('the terminalTabs section to name the claimed size 100x30', 5_000, () => {
          const o = owned();
          return o && o.cols === 100 && o.rows === 30 ? o : null;
        });
        main.client.notify('terminal/resize', { tabId: tab, cols: 0, rows: 0, claim: true });
        await waitFor('the claim to be released', 5_000, () => owned() === null);
        return `claimed by ${owner.owner}, released`;
      });

      // ── flood ──
      await check('flood', async () => {
        const mark = nonce();
        const command = floodCommand(family, mark);
        let pending = 0;
        let highest = 0;
        let paused = false;
        let pauses = 0;
        let resumes = 0;
        let failure = null;
        let reading = Date.now();
        const settle = () => {
          const now = Date.now();
          pending = Math.max(0, pending - ((now - reading) / 1000) * READER_BYTES_PER_SECOND);
          reading = now;
          if (!paused && pending >= PAUSE_AT) {
            paused = true;
            pauses++;
            main.client.call('terminal/pause', { tabId: tab }).catch((error) => (failure ??= error));
          } else if (paused && pending <= RESUME_AT) {
            paused = false;
            resumes++;
            main.client.call('terminal/resume', { tabId: tab }).catch((error) => (failure ??= error));
          }
        };
        tap.onBytes = (n) => {
          settle();
          pending += n;
          highest = Math.max(highest, pending);
          settle();
        };
        const drain = setInterval(settle, 10);
        const from = { bytes: tap.bytes, lines: tap.lines.length };
        try {
          main.input(tab, `${command}\r`);
          await waitFor(`FLOODEND (read ${tap.bytes - from.bytes} bytes)`, FLOOD_TIMEOUT_MS, () => failure || tap.count(`FLOODEND-${mark}`) > 0);
          if (failure) throw failure;
        } finally {
          clearInterval(drain);
          tap.onBytes = null;
          if (paused) await main.client.call('terminal/resume', { tabId: tab }).catch(() => undefined);
        }
        const read = tap.bytes - from.bytes;
        let next = 1;
        let missing = 0;
        let repeated = 0;
        const row = new RegExp(`^L(\\d+)-${FLOOD_PAD}$`);
        for (const line of tap.lines.slice(from.lines)) {
          const n = Number(row.exec(line)?.[1]);
          if (!n) continue;
          if (n === next) next++;
          else if (n < next) repeated++;
          else {
            missing += n - next;
            next = n + 1;
          }
        }
        const found = next - 1;
        if (tap.violations.length) throw new Error(`feed stamps broke: ${tap.violations.slice(0, 3).join('; ')}`);
        if (read < FLOOD_MIN_BYTES) throw new Error(`only ${read} bytes were read (need ${FLOOD_MIN_BYTES})`);
        if (missing || found !== FLOOD_LINES) throw new Error(`lost output: ${missing} lines missing, last line ${found} of ${FLOOD_LINES}`);
        if (pauses === 0) throw new Error(`the backlog never reached ${PAUSE_AT} bytes (highest ${Math.round(highest)}): flow control was not exercised`);
        if (highest > FLOOD_BACKLOG_LIMIT) throw new Error(`the backlog reached ${Math.round(highest)} bytes (limit ${FLOOD_BACKLOG_LIMIT}) with ${pauses} pauses`);
        return `${read} bytes, ${found} lines, ${repeated} repeated, ${pauses} pauses, ${resumes} resumes, backlog ${Math.round(highest)}`;
      });
    } else {
      for (const name of ['input', 'resize', 'flood']) skipped(name, 'ensure+attach failed');
    }

    // ── reconnect ──
    await check('reconnect', async () => {
      const first = await open();
      const second = await open();
      const made = await first.ensure(options);
      const id = made.id;
      tabs.push(id);
      const { tap: before } = await first.attach(id);
      const a = `RA-${nonce()}`;
      first.input(id, `echo ${a}\r`);
      await before.waitLine(a);
      await sleep(300);
      const last = before.last;
      if (!last) throw new Error('no frame was read before the connection ended');
      await first.close();
      // Output while no connection of this check reads the tab.
      const again = await second.ensure(options, id);
      if (again.id !== id) throw new Error(`terminal/ensure with the id ${id} answered ${again.id}`);
      const b = `RB-${nonce()}`;
      second.input(id, `echo ${b}\r`);
      await sleep(600);
      const { tap: after } = await second.attach(id, { epoch: last.epoch, seq: last.seq });
      await after.waitLine(b);
      await sleep(300);
      if (after.violations.length) throw new Error(`stamps broke: ${after.violations.slice(0, 3).join('; ')}`);
      if (after.stamps[0] !== last.seq + 1) throw new Error(`the first frame after ${last.epoch}:${last.seq} was ${after.stamps[0]}`);
      if (after.stamps.some((seq) => seq <= last.seq)) throw new Error('a frame the first connection had read came again');
      if (after.count(b) !== 1) throw new Error(`${b} arrived ${after.count(b)} times`);
      if (after.count(a) !== 0) throw new Error(`${a} came again after the resume`);
      return `resumed after ${last.epoch}:${last.seq}, ${after.stamps.length} frames`;
    });

    // ── second connection pauses, the first closes ──
    await check('second-connection', async () => {
      const first = await open();
      const second = await open();
      const made = await first.ensure(options);
      const id = made.id;
      tabs.push(id);
      await first.attach(id);
      const { tap: reading } = await second.attach(id);
      await second.client.call('terminal/pause', { tabId: id });
      await first.close();
      const mark = `MC-${nonce()}`;
      second.input(id, `echo ${mark}\r`);
      await sleep(300);
      await second.client.call('terminal/resume', { tabId: id });
      await reading.waitLine(mark);
      if (second.client.status.state !== 'ready') throw new Error(`the second connection is ${second.client.status.state}`);
      return `${mark} read after the resume`;
    });

    // ── dispose ──
    if (ensured) {
      await check('dispose', async () => {
        const started = Date.now();
        const answered = main.client.call('terminal/dispose', { tabId: tab });
        await waitFor('process/exited', EXIT_TIMEOUT_MS, () => tap.exited);
        await answered;
        tabs.splice(tabs.indexOf(tab), 1);
        return `exited ${Date.now() - started} ms after the dispose`;
      });
    } else skipped('dispose', 'ensure+attach failed');

    for (const id of tabs) await dispose(main, id);
  }

  await Promise.all(opened.map((link) => link.close()));
  await main.close();

  const failed = results.filter((row) => !row.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (args.json) {
    const byProfile = [...new Set(results.map((row) => row.profile))].map((id) => ({
      profile: id,
      checks: results.filter((row) => row.profile === id).map(({ name, ok, ms, detail }) => ({ name, ok, ms, detail })),
    }));
    await writeFile(args.json, `${JSON.stringify({ profile: args.profile ?? null, profiles: byProfile, checks: results }, null, 2)}\n`);
  }
  return failed.length ? 1 : 0;
}

process.exitCode = await run();
// The connections are closed above; ws sockets of a failed run must not hold the process.
setTimeout(() => process.exit(process.exitCode), 200).unref();
