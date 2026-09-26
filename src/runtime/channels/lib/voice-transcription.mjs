import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVoiceRuntime, selectVoiceModelId } from './voice-runtime-fetcher.mjs';
import { ensureReady, transcribe } from './whisper-server.mjs';
import { normalizeWhisperLanguage, detectDeviceLanguage } from './whisper-language.mjs';

const _require = createRequire(import.meta.url);

// Voice-attachment transcription pipeline. `config` is read live through the
// injected getter so runtime config reloads (reloadRuntimeConfig) keep the
// same semantics as a file-level `let config` reference.
function isVoiceAttachment(contentType) {
  if (typeof contentType !== 'string') return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith('audio/') || ct.startsWith('application/ogg');
}

function runCmd(cmd, args, capture = false) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'ignore',
      windowsHide: true,
    });
    let out = '';
    if (capture && proc.stdout)
      proc.stdout.on('data', (d) => {
        out += d;
      });
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}`))));
    proc.on('error', reject);
  });
}

// ── voice.transcription concurrency queue (max=1 by default, config-driven) ──
// The limit is re-read on every drain, so a runtime config reload applies to
// the requests still waiting.
function createVoiceTranscriptionQueue(getConfig) {
  let running = 0;
  const pending = [];
  function drain() {
    const limit = getConfig().voice?.transcription?.maxConcurrency ?? 1;
    while (running < limit && pending.length > 0) {
      const { fn, resolve, reject } = pending.shift();
      running++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          running--;
          drain();
        });
    }
  }
  return function enqueue(fn) {
    return new Promise((resolve, reject) => {
      pending.push({ fn, resolve, reject });
      drain();
    });
  };
}

// Container duration via ffprobe (bundled binary when present). Any failure —
// missing ffprobe, unreadable container — reports an unknown duration so the
// caller's gate cannot reject a file it could not measure.
async function probeAudioDurationSec(filePath) {
  try {
    const ffprobePath = (() => {
      try {
        return _require('ffprobe-static').path;
      } catch {
        return 'ffprobe';
      }
    })();
    return await new Promise((resolve, reject) => {
      const args = [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ];
      let out = '';
      const proc = spawn(ffprobePath, args, { windowsHide: true });
      proc.stdout.on('data', (d) => {
        out += d;
      });
      proc.on('close', (code) => {
        code === 0 ? resolve(parseFloat(out.trim()) || null) : reject(new Error(`ffprobe exit ${code}`));
      });
      proc.on('error', reject);
    });
  } catch {
    return null;
  }
}

// One whisper-ready wav per attachment: a cached conversion is reused while its
// file still exists, and parallel callers for the same key share a single
// ffmpeg spawn instead of racing two conversions onto the same output path.
function createVoiceWavCache() {
  const wavByAttachment = new Map(); // attachmentId → wavPath
  const ffmpegInflight = new Map(); // attachmentId|wavPath → Promise<void> single-flight ffmpeg

  return {
    async ensureWav({ audioPath, attachmentId, ffmpegPath, threadCount, sampleRate, channels }) {
      let wavPath;
      if (attachmentId && wavByAttachment.has(attachmentId)) {
        wavPath = wavByAttachment.get(attachmentId);
        if (!fs.existsSync(wavPath)) {
          wavByAttachment.delete(attachmentId);
          wavPath = undefined;
        } else {
          process.stderr.write(`mixdog: voice.transcription wav cache hit (${attachmentId})\n`);
        }
      }
      if (!wavPath) {
        wavPath = audioPath.replace(/\.[^.]+$/, '.wav');
        const _ffmpegKey = attachmentId || wavPath;
        if (ffmpegInflight.has(_ffmpegKey)) {
          await ffmpegInflight.get(_ffmpegKey);
        } else {
          const _ffmpegPromise = runCmd(ffmpegPath, [
            '-i',
            audioPath,
            // Leading silence so a clipped onset still decodes as the first word.
            '-af',
            'adelay=300:all=1',
            '-ar',
            String(sampleRate),
            '-ac',
            String(channels),
            '-threads',
            String(threadCount),
            '-y',
            wavPath,
          ]);
          ffmpegInflight.set(_ffmpegKey, _ffmpegPromise);
          try {
            await _ffmpegPromise;
            if (attachmentId) wavByAttachment.set(attachmentId, wavPath);
          } finally {
            ffmpegInflight.delete(_ffmpegKey);
          }
        }
      }
      return wavPath;
    },
  };
}

// The one resolution of the managed runtime and the exact whisper-server
// contract, shared by transcription and warm-up. Returns { error } (a
// user-actionable message) when the runtime is not installed.
function resolveVoiceTranscriptionRuntime(config, dataDir) {
  const runtime = resolveVoiceRuntime(dataDir, { modelId: selectVoiceModelId(config.voice) });
  if (!runtime?.installed) {
    const missing = [runtime?.binary ? null : 'binary', runtime?.model ? null : 'model', runtime?.ffmpeg ? null : 'ffmpeg']
      .filter(Boolean)
      .join(' + ');
    return {
      error: `voice runtime not installed (missing: ${missing}) — open the setup wizard and click "Install voice"`,
    };
  }
  const cpuCount = (() => {
    try {
      return os.cpus().length;
    } catch {
      return 2;
    }
  })();
  const threadCount = config.voice?.transcription?.threadCount ?? Math.max(1, Math.ceil(cpuCount / 4));
  return {
    runtime,
    threadCount,
    serverContract: { serverCmd: runtime.serverCmd, modelPath: runtime.modelPath, threadCount, host: '127.0.0.1' },
  };
}

// Creates the voice-transcription surface bound to a live config getter and
// data dir. Returns { isVoiceAttachment, transcribeVoice, prepareTranscription }.
function createVoiceTranscription({ getConfig, dataDir }) {
  const _voiceTranscriptionQueue = createVoiceTranscriptionQueue(getConfig);
  const _voiceWavCache = createVoiceWavCache();
  // ── transcript cache keyed by attachment id ──
  const _voiceTranscriptCache = new Map(); // attachmentId → transcript string
  const _voiceInflight = new Map(); // attachmentId → Promise<string|null>

  async function transcribeVoice(audioPath, { attachmentId } = {}) {
    const config = getConfig();
    // ── size gate (config: voice.transcription.maxFileSizeMB) ──
    const maxSizeBytes = (config.voice?.transcription?.maxFileSizeMB ?? 0) * 1024 * 1024;
    if (maxSizeBytes > 0) {
      try {
        const stat = await fs.promises.stat(audioPath);
        if (stat.size > maxSizeBytes) {
          process.stderr.write(
            `mixdog: voice.transcription skipped — file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB > ${config.voice.transcription.maxFileSizeMB} MB): ${audioPath}\n`
          );
          return null;
        }
      } catch {
        /* stat failure: proceed */
      }
    }
    // ── duration gate (config: voice.transcription.maxDurationSec) ──
    const maxDurationSec = config.voice?.transcription?.maxDurationSec ?? 0;
    if (maxDurationSec > 0) {
      const dur = await probeAudioDurationSec(audioPath);
      if (dur !== null && dur > maxDurationSec) {
        process.stderr.write(
          `mixdog: voice.transcription skipped — audio too long (${Math.floor(dur)}s > ${maxDurationSec}s): ${audioPath}\n`
        );
        return null;
      }
    }
    // ── transcript cache hit ──
    if (attachmentId && _voiceTranscriptCache.has(attachmentId)) {
      process.stderr.write(`mixdog: voice.transcription cache hit (${attachmentId})\n`);
      return _voiceTranscriptCache.get(attachmentId);
    }
    if (attachmentId && _voiceInflight.has(attachmentId)) {
      return _voiceInflight.get(attachmentId);
    }
    const p = _voiceTranscriptionQueue(() => _doTranscribeVoice(audioPath, attachmentId));
    if (attachmentId) {
      _voiceInflight.set(attachmentId, p);
      p.catch((err) => {
        try {
          process.stderr.write(`mixdog: voice.transcription inflight rejection: ${err?.stack || err}\n`);
        } catch {}
      }).finally(() => _voiceInflight.delete(attachmentId));
    }
    return p;
  }

  async function _doTranscribeVoice(audioPath, attachmentId) {
    const config = getConfig();
    try {
      const { error, runtime, threadCount, serverContract } = resolveVoiceTranscriptionRuntime(config, dataDir);
      if (error) throw new Error(error);
      const lang = normalizeWhisperLanguage(config.voice?.language) ?? detectDeviceLanguage();
      const wavPath = await _voiceWavCache.ensureWav({
        audioPath,
        attachmentId,
        ffmpegPath: runtime.ffmpegPath,
        threadCount,
        sampleRate: config.voice?.transcription?.sampleRate ?? 16000,
        channels: config.voice?.transcription?.channels ?? 1,
      });
      process.stderr.write(
        `mixdog: voice.transcription start runtime=${runtime.kind} cmd=${path.basename(runtime.whisperCmd)}\n`
      );
      await ensureReady(serverContract);
      const text = await transcribe(wavPath, { language: lang });
      const result = text.trim() || null;
      if (attachmentId && result) _voiceTranscriptCache.set(attachmentId, result);
      return result;
    } catch (err) {
      // Propagate ALL real failures so the caller's retry (network-class) and
      // failure marker (index.mjs catch) fire; null is reserved strictly for a
      // legit empty transcript.
      process.stderr.write(`mixdog: voice.transcription failed: ${err}\n`);
      throw err;
    }
  }

  // Warm the singleton whisper-server for the current contract (re-arming its
  // idle release) so the next transcription skips the cold model load. Never
  // throws: warm-up is advisory and the real transcription reports failures.
  async function prepareTranscription() {
    const { error, serverContract } = resolveVoiceTranscriptionRuntime(getConfig(), dataDir);
    if (error) return { ready: false, reason: error };
    try {
      await ensureReady(serverContract);
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: String(err?.message || err) };
    }
  }

  return { isVoiceAttachment, transcribeVoice, prepareTranscription };
}

export { createVoiceTranscription };
