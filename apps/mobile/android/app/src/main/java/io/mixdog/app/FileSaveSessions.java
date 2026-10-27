package io.mixdog.app;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The pure bookkeeping behind the native file-save sink (MixdogFileSave): the
 * handle table and every argument / offset / size rule of
 * shared/native-file-save.ts, with no Android types so it runs on a plain JVM
 * (scripts/test-origin-policy-java.mjs). Error codes are the contract's
 * `NativeFileSaveErrorCode` strings.
 *
 * A handle is minted here (128 random bits, base64url), is bound to the owner
 * (the page that began it) and is valid only for that owner. Open sessions
 * accept strictly sequential writes up to the declared size; once finished a
 * session only stays findable (for share), never writable.
 *
 * Share again: share never changes a session, so a finished handle answers any
 * number of fileSaveShare calls (e.g. after a dismissed chooser). It expires
 * when (a) its page changes / the activity is destroyed, (b) MAX_FINISHED
 * newer files finish and push it out (oldest first; finishing never evicts
 * the file just finished), or (c) the process dies. There is no timer.
 */
final class FileSaveSessions {
  static final long MAX_BYTES = 256L * 1024 * 1024; // FILE_DOWNLOAD_MAX_BYTES
  static final int MAX_CHUNK_BYTES = 1024 * 1024; // NATIVE_FILE_SAVE_MAX_CHUNK_BYTES
  static final int MAX_BASE64_CHARS = ((MAX_CHUNK_BYTES + 2) / 3) * 4;
  static final int MAX_OPEN = 4;
  static final int MAX_FINISHED = 4;

  static final String TOO_LARGE = "too-large";
  static final String OFFSET_MISMATCH = "offset-mismatch";
  static final String SIZE_MISMATCH = "size-mismatch";
  static final String UNKNOWN_HANDLE = "unknown-handle";
  static final String INVALID = "invalid";

  static final String APK_MIME = "application/vnd.android.package-archive";

  private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  private static final int MAX_NAME_CHARS = 120;

  static final class Session {
    final String handle;
    final Object owner;
    final long size;
    /** The platform sink (uri / file / streams); opaque here. */
    Object target;
    long written;
    boolean finished;

    Session(String handle, Object owner, long size) {
      this.handle = handle;
      this.owner = owner;
      this.size = size;
    }
  }

  private final SecureRandom random = new SecureRandom();
  private final Map<String, Session> sessions = new LinkedHashMap<>();

  /** An integral JSON number as a long, or null. */
  static Long exactLong(Object value) {
    if (!(value instanceof Number)) return null;
    double d = ((Number) value).doubleValue();
    long l = (long) d;
    return d == (double) l && !Double.isInfinite(d) ? Long.valueOf(l) : null;
  }

  /** null when the declared size may be saved. */
  static String checkBegin(Long size) {
    if (size == null || size < 0) return INVALID;
    return size > MAX_BYTES ? TOO_LARGE : null;
  }

  /** A file name that is safe on every device filesystem; never a path. */
  static String sanitizeName(String raw) {
    StringBuilder out = new StringBuilder();
    for (int i = 0; raw != null && i < raw.length(); i++) {
      char c = raw.charAt(i);
      boolean bad = c < 0x20 || c == 0x7f || "\\/:*?\"<>|".indexOf(c) >= 0;
      out.append(bad ? '_' : c);
    }
    String name = out.toString().trim();
    while (name.startsWith(".")) name = name.substring(1).trim();
    while (name.endsWith(".") || name.endsWith(" ")) name = name.substring(0, name.length() - 1);
    if (name.isEmpty()) return "download";
    if (name.length() > MAX_NAME_CHARS) {
      int dot = name.lastIndexOf('.');
      String ext = dot > 0 && name.length() - dot <= 16 ? name.substring(dot) : "";
      name = name.substring(0, MAX_NAME_CHARS - ext.length()) + ext;
    }
    return name;
  }

  /** An APK by stored MIME or by name; servers often send octet-stream for APKs. */
  static boolean isApk(String name, String mime) {
    return APK_MIME.equals(mime) || (name != null && name.toLowerCase(Locale.ROOT).endsWith(".apk"));
  }

  static String sanitizeMime(String raw) {
    String mime = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
    return mime.matches("[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}")
        ? mime
        : "application/octet-stream";
  }

  /** "name.ext" → "name (n).ext" for n >= 1. */
  static String numberedName(String name, int n) {
    int dot = name.lastIndexOf('.');
    if (dot <= 0) return name + " (" + n + ")";
    return name.substring(0, dot) + " (" + n + ")" + name.substring(dot);
  }

  /** Mint a handle and register an open session; null while too many are open. */
  synchronized Session open(Object owner, long size) {
    int open = 0;
    for (Session s : sessions.values()) if (!s.finished) open++;
    if (open >= MAX_OPEN) return null;
    byte[] bytes = new byte[16];
    random.nextBytes(bytes);
    String handle = base64Url(bytes);
    Session session = new Session(handle, owner, size);
    sessions.put(handle, session);
    return session;
  }

  /** The session for a handle, only for the owner that began it. */
  synchronized Session find(String handle, Object owner) {
    Session s = handle == null ? null : sessions.get(handle);
    return s != null && s.owner == owner ? s : null;
  }

  /** null when `length` bytes at `offset` may be appended. */
  static String checkWrite(Session s, Long offset, int length) {
    if (s.finished) return UNKNOWN_HANDLE;
    if (offset == null || offset < 0 || length <= 0 || length > MAX_CHUNK_BYTES) return INVALID;
    if (offset != s.written) return OFFSET_MISMATCH;
    return length > s.size - s.written ? TOO_LARGE : null;
  }

  /** null when every declared byte arrived. `declared` is the size restated by the page. */
  static String checkFinish(Session s, Long declared) {
    if (s.finished) return UNKNOWN_HANDLE;
    if (declared == null) return INVALID;
    return declared == s.size && s.written == s.size ? null : SIZE_MISMATCH;
  }

  synchronized void markFinished(Session s) {
    s.finished = true;
    int finished = 0;
    for (Session other : sessions.values()) if (other.finished) finished++;
    for (Iterator<Session> it = sessions.values().iterator(); finished > MAX_FINISHED && it.hasNext(); ) {
      if (it.next().finished) {
        it.remove();
        finished--;
      }
    }
  }

  synchronized void remove(Session s) {
    sessions.remove(s.handle);
  }

  /** Remove and return the sessions of `owner` (null = all). */
  synchronized List<Session> take(Object owner) {
    List<Session> taken = new ArrayList<>();
    for (Iterator<Session> it = sessions.values().iterator(); it.hasNext(); ) {
      Session s = it.next();
      if (owner == null || s.owner == owner) {
        taken.add(s);
        it.remove();
      }
    }
    return taken;
  }

  static String base64Url(byte[] bytes) {
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < bytes.length; i += 3) {
      int b0 = bytes[i] & 0xff;
      int b1 = i + 1 < bytes.length ? bytes[i + 1] & 0xff : 0;
      int b2 = i + 2 < bytes.length ? bytes[i + 2] & 0xff : 0;
      out.append(ALPHABET.charAt(b0 >> 2));
      out.append(ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4)));
      if (i + 1 < bytes.length) out.append(ALPHABET.charAt(((b1 & 15) << 2) | (b2 >> 6)));
      if (i + 2 < bytes.length) out.append(ALPHABET.charAt(b2 & 63));
    }
    return out.toString();
  }
}
