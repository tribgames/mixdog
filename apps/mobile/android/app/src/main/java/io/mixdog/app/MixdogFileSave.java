package io.mixdog.app;

import android.content.BroadcastReceiver;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.app.PendingIntent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * Native save sink for files the phone page downloaded (the Android half of
 * shared/native-file-save.ts; rules and error codes live in FileSaveSessions).
 *
 * Android 10+ (API 29+): a pending `MediaStore.Downloads` entry
 * (`Download/Mixdog/`, IS_PENDING=1) is written through its file descriptor
 * and published (IS_PENDING=0) only by finish; abort / any failure deletes the
 * pending entry. Below API 29 (minSdk is 23) the app-specific external files
 * dir (`Download/`, no storage permission) is used instead: a `.part` file
 * renamed on finish, shared through the existing FileProvider (`downloads`
 * entry in file_paths.xml). Those files are private to the app and removed on
 * uninstall; the share sheet is how the user gets them out.
 *
 * All storage work runs on one background thread (never the UI thread), so
 * writes stay ordered; every chunk is fsync'd before it is acknowledged.
 * Validation failures (bad offset, overflow, bad base64) leave the handle
 * open for the page to abort; storage / I/O failures delete the partial file
 * and invalidate the handle. Handles belong to the page that began them:
 * navigating the WebView (or destroying the activity) aborts them. An APK is
 * opened in the package installer instead of the share sheet.
 */
final class MixdogFileSave {
  interface Reply {
    void send(String resultJson);
  }

  private static final String SUBDIR = "Mixdog";
  private static final String PART_SUFFIX = ".part";
  private static final long SHARE_SETTLE_MS = 700;
  private static final AtomicBoolean STARTUP_CLEANED = new AtomicBoolean(false);

  /** The platform side of one session. */
  private static final class Sink {
    String name;
    String mime;
    Uri uri; // API 29+: the MediaStore entry
    File part; // below API 29: the temp file
    File file; // below API 29: the published file
    FileOutputStream out;

    void discard(ContentResolver resolver) {
      closeQuietly();
      if (uri != null) {
        try {
          resolver.delete(uri, null, null);
        } catch (RuntimeException ignored) {
          // Already gone.
        }
      }
      if (part != null && !part.delete()) part.deleteOnExit();
    }

    void closeQuietly() {
      if (out == null) return;
      try {
        out.close();
      } catch (IOException ignored) {
        // Closing a failed stream.
      }
      out = null;
    }
  }

  /** A chooser on screen; resolved when the user comes back to the app. */
  private static final class Share {
    final Reply reply;
    BroadcastReceiver receiver;
    boolean chosen;

    Share(Reply reply) {
      this.reply = reply;
    }
  }

  private static boolean usesMediaStore() {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
  }

  static boolean handles(String method) {
    switch (method) {
      case "fileSaveBegin":
      case "fileSaveWrite":
      case "fileSaveFinish":
      case "fileSaveAbort":
      case "fileSaveShare":
        return true;
      default:
        return false;
    }
  }

  private final MainActivity activity;
  private final FileSaveSessions sessions = new FileSaveSessions();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService executor =
      Executors.newSingleThreadExecutor(
          runnable -> {
            Thread thread = new Thread(runnable, "mixdog-file-save");
            thread.setDaemon(true);
            return thread;
          });
  private Share pendingShare; // UI thread only

  MixdogFileSave(MainActivity activity) {
    this.activity = activity;
    // Once per process: every earlier session died with it, so any pending
    // entry still owned by the app is stale.
    if (STARTUP_CLEANED.compareAndSet(false, true)) submit(this::cleanStale, null);
  }

  /** The page that owns `owner` went away: drop its sessions and partial files. */
  void release(Object owner) {
    submit(() -> discardAll(sessions.take(owner)), null);
  }

  void onDestroy() {
    main.removeCallbacksAndMessages(null);
    resolveShare();
    submit(() -> discardAll(sessions.take(null)), null);
    executor.shutdown();
  }

