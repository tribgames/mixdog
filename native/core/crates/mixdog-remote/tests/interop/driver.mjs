// Browser interop for the Rust WebRTC peer (DS-REM-9/10/11). The phone side is a real
// RTCPeerConnection in Chromium and WebKit, using the phone web UI's usage: the desktop offers,
// the phone lists its receivable codecs, `mixdog-transport[-control]` carrier channels, the
// `mixdog-input` channel for commands.
//
//   INTEROP_NODE_MODULES=<dir containing node_modules/playwright>  node driver.mjs [chromium|webkit]
//
// The desktop half is `webrtc::interop::interop_server` (an ignored test) started per scenario;
// signalling travels over its stdin/stdout. The first decoded live-view frame is written to
// ../fixtures/webrtc/first-frame-<browser>.{png,json}.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.INTEROP_NODE_MODULES, 'x.js'));
const playwright = require('playwright');
const fixtures = path.join(here, '..', 'fixtures', 'webrtc');
mkdirSync(fixtures, { recursive: true });
const crateRoot = path.join(here, '..', '..');

class Desktop {
  constructor(env) {
    this.queue = [];
    this.waiters = [];
    const server = ['webrtc::interop::interop_server', '--ignored', '--nocapture', '--exact'];
    // INTEROP_EXE: a built test binary of the crate (skips cargo).
    const [command, args] = process.env.INTEROP_EXE
      ? [process.env.INTEROP_EXE, server]
      : ['cargo', ['test', '-p', 'mixdog-remote', server[0], '--', ...server.slice(1)]];
    this.child = spawn(command, args, {
      cwd: crateRoot, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line.startsWith('@@ ')) this.push(JSON.parse(line.slice(3)));
      }
    });
  }
  push(message) {
    if (process.env.INTEROP_DEBUG) console.log('<-', JSON.stringify(message).slice(0, 160));
    const waiter = this.waiters.findIndex((w) => w.match(message));
    if (waiter >= 0) this.waiters.splice(waiter, 1)[0].resolve(message);
    else this.queue.push(message);
  }
  send(message) {
    if (process.env.INTEROP_DEBUG) console.log('->', JSON.stringify(message).slice(0, 160));
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  wait(match, ms = 60000) {
    const at = this.queue.findIndex(match);
    if (at >= 0) return Promise.resolve(this.queue.splice(at, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => reject(new Error('desktop message not seen in time')), ms).unref();
    });
  }
  stop() {
    this.send({ t: 'quit' });
    setTimeout(() => this.child.kill(), 3000).unref();
  }
}

// The phone page: plain RTCPeerConnection code.
const PHONE = () => {
  const events = [];
  const pc = new RTCPeerConnection({ iceServers: [] });
  const channels = {};
  const state = { received: [], offerAt: 0, firstFrameMs: null, frame: null };
  window.state = state;
  pc.onicecandidate = (e) =>
    window.toNode({
      t: 'candidate',
      c: e.candidate
        ? { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex, usernameFragment: e.candidate.usernameFragment }
        : null,
    });
  pc.ondatachannel = (e) => {
    const ch = e.channel;
    ch.binaryType = 'arraybuffer';
    channels[ch.label] = ch;
    ch.onmessage = (m) => state.received.push({ label: ch.label, data: typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data) });
    ch.onopen = () => {
      state.open = (state.open ?? 0) + 1;
      if (ch.label === 'mixdog-input') state.inputOpen = true;
    };
  };
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  document.body.append(video);
  pc.ontrack = (e) => {
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    video.play().catch(() => {});
    const onFrame = () => {
      if (state.firstFrameMs !== null) return;
      state.firstFrameMs = performance.now() - state.offerAt;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      state.frame = { dataUrl: canvas.toDataURL('image/png'), width: video.videoWidth, height: video.videoHeight };
    };
    video.requestVideoFrameCallback(onFrame);
  };
  window.fromNode = async (m) => {
    if (m.t === 'offer') {
      state.offerAt = performance.now();
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      window.toNode({ t: 'answer', sdp: pc.localDescription.sdp });
    } else if (m.t === 'candidate') {
      await pc.addIceCandidate(m.c ?? undefined).catch(() => {});
    } else if (m.t === 'send') {
      // Carrier messages are binary; the input channel carries text.
      channels[m.label].send(m.label === 'mixdog-input' ? m.data : new TextEncoder().encode(m.data));
    }
  };
  window.codecs = () => RTCRtpReceiver.getCapabilities('video').codecs.map((c) => c.mimeType);
  window.inbound = async () => {
    const report = await pc.getStats();
    let inbound = null;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = { ...s };
    });
    if (inbound?.codecId) inbound.mimeType = report.get(inbound.codecId)?.mimeType;
    return inbound;
  };
};

