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

## App-Bound ("v20") master key

Chrome 127+ wraps the OSCrypt master key with App-Bound Encryption. Unwrapping
it requires an elevated process that talks to Chrome's elevation service; the
GPL `bitwarden_chromium_import_helper.exe` does that and returns the 32-byte key
over a local named pipe. A manual import (`지금 가져오기`) launches the helper
with the `runas` verb (one UAC prompt per import). The key is written only to
the pipe (base64); the importer wipes its own base64 and decoded key buffers
once the key is used. Passwords and cookies leave only as the sealed AES-GCM
envelope.

The pipe name is compiled into the upstream helper, so it is fixed rather than
per-call. The importer therefore authenticates the peer instead: it creates the
pipe as the first instance (a name already owned by another process is
refused), limits the pipe to a single instance so no second server can be
created while the UAC prompt is up, rejects remote clients, and reads only from
the connection whose client process id is the helper it launched with
`ShellExecuteExW`. Any other connection is dropped unread. Making the name
unique per call would require changing the helper's command line.

## Database snapshots

Chrome's `Login Data` and `Cookies` databases are opened read-only and copied
with SQLite `VACUUM INTO` inside SQLite's own locking, so the copy is either a
consistent point-in-time image or the import fails. The desktop closes Chrome
first; if Chrome still holds the database the importer fails with a "close
Chrome" error instead of reading a torn file copy. Only a real lock (or a file
Chrome holds without sharing) gets that message; read-only, permission, I/O and
corruption failures are reported as unreadable data.

## Error output

The desktop shows stderr to the user, so the importer never forwards parser,
SQLite or helper error text (which can quote `Local State` content or a helper
reply). A failure is classified where it happens and only one of a few fixed
messages is printed: Chrome still running, profile not found, data could not be
read, decryption failed, elevation cancelled or failed, or a generic failure.

Robustness caveat: the unwrap depends on Chrome's current elevation interface,
so a Chrome update can break it. v10 values are decrypted in-process with no
elevation.

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
