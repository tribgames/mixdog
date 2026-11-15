# Relay hand-over: Node to the `mixdog-relay` binary

The procedure the owner runs on the VPS, in order. Nothing in it is run by a
release: `deploy-release.sh` only starts at step 4, and only on the owner's go
(merging `nr-relay-switch`). Each step says how to tell it worked and what to do
if it did not. Run everything as root on the VPS unless a step says otherwise.
`<domain>` is the relay's domain (the name in `/etc/letsencrypt/live/`).

The pieces this uses, all in this directory: `deploy-release.sh`,
`release-transaction.sh` (the transaction: stage, swap, drop-in, restart,
verify, roll back), `mixdog-relay.service`, `coturn/provision-coturn.sh`, and
`shadow-check.sh` (the shadow run of step 3 and the TLS probe of steps 1 and 3).

What the clients see at the switch (step 4), so nobody is surprised: connection
refused for a few seconds while the unit restarts; the Android app's reconnect
screen treats it as a relay restart (`ReconnectState`: reloads at 2, 4, 8, 16 s,
then every 30 s, up to 8 automatic reloads, and at once when the network returns
or the app comes back to the foreground); desktops redial inside their 1-30 s
backoff; phones redial on their ladder. Pending pairing claims and live pairing
codes are dropped, as on any restart. The stored pairings, device credentials,
web push subscriptions and feedback queue are in `DATA_DIR` and are untouched.

## 1. Pre-checks on the VPS

1. The machine against the build target (the owner's decision 1 was the CI
   artifact for glibc 2.28 or newer):

   ```sh
   uname -m            # x86_64 -> mixdog-relay-x86_64-unknown-linux-gnu ; aarch64 -> mixdog-relay-aarch64-unknown-linux-gnu
   ldd --version | head -n 1   # glibc 2.28 or newer
   ```

   Worked when the architecture is one of the two and glibc is at least 2.28. If
   not, stop: the CI binary will not start here, and the build choice (static
   musl, or a build on this host) has to be decided first.

2. The environment the binary will receive. It is the unit's own, plus the
   drop-ins:

   ```sh
   systemctl cat mixdog-relay
   ls -la /etc/systemd/system/mixdog-relay.service.d/
   systemctl show mixdog-relay -p Environment -p EnvironmentFiles --value | sed 's/=.*//'   # names only
   ```

   Expected: `PORT`, `DATA_DIR`, `RENDERER_DIR`, `TLS_CERT`, `TLS_KEY`, the
   `turn.conf` drop-in (it names `EnvironmentFile=/etc/mixdog-relay/turn.env`), and
   any SMTP, FCM or APNs names the feedback mail and native push use.
   `NODE_OPTIONS` (the Node heap cap) is the one name the switch removes; the
   binary has no use for it and `MemoryMax=800M` stays its bound. A drop-in that
   sets anything else the binary reads (`PORT`, `DATA_DIR`, `TLS_*`,
   `RENDERER_*`, `TURN_*`, `SMTP_*`) is read as it is. Write down any drop-in other
   than `turn.conf`: step 4 installs `exec.conf` beside it and leaves it alone.

3. The data directory, and the backup:

   ```sh
   ls -la /var/lib/mixdog-relay
   stamp=$(date +%Y%m%d-%H%M%S)
   tar -C / -czpf /root/relay-before-switch-$stamp.tgz \
     var/lib/mixdog-relay opt/mixdog-relay \
     etc/systemd/system/mixdog-relay.service etc/systemd/system/mixdog-relay.service.d \
     etc/mixdog-relay
   tar -tzf /root/relay-before-switch-$stamp.tgz | head -n 5
   sha256sum /root/relay-before-switch-$stamp.tgz
   ```

   Worked when the listing prints and the archive is non-empty. Copy it off the
   host (`scp`) before step 4: it holds the credential rows and the TURN secret.
   If `tar` complains about a missing path, the listed name is wrong for this
   host: fix it, do not go on without the backup.

