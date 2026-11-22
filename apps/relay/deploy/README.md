# Release safety

`deploy-release.sh` stages a release under the deployment lock, then uses
`release-transaction.sh` to switch installations. The transaction is armed
before the first rename and remains active through post-start verification.

- Preparation/first-rename failure leaves the installed release untouched.
- Second-rename, restart, verification failure, or SIGINT/SIGTERM restores the
  previous release and restarts it.
- A unit that still runs the previous Node release (`systemctl show -p ExecStart`
  does not name the binary) is pointed at the binary by the drop-in
  `/etc/systemd/system/mixdog-relay.service.d/exec.conf` (`ExecStart=` reset,
  then `ExecStart=/opt/mixdog-relay/mixdog-relay`, and `UnsetEnvironment=NODE_OPTIONS`),
  followed by `daemon-reload` before the restart. The transaction records
  whether the drop-in existed and what it held; a rollback restores exactly that
  (and reloads), so a failed first switch returns to the Node release completely.
- Failure to stop or restore the service exits with status 90. The backup is
  preserved if it has not yet been restored; recovery errors are never success.
- The successful verification boundary ends rollback eligibility. Only then
  does the installer remove its old-release backup and stale staging trees. When
  the old release is a Node tree (it holds `server.mjs`, the first switch) the
  backup is kept as `/opt/mixdog-relay.handover` instead, for a manual return;
  the cleanup globs never match that name.

## Layout

The relay is one binary. An installed tree holds `mixdog-relay` (root, 0755),
`deploy/`, `renderer/`, `renderer-releases/` and `mobile-release.json`; no Node
runtime or `node_modules` is installed. A release upload carries `mixdog-relay`
(optional for a renderer-only deploy: the installed binary is kept), `deploy/`,
and the renderer (`renderer/`, or the delta cache from `renderer-delta`).
`deploy.sh` (first install) places the uploaded binary and tree and writes the
unit; `deploy-release.sh` stages and swaps a release. The unit's `MemoryMax=800M`
bounds the process.

## Connection tracking

Every flow through the host holds one netfilter connection-tracking entry; past
`nf_conntrack_max` the kernel drops new flows (`nf_conntrack: table full,
dropping packet` in the kernel log, `drop`/`early_drop` in
`/proc/net/stat/nf_conntrack`, where `drop` counts refused flows and
`early_drop` counts entries evicted to make room under pressure, not
necessarily refused flows). The kernel sizes the table from RAM (buckets =
RAM / 16384 / 8 bytes, max = buckets): 8192 on this ~1 GB VPS.
`deploy-release.sh` runs `conntrack.sh apply` under the deployment lock, before
staging, on every release. Nothing in it stops a release: whatever the host does
not allow is reported and the release continues.

Sizing (`conntrack.sh` `CONNTRACK_MAX`), a workload estimate:

- 1000 users (the top of "hundreds"), each holding up to 5 TURN allocations.
- 8 entries per allocation, an estimate of what ICE produces, not a TURN or
  coturn limit (permissions per allocation are unbounded): 1 client flow (the
  UDP 5-tuple to 3478, or the TCP connection to 3478/5349), plus one
  relay-port ↔ peer flow per remote candidate ICE checks through it: the peer's
  server-reflexive address(es) and its relay candidates on this host (udp, tcp,
  tls), with room for peer-reflexive ones. Host candidates are private addresses
  coturn refuses (`denied-peer-ip`) and create none.
- 1000 × 5 × 8 = 40 000, plus ~5000 for relay HTTPS/WebSocket legs and their
  TIME_WAIT churn: ~45 000. `131072` (2^17) leaves ~2.9× for ICE restarts,
  reconnect churn (see the timeouts below) and scans.
- Memory: an entry is one `nf_conntrack` slab object (~320 B on x86_64; the
  report prints the live size) plus separately allocated extensions, held only
  while the entry exists. 131072 × 320 B = 40 MiB of entry objects at a full
  table, ~4% of the VPS's 961 MB; extensions and slab overhead add to that, so
  it is an estimate, not a ceiling. The hash table is allocated up front:
  131072 buckets × 8 B = 1 MiB. One bucket per entry is the kernel's own default
  ratio.
