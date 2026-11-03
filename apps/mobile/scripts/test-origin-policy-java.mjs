// Runs the shared origin-policy cases (test-vectors/origin-policy.json) against
// the Android implementation (OriginPolicy.java, pure JDK) with javac + java.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cases = JSON.parse(readFileSync(join(root, 'test-vectors', 'origin-policy.json'), 'utf8'));
const j = (value) => (value === null ? 'null' : JSON.stringify(value));

const source = `package io.mixdog.app;
import java.util.*;
public class OriginPolicyCheck {
  static int failures = 0;
  static void eq(Object actual, Object expected, String label) {
    if (!Objects.equals(actual, expected)) { failures++; System.out.println("FAIL " + label + ": " + actual + " != " + expected); }
  }
  public static void main(String[] args) {
    Set<String> saved = new HashSet<>(Arrays.asList(${cases.saved.map(j).join(', ')}));
${cases.origin.map((c) => `    eq(OriginPolicy.originOf(${j(c.url)}), ${j(c.origin)}, ${j(c.url)});`).join('\n')}
${cases.allowed.map((c) => `    eq(OriginPolicy.isAllowed(${j(c.url)}, saved), ${c.allowed}, ${j(c.url)});`).join('\n')}
    List<Object> input = new ArrayList<>(); ${cases.sanitize.input.map((v) => `input.add(${typeof v === 'string' ? j(v) : 'null'});`).join(' ')}
    Set<String> expected = new HashSet<>(Arrays.asList(${cases.sanitize.output.map(j).join(', ')}));
    eq(OriginPolicy.sanitize(input), expected, "sanitize");
    if (failures > 0) System.exit(1);
    System.out.println("origin policy (java): ok");
  }
}
`;

const queueSource = `package io.mixdog.app;
import java.util.*;
public class QueueCheck {
  static int failures = 0;
  static void eq(Object actual, Object expected, String label) {
    if (!Objects.equals(actual, expected)) { failures++; System.out.println("FAIL " + label + ": " + actual + " != " + expected); }
  }
  static Map<String, String> entry(String id, String host, long createdAt) {
    Map<String, String> m = new HashMap<>();
    m.put("id", id); m.put("action", "allow"); m.put("sessionId", "s"); m.put("createdAt", String.valueOf(createdAt));
    if (host != null) m.put("hostId", host);
    return m;
  }
  static List<String> ids(List<Map<String, String>> q) {
    List<String> out = new ArrayList<>(); for (Map<String, String> e : q) out.add(e.get("id")); return out;
  }
  public static void main(String[] args) {
    long now = 1_000_000_000L;
    List<Map<String, String>> q = new ArrayList<>();
    q = PendingActionQueue.add(q, entry("a", "hostA", now), now);
    q = PendingActionQueue.add(q, entry("b", "hostB", now), now);
    q = PendingActionQueue.add(q, entry("c", null, now), now);
    q = PendingActionQueue.add(q, entry("a", "hostA", now), now);
    eq(ids(q), Arrays.asList("a", "b", "c"), "add is idempotent by id");
    eq(ids(PendingActionQueue.forHost(q, "hostA", now)), Arrays.asList("a", "c"), "host A sees own + unbound");
    eq(ids(PendingActionQueue.forHost(q, "hostB", now)), Arrays.asList("b", "c"), "host B sees own + unbound");
    eq(ids(PendingActionQueue.forHost(q, "", now)), Arrays.asList("c"), "unknown host sees unbound only");
    // peeking does not consume; only ack removes
    eq(ids(PendingActionQueue.forHost(q, "hostA", now)), Arrays.asList("a", "c"), "peek leaves entries");
    q = PendingActionQueue.ack(q, "a");
    eq(ids(q), Arrays.asList("b", "c"), "ack removes");
    eq(ids(PendingActionQueue.forHost(q, "hostA", now)), Arrays.asList("c"), "other host's action stays parked");
    long later = now + PendingActionQueue.TTL_MS + 1;
    eq(ids(PendingActionQueue.forHost(q, "hostB", later)), new ArrayList<String>(), "expired actions are not served");
    eq(ids(PendingActionQueue.add(q, entry("d", "hostA", later), later)), Arrays.asList("d"), "expired actions are pruned on add");
    List<Map<String, String>> many = new ArrayList<>();
    for (int i = 0; i < 12; i++) many = PendingActionQueue.add(many, entry("n" + i, "hostA", now), now);
    eq(many.size(), PendingActionQueue.MAX_PENDING, "queue is capped");
    eq(many.get(0).get("id"), "n4", "oldest dropped");
    Set<String> saved = new HashSet<>(Arrays.asList("https://relay.example.com"));
    eq(NavigationPolicy.allowMainFrame("https://relay.example.com/d/x/", saved), true, "saved origin");
    eq(NavigationPolicy.allowMainFrame("https://localhost/index.html", saved), true, "bundled origin");
    eq(NavigationPolicy.allowMainFrame("https://evil.example.net/login", saved), false, "POST target outside origins");
    eq(NavigationPolicy.allowMainFrame("https://relay.example.com.evil.net/", saved), false, "lookalike redirect target");
    eq(NavigationPolicy.allowMainFrame("http://relay.example.com/", saved), false, "downgrade redirect target");
    eq(NavigationPolicy.allowMainFrame("javascript:alert(1)", saved), false, "script url");
    eq(Arrays.toString(WebViewInsets.margins(12, 80, 12, 48, 0)), "[12, 80, 12, 48]", "closed keyboard keeps the bars");
    eq(Arrays.toString(WebViewInsets.margins(0, 80, 0, 0, 900)), "[0, 80, 0, 900]", "keyboard lifts the bottom");
    eq(Arrays.toString(WebViewInsets.margins(0, 80, 0, 48, 900)), "[0, 80, 0, 900]", "keyboard covers the navigation bar, never stacks");
    if (failures > 0) System.exit(1);
    System.out.println("pending queue + navigation policy + webview insets (java): ok");
  }
}
`;

