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

const dir = mkdtempSync(join(tmpdir(), 'mixdog-origin-'));
try {
  const pkg = join(dir, 'io', 'mixdog', 'app');
  mkdirSync(pkg, { recursive: true });
  cpSync(join(root, 'android/app/src/main/java/io/mixdog/app/OriginPolicy.java'), join(pkg, 'OriginPolicy.java'));
  writeFileSync(join(pkg, 'OriginPolicyCheck.java'), source);
  execFileSync('javac', ['-d', dir, join(pkg, 'OriginPolicy.java'), join(pkg, 'OriginPolicyCheck.java')], { stdio: 'inherit' });
  execFileSync('java', ['-cp', dir, 'io.mixdog.app.OriginPolicyCheck'], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
