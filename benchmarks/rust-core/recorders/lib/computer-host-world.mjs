// The world Node's Computer Use runs in, for the recorders that drive the real core client (computer-bridge/client.mjs) together with the
// real desktop host (apps/desktop/src/main/computer): what stands in for the machine is only what those read and spawn. Electron is a
// stand-in module (displays, the image object, the capture sources), `child_process` spawns a scripted `mixdog-computer` helper and a
// virtual `gdbus` / `gsettings`, `fs` answers the virtual Linux paths, and `process.platform` / `Date.now` are the case's. The client
// reaches the host over the host's own loopback HTTP bridge, discovered through the data directory's file as in production.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import zlib from 'node:zlib';

export const HELPER_BIN = '/opt/mixdog/mixdog-computer';
const MARKER = '@@MIXCU@@';

/** A real PNG (zlib-compressed scanlines, CRCs) of the given RGB pixels. */
export function pngOf(width, height, pixels) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.from([0, ...pixels.slice(y * width, (y + 1) * width).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** The pixels of a PNG written by `pngOf` (8-bit RGB, filter 0), as the BGRA bitmap Electron's `toBitmap` gives. */
function bitmapOf(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let data = Buffer.alloc(0);
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') data = Buffer.concat([data, png.subarray(at + 8, at + 8 + length)]);
    at += 12 + length;
  }
  const raw = zlib.inflateSync(data);
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = y * (width * 3 + 1) + 1 + x * 3;
      const to = (y * width + x) * 4;
      out[to] = raw[from + 2];
      out[to + 1] = raw[from + 1];
      out[to + 2] = raw[from];
      out[to + 3] = 255;
    }
  }
  return out;
}

/** Electron's `NativeImage` as the capture code uses it. `encodeJpeg` is the case's stand-in for Chromium's encoder. */
function nativeImageOf(png, encodeJpeg) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return {
    getSize: () => ({ width, height }),
    isEmpty: () => width === 0 || height === 0,
    toPNG: () => png,
    toBitmap: () => bitmapOf(png),
    toJPEG: (quality) => encodeJpeg(png, quality),
    resize: ({ width: w, height: h }) => {
      throw new Error(`the stand-in image cannot resample ${width}x${height} to ${w}x${h}`);
    },
  };
}

// Every name the host's modules import from Electron at load time; the ones its computer paths use are given in `electronOf`, the rest are inert.
const ELECTRON_NAMES = [
  'app', 'BrowserWindow', 'clipboard', 'desktopCapturer', 'globalShortcut', 'nativeImage', 'powerMonitor', 'screen', 'session', 'systemPreferences',
  'safeStorage', 'ipcMain', 'Menu', 'Tray', 'shell', 'dialog', 'net', 'protocol', 'webContents', 'Notification', 'nativeTheme', 'autoUpdater', 'utilityProcess',
];
const electronModule = `const e = globalThis.__mixdogElectron;\n${ELECTRON_NAMES.map((name) => `export const ${name} = e.${name};`).join('\n')}`;

let hooked = false;
function hookElectron() {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'electron'
        ? { url: `data:text/javascript,${encodeURIComponent(electronModule)}`, shortCircuit: true }
        : next(specifier, context);
    },
  });
}

/**
 * The patches that make one machine real to the code under test. `world` is the case's machine (see `Machine`); `install(world, platform)`
 * returns the restore function.
 */
export class Machine {
  constructor({ dataDir, helper, encodeJpeg }) {
    this.dataDir = dataDir;
    this.helper = helper;
    this.encodeJpeg = encodeJpeg;
    this.world = null;
    this.clock = 0;
    this.origin = Date.now();
    /** Everything the machine was asked: `spawns` = gdbus/gsettings (program and arguments), `requests` = what reached the helper. */
    this.spawns = [];
    this.requests = [];
    /** The same two streams in the order they happened: `{ tool: [program, ...args] }` or `{ helper: request }`. */
    this.events = [];
    this.helpers = [];
  }

  reset() {
    this.spawns = [];
    this.requests = [];
    this.events = [];
  }

  /** `gdbus` / `gsettings` answers: `{ status, out?, stderr?, write? }`, or null for a program that does not exist. */
  tool(command, args) {
    return this.world.tools(command, args, this);
  }

  spawn = (command, args = []) => {
    if (command === HELPER_BIN) return this.spawnHelper();
    return this.spawnTool(command, args);
  };

