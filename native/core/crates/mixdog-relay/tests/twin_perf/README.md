# Relay performance comparison (twin_perf)

Starts the Node relay (`tests/twin/node/relay-host.mjs`) and the Rust relay (`relay_twin_host`) one after the other on the
same machine, with the same knobs, plain HTTP on 127.0.0.1, and drives both with the same load (`load.rs`: tokio clients
written for the test, not the relay's code). The processes are started through `tests/twin/proc.rs`, included with `#[path]`
and left unedited. Every scenario runs three times per runtime, the runs alternating Node, Rust, Node, Rust, ..., and the
medians are compared.

| test | load |
| --- | --- |
| `frame_latency_of_one_desktop_and_32_phones` | 1 desktop and 32 phones exchange binary and text frames of 1 KiB, 64 KiB and 1 MiB (every phone sends at once, then the desktop answers every phone); p50, p99 and max each way |
| `bulk_frames_and_a_sustained_stream` | one 64 MiB binary frame each way (the desktop's carries its 42-byte routing envelope inside the 64 MiB policy) and a 16 MiB/s stream of 256 KiB frames for 8 s each way: time to deliver, frame latency, and the relay's peak memory growth over idle (the bytes it buffered) |
| `idle_phone_legs_across_64_desktops` | 2000 phone legs on 64 desktops, through their handshake, idle for 60 s: resident memory and processor time of the relay (heartbeat and sweep) |
| `static_serving_of_br_siblings_and_live_gzip` | 1000 requests (16 at a time) each for `index.html` with a `.br` sibling, a 2 MiB hashed asset with its `.br` sibling, and a 300 KiB file with none (gzipped live): requests per second, p50, p99 |
| `refused_upgrades_and_hook_round_trips` | 40 `/ws` upgrades without a pairing, 10 a second, each closed 4005 (the verify-release path), and 100 `/hook` round trips through a hook leg |

The devices and browsers are written into `devices.json` before the relay starts (both relays load the same file), so the
load needs no claim flow. Requests are `Connection: close`, the same for both relays.

## Verdict

The test fails when, in the medians, the Rust relay's

- latency p50 or p99, or time to deliver, is more than 5 % worse than Node's (a difference under 50 microseconds is below what
  the measurement resolves and counts as equal);
- request rate (static files, hook round trips) is more than 5 % lower;
- peak resident memory is higher than Node's, or past 800 MiB (the `MemoryMax` of `deploy/mixdog-relay.service`).

Maxima, processor time and the buffered bytes are printed and not gated. The Node host here runs without the service's
`--max-old-space-size=512`; the comparison is against Node left to use what it wants.

## Run

Release profile only (a debug build of the relay makes the comparison meaningless), ignored tests only:

```
cargo nextest run -p mixdog-relay --release --features test-support --offline -E 'binary(twin_perf)' --run-ignored only --success-output immediate
```

`node` with `ws` and `nodemailer` resolvable (`npm ci --prefix apps/relay`) is required, as for the `twin` suite. The relay's
pid and memory are read through PowerShell (`Get-NetTCPConnection`, `Get-Process`) on Windows and `ss` and `/proc` on Linux; no other platform is
supported. The table of each scenario is printed and written to `$CARGO_TARGET_TMPDIR/twin_perf-<scenario>.txt`; paste it into
the pull request. Idle fleet alone takes about 8 minutes (60 s idle, six runs).

## Why it is not in CI

Shared CI runners have noisy neighbours and unstable clocks: a 5 % threshold on latency there is a coin toss. Run it on a quiet
machine, before a release or after a change to the relay's transport, and read the table.
