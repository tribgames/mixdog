package io.mixdog.app;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Android self-update behind the native bridge: the APK is a GitHub Release
 * asset on `mobile-v*` tags. This class looks the release up (same selection as
 * the old JS check), downloads it with the system DownloadManager into the
 * app-specific `updates/` folder, verifies it (size, SHA-256 when GitHub
 * published one, package name, higher versionCode, same signing certificates)
 * and hands it to the system package installer. The download URL only ever
 * comes from the release lookup here, never from the web page. State is
 * persisted, so a download survives process death; every change calls
 * `onChange` (the web app listens for `mixdognativeupdate`).
 *
 * Statuses: idle, checking, up-to-date, available, downloading, ready,
 * needs-permission, installing, failed (+ error network|verify|storage|install).
 */
final class MixdogAppUpdater {
  private static final String PREFS = "mixdog_app_update";
  private static final String LAST_CHECK = "last_check";
  private static final String AVAILABLE = "available";
  private static final String TARGET = "target";
  private static final String DOWNLOAD_ID = "download_id";
  private static final String DISMISSED = "dismissed_version";
  private static final String AUTO = "auto_download";
  private static final String AUTO_BLOCKED = "auto_blocked_version";

  private static final String RELEASES_API = "https://api.github.com/repos/tribgames/mixdog/releases?per_page=20";
  private static final String DOWNLOAD_PREFIX = "https://github.com/tribgames/mixdog/releases/download/";
  private static final String TAG_PREFIX = "mobile-v";
  private static final String UPDATES_DIR = "updates";
  // The relay (same default origin as the desktop) names the newest published
  // version; GitHub's 60/h anonymous limit is only touched when that is newer
  // than the installed app, or as a once-an-hour fallback if the relay is down.
  private static final String RELAY_LATEST = "https://192-255-139-161.sslip.io/app/latest.json";
  private static final String GITHUB_CHECK = "github_check";
  private static final long CHECK_INTERVAL_MS = 10L * 60 * 1000;
  private static final long GITHUB_FALLBACK_MS = 60L * 60 * 1000;
  // Progress reaches the web app at most ~4 times a second.
  private static final long POLL_MS = 250;
  private static final int MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

  // One release lookup per process, whichever updater instance (activity
  // recreation) asked; its result goes to the newest instance.
  private static final AtomicBoolean LOOKUP_RUNNING = new AtomicBoolean(false);
  private static volatile MixdogAppUpdater active = null;

  private static final ScheduledExecutorService WORK =
      Executors.newSingleThreadScheduledExecutor(
          runnable -> {
            Thread thread = new Thread(runnable, "mixdog-app-update");
            thread.setDaemon(true);
            return thread;
          });

  /** A published APK: what the release lookup found. */
  static final class Release {
    final String version;
    final String url;
    final long size; // 0 = not published
    final String digest; // lowercase sha256 hex, "" = not published

    Release(String version, String url, long size, String digest) {
      this.version = version;
      this.url = url;
      this.size = size;
      this.digest = digest;
    }

    JSONObject toJson() throws JSONException {
      return new JSONObject().put("version", version).put("url", url).put("size", size).put("digest", digest);
    }

    static Release fromJson(String json) {
      try {
        JSONObject o = new JSONObject(json);
        return new Release(o.getString("version"), o.getString("url"), o.optLong("size", 0), o.optString("digest", ""));
      } catch (JSONException e) {
        return null;
      }
    }
  }

  private final MainActivity activity;
  private final Context context;
  private final Runnable onChange;
  private final String installed;

  private String status = "idle";
  private String error = null;
  private Release available = null; // newest release found by the last lookup
  private Release target = null; // the release being downloaded / ready
  private long downloadId = -1;
  private long received = 0;
  private long total = 0;
  // Bumped whenever a download is (re)scheduled or dropped: a poll or
  // verification carries the number it started with and exits when it is stale.
  private long pollGeneration = 0;
  private boolean installerLaunched = false;
  private boolean closed = false;
  private boolean foreground = false;
  private boolean auto = false; // the current download was started automatically
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final Runnable tick = this::tick;
  // The last finished lookup: when, and "network" if it failed (cleared by a success).
  private String lastCheckError = null;
  private long lastCheckAt = 0;