4. The Node baseline the switch is judged against (take it while the Node relay
   is serving, at a busy hour, and keep the output):

   ```sh
   systemctl show -p MemoryCurrent -p CPUUsageNSec -p ActiveEnterTimestamp mixdog-relay
   journalctl -u mixdog-relay --since '24 hours ago' --no-pager | grep '\[relay\] sockets 30s' > /root/relay-node-sockets-$stamp.txt
   wc -l < /root/relay-node-sockets-$stamp.txt
   # phones, buffered bytes, loop-p50/p99/max per 30 s; the busiest and the median:
   sed -n 's/.*phones=\([0-9]*\).* loop-p50=\([0-9.]*\)ms loop-p99=\([0-9.]*\)ms loop-max=\([0-9.]*\)ms.*/\1 \2 \3 \4/p' \
     /root/relay-node-sockets-$stamp.txt | sort -k4 -n | tail -n 3
   ```

   The line is `[relay] sockets 30s phones=N buffered desktop:ab=0B ... loop-p50=..ms
   loop-p99=..ms loop-max=..ms`. Compare later against the figures of the
   `nr-relay-twin-perf` table (`native/core/crates/mixdog-relay/tests/twin_perf/README.md`
   says how it is produced; the table is attached to that task's pull request). The
   binary must not be slower than Node there, and its resident memory must be lower.
   Note that after the switch `loop-p50/p99/max` measure the Rust runtime's
   scheduling lag, not a Node event loop's, so compare the order of magnitude, not
   the identity of the figure.

5. The TLS protocols and suites the Node listener accepts today (the baseline the
   shadow port is compared with in step 3). This tests every protocol and suite the
   host's `openssl` knows, against the live port, and needs nothing but `openssl`:

   ```sh
   /root/shadow-check.sh tls <domain> 443 127.0.0.1 | tee /root/relay-node-tls-$stamp.txt
   grep -c ' ACCEPTED$' /root/relay-node-tls-$stamp.txt
   ```

   (`shadow-check.sh` must already be on the host: upload it as step 2 shows, before this
   check.) The lines are `<protocol> <suite> ACCEPTED|REFUSED|UNTESTABLE`.
   `nmap --script ssl-enum-ciphers -p 443 <domain>` gives the same picture when nmap
   is installed. To see Node's own default list: `node -p "require('tls').DEFAULT_CIPHERS"`.
   `UNTESTABLE` means this `openssl` build cannot offer that protocol or suite; it is
   not a refusal.

6. A check that the binary loads the live `devices.json` as it is is part of step 3
   (it needs the binary). Nothing to do here except note the device and client
   counts Node holds now, for the record:

   ```sh
   node -e 'const r=JSON.parse(require("fs").readFileSync("/var/lib/mixdog-relay/devices.json","utf8"));console.log("devices",Object.keys(r).length,"clients",Object.values(r).reduce((n,d)=>n+Object.keys(d.clients||{}).length,0))'
   ```

## 2. Build, and get the files to the host

The binary comes from a `workflow_dispatch` run of `mixdogd-build.yml` at the exact
commit to be switched (task `nr-relay-ci-build`: the two Linux legs build
`mixdog-relay` in the manylinux_2_28 containers, smoke-start it, and upload it as
`mixdog-relay-<target>`):

```sh
gh workflow run mixdogd-build.yml --ref main -f ref=<commit sha>
gh run list --workflow mixdogd-build.yml --limit 3          # note the run id
gh run watch <run id> --exit-status
gh run download <run id> -n mixdog-relay-x86_64-unknown-linux-gnu -D /tmp/relay-bin   # or -aarch64-... for aarch64
sha256sum /tmp/relay-bin/mixdog-relay
```

Worked when the run is green (including its "The relay starts and answers /healthz"
step) and the sha256 prints. Write the sha256 down: the release that step 4 deploys
stages the binary of its own `mixdogd-build` job. When it is built from the same
commit as this run, `sha256sum /opt/mixdog-relay/mixdog-relay` after step 4 equals
this hash (builds are expected to be reproducible, not guaranteed: a different hash
from the same commit is worth a look, not a rollback by itself); so switch from the
commit this run built. If
the run fails, nothing has changed on the server; fix the build first.

Upload the binary and the helper to the host. The binary goes to a scratch path, not
to `/opt/mixdog-relay`:

```sh
scp /tmp/relay-bin/mixdog-relay root@<host>:/root/mixdog-relay.candidate
scp apps/relay/deploy/shadow-check.sh root@<host>:/root/shadow-check.sh
ssh root@<host> 'chmod 0755 /root/mixdog-relay.candidate /root/shadow-check.sh && sha256sum /root/mixdog-relay.candidate'
```

The hash printed on the host must equal the one printed in the build step. If not,
the copy is damaged: upload again.

## 3. Shadow check

Runs the candidate beside the live Node relay, on a spare port, against a copy of
`DATA_DIR` that has no `feedback/` (a queued mail is never sent twice). Pick a port
`ufw` does not open (the script refuses one it opens or one already listening);
`8443` is used below:

```sh
ufw status | grep -w 8443 || echo "8443 is not opened: good"
TLS_BASELINE=/root/relay-node-tls-$stamp.txt \
  /root/shadow-check.sh run /root/mixdog-relay.candidate <domain> 8443 2>&1 | tee /root/relay-shadow-$stamp.txt
```

What it does, and how each result reads:

- **The start-up line** `[relay] https listening on :8443 (renderer: /opt/mixdog-relay/renderer)`:
  the unit's environment with only `PORT` changed (and `DATA_DIR` pointed at the
  scratch copy, `SMTP_USER` and `SMTP_PASSWORD` unset, so the copy cannot send mail).
  The process runs as `mixdog-relay`, the user of the unit. Fail: no line within 20 s;
  the script prints the first log lines. Typical causes: a certificate the user
  cannot read, a missing library (`ldd /root/mixdog-relay.candidate`).
