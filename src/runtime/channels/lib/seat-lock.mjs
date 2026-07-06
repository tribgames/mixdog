import net from "net";
import { createHash } from "crypto";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";

// OS-enforced bridge-seat singleton. The seat is a named-pipe (win32) / unix
// domain socket (posix) server: acquiring the seat == successfully listen()ing
// on the address. Because the OS binds exactly one listener per address, at
// most one process can hold the seat at a time — no file heartbeat / staleness
// heuristics, and a holder crash auto-releases (win32 removes the pipe; posix
// leaves a stale socket file that a connect-probe detects and unlinks).
//
// Takeover is an EXPLICIT release message, not a last-wins file overwrite: a
// contender that finds the seat occupied connects to the holder and sends
// {"op":"takeover",...}; the holder runs its teardown (onTakeover -> the
// worker's stopOwnedRuntime) then closes the server, letting the contender's
// retried listen() succeed within a bounded backoff window.
function hashRoot(runtimeRoot) {
  return createHash("sha1").update(String(runtimeRoot)).digest("hex").slice(0, 16);
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
export function createSeatLock({ runtimeRoot, instanceId }) {
  const isWin = process.platform === "win32";
  const address = isWin
    ? `\\\\.\\pipe\\mixdog-seat-${hashRoot(runtimeRoot)}`
    : join(runtimeRoot, "seat.sock");
  let server = null;
  let held = false;
  let takeoverHandler = null;
  let releasing = null;

  function isSeatHeld() {
    // Daemon model: the machine-global channels daemon is the permanent
    // singleton bridge owner (pid-verified channel-daemon-owner lock). Ownership
    // is unconditional — the OS seat lease/heartbeat/steal is retired.
    return true;
  }
  function seatAddress() {
    return address;
  }
  // Register the teardown to run when a takeover message arrives (or on an
  // explicit releaseSeat). Runs BEFORE the server closes so the contender only
  // wins the seat once we've released the backend.
  function onTakeover(cb) {
    takeoverHandler = cb;
  }
  function closeServer() {
    // Capture holder status BEFORE nulling: only the process that actually held
    // the listener may unlink the posix socket file. A non-holder close must
    // never unlink — otherwise it races away a NEW holder's freshly-bound
    // socket, re-opening the seat as falsely vacant (double-owner).
    const wasListener = server !== null;
    return new Promise((resolve) => {
      const s = server;
      server = null;
      held = false;
      if (!s) return resolve();
      try {
        s.close(() => resolve());
      } catch {
        resolve();
      }
    }).then(() => {
      // posix: remove OUR socket file so the next listen() is clean — but only
      // when we were the confirmed listener (see wasListener above).
      if (!isWin && wasListener) {
        try { if (existsSync(address)) unlinkSync(address); } catch {}
      }
    });
  }
  async function runTeardownThenClose(reason) {
    // Coalesce concurrent release paths (takeover message + explicit stop).
    if (releasing) return releasing;
    releasing = (async () => {
      try { await takeoverHandler?.(reason); } catch {}
      await closeServer();
    })();
    try { await releasing; } finally { releasing = null; }
  }
  function handleLine(line, sock) {
    let msg = null;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg?.op === "takeover") {
      // Ack first so the contender knows we received the takeover and is not
      // left waiting the full timeout, then release.
      try { sock.write(JSON.stringify({ op: "ack", instanceId }) + "\n"); } catch {}
      void runTeardownThenClose({ reason: "takeover", byInstanceId: msg.instanceId });
    }
  }
  function attachServer(s) {
    s.on("connection", (sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line) handleLine(line, sock);
        }
      });
      sock.on("error", () => {});
    });
    // A server-level error after listen (e.g. pipe invalidated) must not crash
    // the worker; drop the dead handle so the next acquire re-listens.
    s.on("error", () => {});
  }
  function tryListen() {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      const onError = (err) => { s.removeListener("listening", onListening); reject(err); };
      const onListening = () => {
        s.removeListener("error", onError);
        server = s;
        held = true;
        attachServer(s);
        s.unref?.();
        resolve(true);
      };
      s.once("error", onError);
      s.once("listening", onListening);
      s.listen(address);
    });
  }
  // Connect to the current holder. When takeover=true, send the takeover
  // message. Resolves:
  //   'alive' — a live holder answered (or we connected)         -> back off
  //   'stale' — connect refused/ENOENT (posix crashed holder)    -> unlink+retry
  function connectHolder({ takeover }) {
    return new Promise((resolve) => {
      const sock = net.createConnection(address);
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch {}
        resolve(r);
      };
      sock.on("connect", () => {
        if (takeover) {
          try { sock.write(JSON.stringify({ op: "takeover", instanceId }) + "\n"); } catch { done("alive"); }
        } else {
          done("alive");
        }
      });
      sock.on("data", () => done("alive")); // ack
      sock.on("error", (err) => {
        const code = err?.code;
        done(code === "ECONNREFUSED" || code === "ENOENT" ? "stale" : "alive");
      });
      sock.on("close", () => done("alive"));
      const t = setTimeout(() => done("alive"), 1500);
      t.unref?.();
    });
  }
  // Acquire the seat. force=true (default) takes over a live holder via the
  // takeover message; force=false (claim-if-vacant) backs off when a live
  // holder is present but still reclaims a stale (crashed) posix socket.
  // Returns true on success, false on timeout / vacant-only backoff.
  // Deletion of the seat lease/steal protocol. Under the daemon model there is
  // exactly one channels runtime per machine (enforced upstream by the
  // singleton daemon-owner lock), so acquiring the bridge seat is unconditional
  // and never contends — no listen()/EADDRINUSE probe, no explicit takeover
  // message, no claim-if-vacant backoff, no false-stale steal. The former
  // named-pipe / unix-socket server machinery (tryListen/connectHolder/
  // handleLine/attachServer) is now unreachable and kept only until the file is
  // pruned in a follow-up cleanup.
  async function acquireSeat(_opts = {}) {
    held = true;
    return true;
  }
  // Graceful release: run teardown (if any) then close the server. Idempotent.
  async function releaseSeat(reason = { reason: "release" }) {
    if (!server && !held) {
      // Not the holder: nothing to close and — critically — do NOT unlink; the
      // socket file may belong to a NEW holder that bound after we released.
      return;
    }
    await runTeardownThenClose(reason);
  }
  // Close the server WITHOUT running the teardown callback. Used by the worker's
  // stopOwnedRuntime itself so the teardown (which calls this) does not recurse.
  async function closeSeatServer() {
    await closeServer();
  }
  return {
    acquireSeat,
    releaseSeat,
    closeSeatServer,
    onTakeover,
    isSeatHeld,
    seatAddress,
  };
}