const fileSaveSource = `package io.mixdog.app;
import java.util.*;
public class FileSaveCheck {
  static int failures = 0;
  static void eq(Object actual, Object expected, String label) {
    if (!Objects.equals(actual, expected)) { failures++; System.out.println("FAIL " + label + ": " + actual + " != " + expected); }
  }
  public static void main(String[] args) {
    Object pageA = new Object(), pageB = new Object();
    FileSaveSessions sessions = new FileSaveSessions();
    eq(FileSaveSessions.checkBegin(10L), null, "ordinary size");
    eq(FileSaveSessions.checkBegin(0L), null, "empty file");
    eq(FileSaveSessions.checkBegin(FileSaveSessions.MAX_BYTES), null, "limit is inclusive");
    eq(FileSaveSessions.checkBegin(FileSaveSessions.MAX_BYTES + 1), "too-large", "over the limit");
    eq(FileSaveSessions.checkBegin(-1L), "invalid", "negative size");
    eq(FileSaveSessions.checkBegin(null), "invalid", "missing size");
    eq(FileSaveSessions.exactLong(12), 12L, "int size");
    eq(FileSaveSessions.exactLong(12.0), 12L, "integral double");
    eq(FileSaveSessions.exactLong(12.5), null, "fractional size");
    eq(FileSaveSessions.exactLong("12"), null, "string size");
    eq(FileSaveSessions.exactLong(Double.POSITIVE_INFINITY), null, "infinite size");

    FileSaveSessions.Session s = sessions.open(pageA, 10);
    eq(s.handle.matches("[A-Za-z0-9_-]{22}"), true, "128-bit base64url handle");
    eq(sessions.open(pageA, 10).handle.equals(s.handle), false, "handles are unique");
    eq(sessions.find(s.handle, pageA) == s, true, "owner finds its handle");
    eq(sessions.find(s.handle, pageB), null, "another page cannot use the handle");
    eq(sessions.find("nope", pageA), null, "unknown handle");
    eq(sessions.find(null, pageA), null, "null handle");

    eq(FileSaveSessions.checkWrite(s, 0L, 4), null, "first chunk");
    s.written = 4;
    eq(FileSaveSessions.checkWrite(s, 0L, 4), "offset-mismatch", "replayed offset");
    eq(FileSaveSessions.checkWrite(s, 8L, 2), "offset-mismatch", "skipped offset");
    eq(FileSaveSessions.checkWrite(s, null, 2), "invalid", "missing offset");
    eq(FileSaveSessions.checkWrite(s, 4L, 0), "invalid", "empty chunk");
    eq(FileSaveSessions.checkWrite(s, 4L, FileSaveSessions.MAX_CHUNK_BYTES + 1), "invalid", "oversize chunk");
    eq(FileSaveSessions.checkWrite(s, 4L, 7), "too-large", "overflow past the declared size");
    eq(FileSaveSessions.checkWrite(s, 4L, 6), null, "exactly the declared size");
    eq(FileSaveSessions.checkFinish(s, 10L), "size-mismatch", "finish before every byte arrived");
    s.written = 10;
    eq(FileSaveSessions.checkFinish(s, 11L), "size-mismatch", "restated size differs");
    eq(FileSaveSessions.checkFinish(s, null), "invalid", "restated size missing");
    eq(FileSaveSessions.checkFinish(s, 10L), null, "complete");
    sessions.markFinished(s);
    eq(FileSaveSessions.checkWrite(s, 10L, 1), "unknown-handle", "no writes after finish");
    eq(FileSaveSessions.checkFinish(s, 10L), "unknown-handle", "no second finish");
    eq(sessions.find(s.handle, pageA) == s, true, "finished handle stays findable for share");

    FileSaveSessions many = new FileSaveSessions();
    for (int i = 0; i < FileSaveSessions.MAX_OPEN; i++) eq(many.open(pageA, 1) != null, true, "open " + i);
    eq(many.open(pageA, 1), null, "too many open handles");
    eq(many.take(pageB).size(), 0, "other page owns none");
    eq(many.take(pageA).size(), FileSaveSessions.MAX_OPEN, "page release takes its handles");
    eq(many.open(pageA, 1) != null, true, "slots free after release");
    List<FileSaveSessions.Session> done = new ArrayList<>();
    FileSaveSessions keep = new FileSaveSessions();
    for (int i = 0; i < FileSaveSessions.MAX_FINISHED + 2; i++) { FileSaveSessions.Session f = keep.open(pageA, 0); keep.markFinished(f); done.add(f); }
    eq(keep.find(done.get(0).handle, pageA), null, "oldest finished handle evicted");
    eq(keep.find(done.get(done.size() - 1).handle, pageA) != null, true, "newest finished handle kept");
    for (int i = 0; i < 3; i++) eq(keep.find(done.get(done.size() - 1).handle, pageA) != null, true, "share again " + i);
    int alive = 0;
    for (FileSaveSessions.Session f : done) if (keep.find(f.handle, pageA) != null) alive++;
    eq(alive, FileSaveSessions.MAX_FINISHED, "exactly the newest MAX_FINISHED stay shareable");
    eq(keep.find(done.get(done.size() - 1).handle, pageB), null, "share again is still page-bound");
    keep.remove(done.get(done.size() - 1));
    eq(keep.find(done.get(done.size() - 1).handle, pageA), null, "removed handle is invalid");

    eq(FileSaveSessions.sanitizeName("../../etc/passwd"), "_.._etc_passwd", "path separators never survive");
    eq(FileSaveSessions.sanitizeName("a/b\\\\c.txt"), "a_b_c.txt", "separators become underscores");
    eq(FileSaveSessions.sanitizeName("  ..hidden.txt "), "hidden.txt", "leading dots and spaces trimmed");
    eq(FileSaveSessions.sanitizeName(""), "download", "empty name");
    eq(FileSaveSessions.sanitizeName(null), "download", "null name");
    eq(FileSaveSessions.sanitizeName("report.pdf"), "report.pdf", "plain name kept");
    String longName = "x".repeat(300) + ".pdf";
    eq(FileSaveSessions.sanitizeName(longName).length(), 120, "long name capped");
    eq(FileSaveSessions.sanitizeName(longName).endsWith(".pdf"), true, "extension kept when capped");
    eq(FileSaveSessions.sanitizeMime("Image/PNG"), "image/png", "mime lower-cased");
    eq(FileSaveSessions.sanitizeMime("text/plain; charset=utf-8"), "application/octet-stream", "mime parameters refused");
    eq(FileSaveSessions.sanitizeMime(""), "application/octet-stream", "empty mime");
    eq(FileSaveSessions.isApk("app.bin", FileSaveSessions.APK_MIME), true, "apk by mime");
    eq(FileSaveSessions.isApk("app.apk", "application/octet-stream"), true, "apk by name");
    eq(FileSaveSessions.isApk("APP.APK", "application/octet-stream"), true, "apk name is case-insensitive");
    eq(FileSaveSessions.isApk("app.apk.txt", "text/plain"), false, "apk only as the final extension");
    eq(FileSaveSessions.isApk("report.pdf", "application/pdf"), false, "other files are not apks");
    eq(FileSaveSessions.isApk(null, "application/octet-stream"), false, "no name, no apk mime");
    eq(FileSaveSessions.numberedName("a.txt", 2), "a (2).txt", "numbered with extension");
    eq(FileSaveSessions.numberedName("a", 1), "a (1)", "numbered without extension");
    eq(FileSaveSessions.base64Url(new byte[] {(byte) 0xfb, (byte) 0xff, (byte) 0xbf}), "-_-_", "base64url alphabet");
    eq(FileSaveSessions.base64Url(new byte[] {1}), "AQ", "base64url has no padding");
    if (failures > 0) System.exit(1);
    System.out.println("file save sessions (java): ok");
  }
}
`;