- Timeouts stay at the kernel defaults, and they are why churn needs headroom.
  A UDP entry lives 30 s after the last packet on its 5-tuple, 120 s once it is
  a detected stream (traffic seen both ways). Only tuples that carry traffic
  stay tracked: an active ICE pair's consent checks (every ~5 s, RFC 7675) keep
  it; an allocation or peer tuple that only sees a TURN refresh minutes apart
  loses its entry in between and gets a new one with the next packet (no NAT runs
  here, so nothing breaks). TCP: after an observed FIN an entry stays in
  FIN_WAIT/TIME_WAIT for 120 s, after an RST in CLOSE for 10 s; a connection
  whose teardown the host never sees stays ESTABLISHED for 5 days. So during
  reconnect churn the table holds more TCP entries than there are open
  sockets.

What `apply` does, in this order, writing nothing already in force:

1. If no `nf_conntrack_max` sysctl exists, `modprobe nf_conntrack` (a failure
   is reported); the steps below then find the sysctls unreadable and leave them
   alone.
2. Capacity: reads `nf_conntrack_max` and writes 131072 only when it is lower,
   then reads it back. A higher value, and 0 (unlimited on some kernels), are
   left alone. When the value in force stays below 131072 (a refused write) it
   prints a `CAPACITY RISK` warning and continues.
3. Hash, the same way and independent of step 2: `nf_conntrack_buckets` is
   read and written to 131072 only when lower; a larger hash stays. The hash
   sets lookup cost per entry, never capacity.
4. Boot configuration, one mechanism: `/etc/sysctl.d/99-mixdog-conntrack.conf`
   sets each key whose 131072 is in force and read back after steps 2–3. For a
   key the kernel refused, or left alone, the file keeps whatever it already
   set for that key (nothing, on a first run). It is installed through a
   temporary file renamed over it, only when its content differs, and reported
   as installed only after it reads back as written; a failed install leaves
   the previous file in place. With it,
   `/etc/modules-load.d/mixdog-conntrack.conf` loads `nf_conntrack` before
   `systemd-sysctl` runs, so the keys exist when the file is applied. A refused
   step is reported with the value in force now and the value configured for
   the next boot, as two facts, and changes nothing else.
5. Warns about any other sysctl file that sets the same keys (the file applied
   last at boot wins).
6. Reports: the values in force now (limit, buckets, entries in use with
   headroom), the values configured for the next boot (and whether the module
   is preloaded), `drop` / `early_drop` / `insert_failed` since boot (from
   `/proc/net/stat/nf_conntrack`, else `conntrack -S`, else stated as
   unavailable, not zero), and the memory a full table takes against RAM. Any
   value it cannot read is printed as unavailable.
   `bash /opt/mixdog-relay/deploy/conntrack.sh report` prints the same on
   demand.

By hand, on a host whose `nf_conntrack_buckets` sysctl is read-only (the
script then reports the refusal and leaves the hash alone): set the hash when
the module loads, `echo 'options nf_conntrack hashsize=131072'
>/etc/modprobe.d/nf_conntrack-hash.conf`; if `nf_conntrack` is loaded from the
initramfs, run `update-initramfs -u`; if it is built into the kernel
(`/sys/module/nf_conntrack/initstate` absent), add `nf_conntrack.hashsize=131072`
to the kernel command line instead. It takes effect at the next boot (or the
next load of the module); check with
`cat /sys/module/nf_conntrack/parameters/hashsize`.

Rollout: files under `deploy/` count as a relay input, and `deploy-remote.ps1`
deploys a relay change only with a CI build of the current relay sources (or
`-LocalRelayBuild`). That condition applies to the relay binary only: any
renderer deploy still packages the current `deploy/` tree and runs this step.
Only a run with no renderer change and no usable relay build uploads nothing.

## Verification

The installed binary's `mixdog-relay verify-release` verifies:

1. `/healthz` reports a listening relay.
2. `/readyz` reports readable entry/bootstrap/style/manifest/worker assets,
   including the expected `index.html` SHA-256 and renderer release metadata.
3. `/ws` upgrades with a same-origin request and rejects missing pairing with
   close code 4005.
4. `/ws` rejects a foreign Origin with HTTP 403.

The installer connects to loopback while keeping the public hostname for TLS
certificate validation. HTTP and WebSocket checks have bounded deadlines.
The probes never register a device or read a real pairing token. They verify
the relay's upgrade/authentication path, **not** a live desktop connection,
E2EE conversation, or phone UI. Public-network reachability is also checked by
the existing caller after deployment.