- **No failure line** in its log (`failed to start`, `cannot read`,
  `ignoring malformed`, `...unusable`, `TURN credential issuance disabled`).
  A `TURN credential issuance disabled` line means the `turn.env` secret was not
  passed: look at step 1.2.
- **The device store.** The binary reports no counts of its own at start-up; the
  script instead has it register one new device through the shadow port, which makes
  it rewrite the scratch `devices.json` from what it loaded, and compares that file
  with what Node's own loader (`lib/device-store-persistence.mjs` of the installed
  Node tree, `NODE_TREE` to override) makes of the original, plus the new device.
  `PASS ... node loads devices=N clients=M; the binary wrote devices=N clients=M`
  means every device and client row, and every profile name (the 80-unit clip, also
  one that cuts an emoji in half), is the same. `NOT CHECKED` is printed, and is not a
  pass, when there is no `node` or no Node tree on the host; run this step before the
  Node tree is retired (step 7). A difference prints up to ten differing device ids
  (first eight characters): keep the scratch directory with `KEEP_SCRATCH=1`, do not
  go on, and report them.
- **Web push** enabled with the public key of `webpush-vapid.json` (and the same key
  the live relay serves, when it answers on `https://<domain>/webpush/key`).
- **`verify-release`** from the candidate against the shadow port:
  `mixdog-relay verify-release --origin=https://<domain>:8443 --address=127.0.0.1 --expected-index=<sha256 of the installed renderer/index.html>`
  (`/healthz`, `/readyz` with the renderer hash, `/ws` upgrade refused with 4005,
  foreign origin 403). It then stops the candidate and removes the scratch copy.