const reconnectSource = `package io.mixdog.app;
import java.util.*;
public class ReconnectCheck {
  static int failures = 0;
  static void eq(Object actual, Object expected, String label) {
    if (!Objects.equals(actual, expected)) { failures++; System.out.println("FAIL " + label + ": " + actual + " != " + expected); }
  }
  static final String PAGE = "https://relay.example.com/d/abc/";
  static ReconnectState.Phase p(ReconnectState s) { return s.phase(); }
  public static void main(String[] args) {
    Set<String> saved = new HashSet<>(Arrays.asList("https://relay.example.com", "http://localhost:8787"));

    // Backoff: 2s doubling to a 30s ceiling, never negative or overflowing.
    long[] delays = {2000, 4000, 8000, 16000, 30000, 30000};
    for (int i = 0; i < delays.length; i++) eq(ReconnectState.delayMs(i), delays[i], "delay " + i);
    eq(ReconnectState.delayMs(1000), 30000L, "huge count stays capped");
    eq(ReconnectState.delayMs(-3), 2000L, "negative count is the first delay");

    // Which failures are worth waiting for.
    for (int code : new int[] {-1, -2, -6, -7, -8, -11, -15}) eq(ReconnectState.isTransientError(code), true, "transient error " + code);
    for (int code : new int[] {0, -3, -4, -5, -9, -10, -12, -13, -14, -16}) eq(ReconnectState.isTransientError(code), false, "permanent error " + code);
    for (int status : new int[] {502, 503, 504}) eq(ReconnectState.isTransientStatus(status), true, "gateway status " + status);
    for (int status : new int[] {200, 301, 400, 401, 403, 404, 410, 429, 500, 501}) eq(ReconnectState.isTransientStatus(status), false, "real answer " + status);

    // Only an allowed, non-bundled relay URL is ever reloaded.
    eq(ReconnectState.isRecoverableUrl(PAGE, saved), true, "saved relay page");
    eq(ReconnectState.isRecoverableUrl("HTTPS://Relay.Example.com:443/d/abc?x=1#y", saved), true, "same origin, other spelling");
    eq(ReconnectState.isRecoverableUrl("http://localhost:8787/d/abc/", saved), true, "loopback relay");
    eq(ReconnectState.isRecoverableUrl("https://localhost/index.html", saved), false, "bundled screen has no network to wait for");
    eq(ReconnectState.isRecoverableUrl("https://evil.example.net/", saved), false, "unknown origin");
    eq(ReconnectState.isRecoverableUrl("https://relay.example.com.evil.net/", saved), false, "lookalike origin");
    eq(ReconnectState.isRecoverableUrl("http://relay.example.com/d/abc/", saved), false, "downgraded scheme");
    eq(ReconnectState.isRecoverableUrl("chrome-error://chromewebdata/", saved), false, "error page url");
    eq(ReconnectState.isRecoverableUrl(null, saved), false, "no url");

    // Idle: nothing to reload, no stale timer or trigger does anything.
    ReconnectState s = new ReconnectState();
    eq(p(s), ReconnectState.Phase.IDLE, "starts idle");
    eq(s.active(), false, "idle is not active");
    eq(s.dueReload(), null, "no timer when idle");
    eq(s.retryNow(), null, "no trigger when idle");
    eq(s.pageFinished(PAGE), false, "an ordinary page finishing is not a recovery");

    // A failure episode runs the whole backoff, then gives up.
    eq(s.failed(PAGE), 2000L, "first wait");
    eq(p(s), ReconnectState.Phase.WAITING, "waiting after the failure");
    eq(s.active(), true, "waiting is active");
    eq(s.pageFinished(PAGE), false, "the error page finishing is not a recovery");
    List<Long> waits = new ArrayList<>();
    waits.add(2000L);
    String other = "https://relay.example.com/d/abc/?redirected=1";
    for (int i = 0; i < ReconnectState.MAX_RELOADS; i++) {
      eq(s.dueReload(), PAGE, "reload " + (i + 1) + " reloads the first failing url");
      eq(p(s), ReconnectState.Phase.LOADING, "loading during reload " + (i + 1));
      s.pageStarted(PAGE);
      waits.add(s.failed(other));
    }
    eq(waits, Arrays.asList(2000L, 4000L, 8000L, 16000L, 30000L, 30000L, 30000L, 30000L, -1L), "bounded backoff");
    eq(p(s), ReconnectState.Phase.GAVE_UP, "gave up after the cap");
    eq(s.dueReload(), null, "no timer once gave up");
    eq(s.failed(PAGE), -1L, "a late failure does not restart the backoff");

    // The button (or network / foreground) restarts it from the beginning.
    eq(s.retryNow(), PAGE, "button reloads");
    eq(p(s), ReconnectState.Phase.LOADING, "loading after the button");
    eq(s.retryNow(), null, "a reload in flight is left alone");
    s.pageStarted(PAGE);
    eq(s.failed(PAGE), 4000L, "fresh backoff after a manual retry");

    // Network back / foreground while a timer is pending reloads at once.
    eq(s.retryNow(), PAGE, "trigger while waiting reloads now");
    eq(s.dueReload(), null, "the pending timer then finds nothing to do");

    // The error page of the previous attempt finishing late is not the reload succeeding.
    eq(s.pageFinished(PAGE), false, "stale finish before the reload started");
    eq(p(s), ReconnectState.Phase.LOADING, "still loading");
    s.pageStarted(PAGE);
    eq(s.pageFinished(PAGE), true, "the reload finished");
    eq(p(s), ReconnectState.Phase.IDLE, "idle after recovery");
    eq(s.url(), "", "episode forgotten");
    eq(s.pageFinished(PAGE), false, "recovery is reported once");

    // A new episode starts a new backoff and a new target.
    eq(s.failed("https://relay.example.com/d/xyz/"), 2000L, "new episode starts at the first wait");
    eq(s.url(), "https://relay.example.com/d/xyz/", "new target");

    // A reload redirected off the allowed origins is not retried by itself.
    s.dueReload();
    s.pageStarted(PAGE);
    s.blocked("chrome-error://chromewebdata/");
    eq(p(s), ReconnectState.Phase.LOADING, "an error-page url is not a blocked redirect");
    s.blocked("https://evil.example.net/login");
    eq(p(s), ReconnectState.Phase.GAVE_UP, "blocked redirect stops the automatic retries");
    eq(s.failed(PAGE), -1L, "and stays stopped");
    eq(s.dueReload(), null, "no timer after a blocked redirect");
    s.clear();
    eq(p(s), ReconnectState.Phase.IDLE, "clear forgets the episode");
    s.failed(PAGE);
    s.blocked("https://evil.example.net/login");
    eq(p(s), ReconnectState.Phase.WAITING, "a blocked url outside a reload changes nothing");

    // A navigation that is not this episode's own reload ends the episode.
    String pairing = "https://localhost/?manage=1";
    s.clear();
    s.failed(PAGE);
    eq(s.pageStarted(pairing), true, "pairing screen starting while waiting ends the episode");
    eq(p(s), ReconnectState.Phase.IDLE, "idle after leaving for pairing");
    eq(s.dueReload(), null, "the pending timer no longer returns the failed relay");
    eq(s.retryNow(), null, "nor does a network or foreground trigger");

    s.failed(PAGE);
    eq(s.pageFinished(pairing), true, "pairing screen finishing while waiting ends the episode");
    eq(p(s), ReconnectState.Phase.IDLE, "idle after the pairing page finished");
    eq(s.dueReload(), null, "no stale reload after the pairing page finished");

    for (int i = 0; i < ReconnectState.MAX_RELOADS; i++) { s.failed(PAGE); s.dueReload(); }
    eq(p(s), ReconnectState.Phase.LOADING, "setup: loading");
    s.failed(PAGE);
    eq(p(s), ReconnectState.Phase.GAVE_UP, "setup: gave up");
    eq(s.pageStarted(pairing), true, "pairing screen starting after giving up ends the episode");
    eq(p(s), ReconnectState.Phase.IDLE, "idle after leaving from the button state");
    eq(s.retryNow(), null, "the button state is gone");

    // The reload in flight: its own origin (and redirect hops) stay the episode; another origin ends it.
    s.failed(PAGE);
    s.retryNow();
    eq(s.pageStarted(PAGE + "?again=1"), false, "own reload with another path stays the episode");
    eq(p(s), ReconnectState.Phase.LOADING, "still loading");
    eq(s.pageStarted(pairing), true, "another origin starting during the reload ends it");
    eq(p(s), ReconnectState.Phase.IDLE, "idle after the reload was superseded");

    s.failed(PAGE);
    s.retryNow();
    eq(s.pageFinished(pairing), true, "another origin finishing during the reload ends it");
    eq(p(s), ReconnectState.Phase.IDLE, "idle after the superseding page finished");

    // The failed page's own late events and non-navigations never end it.
    s.failed(PAGE);
    eq(s.pageStarted(null), false, "no url is not a navigation");
    eq(s.pageStarted("about:blank"), false, "about:blank is not a navigation");
    eq(s.pageFinished("chrome-error://chromewebdata/"), false, "error document finishing is not a navigation");
    eq(s.pageFinished(PAGE), false, "failed page finishing late is not a navigation");
    eq(p(s), ReconnectState.Phase.WAITING, "still waiting");

    // Originless finishes never count as the reload succeeding.
    s.clear();
    s.failed(PAGE);
    s.retryNow();
    s.pageStarted(PAGE);
    eq(s.pageFinished(null), false, "null finish during a started reload");
    eq(s.pageFinished("about:blank"), false, "about:blank finish during a started reload");
    eq(s.pageFinished("chrome-error://chromewebdata/"), false, "error document finish during a started reload");
    eq(p(s), ReconnectState.Phase.LOADING, "recovery stays until a real finish");
    eq(s.pageFinished(PAGE), true, "a real allowed-origin finish recovers");
    eq(p(s), ReconnectState.Phase.IDLE, "idle after the real finish");

    // A redirect target that failed counts as the episode's own origin.
    String hop = "https://relay.example.com/login";
    s.clear();
    s.failed(PAGE);
    s.dueReload();
    s.pageStarted(PAGE);
    s.failed(hop);
    eq(s.pageFinished(hop), false, "error page of a same-origin redirect target is ours");
    String hopOrigin = "http://localhost:8787/d/abc/";
    s.dueReload();
    s.failed(hopOrigin);
    eq(s.pageFinished(hopOrigin), false, "error page of a redirect to another failed origin is ours");

    // Explicit abandon (choose another PC / Back).
    s.clear();
    eq(p(s), ReconnectState.Phase.IDLE, "clear abandons");
    eq(s.dueReload(), null, "abandoned: no timer");
    eq(s.retryNow(), null, "abandoned: no trigger");

    if (failures > 0) System.exit(1);
    System.out.println("reconnect state (java): ok");
  }
}
`;