  MixdogAppUpdater(MainActivity activity, Runnable onChange) {
    this.activity = activity;
    this.context = activity.getApplicationContext();
    this.onChange = onChange;
    this.installed = installedVersionName();
    SharedPreferences prefs = prefs();
    available = Release.fromJson(prefs.getString(AVAILABLE, ""));
    if (available != null && compareVersions(available.version, installed) <= 0) {
      available = null;
      prefs.edit().remove(AVAILABLE).apply();
    }
    target = Release.fromJson(prefs.getString(TARGET, ""));
    downloadId = prefs.getLong(DOWNLOAD_ID, -1);
    // The update was installed (or a newer build sideloaded): nothing to resume.
    if (target != null && (downloadId < 0 || compareVersions(target.version, installed) <= 0)) dropDownload();
    if (target != null) {
      auto = prefs.getBoolean(AUTO, false);
      status = "downloading";
      total = target.size;
    } else if (available != null) {
      status = "available";
    } else if (prefs.getLong(LAST_CHECK, 0) > 0) {
      status = "up-to-date";
    }
    active = this;
    WORK.execute(this::startupCleanup);
  }

  /** Under the lock, so the retained target is whatever is current now and a
   *  `start()` in between is never wiped. */
  private synchronized void startupCleanup() {
    if (closed) return;
    cleanup(target == null ? null : target.version);
    schedulePoll();
  }

  void close() {
    synchronized (this) {
      closed = true;
      foreground = false;
      handler.removeCallbacks(tick);
    }
  }

  // ---- bridge calls ----

  synchronized JSONObject get(boolean check) throws JSONException {
    boolean idle =
        "idle".equals(status)
            || "up-to-date".equals(status)
            || "available".equals(status)
            || "failed".equals(status)
            || "checking".equals(status);
    long now = System.currentTimeMillis();
    long last = prefs().getLong(LAST_CHECK, 0);
    if (idle && (check || now < last || now - last >= CHECK_INTERVAL_MS)) beginLookup(check);
    return state();
  }

  synchronized JSONObject start() throws JSONException {
    if (available == null || !("available".equals(status) || "failed".equals(status))) return state();
    startDownload(false);
    return state();
  }

  /** Enqueue the download of `available` (the verified path is the same for a tap and for an automatic start). */
  private void startDownload(boolean automatic) throws JSONException {
    File dir = updatesDir();
    if (dir == null) {
      fail("storage");
      return;
    }
    dropDownload();
    try {
      DownloadManager.Request request =
          new DownloadManager.Request(Uri.parse(available.url))
              .setTitle("Mixdog " + available.version)
              .setMimeType(FileSaveSessions.APK_MIME)
              .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
              .setDestinationInExternalFilesDir(context, null, UPDATES_DIR + "/" + fileName(available.version));
      downloadId = downloads().enqueue(request);
    } catch (RuntimeException e) {
      fail("storage");
      return;
    }
    target = available;
    auto = automatic;
    received = 0;
    total = target.size;
    prefs()
        .edit()
        .putString(TARGET, target.toJson().toString())
        .putLong(DOWNLOAD_ID, downloadId)
        .putBoolean(AUTO, automatic)
        .apply();
    status = "downloading";
    error = null;
    changed();
    schedulePoll();
  }

  /** Never auto-download this version again (explicit cancel, or its auto-download failed verification). */
  private void blockAuto(String version) {
    prefs().edit().putString(AUTO_BLOCKED, version).apply();
  }

  synchronized JSONObject cancel() throws JSONException {
    if ("installing".equals(status)) return state();
    boolean busy =
        "downloading".equals(status)
            || "ready".equals(status)
            || "needs-permission".equals(status)
            || "failed".equals(status);
    if (busy) {
      Release shown = target != null ? target : available;
      if (shown != null) blockAuto(shown.version);
    }
    dropDownload();
    if (busy) {
      status = available != null ? "available" : "idle";
      error = null;
      changed();
    }
    return state();
  }

