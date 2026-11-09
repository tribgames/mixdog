# Phone protocol audit

What the paired phone sends to the PC at the Node baseline `b6f10295a`, what served it there, and what serves it in `mixdogd` on the audited tree.

```
python benchmarks/rust-core/audits/phone-protocol/audit.py     # python 3 + git, no builds, about 1 minute
```

Writes `phone-protocol-table.md` (counts, port units, table) and `phone-protocol-table.json` (every field). The "tree audited" line is the checkout the script ran in, so re-running after the audit commit names that commit.

## What is the "phone source"

`apps/mobile` is only a Capacitor shell (pairing screen, native push, file save). The code that talks to the PC is the relay web app the shell loads: `apps/desktop/src/renderer` (`remote-shim*.ts`, `native-push-bridge.ts`, `public/sw*.js`) over `apps/desktop/src/shared`. The script reads those from git at the baseline and extracts:

- requests: every `call` / `fire` / `invoke` / `fireHanded` whose first argument is a string literal or a `shared/` constant (`FILE_DOWNLOAD_REMOTE_METHODS.*`, `REMOTE_WEBRTC_*`), plus the boot prefetch tuples; args are the positional array text at the call site, the reply is the declared type of the `DesktopApi` member in `shared/contract*.ts` with its interface fields;
- events: every `message.event === ...` branch of `remote-shim-dispatch.ts`, plus the non-event frames;
- push: the service worker `push` handler, `NativePushContent`, the Android/iOS decryptors, the Allow/Deny notification actions;
- transfers: the `fileDownload*`, ranged-read, attachment, visualize-pane calls (surface `transfer`) and the encrypted media lane; the native file save is phone-local and excluded.

## Classes

| class | rule used by the script |
|---|---|
| `same` | the target method (or section / notification) exists, allows the `relay` origin, has a handler that the daemon builds, and a Node recording of that operation (`op`/`method`/`call` key in `native/core/fixtures`) is consumed by a Rust test in the handler's crate that names the Node op or the wire method. The evidence column says which; "names the Node op only" means the engine is compared with the recording, the relay envelope is not. |
| `exists-unproven` | same, without such a recording-backed test (a test of the method may exist: listed as `test`). |
| `missing` | no target, removed by design, a target that refuses the relay origin, a handler no non-test code reaches, or a module nobody builds (live view, MXT transport, media lane). |
| `phone-changed` | the audited tree has a replacement in the phone source (`apps/mobile/src/screen-reporter.ts`, `packages/protocol-client`), whatever the server side says. The `server` column is kept apart for these rows. |

`server` is `served` / `unserved` / `by-design` and is independent of the class; the port units use both.

## Inputs the script does not derive

Four small tables at the top of `audit.py` are curated and are checked on every run (a stale entry stops it): `EVENT_MAP` (Node event to protocol notification, from `spec-v2/desktop-services.md` section 2.4), `MECHANICS` (phone names the DS inventory does not list), `PHONE_O1` (which o1 file replaces a Node call), `FEATURE_RULES` (user-visible feature wording).

## Limits

- Reply fields are the declared TypeScript reply types, not a trace of the fields each screen reads.
- Handler lines are the first non-test string literal of the method (or a `ClientRequest::<Variant>` arm in `mixdog-app-server/src/server.rs`); "built by the daemon" is a name search in the daemon's non-test sources, backed by the compose-time `Unclaimed` check (`compose_flip.rs`, `builder.unclaimed()`).
- Publisher checks look for `SectionName::<Variant>`, the section name string, or the typed notification name outside the protocol crates; a publisher that builds the name dynamically is reported as missing (the text says "static search").
- Nothing here runs the daemon or a phone: no behaviour is asserted beyond what a cited test already compares.
