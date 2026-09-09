# Mixdog browser password import sidecar

This directory builds the two Windows executables used to import Chrome saved
passwords. It is a separate GPL-3.0-only process; Mixdog's MIT main process
communicates with it through a bounded child-process protocol.

The build is pinned to commit
`6e2c2151f215df69b7cf75b43f189b2cba8b6b5e` of
https://github.com/bitwarden/clients. `build.ps1` checks out only the required
native source, adds the Mixdog wrapper, builds both unsigned executables, and
emits the complete GPL notice with the binaries.

Windows desktop packaging invokes this build automatically. No code-signing
certificate is required.

The wrapper never writes plaintext credentials to stdout. The desktop main
process sends a one-time key through inherited stdin, receives an AES-256-GCM
envelope, decrypts it in memory, and immediately stores the result with
Electron `safeStorage`.

## Cookie import

Cookie database schema 24 and newer binds encrypted values to their domain
with a SHA-256 prefix, independently of the v10/v20 encryption envelope. The
importer validates that binding and preserves plaintext values without lossy
text conversion. Partitioned cookies retain their top-level site and
cross-site-ancestor identity. Missing or invalid ancestry is reported as an
error rather than silently widened into an unpartitioned cookie.

The encrypted cookie payload is a version-2 report containing `sourceCount`,
`expired`, `cookies`, and categorized `failures`. Every source row must be
accounted for. Expired entries are excluded before decryption, not reported as
failures. The desktop rejects older reports, so ship the desktop and native
helper together. Data import never claims that a website accepted the session.
Device-bound sessions may require a fresh login in a supported browser.

After preparing the pinned native dependency checkout with the existing build
process, run the native behavioral tests without changing that checkout:

```powershell
node native/mixdog-browser-import/test.mjs
```

An optional first argument selects an already-prepared `desktop_native`
dependency directory. Tests use synthetic cookie databases and a temporary
workspace, not the user's browser data.