`/readyz` is public, returns no filesystem paths, and caches its bounded file
inspection for two seconds. Unversioned renderer output fails readiness and
must be rebuilt rather than silently reused.

## Side-by-side renderer releases

Each phone / second PC is served the web renderer that matches the desktop
version of the main PC it is paired with (the relay's renderer release registry).

- Desktops send `{ type: 'desktop-version', appVersion, rendererRelease? }` when
  their device leg connects. The relay stores it on the device row in
  `devices.json` (`appVersion`, `rendererRelease`, `versionSeenAt`), so it
  survives restarts. Old desktops send nothing.
- Layout: `/opt/mixdog-relay/renderer` stays the newest renderer (also the
  delta base); `/opt/mixdog-relay/renderer-releases/` holds `index.json` plus one
  tree per release (`<desktopVersion>-<shell hash prefix>`, and `legacy`).
  Override with `RENDERER_RELEASES_DIR`; only an absent registry allows
  single-renderer mode. An invalid registry never serves the default shell.
- **Selection rule**: a reported desktop version requires an exact match. The
  shell hash can pin a rebuild of that version; otherwise the newest build of
  that version wins. The adopted **`legacy`** shell may match by exact hash
  when it has no version metadata and no known version contradicts the match.
  A PC reporting neither identifier keeps the **`legacy`**
  release (or the newest release if there is no legacy). If the reported version
  has no available renderer, the relay shows a reload page instead of serving
  another version. The response is `no-store`, so already-installed workers
  discard a stale cached shell, and worker scripts remain reachable. The native
  app still gets update advice for unmatched older PCs. `/d/<id>/…` uses the route's
  device; root requests (`/sw.js`, `/assets/…`) use the paired token's device,
  else the `mixdog_device` cookie.
- **Retention rule**: `legacy` is never collected; the newest 3 releases are
  kept; releases still selected for a device seen in the last 30 days are kept
  too (newest first) up to 6 non-legacy releases.
- Caching: hashed `/assets/*` are content-addressed and `immutable` across
  releases; other root responses carry `Vary: Cookie`; `/d/<id>/…` URLs are
  per device; ETags are content hashes, so service worker and shell
  validators never collide between releases.
- Deploy: `deploy-release.sh <domain> <tag> <desktop-version>` runs
  `mixdog-relay renderer-releases --action=prepare` against the **staged** tree: the
  installed registry is hardlinked in, the new renderer is added as one more
  release, and GC runs (registry written by rename, so the installed tree
  that rollback restores is never touched). The swap, backup and rollback are
  the unchanged transaction above. A relay-only deploy passes no desktop
  version and registers nothing.
- `/readyz` inspects the current renderer **and every retained release**; any
  broken one is not-ready. `mixdog-relay verify-release --expected-release=<id>`
  additionally requires the release this deploy added.

The transaction tests use real filesystem renames only inside a generated
temporary directory and replace `systemctl` with a recorder. They never run
the production installer or contact a VPS.

## STUN/TURN for phone ↔ PC WebRTC (coturn)

`coturn/` provisions a self-operated STUN + authenticated TURN server beside the
relay. Nothing here runs from `deploy-release.sh`: provisioning installs a
package, opens ports and creates a secret, so it is a separate, explicit step.

- Credentials are TURN REST credentials: username `<expiry>:<opaque device id>`,
  password `base64(HMAC-SHA1(secret, username))`, valid 24 hours
  (draft-uberti-behave-turn-rest-00 §2.2). The secret is generated on the VPS
  into `/etc/mixdog-relay/turn.env` (root, 0600; systemd passes it to the relay)
  and `/etc/mixdog-coturn/turnserver.conf` (root:turnserver, 0640). It is not in
  the repo and not readable by the relay account.
- The relay issues credentials only on the authenticated desktop leg
  (`ice-servers-request` → `ice-servers`), only for a device
  with at least one paired phone, at most `TURN_ISSUE_LIMIT` times per
  credential lifetime (24 h) per device. A rate-limited answer carries
  `retryAfterMs`; the desktop waits exactly that. The PC hands the same list to
  its phone over the end-to-end encrypted channel.
- Ports: `3478/udp+tcp` (STUN/TURN), `5349/tcp` (TURN over TLS, the relay's
  certificate copied for the `turnserver` account, refreshed by a certbot hook
  that only restarts a coturn that is running), `49152-65535/udp` (coturn's
  default relay range). Relaying to loopback, private, link-local and other
  non-global ranges is denied; TCP allocations and the CLI are off; the public
  address is advertised with `external-ip`.
- **Hairpin policy.** Two relayed endpoints reach each other through each
  other's relay address on this host, so the host's own public address must stay
  a valid peer. coturn's `allowed-peer-ip`/`denied-peer-ip` take addresses and
  ranges only, no ports, so they cannot say "only the relay ports". The
  `mixdog-coturn-egress` unit therefore loads an nftables policy
  (`inet mixdog_coturn`, `egress.nft.template`): a packet from the `turnserver`
  account to an address of this host is accepted only to the relay UDP range;
  replies on flows that came in from outside pass; everything else is dropped.
  "An address of this host" is two sets: the configured public address
  (`ip daddr <public-ipv4>`, rendered from the provision input, the only address
  coturn advertises as `external-ip`), so it is restricted whether the host owns
  it or a **provider NAT maps it** to the host (then it is not a local route and
  the hairpin would otherwise leave the host unfiltered), and every address the
  host routes as local (`fib daddr type local`, IPv4 and IPv6: coturn does not
  advertise those but may still allocate relay addresses on them, so this rule is
  what restricts them). On a NAT-mapped address, relaying
  two endpoints through each other additionally needs the provider's NAT to
  hairpin; provisioning says which case it found, and `verify-turn.sh` tests
  both.
  `mixdog-coturn` requires that unit, so coturn never runs without it. The
  egress unit also merges the range into `net.ipv4.ip_local_reserved_ports`
  (never overwriting what is reserved there) and takes back only the part it
  added when it stops or fails to start (ownership is recorded before the
  sysctl is changed), so no outgoing socket of another service sits inside the
  range (`mixdog-relay reserved-ports`). Residual: a fixed-port UDP service of this host
  bound inside 49152-65535 would be reachable through a relay;
  `verify-turn.sh` fails if one exists.

### Deploy-time decisions (no built-in values)

These two figures depend on how many live views a deployment runs and how often
desktops restart; the contract (`docs/remote-webrtc.md`) bounds neither the
sources per viewer nor restarts, so there is no default. `provision-coturn.sh`
refuses to run without them.

- `--user-quota=N` → coturn `user-quota`: allocations one device (one TURN user
  id) may hold at once; `0` is coturn's own "no quota". Each peer connection
  gathers one relay candidate per TURN URL the relay lists (`udp`, `tcp`, and
  `tls` when provisioned = 3), and the PC and its phone each hold one set, so one
  live view needs about `2 × 3 = 6`; size it as
  `6 × (concurrent live views per device you allow)`, plus room for the previous
  set while an ICE restart replaces it. Measure: run the views you intend to
  allow, then count the device's concurrent allocations from coturn's log of
  successful ALLOCATE requests per user (`journalctl -u mixdog-coturn`; add
  `verbose` to the config temporarily if the default level does not log them) and
  set the quota to the peak plus that restart overlap.
- `--issue-limit=N` → relay `TURN_ISSUE_LIMIT`: credential requests per device per
  credential lifetime. A desktop asks once per lifetime and once per process
  start, so it is the number of starts you expect from one device in 24 h plus
  one. Measure: `journalctl -u mixdog-relay | grep 'ice-servers issued'` shows one
  line per issued credential with the device prefix; `ice-servers refused
  cause=rate-limited` shows the limit being hit. Raise it if a legitimate
  device is refused.

### Relay load: no coturn limits

coturn's `max-bps`, `bps-capacity` and `total-quota` are deliberately not set
(the template comment says the same):

- **One stream is already bounded.** The sender sets no `maxBitrate`, so
  libwebrtc's default ceiling applies: 2500 kbit/s above 960×540
  (`GetMaxDefaultVideoBitrateKbps`, `video/config/encoder_stream_factory.cc`).
- **The VPS has measured headroom.** A capacity run (coturn 4.18.0 in Docker
  limited to this VPS's shape, 1 vCPU / 961 MB, this template, UDP relay,
  1200-byte packets) was loss-free at ~99 Mbit/s egress (20 × 4.8 Mbit/s: 12%
  CPU, ≤19 MiB) — about 40 streams at the default ceiling. Loss began past that
  (375 Mbit/s: 2%; 426 Mbit/s: 34% at ~91% CPU; socket `RcvbufErrors`). The real
  VPS's margin is unknown (±50%).
- **Most views go direct** (`docs/remote-webrtc.md`) and never touch this server.
- **A cap would not cut VPS load.** A view refused here falls back to the JPEG
  view, which runs over the relay on this same VPS.
- **`bps-capacity` does not fit.** It is an admission budget: every ALLOCATE
  reserves its `max-bps` (WebRTC sends no BANDWIDTH attribute), relayed or not
  (`allocate_bps`, `src/apps/relay/netengine.c`; past it `486`,
  `src/server/ns_turn_server.c`), and coturn exits if it is set without
  `max-bps` (`src/apps/relay/mainrelay.c`). With ~6 allocations per view held for
  the connection's life, ~100 Mbit/s admitted only about 3 relay-capable views.

Watch the real load instead (`journalctl -u mixdog-coturn`, the host's egress
counters) and revisit with measurements. A `user-quota` refusal (`486`) or an
unreachable TURN server leaves that end without relay candidates: ICE still
tries the direct pairs, and if none works the JPEG view stays.

### Provision

Before the relay deploy, so the relay restarts once. Needs `nftables` installed
(and `nftables.service`, if enabled, must not load a config that flushes the
ruleset after boot):

```bash
scp -r apps/relay/deploy/coturn root@<vps>:/root/mixdog-coturn
ssh root@<vps> 'bash /root/mixdog-coturn/provision-coturn.sh <relay-domain> <public-ipv4> --user-quota=<N> --issue-limit=<N>'
```

The egress service runs `/opt/mixdog-relay/mixdog-relay reserved-ports`, so the
relay must be deployed first (the script stops if the binary is missing). A box
provisioned before the switch keeps working until it is provisioned again: its
egress unit runs the copy of `reserved-ports.mjs` in `/etc/mixdog-coturn` with
the Node it was provisioned with. Re-provision after the first binary release
to drop that dependency.

The script masks and stops the package's stock `coturn.service` (and refuses to
continue if it, or any other process, still holds the TURN ports) before it
installs anything, and waits for the listening sockets before it reports success.