  spawnTool(command, args) {
    this.spawns.push([command, ...args]);
    this.events.push({ tool: [command, ...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    const answer = this.tool(command, args);
    setImmediate(() => {
      if (!answer) return child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
      if (answer.out) child.stdout.emit('data', answer.out);
      child.emit('close', answer.status);
    });
    return child;
  }

  /** The scripted `mixdog-computer`: one JSON request per stdin line, one marked reply line per request, as the real helper speaks. */
  spawnHelper() {
    const child = new EventEmitter();
    child.pid = 4242 + this.helpers.length;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.stdin.write = (line) => {
      const request = JSON.parse(line);
      this.requests.push(request);
      this.events.push({ helper: request });
      const { id } = request;
      const reply = this.helper(request, this);
      setImmediate(() => child.stdout.emit('data', `${MARKER}${JSON.stringify(reply.ok === false ? { id, ok: false, error: reply.error } : { id, ok: true, result: reply.result })}\n`));
      return true;
    };
    child.stdin.end = () => {};
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('exit', 0, null));
      return true;
    };
    this.helpers.push(child);
    return child;
  }

  install(world, platform) {
    hookElectron();
    const saved = {
      access: fs.accessSync, exists: fs.existsSync, read: fs.readFileSync, rm: fs.rmSync, spawn: childProcess.spawn, execFile: childProcess.execFile,
      env: process.env, now: Date.now, platform: Object.getOwnPropertyDescriptor(process, 'platform'), electron: globalThis.__mixdogElectron,
    };
    this.world = world;
    this.clock = 0;
    const posix = (file) => String(file).replaceAll('\\', '/');
    const virtual = (file) => typeof file === 'string' && posix(file).startsWith('/') && !/^\/[a-z]:/i.test(posix(file));
    const missing = (file) => Object.assign(new Error(`ENOENT: no such file or directory, access '${file}'`), { code: 'ENOENT' });
    fs.accessSync = (file, mode) => {
      if (!virtual(file)) return saved.access(file, mode);
      const held = mode === fs.constants.X_OK ? world.executables : world.writable;
      if (!held.includes(posix(file))) throw missing(file);
    };
    fs.existsSync = (file) => (virtual(file) ? world.existing.includes(posix(file)) : saved.exists(file));
    fs.readFileSync = (file, ...rest) => {
      if (!virtual(file)) return saved.read(file, ...rest);
      const bytes = world.files?.[posix(file)];
      if (!bytes) throw missing(file);
      return bytes;
    };
    fs.rmSync = (file, ...rest) => {
      if (!virtual(file)) return saved.rm(file, ...rest);
      delete world.files?.[posix(file)];
    };
    childProcess.spawn = this.spawn;
    childProcess.execFile = (command, args, _options, done) => {
      this.spawns.push([command, ...args]);
      this.events.push({ tool: [command, ...args] });
      const answer = this.tool(command, args);
      setImmediate(() => {
        if (!answer) return done(Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }), '', '');
        if (answer.status !== 0) return done(Object.assign(new Error(`Command failed: ${command} ${args.join(' ')}`), { code: answer.status }), '', answer.stderr ?? '');
        done(null, answer.out ?? '', '');
      });
      return new EventEmitter();
    };
    syncBuiltinESMExports();
    process.env = { ...world.env, MIXDOG_DATA_DIR: this.dataDir, MIXDOG_COMPUTER_BIN: HELPER_BIN };
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Date.now = () => this.origin + this.clock;
    globalThis.__mixdogElectron = electronOf(world, this.encodeJpeg);
    return () => {
      fs.accessSync = saved.access;
      fs.existsSync = saved.exists;
      fs.readFileSync = saved.read;
      fs.rmSync = saved.rm;
      childProcess.spawn = saved.spawn;
      childProcess.execFile = saved.execFile;
      syncBuiltinESMExports();
      process.env = saved.env;
      Object.defineProperty(process, 'platform', saved.platform);
      Date.now = saved.now;
      globalThis.__mixdogElectron = saved.electron;
    };
  }
}

function electronOf(world, encodeJpeg) {
  const display = { id: 1, bounds: { x: 0, y: 0, ...world.display }, size: world.display, scaleFactor: 1 };
  const events = () => ({ on() {}, off() {}, removeListener() {} });
  const inert = () => new Proxy(() => undefined, { get: (_target, key) => (key === 'then' ? undefined : inert()), apply: () => undefined });
  return {
    ...Object.fromEntries(ELECTRON_NAMES.map((name) => [name, inert()])),
    app: { getPath: () => '/home/u', on() {}, isReady: () => true, whenReady: () => Promise.resolve() },
    BrowserWindow: { getAllWindows: () => [], fromId: () => null },
    clipboard: {},
    desktopCapturer: { getSources: async () => { throw new Error('the stand-in has no Electron capture source'); } },
    globalShortcut: { register: () => true, unregister() {} },
    nativeImage: { createFromBuffer: (buffer) => nativeImageOf(Buffer.from(buffer), encodeJpeg) },
    powerMonitor: events(),
    screen: { ...events(), getAllDisplays: () => [display], getPrimaryDisplay: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }), screenToDipPoint: (p) => p, dipToScreenPoint: (p) => p },
    session: {},
    systemPreferences: {},
  };
}