// `v` names the phone: several phones share one desktop process and one capture.
async function openPhone(browser, desktop, v = 'a') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.exposeFunction('toNode', (m) => desktop.send({ ...m, v }));
  await page.goto('about:blank');
  await page.evaluate(`(${PHONE.toString()})()`);
  return page;
}

// Desktop → page signalling pump.
function pump(desktop, page, v = 'a') {
  const timer = setInterval(async () => {
    for (const kind of ['offer', 'candidate']) {
      for (;;) {
        const m = desktop.queue.find((q) => q.t === kind && (q.v ?? 'a') === v);
        if (!m) break;
        desktop.queue.splice(desktop.queue.indexOf(m), 1);
        await page.evaluate((x) => window.fromNode(x), kind === 'offer' ? m : { t: 'candidate', c: m.c });
      }
    }
  }, 20);
  return () => clearInterval(timer);
}

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function carrier(browser, name) {
  const desktop = new Desktop({ INTEROP_MODE: 'carrier' });
  const page = await openPhone(browser, desktop);
  const stop = pump(desktop, page);
  try {
    // The desktop's `Connected` (certificate) precedes `Open`, which precedes any message.
    const connected = await desktop.wait((m) => m.t === 'connected');
    assert.equal(connected.cert, true, 'remote certificate reported');
    const open = await desktop.wait((m) => m.t === 'open');
    assert.equal(open.path, 'Some(Direct)');
    await until(() => page.evaluate(() => (window.state.open ?? 0) >= 2), 15000, 'phone channels open');
    await page.evaluate(() => {
      window.fromNode({ t: 'send', label: 'mixdog-transport', data: 'p1' });
      window.fromNode({ t: 'send', label: 'mixdog-transport-control', data: 'pc1' });
      window.fromNode({ t: 'send', label: 'mixdog-transport', data: 'p2' });
    });
    const got = [];
    for (let i = 0; i < 3; i++) got.push(await desktop.wait((m) => m.t === 'message'));
    const byChannel = (c) => got.filter((m) => m.channel === c).map((m) => m.data);
    assert.deepEqual(byChannel('App'), ['p1', 'p2']);
    assert.deepEqual(byChannel('Control'), ['pc1']);
    const phoneGot = await until(async () => {
      const r = await page.evaluate(() => window.state.received);
      return r.length >= 3 ? r : null;
    }, 15000, 'phone received desktop messages');
    const by = (l) => phoneGot.filter((m) => m.label === l).map((m) => m.data);
    assert.deepEqual(by('mixdog-transport'), ['d1', 'd2']);
    assert.deepEqual(by('mixdog-transport-control'), ['dc1']);
    console.log(`[${name}] carrier ok`);
  } finally {
    stop();
    desktop.stop();
    await page.context().close();
  }
}

