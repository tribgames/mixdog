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
