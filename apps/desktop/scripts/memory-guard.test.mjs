// Self-tests for the sampled memory guard: a bounded child tree, an over-cap
// tree, fail-closed behaviour when the tree cannot be observed, child status
// propagation, global free-memory protection, orphan cleanup, usage errors and
// the caps wired into package.json.
//
// Every synthetic child is bounded in time and allocation, and nothing is
// written outside the OS temp directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./memory-guard.mjs", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

function runGuard(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [GUARD, ...args], {
      env: {
        ...process.env,
        // Self-tests must be deterministic and must not consume the caller's
        // real system reserve while validating synthetic child allocations.
        MIXDOG_MEMGUARD_TEST_FREE_MB_SEQUENCE: "8192",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const peakMb = (stderr) => {
  const match = /peak tree RSS ([\d.]+) MB/.exec(stderr);
  return match ? Number(match[1]) : null;
};

// ~32 MB held for 1.5s: large enough to observe without pressuring a developer
// machine that is already running Electron, an editor, and a provider turn.
const BOUNDED_CHILD =
  "const blocks = []; for (let i = 0; i < 4; i += 1) blocks.push(Buffer.alloc(8 * 1024 * 1024, 1));"
  + " setTimeout(() => { if (blocks.length === 4) process.exit(0); }, 1500);";
// A child whose grandchild grows: only a tree-aware guard sees it. Allocation
// steps stay small so this file can run inside the guarded renderer leg.
const OVER_CAP_TREE =
  "const { spawn } = require('node:child_process');"
  + " spawn(process.execPath, ['-e', 'const b = []; setInterval(() => b.push(Buffer.alloc(8 * 1024 * 1024, 1)), 80);'], { stdio: 'ignore' });"
  + " setTimeout(() => {}, 60000);";

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a bounded child tree passes and reports a non-zero peak", async () => {
  const result = await runGuard([
    "--cap-mb=160", "--sample-ms=100", "--label=selftest.bounded",
    "--", process.execPath, "-e", BOUNDED_CHILD,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const peak = peakMb(result.stderr);
  assert.ok(peak !== null && peak > 24, `expected the 32 MB child to be observed, saw ${peak} MB`);
});

test("an over-cap tree is terminated and reported as failed", async () => {
  const result = await runGuard([
    "--cap-mb=96", "--sample-ms=100", "--label=selftest.overcap",
    "--", process.execPath, "-e", OVER_CAP_TREE,
  ]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /exceeded cap 96 MB/);
  assert.match(result.stderr, /FAILED — memory cap exceeded/);
});

test("a probe failure fails closed while the child is still live", async () => {
  const result = await runGuard([
    "--cap-mb=900", "--sample-ms=100", "--label=selftest.probefail",
    "--", process.execPath, "-e", "setTimeout(() => {}, 30000);",
  ], { MIXDOG_MEMGUARD_TEST_PROBE_FAILURE: "always" });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /memory probe failed/);
  assert.match(result.stderr, /FAILED —/);
});

test("insufficient global headroom refuses to spawn the child", async () => {
  const result = await runGuard([
    "--cap-mb=300", "--min-free-mb=500", "--sample-ms=100", "--label=selftest.preflight",
    "--", process.execPath, "-e", "process.stdout.write('CHILD_STARTED')",
  ], { MIXDOG_MEMGUARD_TEST_FREE_MB_SEQUENCE: "799" });
  assert.equal(result.code, 75, result.stderr);
  assert.match(result.stderr, /refusing to start/);
  assert.match(result.stderr, /below required headroom 800 MB/);
  assert.doesNotMatch(result.stdout, /CHILD_STARTED/);
});

test("an empty free-memory seam falls back to the real OS probe", async () => {
  const result = await runGuard([
    "--cap-mb=160", "--min-free-mb=128", "--sample-ms=100", "--label=selftest.real-free",
    "--", process.execPath, "-e", "setTimeout(() => process.exit(0), 2500);",
  ], { MIXDOG_MEMGUARD_TEST_FREE_MB_SEQUENCE: "" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /minimum system free (?!0\.0 )[\d.]+ MB/);
});

test("low system memory terminates the owned tree and reaps its grandchild", async () => {
  const pidFile = join(tmpdir(), `mixdog-memory-guard-${process.pid}-${Date.now()}.pid`);
  const grandchild = "setInterval(() => {}, 60000);";
  const parent = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "setInterval(() => {}, 60000);",
  ].join("");
  try {
    const result = await runGuard([
      "--cap-mb=300", "--min-free-mb=500", "--sample-ms=100", "--label=selftest.lowfree",
      "--", process.execPath, "-e", parent,
    ], {
      MIXDOG_MEMGUARD_TEST_FREE_MB_SEQUENCE: "8192,8192,8192,8192,8192,128",
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /fell below reserve 500 MB/);
    assert.match(result.stderr, /FAILED — system free-memory reserve exhausted/);
    assert.equal(existsSync(pidFile), true, "the synthetic grandchild must start before pressure");
    const grandchildPid = Number(readFileSync(pidFile, "utf8"));
    const deadline = Date.now() + 2_000;
    while (processAlive(grandchildPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(processAlive(grandchildPid), false,
      `tracked grandchild ${grandchildPid} must not survive the guard`);
  } finally {
    rmSync(pidFile, { force: true });
  }
});

test("a run without a single observation fails instead of passing at 0.0 MB", async () => {
  const result = await runGuard([
    "--cap-mb=900", "--sample-ms=100", "--label=selftest.unobserved",
    "--", process.execPath, "-e", "process.exit(0);",
  ], { MIXDOG_MEMGUARD_TEST_PROBE_DELAY_MS: "800" });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /no valid memory sample observed/);
  assert.match(result.stderr, /never observed by a memory probe/);
});

test("a child exit code is propagated instead of flattened", async () => {
  const result = await runGuard([
    "--cap-mb=900", "--sample-ms=150", "--label=selftest.exitcode",
    "--", process.execPath, "-e", "setTimeout(() => process.exit(3), 1500);",
  ]);
  assert.equal(result.code, 3, result.stderr);
});

test("usage errors are rejected before any child is spawned", async () => {
  const missingCommand = await runGuard(["--cap-mb=900"]);
  assert.equal(missingCommand.code, 64);
  assert.match(missingCommand.stderr, /expected `-- <command>/);

  const invalidCap = await runGuard(["--cap-mb=0", "--", process.execPath, "-e", ""]);
  assert.equal(invalidCap.code, 64);
  assert.match(invalidCap.stderr, /invalid --cap-mb=0/);

  const invalidReserve = await runGuard([
    "--min-free-mb=0", "--", process.execPath, "-e", "",
  ]);
  assert.equal(invalidReserve.code, 64);
  assert.match(invalidReserve.stderr, /invalid --min-free-mb=0/);
});

test("both renderer legs run under the approved cap and sampling interval", () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const legs = manifest.scripts["test:renderer"]
    .split("&&")
    .map((leg) => leg.trim())
    .filter((leg) => leg.startsWith("node scripts/memory-guard.mjs"));
  assert.equal(legs.length, 2, "both renderer legs must run under the guard");
  for (const leg of legs) {
    const guardOptions = leg.split(" -- ")[0];
    assert.match(guardOptions, /--cap-mb=1200\b/);
    assert.match(guardOptions, /--min-free-mb=2048\b/);
    assert.match(guardOptions, /--sample-ms=200\b/);
  }
});
