import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { resolveVoiceRuntime, selectVoiceModelId } from "./voice-runtime-fetcher.mjs";
import { ensureReady, transcribe } from "./whisper-server.mjs";
import { normalizeWhisperLanguage, detectDeviceLanguage } from "./whisper-language.mjs";

const _require = createRequire(import.meta.url);

// Voice-attachment transcription pipeline. Extracted verbatim from
// channels/index.mjs (behavior-preserving). `config` is read live through the
// injected getter so runtime config reloads (reloadRuntimeConfig) keep the
// same semantics as the original file-level `let config` reference.
function isVoiceAttachment(contentType) {
  if (typeof contentType !== 'string') return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith("audio/") || ct.startsWith("application/ogg");
}

function runCmd(cmd, args, capture = false) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
      windowsHide: true
    });
    let out = "";
    if (capture && proc.stdout) proc.stdout.on("data", (d) => {
      out += d;
    });
    proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}`)));
    proc.on("error", reject);
  });
}

// Creates the voice-transcription surface bound to a live config getter and
// data dir. Returns { isVoiceAttachment, transcribeVoice }.
function createVoiceTranscription({ getConfig, dataDir }) {
  // ── voice.transcription concurrency queue (max=1 by default, config-driven) ──
  const _voiceTranscriptionQueue = (() => {
    let running = 0;
    const pending = [];
    function drain() {
      const limit = getConfig().voice?.transcription?.maxConcurrency ?? 1;
      while (running < limit && pending.length > 0) {
        const { fn, resolve, reject } = pending.shift();
        running++;
        fn().then(resolve, reject).finally(() => { running--; drain(); });
      }
    }
    return function enqueue(fn) {
      return new Promise((resolve, reject) => { pending.push({ fn, resolve, reject }); drain(); });
    };
  })();

  // ── wav + transcript cache keyed by attachment id ──
  const _voiceWavCache = new Map();        // attachmentId → wavPath
  const _voiceTranscriptCache = new Map(); // attachmentId → transcript string
  const _voiceInflight = new Map();        // attachmentId → Promise<string|null>
  const _voiceFfmpegInflight = new Map();  // attachmentId|wavPath → Promise<void> single-flight ffmpeg

  async function _probeAudioDurationSec(filePath) {
    try {
      const ffprobePath = (() => { try { return _require('ffprobe-static').path; } catch { return 'ffprobe'; } })();
      return await new Promise((resolve, reject) => {
        const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
        let out = '';
        const proc = spawn(ffprobePath, args, { windowsHide: true });
        proc.stdout.on('data', (d) => { out += d; });
        proc.on('close', (code) => { code === 0 ? resolve(parseFloat(out.trim()) || null) : reject(new Error(`ffprobe exit ${code}`)); });
        proc.on('error', reject);
      });
    } catch {
      return null;
    }
  }

  async function transcribeVoice(audioPath, { attachmentId } = {}) {
    const config = getConfig();
    // ── size gate (config: voice.transcription.maxFileSizeMB) ──
    const maxSizeBytes = (config.voice?.transcription?.maxFileSizeMB ?? 0) * 1024 * 1024;
    if (maxSizeBytes > 0) {
      try {
        const stat = await fs.promises.stat(audioPath);
        if (stat.size > maxSizeBytes) {
          process.stderr.write(`mixdog: voice.transcription skipped — file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB > ${config.voice.transcription.maxFileSizeMB} MB): ${audioPath}\n`);
          return null;
        }
      } catch { /* stat failure: proceed */ }
    }
    // ── duration gate (config: voice.transcription.maxDurationSec) ──
    const maxDurationSec = config.voice?.transcription?.maxDurationSec ?? 0;
    if (maxDurationSec > 0) {
      const dur = await _probeAudioDurationSec(audioPath);
      if (dur !== null && dur > maxDurationSec) {
        process.stderr.write(`mixdog: voice.transcription skipped — audio too long (${Math.floor(dur)}s > ${maxDurationSec}s): ${audioPath}\n`);
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
        try { process.stderr.write(`mixdog: voice.transcription inflight rejection: ${err?.stack || err}\n`); } catch {}
      }).finally(() => _voiceInflight.delete(attachmentId));
    }
    return p;
  }

  async function _doTranscribeVoice(audioPath, attachmentId) {
    const config = getConfig();
    try {
      const runtime = resolveVoiceRuntime(dataDir, { modelId: selectVoiceModelId(config.voice) });
      if (!runtime?.installed) {
        const missing = [runtime?.binary ? null : 'binary', runtime?.model ? null : 'model', runtime?.ffmpeg ? null : 'ffmpeg'].filter(Boolean).join(' + ');
        throw new Error(`voice runtime not installed (missing: ${missing}) — open the setup wizard and click "Install voice"`);
      }
      const whisperCmd = runtime.whisperCmd;
      const modelPath = runtime.modelPath;
      const ffmpegPath = runtime.ffmpegPath;
      const lang = normalizeWhisperLanguage(config.voice?.language) ?? detectDeviceLanguage();
      const _cpuCount = (() => { try { return os.cpus().length; } catch { return 2; } })();
      const threadCount = config.voice?.transcription?.threadCount ?? Math.max(1, Math.ceil(_cpuCount / 4));
      // ── wav cache keyed by attachment id ──
      let wavPath;
      if (attachmentId && _voiceWavCache.has(attachmentId)) {
        wavPath = _voiceWavCache.get(attachmentId);
        if (!fs.existsSync(wavPath)) {
          _voiceWavCache.delete(attachmentId);
          wavPath = undefined;
        } else {
          process.stderr.write(`mixdog: voice.transcription wav cache hit (${attachmentId})\n`);
        }
      }
      if (!wavPath) {
        wavPath = audioPath.replace(/\.[^.]+$/, ".wav");
        const sampleRate = config.voice?.transcription?.sampleRate ?? 16000;
        const channels = config.voice?.transcription?.channels ?? 1;
        // Single-flight: parallel callers for the same key share one ffmpeg spawn.
        const _ffmpegKey = attachmentId || wavPath;
        if (_voiceFfmpegInflight.has(_ffmpegKey)) {
          await _voiceFfmpegInflight.get(_ffmpegKey);
        } else {
          const _ffmpegPromise = runCmd(ffmpegPath, ["-i", audioPath, "-ar", String(sampleRate), "-ac", String(channels), "-threads", String(threadCount), "-y", wavPath]);
          _voiceFfmpegInflight.set(_ffmpegKey, _ffmpegPromise);
          try {
            await _ffmpegPromise;
            if (attachmentId) _voiceWavCache.set(attachmentId, wavPath);
          } finally {
            _voiceFfmpegInflight.delete(_ffmpegKey);
          }
        }
      }
      process.stderr.write(`mixdog: voice.transcription start runtime=${runtime.kind} cmd=${path.basename(whisperCmd)}\n`);
      await ensureReady({ serverCmd: runtime.serverCmd, modelPath, threadCount, host: '127.0.0.1' });
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

  return { isVoiceAttachment, transcribeVoice };
}

export { isVoiceAttachment, runCmd, createVoiceTranscription };