  synchronized JSONObject install() throws JSONException {
    if (!"ready".equals(status) && !"needs-permission".equals(status)) return state();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.getPackageManager().canRequestPackageInstalls()) {
      status = "needs-permission";
      error = null;
      changed();
      Intent settings =
          new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
      activity.runOnUiThread(
          () -> {
            try {
              activity.startActivity(settings);
            } catch (ActivityNotFoundException e) {
              synchronized (this) {
                if ("needs-permission".equals(status)) fail("install");
              }
            }
          });
      return state();
    }
    status = "installing";
    error = null;
    installerLaunched = false;
    changed();
    final Release release = target;
    WORK.execute(() -> installNow(release));
    return state();
  }

  synchronized JSONObject dismiss(String version) throws JSONException {
    if (!version.isEmpty()) {
      prefs().edit().putString(DISMISSED, version).apply();
      changed();
    }
    return state();
  }

  synchronized boolean openInBrowser() {
    Release release = target != null ? target : available;
    if (release == null) return false;
    try {
      activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(release.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      return true;
    } catch (ActivityNotFoundException e) {
      return false;
    }
  }

  /** Delay until the next foreground check: the time left of the interval, a full interval when that makes no sense (clock moved). */
  static long nextCheckDelay(long lastCheck, long now) {
    long due = lastCheck + CHECK_INTERVAL_MS - now;
    return due > 0 && due < CHECK_INTERVAL_MS ? due : CHECK_INTERVAL_MS;
  }

  /** Foreground timer (main thread): the throttled `get(false)` check, then again when it is due. */
  private synchronized void tick() {
    if (closed || !foreground) return;
    try {
      get(false);
    } catch (JSONException e) {
      // state() only fails on a JSON key problem; nothing to report.
    }
    handler.postDelayed(tick, nextCheckDelay(prefs().getLong(LAST_CHECK, 0), System.currentTimeMillis()));
  }

  /** The activity left the foreground: stop the timer. */
  synchronized void onPause() {
    foreground = false;
    handler.removeCallbacks(tick);
  }

  /** Back from the unknown-sources settings or from the system installer; also the foreground check. */
  synchronized void onResume() {
    foreground = true;
    handler.removeCallbacks(tick);
    tick();
    if ("needs-permission".equals(status)) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.getPackageManager().canRequestPackageInstalls()) {
        status = "ready";
      }
      changed();
    } else if ("installing".equals(status) && installerLaunched) {
      // The installer closed without replacing the app (cancelled or failed).
      installerLaunched = false;
      status = "ready";
      changed();
    }
  }

  // ---- state ----

  private synchronized JSONObject state() throws JSONException {
    JSONObject json = new JSONObject().put("status", status).put("installed", installed);
    Release shown = target != null ? target : available;
    if (shown != null) {
      json.put("version", shown.version);
      if (shown.version.equals(prefs().getString(DISMISSED, ""))) json.put("dismissed", true);
    }
    if (target != null) {
      if (auto) json.put("auto", true);
      json.put("receivedBytes", received);
      long totalBytes = total > 0 ? total : target.size;
      if (totalBytes > 0) json.put("totalBytes", totalBytes);
    }
    if ("failed".equals(status) && error != null) json.put("error", error);
    if (lastCheckError != null) json.put("lastCheckError", lastCheckError).put("lastCheckAt", lastCheckAt);
    return json;
  }

  private void changed() {
    if (!closed) onChange.run();
  }

  private void fail(String reason) {
    status = "failed";
    error = reason;
    changed();
  }

  private SharedPreferences prefs() {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private DownloadManager downloads() {
    return (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
  }

  private String installedVersionName() {
    try {
      String name = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
      return name == null ? "" : name;
    } catch (PackageManager.NameNotFoundException e) {
      return "";
    }
  }

  // ---- release lookup ----

  private void beginLookup(boolean manual) {
    if (manual && !"checking".equals(status)) {
      status = "checking";
      error = null;
      changed();
    }
    if (!LOOKUP_RUNNING.compareAndSet(false, true)) return;
    // The attempt counts from now: a restart mid-lookup must not fire another.
    prefs().edit().putLong(LAST_CHECK, System.currentTimeMillis()).commit();
    WORK.execute(
        () -> {
          Release found = null;
          boolean ok = true;
          try {
            found = lookup();
          } catch (Exception e) {
            ok = false;
          }
          LOOKUP_RUNNING.set(false);
          MixdogAppUpdater latest = active;
          if (latest != null) latest.finishLookup(found, ok);
        });
  }

  private synchronized void finishLookup(Release found, boolean ok) {
    if (closed) return;
    if (target != null || "ready".equals(status) || "installing".equals(status) || "needs-permission".equals(status)) {
      return; // a download took over meanwhile
    }
    if (!ok) {
      // A background lookup that fails keeps the status (a manual one reports
      // it) but is recorded for `state()`.
      lastCheckError = "network";
      lastCheckAt = System.currentTimeMillis();
      if ("checking".equals(status)) fail("network");
      else changed();
      return;
    }
    boolean hadError = lastCheckError != null;
    lastCheckError = null;
    lastCheckAt = System.currentTimeMillis();
    boolean same = found == null ? available == null : available != null && available.version.equals(found.version);
    available = found;
    if (found == null) prefs().edit().remove(AVAILABLE).apply();
    else {
      try {
        prefs().edit().putString(AVAILABLE, found.toJson().toString()).apply();
      } catch (JSONException e) {
        // Not persisted: the next lookup finds it again.
      }
    }
    String next = found == null ? "up-to-date" : "available";
    if (!same || !next.equals(status)) {
      status = next;
      error = null;
      changed();
    } else if (hadError) {
      changed();
    }
    // Download by itself; the user still taps Install. `dismissed` only hides the toast.
    if (found != null && "available".equals(status) && !found.version.equals(prefs().getString(AUTO_BLOCKED, ""))) {
      try {
        startDownload(true);
      } catch (JSONException e) {
        // Not started: the next lookup tries again.
      }
    }
  }

  /**
   * The relay is asked every interval (it is not rate limited); GitHub only when
   * the relay reports a newer version, or, with the relay unreachable, at most
   * once per GITHUB_FALLBACK_MS. The relay answer is only a hint: the release
   * itself still comes from the GitHub lookup and is verified as before.
   */
  private Release lookup() throws Exception {
    String relayVersion = null; // null = relay unavailable
    try {
      relayVersion = relayLatestVersion();
    } catch (Exception e) {
      // Unreachable, 404 (old relay or no release known), any non-200 or a bad body.
    }
    switch (planLookup(relayVersion, installed, System.currentTimeMillis(), prefs().getLong(GITHUB_CHECK, 0))) {
      case PLAN_GITHUB:
        return githubLookup();
      case PLAN_UP_TO_DATE:
        return null;
      default:
        throw new IOException("relay unavailable, GitHub fallback not due");
    }
  }

  private static final int PLAN_UP_TO_DATE = 0;
  private static final int PLAN_GITHUB = 1;
  private static final int PLAN_SKIP = 2;

  /**
   * What a lookup does. relayVersion is the version from a valid 200 relay
   * answer, or null when the relay is unavailable (unreachable, 404, any other
   * non-200, malformed body).
   *  - valid answer, not newer than installed -> PLAN_UP_TO_DATE (no GitHub call)
   *  - valid answer, newer                    -> PLAN_GITHUB
   *  - unavailable, last GitHub call >= 1 h ago (or clock went back) -> PLAN_GITHUB
   *  - unavailable, last GitHub call < 1 h ago -> PLAN_SKIP (counts as a failed check)
   */
  static int planLookup(String relayVersion, String installedVersion, long now, long lastGithubCheck) {
    if (relayVersion != null) {
      return compareVersions(relayVersion, installedVersion) > 0 ? PLAN_GITHUB : PLAN_UP_TO_DATE;
    }
    boolean recent = now >= lastGithubCheck && now - lastGithubCheck < GITHUB_FALLBACK_MS;
    return recent ? PLAN_SKIP : PLAN_GITHUB;
  }

  /** The version from a valid 200 relay answer; throws on anything else (404 included) so the caller treats the relay as unavailable. */
  private String relayLatestVersion() throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(RELAY_LATEST).openConnection();
    try {
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(10_000);
      connection.setReadTimeout(15_000);
      connection.setRequestProperty("Accept", "application/json");
      connection.setRequestProperty("User-Agent", "MixdogApp/" + installed);
      int code = connection.getResponseCode();
      if (code != 200) throw new IOException("HTTP " + code);
      String version = parseRelayLatest(readBody(connection));
      if (version == null) throw new IOException("bad relay answer");
      return version;
    } finally {
      connection.disconnect();
    }
  }

  /** The version of a well-formed relay answer (version matches the strict APK url), else null. */
  static String parseRelayLatest(String json) {
    try {
      JSONObject o = new JSONObject(json);
      String version = o.optString("version", "");
      String url = o.optString("url", "");
      if (!version.matches("\\d+\\.\\d+\\.\\d+")) return null;
      if (!url.matches(
          Pattern.quote(DOWNLOAD_PREFIX + TAG_PREFIX + version + "/") + "[A-Za-z0-9_.-]+\\.apk")) {
        return null;
      }
      return version;
    } catch (JSONException e) {
      return null;
    }
  }

  private Release githubLookup() throws Exception {
    prefs().edit().putLong(GITHUB_CHECK, System.currentTimeMillis()).commit();
    HttpURLConnection connection = (HttpURLConnection) new URL(RELEASES_API).openConnection();
    try {
      connection.setConnectTimeout(10_000);
      connection.setReadTimeout(15_000);
      connection.setRequestProperty("Accept", "application/vnd.github+json");
      connection.setRequestProperty("User-Agent", "MixdogApp/" + installed);
      if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
      return pick(new JSONArray(readBody(connection)), installed);
    } finally {
      connection.disconnect();
    }
  }

  private static String readBody(HttpURLConnection connection) throws IOException {
    try (InputStream in = connection.getInputStream()) {
      ByteArrayOutputStream body = new ByteArrayOutputStream();
      byte[] buffer = new byte[16 * 1024];
      int n;
      while ((n = in.read(buffer)) > 0) {
        body.write(buffer, 0, n);
        if (body.size() > MAX_RESPONSE_BYTES) throw new IOException("response too large");
      }
      return new String(body.toByteArray(), StandardCharsets.UTF_8);
    }
  }

  /** The newest published `mobile-v*` release with a GitHub-hosted APK that is newer than the installed version. */
  static Release pick(JSONArray releases, String installedVersion) {
    Release best = null;
    for (int i = 0; i < releases.length(); i++) {
      JSONObject release = releases.optJSONObject(i);
      if (release == null || release.optBoolean("draft", false) || release.optBoolean("prerelease", false)) continue;
      String tag = release.optString("tag_name", "");
      if (!tag.startsWith(TAG_PREFIX)) continue;
      String version = tag.substring(TAG_PREFIX.length());
      if (!version.matches("\\d+(\\.\\d+)*")) continue;
      JSONObject apk = null;
      JSONArray assets = release.optJSONArray("assets");
      for (int j = 0; assets != null && j < assets.length() && apk == null; j++) {
        JSONObject asset = assets.optJSONObject(j);
        if (asset != null
            && asset.optString("name", "").endsWith(".apk")
            && asset.optString("browser_download_url", "").startsWith(DOWNLOAD_PREFIX)) {
          apk = asset;
        }
      }
      if (apk == null) continue;
      if (compareVersions(version, installedVersion) <= 0) continue;
      if (best != null && compareVersions(version, best.version) <= 0) continue;
      String digest = apk.optString("digest", "");
      best =
          new Release(
              version,
              apk.optString("browser_download_url"),
              Math.max(0, apk.optLong("size", 0)),
              digest.matches("(?i)sha256:[0-9a-f]{64}") ? digest.substring(7).toLowerCase() : "");
    }
    return best;
  }

  /** Numeric dotted compare; a non-numeric or missing part counts as 0. */
  static int compareVersions(String left, String right) {
    String[] a = left.split("\\.");
    String[] b = right.split("\\.");
    for (int i = 0; i < Math.max(a.length, b.length); i++) {
      long x = i < a.length ? leadingNumber(a[i]) : 0;
      long y = i < b.length ? leadingNumber(b[i]) : 0;
      if (x != y) return x < y ? -1 : 1;
    }
    return 0;
  }

  private static long leadingNumber(String part) {
    int end = 0;
    while (end < part.length() && end < 18 && part.charAt(end) >= '0' && part.charAt(end) <= '9') end++;
    return end == 0 ? 0 : Long.parseLong(part.substring(0, end));
  }

  // ---- download ----

  private static String fileName(String version) {
    return "mixdog-" + version + ".apk";
  }

  private File updatesDir() {
    File base = context.getExternalFilesDir(null);
    if (base == null) return null;
    File dir = new File(base, UPDATES_DIR);
    return dir.isDirectory() || dir.mkdirs() ? dir : null;
  }

  /** Forget the download (and its file); lookup results stay. */
  private void dropDownload() {
    if (downloadId >= 0) {
      try {
        downloads().remove(downloadId);
      } catch (RuntimeException e) {
        // Already gone.
      }
    }
    downloadId = -1;
    target = null;
    auto = false;
    pollGeneration++;
    received = 0;
    total = 0;
    prefs().edit().remove(TARGET).remove(DOWNLOAD_ID).remove(AUTO).apply();
    cleanup(null);
  }

  /** Delete every APK in `updates/` except the one for `keepVersion`. */
  private void cleanup(String keepVersion) {
    File dir = updatesDir();
    File[] files = dir == null ? null : dir.listFiles();
    if (files == null) return;
    for (File file : files) {
      if (keepVersion == null || !file.getName().equals(fileName(keepVersion))) file.delete();
    }
  }

  /** Start polling the current download; any earlier poll becomes stale. */
  private synchronized void schedulePoll() {
    if (closed || !"downloading".equals(status)) return;
    final long generation = ++pollGeneration;
    WORK.execute(() -> poll(generation));
  }

  /** One DownloadManager query; reschedules itself while the download runs. */
  private void poll(long generation) {
    long id;
    synchronized (this) {
      if (closed || generation != pollGeneration || !"downloading".equals(status)) return;
      id = downloadId;
    }
    int downloadStatus = -1; // -1: the entry no longer exists
    int reason = 0;
    long got = 0;
    long all = -1;
    Cursor cursor = downloads().query(new DownloadManager.Query().setFilterById(id));
    try {
      if (cursor != null && cursor.moveToFirst()) {
        downloadStatus = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
        reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
        got = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
        all = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
      }
    } finally {
      if (cursor != null) cursor.close();
    }
    synchronized (this) {
      if (closed || generation != pollGeneration || !"downloading".equals(status)) return;
      if (downloadStatus == -1) {
        // Removed outside the app (system Downloads UI).
        dropDownload();
        status = available != null ? "available" : "idle";
        changed();
        return;
      }
      if (downloadStatus == DownloadManager.STATUS_FAILED) {
        dropDownload();
        fail(
            reason == DownloadManager.ERROR_INSUFFICIENT_SPACE
                    || reason == DownloadManager.ERROR_DEVICE_NOT_FOUND
                    || reason == DownloadManager.ERROR_FILE_ERROR
                ? "storage"
                : "network");
        return;
      }
      if (all > 0) total = all;
      if (downloadStatus == DownloadManager.STATUS_SUCCESSFUL) {
        got = total > 0 ? total : got;
      }
      if (got != received) {
        received = got;
        changed();
      }
      if (downloadStatus != DownloadManager.STATUS_SUCCESSFUL) {
        WORK.schedule(() -> poll(generation), POLL_MS, TimeUnit.MILLISECONDS);
        return;
      }
    }
    verifyDownloaded(generation);
  }

  private void verifyDownloaded(long generation) {
    Release release;
    synchronized (this) {
      if (closed || generation != pollGeneration) return;
      release = target;
    }
    boolean ok = release != null && verify(release, new File(updatesDir(), fileName(release.version)));
    synchronized (this) {
      if (closed || generation != pollGeneration || !"downloading".equals(status)) return;
      if (ok) {
        status = "ready";
        error = null;
      } else {
        if (auto) blockAuto(release.version);
        dropDownload();
        status = "failed";
        error = "verify";
      }
      changed();
    }
  }

  // ---- verify + install ----

  private void installNow(Release release) {
    File dir = updatesDir();
    File file = release == null || dir == null ? null : new File(dir, fileName(release.version));
    // Checked again right before install: the file sits in storage other apps
    // may write to on older releases.
    boolean ok = file != null && verify(release, file);
    synchronized (this) {
      if (closed || !"installing".equals(status)) return;
      if (!ok) {
        if (auto && release != null) blockAuto(release.version);
        dropDownload();
        status = "failed";
        error = "verify";
        changed();
        return;
      }
    }
    Intent intent;
    try {
      Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
      intent =
          new Intent(Intent.ACTION_VIEW)
              .setDataAndType(uri, FileSaveSessions.APK_MIME)
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    } catch (IllegalArgumentException e) {
      synchronized (this) {
        if ("installing".equals(status)) fail("install");
      }
      return;
    }
    final Intent launch = intent;
    activity.runOnUiThread(
        () -> {
          synchronized (this) {
            if (!"installing".equals(status)) return;
            try {
              activity.startActivity(launch);
              installerLaunched = true;
            } catch (RuntimeException e) {
              fail("install");
            }
          }
        });
  }

  @SuppressWarnings("deprecation")
  private boolean verify(Release release, File file) {
    try {
      if (!file.isFile()) return false;
      if (release.size > 0 && file.length() != release.size) return false;
      if (!release.digest.isEmpty() && !release.digest.equals(sha256(file))) return false;
      PackageManager packages = context.getPackageManager();
      int flags =
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
              ? PackageManager.GET_SIGNING_CERTIFICATES
              : PackageManager.GET_SIGNATURES;
      PackageInfo archive = packages.getPackageArchiveInfo(file.getAbsolutePath(), flags);
      if (archive == null || !context.getPackageName().equals(archive.packageName)) return false;
      PackageInfo current = packages.getPackageInfo(context.getPackageName(), flags);
      if (PackageInfoCompat.getLongVersionCode(archive) <= PackageInfoCompat.getLongVersionCode(current)) {
        return false;
      }
      Set<Signature> signers = signers(archive);
      return !signers.isEmpty() && signers.equals(signers(current));
    } catch (Exception e) {
      return false;
    }
  }

  @SuppressWarnings("deprecation")
  private static Set<Signature> signers(PackageInfo info) {
    Signature[] list = null;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      SigningInfo signing = info.signingInfo;
      if (signing != null) list = signing.getApkContentsSigners();
    } else {
      list = info.signatures;
    }
    return list == null ? new HashSet<>() : new HashSet<>(Arrays.asList(list));
  }

  private static String sha256(File file) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (InputStream in = new FileInputStream(file)) {
      byte[] buffer = new byte[64 * 1024];
      int n;
      while ((n = in.read(buffer)) > 0) digest.update(buffer, 0, n);
    }
    StringBuilder hex = new StringBuilder();
    for (byte b : digest.digest()) hex.append(String.format("%02x", b));
    return hex.toString();
  }
}