- **TLS.** The same probe as step 1.5 against the shadow port, and the list of
  protocol/suite lines Node accepted and the shadow port refuses. rustls does not
  offer TLS 1.2 CBC suites, DHE suites, TLS 1.0 or 1.1, so expect those lines. The
  Android app's `minSdkVersion` is 23 (Android 6), which negotiates the
  `ECDHE-*-GCM` suites rustls offers; an Android or iOS release older than that (a
  client that can only do CBC or DHE) would no longer connect, and the fleet's
  oldest versions are not recorded in the repository: check the oldest Android and
  iOS versions your users actually run (the relay's own Node log does not show them).
  **The owner decides whether any refused suite is acceptable before step 4.** If
  it is not, stop here: the change is in the TLS configuration of the binary, not in
  this procedure.

The check passed when its last line is `shadow check: all checks passed` and the
exit status is 0. It never touches the live service, port or `DATA_DIR`. If the run
was interrupted, `ls -d /var/tmp/mixdog-shadow.*` shows a leftover scratch copy:
`rm -rf` it (it holds copies of the credentials), and `pgrep -af /var/tmp/mixdog-shadow`
must show nothing.

## 4. Switch

On the owner's go: merge `nr-relay-switch`, then run the deploy workflow as for any
release (`gh workflow run deploy.yml`, or the way releases are started today). The
release's `stage-relay` job stages the Linux binary of its `mixdogd-build` job with
`deploy/` and `renderer/`; `deploy-relay` runs `deploy-release.sh` on the host.
What `deploy-release.sh <domain> <tag> [desktop-version] [android-url]` does, under
the deployment lock and the release transaction (`release-transaction.sh`):

1. Stages `/opt/mixdog-relay.next-<tag>` with the binary (mode 0755, root), `deploy/`,
   `mobile-release.json`, and the renderer (delta applied through the staged binary,
   the full upload, or the installed renderer hard-linked), then runs
   `mixdog-relay renderer-releases --action=prepare` there.
2. Arms the transaction, moves `/opt/mixdog-relay` to `/opt/mixdog-relay.backup-<tag>`
   and the staged tree in its place.
3. Because the unit still runs Node (`systemctl show -p ExecStart` does not name the
   binary), writes the drop-in
   `/etc/systemd/system/mixdog-relay.service.d/exec.conf` (`ExecStart=` reset, then
   `ExecStart=/opt/mixdog-relay/mixdog-relay`, and `UnsetEnvironment=NODE_OPTIONS`),
   runs `systemctl daemon-reload`, then `systemctl restart mixdog-relay`.
4. Runs the installed binary's `verify-release` against `https://<domain>` with the
   expected renderer hash and release id.
5. On any failure, or a signal: stops the service, puts the Node tree back, restores
   the drop-in to what it was (here: removes `exec.conf`), reloads, restarts and
   checks the unit is active. Exit status 90 means the rollback itself failed and
   both trees were kept: go to step 6 by hand.
6. On success: the Node tree (it holds `server.mjs`) is kept as
   `/opt/mixdog-relay.handover`; the cleanup globs never match that name.

Worked when the workflow's `deploy-relay` job is green and its last log line is
`[deploy] activated <tag> renderer=<sha256> release=<id> mode=<mode>`. A red job
after `[deploy] rolled back to the previous release` means the Node relay is serving
again: read the job log for the reason, and run step 5's `journalctl` line to see
what the binary printed.

## 5. After the switch

```sh
systemctl is-active mixdog-relay && systemctl show -p ExecStart mixdog-relay | grep -c /opt/mixdog-relay/mixdog-relay
journalctl -u mixdog-relay --since '10 minutes ago' --no-pager | grep -E '\[relay\] (https listening|ice-servers|feedback|sockets 30s)|failed|disabled'
curl -fsS https://<domain>/healthz ; echo
curl -fsS https://<domain>/readyz | head -c 300 ; echo
systemctl show -p MemoryCurrent -p CPUUsageNSec mixdog-relay
certbot renew --dry-run
grep -n 'systemctl' /etc/letsencrypt/renewal-hooks/deploy/mixdog-relay
```

Expect, in this order of importance:

- `[relay] https listening on :443 (renderer: /opt/mixdog-relay/renderer)`, then (with
  clients) `[relay] ice-servers issued device=<8 chars>`; a `[relay] feedback ...`
  line when feedback is used; and every 30 seconds `[relay] sockets 30s phones=N
  buffered ... loop-p50=..ms loop-p99=..ms loop-max=..ms`. The operator lines keep
  the text Node wrote (the catalogue is `src/logline.rs` in the crate), so the
  greps and alerts you had keep working; only the `loop-*` figures now measure the
  Rust runtime's scheduling lag. No `failed to start`, no
  `TURN credential issuance disabled`.
- `/healthz` answers `{"status":"ok"}`; `/readyz` answers ready with the renderer
  hash the deploy printed.
- `MemoryCurrent` against the Node baseline of step 1.4 under comparable load (right
  after a restart both are small: compare again after an hour): lower than Node, well
  under the 800 MB bound. If it is higher, report it with the sockets lines before the
  window ends.
- `certbot renew --dry-run` ends with every simulated renewal succeeding, and the
  renewal hook still restarts the service (the `grep` shows the `systemctl restart
  mixdog-relay` line the installer wrote). A change in the hook would show here.
- A phone and a PC reconnecting: open the Mixdog desktop app (it shows the relay as
  connected within its 1-30 s backoff) and the phone app (its reconnect screen ends
  and the session list appears). `journalctl` then shows the phone leg lines. If one
  does not return, note the time and the `phone upgrade refused` / `leg closed` lines.
- A feedback submission from the app arrives (mail received, or the file appears in
  `/var/lib/mixdog-relay/feedback/` and is then sent).

A phone that still shows its reconnect screen after a minute, a desktop that never
shows connected, or failing `verify-release` are reasons to roll back (step 6) while
the window is open.

## 6. Manual rollback within the window

While `/opt/mixdog-relay.handover` exists. `DATA_DIR` needs nothing: the formats are
the same in both directions (proven by the twin data suite), so credentials, pairings
and push subscriptions written by the binary are read by Node.

```sh
systemctl stop mixdog-relay
mv /opt/mixdog-relay /opt/mixdog-relay.rust-aside
mv /opt/mixdog-relay.handover /opt/mixdog-relay
rm -f /etc/systemd/system/mixdog-relay.service.d/exec.conf
systemctl daemon-reload
systemctl start mixdog-relay
systemctl show -p ExecStart mixdog-relay | grep -c server.mjs      # 1: the unit runs Node again
systemctl is-active mixdog-relay
expected=$(sha256sum /opt/mixdog-relay/renderer/index.html | awk '{print $1}')
node /opt/mixdog-relay/deploy/verify-release.mjs --origin=https://<domain> --address=127.0.0.1 --expected-index=$expected
```

Worked when the unit is active, the `grep` prints 1, and the Node `verify-release`
prints its JSON success line. If the unit does not start, `journalctl -u
mixdog-relay -n 50` and the backup tarball of step 1.3 are the fallbacks
(`tar -C / -xzpf /root/relay-before-switch-<stamp>.tgz opt/mixdog-relay etc/systemd`,
`systemctl daemon-reload`, `systemctl restart mixdog-relay`). Tell the lead
(the Rust relay is the one that stays or goes) before the next release: the next
`deploy-release.sh` would install the binary again.

## 7. Retire

Only after the owner's window has passed with the binary serving. Steps in this order:

1. Re-run the coturn provisioning so the egress unit calls the binary instead of
   Node (a box provisioned earlier keeps working with the Node helper until then,
   which is why it can only be removed now):

   ```sh
   cd /opt/mixdog-relay/deploy/coturn      # the new tree carries the updated script
   ./provision-coturn.sh <relay-domain> <public-ipv4> --user-quota=<N> --issue-limit=<N>   # the values of the first provisioning
   systemctl cat mixdog-coturn-egress | grep ExecStart      # /opt/mixdog-relay/mixdog-relay reserved-ports ...
   systemctl is-active mixdog-coturn-egress mixdog-coturn
   ./verify-turn.sh <public-ipv4>
   ```

   Worked when `ExecStart` names the binary, both units are active and
   `verify-turn.sh` passes. If it fails, the old egress unit text is in the backup
   tarball (`etc/systemd`); the relay itself is not affected.

2. Remove the Node copy and Node itself:

   ```sh
   rm -rf /opt/mixdog-relay.handover /opt/mixdog-relay.rust-aside
   apt-get purge -y nodejs
   rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources /etc/apt/keyrings/nodesource.gpg
   apt-get update
   command -v node || echo "node is gone"
   systemctl is-active mixdog-relay
   ```

   Run `shadow-check.sh` (step 3) before this only if you still need it: its device
   store comparison needs the Node tree. After this the relay and every deploy step
   no longer need Node on the host.

3. Tell the lead the switch is final, in the owner's own words, so waves 10 and 11 can
   start. The owner writes the statement `nr-relay-switch-final` records (what was
   switched, the commit and binary sha256 of step 2, the date, the TLS decision of
   step 3 and that the rollback window closed); the lead does not write it for them.
