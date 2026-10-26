# Release safety

`deploy-release.sh` stages a release under the deployment lock, then uses
`release-transaction.sh` to switch installations. The transaction is armed
before the first rename and remains active through post-start verification.

- Preparation/first-rename failure leaves the installed release untouched.
- Second-rename, restart, verification failure, or SIGINT/SIGTERM restores the
  previous release and restarts it.
- Failure to stop or restore the service exits with status 90. The backup is
  preserved if it has not yet been restored; recovery errors are never success.
- The successful verification boundary ends rollback eligibility. Only then
  does the installer remove its old-release backup and stale staging trees.

## Verification

The installed `deploy/verify-release.mjs` verifies:

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
version of the main PC it is paired with (`lib/renderer-releases.mjs`).

- Desktops send `{ type: 'desktop-version', appVersion, rendererRelease? }` when
  their device leg connects. The relay stores it on the device row in
  `devices.json` (`appVersion`, `rendererRelease`, `versionSeenAt`), so it
  survives restarts. Old desktops send nothing.
- Layout: `/opt/mixdog-relay/renderer` stays the newest renderer (also the
  delta base); `/opt/mixdog-relay/renderer-releases/` holds `index.json` plus one
  tree per release (`<desktopVersion>-<shell hash prefix>`, and `legacy`).
  Override with `RENDERER_RELEASES_DIR`; with no registry the relay serves
  `RENDERER_DIR` to everyone, as before.
- **Selection rule**, first match wins: the device's reported renderer release
  id; else the newest release whose desktop version equals the device's; else
  the newest release for an older-or-equal desktop version (a desktop newer than
  every retained release gets the newest one); else — old desktops that never
  report, or versions older than everything retained — the **`legacy`**
  release, i.e. the renderer that was installed when this feature first shipped
  (adopted automatically by the first deploy); with no legacy release, the
  newest. `/d/<id>/…` uses the route's device; root requests (`/sw.js`,
  `/assets/…`) use the paired token's device, else the `mixdog_device` cookie.
- **Retention rule**: `legacy` is never collected; the newest 3 releases are
  kept; releases still selected for a device seen in the last 30 days are kept
  too (newest first) up to 6 non-legacy releases.
- Caching: hashed `/assets/*` are content-addressed and `immutable` across
  releases; other root responses carry `Vary: Cookie`; `/d/<id>/…` URLs are
  per device; ETags are content hashes, so service worker and shell
  validators never collide between releases.
- Deploy: `deploy-release.sh <domain> <tag> <desktop-version>` runs
  `renderer-releases.mjs --action=prepare` against the **staged** tree: the
  installed registry is hardlinked in, the new renderer is added as one more
  release, and GC runs (registry written by rename, so the installed tree
  that rollback restores is never touched). The swap, backup and rollback are
  the unchanged transaction above. A relay-only deploy passes no desktop
  version and registers nothing.
- `/readyz` inspects the current renderer **and every retained release**; any
  broken one is not-ready. `verify-release.mjs --expected-release=<id>`
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
  (`ice-servers-request` → `ice-servers`, `lib/ice-legs.mjs`), only for a device
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
  range (`reserved-ports.mjs`). Residual: a fixed-port UDP service of this host
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

The script masks and stops the package's stock `coturn.service` (and refuses to
continue if it, or any other process, still holds the TURN ports) before it
installs anything, and waits for the listening sockets before it reports success.

### Verify

After the relay deploy (which restarts the relay with the new settings):

```bash
ssh root@<vps> 'bash /opt/mixdog-relay/deploy/coturn/verify-turn.sh <public-ipv4>'
node apps/relay/deploy/coturn/stun-probe.mjs <relay-domain>     # from outside the VPS
```

`verify-turn.sh` checks the services, file modes, config, listeners, the egress
policy (including that the relay range is contained in the reserved ports), then
with `turnutils_uclient` a fresh credential (a relayed client-to-client exchange
through the host's own address), an expired one, and where a relayed packet may
land, always addressed to the public address: a peer inside the relay range
(must be delivered), a peer outside it (must not be, and the policy's drop
counter must have moved), and a loopback peer (must not). The `turnutils_uclient` runs are bounded by the RFC 8489 §6.2.1 UDP
transaction timeout (39.5 s), so the two refusals take that long each.
`stun-probe.mjs` retransmits on the same RFC schedule (up to 39.5 s without a
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