async function liveView(browser, name, { pli }) {
  const desktop = new Desktop({ INTEROP_MODE: 'liveview', ...(pli ? { INTEROP_SKIP_KEY: '1' } : {}) });
  const page = await openPhone(browser, desktop);
  const stop = pump(desktop, page);
  const label = pli ? 'pli' : 'view';
  try {
    const codecs = await page.evaluate(() => window.codecs());
    assert.ok(codecs.some((c) => c.toLowerCase() === 'video/vp8'), 'the browser can receive VP8');
    desktop.send({ t: 'start', codecs, v: 'a' });
    await desktop.wait((m) => m.t === 'connected');
    const frame = await until(() => page.evaluate(() => window.state.frame), 20000, 'first frame');
    const firstFrameMs = await page.evaluate(() => window.state.firstFrameMs);
    const inbound = await page.evaluate(() => window.inbound());
    assert.equal(inbound.mimeType?.toLowerCase(), 'video/vp8', 'negotiated VP8');
    assert.ok(inbound.framesDecoded > 0);
    assert.equal(frame.width, 640);
    assert.equal(frame.height, 360);
    const png = Buffer.from(frame.dataUrl.split(',')[1], 'base64');
    writeFileSync(path.join(fixtures, `first-frame-${name}-${label}.png`), png);
    writeFileSync(
      path.join(fixtures, `first-frame-${name}-${label}.json`),
      JSON.stringify({ browser: name, scenario: label, width: frame.width, height: frame.height, firstFrameMs: Math.round(firstFrameMs), pliCount: inbound.pliCount ?? null, keyFramesDecoded: inbound.keyFramesDecoded ?? null }, null, 2)
    );
    if (pli) {
      // The first keyframe never reached the phone, so a decoded frame proves PLI → keyframe.
      desktop.send({ t: 'stats', v: 'a' });
      const stats = await desktop.wait((m) => m.t === 'stats');
      assert.ok(stats.keyframes >= 2, `PLI produced a keyframe (${JSON.stringify(stats)})`);
      console.log(`[${name}] pli ok: keyframes=${stats.keyframes} pliCount=${inbound.pliCount ?? 'n/a'} first frame ${Math.round(firstFrameMs)} ms`);
      return;
    }
    await until(() => page.evaluate(() => window.state.inputOpen), 10000, 'input channel open');
    const encoded = async () => { desktop.send({ t: 'stats', v: 'a' }); return (await desktop.wait((m) => m.t === 'stats')).encoded; };
    const sample = async (ms) => {
      const e0 = await encoded();
      const a = await page.evaluate(() => window.inbound());
      await new Promise((r) => setTimeout(r, ms));
      const b = await page.evaluate(() => window.inbound());
      const secs = (b.timestamp - a.timestamp) / 1000;
      const e1 = await encoded();
      console.log('  encoder fps', ((e1 - e0) / secs).toFixed(1));
      return { fps: (b.framesDecoded - a.framesDecoded) / secs, bps: ((b.bytesReceived - a.bytesReceived) * 8) / secs };
    };
    await new Promise((r) => setTimeout(r, 3000));
    const before = await sample(4000);
    await page.evaluate(() => window.fromNode({ t: 'send', label: 'mixdog-input', data: JSON.stringify({ encoding: { maxBitrate: 250000, maxFramerate: 10 } }) }));
    assert.equal((await desktop.wait((m) => m.t === 'encoding')).ok, true);
    await new Promise((r) => setTimeout(r, 4000));
    const after = await sample(5000);
    console.log(`[${name}] before ${before.fps.toFixed(1)} fps ${(before.bps / 1000).toFixed(0)} kbps; after ${after.fps.toFixed(1)} fps ${(after.bps / 1000).toFixed(0)} kbps; first frame ${Math.round(firstFrameMs)} ms`);
    assert.ok(before.fps > 15, 'unconstrained cadence');
    assert.ok(after.fps <= 12, `maxFramerate honoured (${after.fps})`);
    assert.ok(after.bps <= 250000 * 1.6, `maxBitrate honoured (${after.bps})`);
    assert.ok(after.bps < before.bps);
    const final = await page.evaluate(() => window.inbound());
    assert.equal(final.frameWidth, 640, 'resolution maintained');
  } finally {
    stop();
    desktop.stop();
    await page.context().close();
  }
}

