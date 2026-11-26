package io.mixdog.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.media.MediaRecorder;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONObject;

/**
 * The composer's dictation recorder (renderer native-dictation.ts). The WebView's getUserMedia
 * switches the phone into voice-call audio mode before it opens a processed input, which takes up
 * to seconds, and every word said meanwhile was lost; an AudioRecord captures from the tap.
 *
 * <p>Calls (JSON replies): `startDictation {take}` → true once capturing (false: no permission or
 * no mic; the page then uses getUserMedia), `stopDictation {take}` → `{data, mimeType}` (AAC in
 * MP4, base64) or null without audio, `cancelDictation {take}` → true. While capturing,
 * `mixdognativedictation` events carry `{take, type: "level", level}` per captured block (the
 * first one means audio is flowing) and `{take, type: "ended"}` when the mic stops on its own.
 */
final class MixdogDictation {
  interface Reply {
    void send(String resultJson);
  }

  interface Events {
    void emit(JSONObject detail);
  }

  private static final int RATE = 16_000;
  private static final int BLOCK_BYTES = RATE / 25 * 2;
  // The page stops a take at 120 s; this only bounds memory when it never does.
  private static final int MAX_BYTES = RATE * 2 * 130;

  private static final class Take {
    final int id;
    final AudioRecord record;
    final ByteArrayOutputStream pcm = new ByteArrayOutputStream();
    volatile boolean running = true;
    Thread reader;

    Take(int id, AudioRecord record) {
      this.id = id;
      this.record = record;
    }
  }