  /** Back in the foreground: a chooser (if any) is gone — settle its result. */
  void onResume() {
    Share share = pendingShare;
    if (share == null) return;
    // The "chosen" broadcast can trail the activity resume slightly.
    main.postDelayed(
        () -> {
          if (pendingShare == share) resolveShare();
        },
        SHARE_SETTLE_MS);
  }

  /** `reply` receives the JSON result; the call never throws. */
  void handle(String method, JSONObject args, Object owner, Reply reply) {
    submit(
        () -> {
          switch (method) {
            case "fileSaveBegin":
              reply.send(begin(args, owner));
              break;
            case "fileSaveWrite":
              reply.send(write(args, owner));
              break;
            case "fileSaveFinish":
              reply.send(finish(args, owner));
              break;
            case "fileSaveAbort":
              reply.send(abort(args, owner));
              break;
            default:
              share(args, owner, reply);
          }
        },
        reply);
  }

  private void submit(Runnable work, Reply reply) {
    try {
      executor.execute(
          () -> {
            try {
              work.run();
            } catch (RuntimeException e) {
              if (reply != null) reply.send(error("storage"));
            }
          });
    } catch (RejectedExecutionException e) {
      if (reply != null) reply.send(error("unknown-handle"));
    }
  }

  private static String error(String code) {
    try {
      return new JSONObject().put("ok", false).put("error", code).toString();
    } catch (Exception e) {
      return "null";
    }
  }

  private static String ok(JSONObject body) {
    try {
      return body.put("ok", true).toString();
    } catch (Exception e) {
      return "null";
    }
  }

  private ContentResolver resolver() {
    return activity.getContentResolver();
  }

  // ---- begin -------------------------------------------------------------

  private String begin(JSONObject args, Object owner) {
    Long size = FileSaveSessions.exactLong(args.opt("size"));
    String bad = FileSaveSessions.checkBegin(size);
    if (bad != null) return error(bad);
    FileSaveSessions.Session session = sessions.open(owner, size);
    if (session == null) return error("storage");
    Sink sink = new Sink();
    sink.name = FileSaveSessions.sanitizeName(args.optString("name", ""));
    sink.mime = FileSaveSessions.sanitizeMime(args.optString("mime", ""));
    try {
      if (usesMediaStore()) openMediaStore(sink);
      else openAppFile(sink, size);
    } catch (SecurityException e) {
      sink.discard(resolver());
      sessions.remove(session);
      return error("permission");
    } catch (IOException | RuntimeException e) {
      sink.discard(resolver());
      sessions.remove(session);
      return error("storage");
    }
    session.target = sink;
    try {
      return ok(new JSONObject().put("handle", session.handle));
    } catch (Exception e) {
      return error("storage");
    }
  }

  private void openMediaStore(Sink sink) throws IOException {
    Uri uri;
    try {
      uri = insertPending(sink.name, sink.mime);
    } catch (IllegalArgumentException e) {
      // MediaStore refused the name / mime pairing: keep the bytes, drop the type.
      sink.mime = "application/octet-stream";
      uri = insertPending(sink.name, sink.mime);
    }
    if (uri == null) throw new IOException("MediaStore insert failed");
    sink.uri = uri;
    ParcelFileDescriptor fd = resolver().openFileDescriptor(uri, "w");
    if (fd == null) throw new IOException("no file descriptor");
    sink.out = new ParcelFileDescriptor.AutoCloseOutputStream(fd);
  }