// Two phones on one screen: each has its own encoder, so one phone's limits touch only that phone.
async function twoViewers(browser, name) {
  const desktop = new Desktop({ INTEROP_MODE: 'liveview' });
  const phones = { a: await openPhone(browser, desktop, 'a'), b: await openPhone(browser, desktop, 'b') };
  const stops = Object.entries(phones).map(([v, page]) => pump(desktop, page, v));
  const stats = async (v) => {
    desktop.send({ t: 'stats', v });
    return desktop.wait((m) => m.t === 'stats' && m.v === v);
  };
  try {
    for (const [v, page] of Object.entries(phones)) {
      desktop.send({ t: 'start', codecs: await page.evaluate(() => window.codecs()), v });
      await desktop.wait((m) => m.t === 'connected' && m.v === v);
      await until(() => page.evaluate(() => window.state.frame), 20000, `first frame of ${v}`);
      await until(() => page.evaluate(() => window.state.inputOpen), 10000, `input channel of ${v}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
    const rate = async (v, ms) => {
      const page = phones[v];
      const a = await page.evaluate(() => window.inbound());
      await new Promise((r) => setTimeout(r, ms));
      const b = await page.evaluate(() => window.inbound());
      const secs = (b.timestamp - a.timestamp) / 1000;
      return { fps: (b.framesDecoded - a.framesDecoded) / secs, bps: ((b.bytesReceived - a.bytesReceived) * 8) / secs };
    };
    const [beforeA, beforeB] = await Promise.all([rate('a', 4000), rate('b', 4000)]);
    const keyframesB = (await stats('b')).keyframes;
    const asks = async () => {
      const i = await phones.b.evaluate(() => window.inbound());
      return (i.pliCount ?? 0) + (i.firCount ?? 0);
    };
    const plisB = await asks();
    await phones.a.evaluate(() => window.fromNode({ t: 'send', label: 'mixdog-input', data: JSON.stringify({ encoding: { maxBitrate: 250000, maxFramerate: 10 } }) }));
    assert.equal((await desktop.wait((m) => m.t === 'encoding' && m.v === 'a')).ok, true);
    await new Promise((r) => setTimeout(r, 4000));
    const [afterA, afterB] = await Promise.all([rate('a', 5000), rate('b', 5000)]);
    console.log(`[${name}] two phones: a ${beforeA.fps.toFixed(1)} -> ${afterA.fps.toFixed(1)} fps, ${(beforeA.bps / 1000).toFixed(0)} -> ${(afterA.bps / 1000).toFixed(0)} kbps; b ${beforeB.fps.toFixed(1)} -> ${afterB.fps.toFixed(1)} fps, ${(beforeB.bps / 1000).toFixed(0)} -> ${(afterB.bps / 1000).toFixed(0)} kbps`);
    assert.ok(afterA.fps <= 12, `phone a's maxFramerate honoured (${afterA.fps})`);
    assert.ok(afterA.bps <= 250000 * 1.6, `phone a's maxBitrate honoured (${afterA.bps})`);
    // Two browsers decoding on one CPU make b's congestion estimate vary; b only has to stay clear of a's cap.
    assert.ok(afterB.fps > 12 && afterB.fps > afterA.fps * 1.3, `phone b keeps its own rate (${afterB.fps})`);
    assert.ok(afterB.bps > afterA.bps * 1.5, `phone b keeps its own bitrate (${afterB.bps} vs ${afterA.bps})`);
    // Phone b may ask for keyframes itself (its own PLI); phone a's commands must add none.
    const plisBAfter = await asks();
    const extra = (await stats('b')).keyframes - keyframesB - (plisBAfter - plisB);
    assert.ok(extra <= 0, `phone a's commands cause no keyframe for phone b (${extra} unexplained)`);
  } finally {
    stops.forEach((stop) => stop());
    desktop.stop();
    await Promise.all(Object.values(phones).map((p) => p.context().close()));
  }
}

// Build once, so the scenarios' timeouts measure the protocol and not the compile (or the wait
// for another build's lock).
if (!process.env.INTEROP_EXE) await new Promise((resolve, reject) =>
  spawn('cargo', ['test', '-p', 'mixdog-remote', '--no-run'], { cwd: crateRoot, stdio: 'inherit' }).on('exit', (code) =>
    code === 0 ? resolve() : reject(new Error('cargo build failed'))
  )
);

const only = process.argv[2];
const launchers = {
  chromium: () => playwright.chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] }),
  webkit: () => playwright.webkit.launch(),
};
let failed = false;
for (const name of Object.keys(launchers).filter((n) => !only || n === only)) {
  const browser = await launchers[name]();
  try {
    await carrier(browser, name);
    await liveView(browser, name, { pli: false });
    await liveView(browser, name, { pli: true });
    await twoViewers(browser, name);
  } catch (error) {
    failed = true;
    console.error(`[${name}] FAILED`, error);
  } finally {
    await browser.close();
  }
}
process.exit(failed ? 1 : 0);