const dir = mkdtempSync(join(tmpdir(), 'mixdog-origin-'));
try {
  const pkg = join(dir, 'io', 'mixdog', 'app');
  mkdirSync(pkg, { recursive: true });
  cpSync(join(root, 'android/app/src/main/java/io/mixdog/app/OriginPolicy.java'), join(pkg, 'OriginPolicy.java'));
  writeFileSync(join(pkg, 'OriginPolicyCheck.java'), source);
  for (const name of ['PendingActionQueue', 'NavigationPolicy', 'WebViewInsets']) {
    cpSync(join(root, `android/app/src/main/java/io/mixdog/app/${name}.java`), join(pkg, `${name}.java`));
  }
  writeFileSync(join(pkg, 'QueueCheck.java'), queueSource);
  cpSync(join(root, 'android/app/src/main/java/io/mixdog/app/FileSaveSessions.java'), join(pkg, 'FileSaveSessions.java'));
  writeFileSync(join(pkg, 'FileSaveCheck.java'), fileSaveSource);
  cpSync(join(root, 'android/app/src/main/java/io/mixdog/app/ReconnectState.java'), join(pkg, 'ReconnectState.java'));
  writeFileSync(join(pkg, 'ReconnectCheck.java'), reconnectSource);
  execFileSync(
    'javac',
    ['-d', dir, ...['OriginPolicy', 'PendingActionQueue', 'NavigationPolicy', 'WebViewInsets', 'FileSaveSessions', 'ReconnectState', 'OriginPolicyCheck', 'QueueCheck', 'FileSaveCheck', 'ReconnectCheck'].map((n) => join(pkg, `${n}.java`))],
    { stdio: 'inherit' }
  );
  execFileSync('java', ['-cp', dir, 'io.mixdog.app.OriginPolicyCheck'], { stdio: 'inherit' });
  execFileSync('java', ['-cp', dir, 'io.mixdog.app.QueueCheck'], { stdio: 'inherit' });
  execFileSync('java', ['-cp', dir, 'io.mixdog.app.FileSaveCheck'], { stdio: 'inherit' });
  execFileSync('java', ['-cp', dir, 'io.mixdog.app.ReconnectCheck'], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