  private final Context context;
  private final Events events;
  private final ExecutorService executor =
      Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "mixdog-dictation"));
  // Touched on the executor only.
  private Take active;

  MixdogDictation(Context context, Events events) {
    this.context = context;
    this.events = events;
  }

  static boolean handles(String method) {
    switch (method) {
      case "startDictation":
      case "stopDictation":
      case "cancelDictation":
        return true;
      default:
        return false;
    }
  }

  /** `reply` receives the JSON result off the UI thread; the call never throws. */
  void handle(String method, JSONObject args, Reply reply) {
    int take = args.optInt("take", -1);
    try {
      executor.execute(
          () -> {
            String result;
            try {
              switch (method) {
                case "startDictation":
                  result = start(take) ? "true" : "false";
                  break;
                case "stopDictation":
                  result = stop(take);
                  break;
                default:
                  result = cancel(take) ? "true" : "false";
              }
            } catch (Exception e) {
              result = "null";
            }
            reply.send(result);
          });
    } catch (RejectedExecutionException e) {
      reply.send("null");
    }
  }

  /** The page that owned the take is gone: its mic is released. */
  void reset() {
    try {
      executor.execute(
          () -> {
            if (active != null) finish(active);
            active = null;
          });
    } catch (RejectedExecutionException ignored) {
      // Already closed.
    }
  }

  void close() {
    reset();
    executor.shutdown();
  }

  private boolean start(int id) {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) return false;
    if (active != null) finish(active);
    active = null;
    int minimum =
        AudioRecord.getMinBufferSize(
            RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
    if (minimum <= 0) return false;
    AudioRecord record =
        new AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            Math.max(minimum, BLOCK_BYTES * 4));
    if (record.getState() != AudioRecord.STATE_INITIALIZED) {
      record.release();
      return false;
    }
    try {
      record.startRecording();
    } catch (IllegalStateException e) {
      record.release();
      return false;
    }
    if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
      record.release();
      return false;
    }
    Take take = new Take(id, record);
    take.reader = new Thread(() -> capture(take), "mixdog-dictation-capture");
    take.reader.start();
    active = take;
    return true;
  }

  private void capture(Take take) {
    byte[] block = new byte[BLOCK_BYTES];
    while (take.running) {
      int read = take.record.read(block, 0, block.length);
      if (read < 0) {
        if (take.running) emit(take.id, "ended", -1);
        return;
      }
      if (read == 0) continue;
      if (take.pcm.size() < MAX_BYTES) take.pcm.write(block, 0, read);
      emit(take.id, "level", rms(block, read));
    }
  }

  private String stop(int id) throws Exception {
    Take take = active;
    if (take == null || take.id != id) return "null";
    active = null;
    byte[] pcm = finish(take);
    if (pcm.length < 2) return "null";
    File out = File.createTempFile("dictation-", ".m4a", context.getCacheDir());
    try {
      encodeAac(pcm, out);
      return new JSONObject()
          .put("data", Base64.encodeToString(readAll(out), Base64.NO_WRAP))
          .put("mimeType", "audio/mp4")
          .toString();
    } finally {
      //noinspection ResultOfMethodCallIgnored
      out.delete();
    }
  }

  private boolean cancel(int id) {
    if (active == null || active.id != id) return false;
    finish(active);
    active = null;
    return true;
  }

  private static byte[] finish(Take take) {
    take.running = false;
    try {
      take.record.stop();
    } catch (IllegalStateException ignored) {
      // Never started or already stopped.
    }
    try {
      take.reader.join();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
    take.record.release();
    return take.pcm.toByteArray();
  }

  private void emit(int take, String type, double level) {
    try {
      JSONObject detail = new JSONObject().put("take", take).put("type", type);
      if (level >= 0) detail.put("level", level);
      events.emit(detail);
    } catch (Exception ignored) {
      // The page is gone.
    }
  }

  /** Same scale as the page's own meter: RMS of samples in [-1, 1]. */
  private static double rms(byte[] block, int length) {
    int samples = length / 2;
    if (samples == 0) return 0;
    double sum = 0;
    for (int i = 0; i + 1 < length; i += 2) {
      double sample = (short) ((block[i] & 0xff) | (block[i + 1] << 8)) / 32768.0;
      sum += sample * sample;
    }
    return Math.sqrt(sum / samples);
  }

  /** 16 kHz mono PCM16 to AAC-LC in MP4, a container the host's transcription already reads. */
  private static void encodeAac(byte[] pcm, File out) throws IOException {
    MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, RATE, 1);
    format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
    format.setInteger(MediaFormat.KEY_BIT_RATE, 32_000);
    format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384);
    MediaCodec codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
    MediaMuxer muxer = null;
    try {
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
      codec.start();
      muxer = new MediaMuxer(out.getPath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
      MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
      int track = -1;
      int offset = 0;
      boolean inputDone = false;
      // Waits only after a pass that moved nothing, so encoding runs at codec speed.
      long waitUs = 0;
      while (true) {
        boolean progressed = false;
        if (!inputDone) {
          int input = codec.dequeueInputBuffer(0);
          if (input >= 0) {
            progressed = true;
            ByteBuffer buffer = codec.getInputBuffer(input);
            buffer.clear();
            int size = Math.min(buffer.remaining(), pcm.length - offset) & ~1;
            buffer.put(pcm, offset, size);
            long presentationUs = (offset / 2) * 1_000_000L / RATE;
            offset += size;
            inputDone = offset >= pcm.length - 1;
            codec.queueInputBuffer(
                input,
                0,
                size,
                presentationUs,
                inputDone ? MediaCodec.BUFFER_FLAG_END_OF_STREAM : 0);
          }
        }
        for (int output;
            (output = codec.dequeueOutputBuffer(info, waitUs)) != MediaCodec.INFO_TRY_AGAIN_LATER;
            waitUs = 0) {
          progressed = true;
          if (output == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            track = muxer.addTrack(codec.getOutputFormat());
            muxer.start();
          } else if (output >= 0) {
            ByteBuffer encoded = codec.getOutputBuffer(output);
            boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
            if (!config && info.size > 0 && track >= 0) {
              encoded.position(info.offset);
              encoded.limit(info.offset + info.size);
              muxer.writeSampleData(track, encoded, info);
            }
            codec.releaseOutputBuffer(output, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
              muxer.stop();
              return;
            }
          }
        }
        waitUs = progressed ? 0 : 10_000;
      }
    } finally {
      codec.release();
      if (muxer != null) muxer.release();
    }
  }

  private static byte[] readAll(File file) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (InputStream in = new FileInputStream(file)) {
      byte[] chunk = new byte[16_384];
      for (int read; (read = in.read(chunk)) > 0; ) bytes.write(chunk, 0, read);
    }
    return bytes.toByteArray();
  }
}