### Verify

After the relay deploy (which restarts the relay with the new settings):

```bash
ssh root@<vps> 'bash /opt/mixdog-relay/deploy/coturn/verify-turn.sh <public-ipv4>'
mixdog-relay stun-probe <relay-domain>     # from outside the VPS: a workstation binary, or `cargo run --release -p mixdog-relay -- stun-probe <relay-domain>`
```

`verify-turn.sh` checks the services, file modes, config, listeners, the egress
policy (including that the relay range is contained in the reserved ports), then
with `turnutils_uclient` a fresh credential (a relayed client-to-client exchange
through the host's own address), an expired one, and where a relayed packet may
land, always addressed to the public address: a peer inside the relay range
(must be delivered), a peer outside it (must not be, and the policy's drop
counter must have moved), and a loopback peer (must not). The `turnutils_uclient` runs are bounded by the RFC 8489 §6.2.1 UDP
transaction timeout (39.5 s), so the two refusals take that long each.
`mixdog-relay stun-probe` retransmits on the same RFC schedule (up to 39.5 s without a
reply).

### Roll back

```bash
ssh root@<vps> 'bash /opt/mixdog-relay/deploy/coturn/deprovision-coturn.sh'
ssh root@<vps> 'systemctl restart mixdog-relay'
```

`deprovision-coturn.sh` disables and removes both services, deletes the egress
table, the certbot hook (a renewal can no longer start coturn), the relay
drop-in, `/etc/mixdog-relay/turn.env`, `/etc/mixdog-coturn`, and exactly the
parts of the port reservation and the ufw rules that provisioning added.
Provisioning records the `ufw allow` rules it added (`ufw-owned`), whether or not
ufw was active, and skips a rule that already existed; rollback removes the
recorded ones whenever ufw is installed and leaves any pre-existing identical
rule alone. Ports opened on a provider firewall are outside the scripts: close
`3478/udp`, `3478/tcp`, `5349/tcp` and `49152-65535/udp` there. The coturn
package stays installed with its stock unit masked. Until the relay restarts it still advertises TURN to desktops; after it,
desktops see no `ice` capability and use no ICE servers. To rotate the secret:
deprovision, provision again, restart the relay.
