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
