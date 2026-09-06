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

The transaction tests use real filesystem renames only inside a generated
temporary directory and replace `systemctl` with a recorder. They never run
the production installer or contact a VPS.
