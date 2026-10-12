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
  execFileSync(
    'javac',
    ['-d', dir, ...['OriginPolicy', 'PendingActionQueue', 'NavigationPolicy', 'WebViewInsets', 'OriginPolicyCheck', 'QueueCheck'].map((n) => join(pkg, `${n}.java`))],
    { stdio: 'inherit' }
  );
  execFileSync('java', ['-cp', dir, 'io.mixdog.app.OriginPolicyCheck'], { stdio: 'inherit' });
  execFileSync('java', ['-cp', dir, 'io.mixdog.app.QueueCheck'], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