  private Uri insertPending(String name, String mime) {
    ContentValues values = new ContentValues();
    values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
    values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + SUBDIR);
    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
    return resolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
  }

  private File appDir() throws IOException {
    File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
    if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) throw new IOException("no storage");
    return dir;
  }

  private void openAppFile(Sink sink, long size) throws IOException {
    File dir = appDir();
    // The quota is the declared size: refuse up front when the disk is short.
    if (dir.getUsableSpace() < size) throw new IOException("not enough space");
    sink.part = File.createTempFile(".mixdog-", PART_SUFFIX, dir);
    sink.out = new FileOutputStream(sink.part);
  }

  // ---- write / finish / abort ---------------------------------------------

  private String write(JSONObject args, Object owner) {
    FileSaveSessions.Session session = sessions.find(args.optString("handle", null), owner);
    if (session == null || !(session.target instanceof Sink)) return error("unknown-handle");
    Sink sink = (Sink) session.target;
    String data = args.optString("data", "");
    if (data.isEmpty() || data.length() > FileSaveSessions.MAX_BASE64_CHARS) return error("invalid");
    byte[] bytes;
    try {
      bytes = Base64.decode(data, Base64.DEFAULT);
    } catch (IllegalArgumentException e) {
      return error("invalid");
    }
    String bad = FileSaveSessions.checkWrite(session, FileSaveSessions.exactLong(args.opt("offset")), bytes.length);
    if (bad != null) return error(bad);
    try {
      sink.out.write(bytes);
      sink.out.flush();
      sink.out.getFD().sync(); // durable before the ack
    } catch (IOException | RuntimeException e) {
      sink.discard(resolver());
      sessions.remove(session);
      return error("storage");
    }
    session.written += bytes.length;
    try {
      return ok(new JSONObject().put("handle", session.handle).put("written", session.written));
    } catch (Exception e) {
      return error("storage");
    }
  }

  private String finish(JSONObject args, Object owner) {
    FileSaveSessions.Session session = sessions.find(args.optString("handle", null), owner);
    if (session == null || !(session.target instanceof Sink)) return error("unknown-handle");
    String bad = FileSaveSessions.checkFinish(session, FileSaveSessions.exactLong(args.opt("size")));
    if (bad != null) return error(bad);
    Sink sink = (Sink) session.target;
    try {
      sink.out.flush();
      sink.out.getFD().sync();
      sink.closeQuietly();
      String displayName = usesMediaStore() ? publishMediaStore(sink) : publishAppFile(sink);
      sink.name = displayName; // the name actually published; titles the share sheet
      sessions.markFinished(session);
      return ok(
          new JSONObject()
              .put("handle", session.handle)
              .put("displayName", displayName)
              .put("size", session.size)
              // API 29+: published MediaStore Downloads entry; below: app-private, reachable only via share.
              .put("persisted", usesMediaStore()));
    } catch (SecurityException e) {
      sink.discard(resolver());
      sessions.remove(session);
      return error("permission");
    } catch (Exception e) {
      sink.discard(resolver());
      sessions.remove(session);
      return error("storage");
    }
  }

  /** IS_PENDING=0; MediaStore may have de-duplicated the name. */
  private String publishMediaStore(Sink sink) throws IOException {
    ContentValues values = new ContentValues();
    values.put(MediaStore.MediaColumns.IS_PENDING, 0);
    if (resolver().update(sink.uri, values, null, null) < 1) throw new IOException("publish failed");
    try (Cursor cursor =
        resolver().query(sink.uri, new String[] {MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
      if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) return cursor.getString(0);
    }
    return sink.name;
  }

  private String publishAppFile(Sink sink) throws IOException {
    File dir = appDir();
    for (int n = 0; n < 1000; n++) {
      File target = new File(dir, n == 0 ? sink.name : FileSaveSessions.numberedName(sink.name, n));
      if (target.exists()) continue;
      if (!sink.part.renameTo(target)) throw new IOException("rename failed");
      sink.part = null;
      sink.file = target;
      return target.getName();
    }
    throw new IOException("no free name");
  }

  private String abort(JSONObject args, Object owner) {
    String handle = args.optString("handle", null);
    FileSaveSessions.Session session = sessions.find(handle, owner);
    // A finished file is already published: abort has nothing to undo.
    if (session == null || session.finished || !(session.target instanceof Sink)) return error("unknown-handle");
    ((Sink) session.target).discard(resolver());
    sessions.remove(session);
    try {
      return ok(new JSONObject().put("handle", session.handle));
    } catch (Exception e) {
      return error("storage");
    }
  }

  private void discardAll(List<FileSaveSessions.Session> taken) {
    for (FileSaveSessions.Session session : taken) {
      // Finished files stay (they are published); only partial ones go.
      if (!session.finished && session.target instanceof Sink) ((Sink) session.target).discard(resolver());
    }
  }

  // ---- share ----------------------------------------------------------------

  private void share(JSONObject args, Object owner, Reply reply) {
    FileSaveSessions.Session session = sessions.find(args.optString("handle", null), owner);
    if (session == null || !session.finished || !(session.target instanceof Sink)) {
      reply.send(error("unknown-handle"));
      return;
    }
    Sink sink = (Sink) session.target;
    Uri uri;
    try {
      uri =
          sink.uri != null
              ? sink.uri
              : FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", sink.file);
    } catch (RuntimeException e) {
      reply.send(error("storage"));
      return;
    }
    String mime = sink.mime;
    String name = sink.name;
    activity.runOnUiThread(() -> startShare(uri, mime, name, reply));
  }

  private void startShare(Uri uri, String mime, String name, Reply reply) {
    resolveShare(); // an older chooser is superseded
    if (FileSaveSessions.isApk(name, mime)) {
      startInstall(uri, reply);
      return;
    }
    Share share = new Share(reply);
    String action = activity.getPackageName() + ".FILE_SHARE_CHOSEN";
    share.receiver =
        new BroadcastReceiver() {
          @Override
          public void onReceive(Context context, Intent intent) {
            share.chosen = true;
          }
        };
    ContextCompat.registerReceiver(
        activity, share.receiver, new IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
    PendingIntent chosen =
        PendingIntent.getBroadcast(activity, 0, new Intent(action).setPackage(activity.getPackageName()), flags);
    // The sheet previews the clip / EXTRA_TITLE; without them it shows the MediaStore id.
    Intent send =
        new Intent(Intent.ACTION_SEND)
            .setType(mime)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .putExtra(Intent.EXTRA_TITLE, name)
            .putExtra(Intent.EXTRA_SUBJECT, name);
    send.setClipData(new ClipData(name, new String[] {mime}, new ClipData.Item(uri)));
    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    pendingShare = share;
    try {
      activity.startActivity(Intent.createChooser(send, name, chosen.getIntentSender()));
    } catch (ActivityNotFoundException | SecurityException e) {
      pendingShare = null;
      activity.unregisterReceiver(share.receiver);
      reply.send(error(e instanceof SecurityException ? "permission" : "invalid"));
    }
  }

  /** An APK goes straight to the package installer; opening it counts as handled. */
  private void startInstall(Uri uri, Reply reply) {
    Intent install =
        new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, FileSaveSessions.APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    try {
      activity.startActivity(install);
    } catch (ActivityNotFoundException | SecurityException e) {
      reply.send(error(e instanceof SecurityException ? "permission" : "invalid"));
      return;
    }
    sendShared(reply, true);
  }

  private void sendShared(Reply reply, boolean shared) {
    try {
      reply.send(ok(new JSONObject().put("shared", shared)));
    } catch (Exception ignored) {
      // The page is gone.
    }
  }

  /** Answer the pending chooser: dismissing it is a normal `shared: false`. */
  private void resolveShare() {
    Share share = pendingShare;
    if (share == null) return;
    pendingShare = null;
    try {
      activity.unregisterReceiver(share.receiver);
    } catch (IllegalArgumentException ignored) {
      // Already unregistered.
    }
    sendShared(share.reply, share.chosen);
  }

  // ---- startup cleanup --------------------------------------------------------

  private void cleanStale() {
    if (usesMediaStore()) {
      Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
      try (Cursor cursor =
          resolver()
              .query(
                  collection,
                  new String[] {MediaStore.MediaColumns._ID},
                  MediaStore.MediaColumns.OWNER_PACKAGE_NAME + "=? AND " + MediaStore.MediaColumns.IS_PENDING + "=1",
                  new String[] {activity.getPackageName()},
                  null)) {
        while (cursor != null && cursor.moveToNext()) {
          try {
            resolver().delete(ContentUris.withAppendedId(collection, cursor.getLong(0)), null, null);
          } catch (RuntimeException ignored) {
            // Best effort.
          }
        }
      } catch (RuntimeException ignored) {
        // Best effort.
      }
      return;
    }
    try {
      File[] stale = appDir().listFiles((dir, name) -> name.endsWith(PART_SUFFIX));
      if (stale != null) {
        for (File file : stale) {
          if (!file.delete()) file.deleteOnExit();
        }
      }
    } catch (IOException ignored) {
      // No storage, nothing to clean.
    }
  }
}
