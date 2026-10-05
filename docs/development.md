# Development, configuration, and testing

## Data and configuration

Mixdog uses `~/.mixdog` as its home root and `~/.mixdog/data` for runtime data
by default.

```bash
MIXDOG_HOME=/path/to/home mixdog
MIXDOG_DATA_DIR=/path/to/data mixdog
```

Useful environment variables:

- `MIXDOG_TUI_MOUSE=0` — use terminal-native mouse behavior.
- `MIXDOG_DISABLE_MODEL_PREFETCH=1` — disable provider model prefetch.
- `MIXDOG_MODE=ship|dev` — select shipping or development diagnostics.
- `MIXDOG_DIAGNOSTICS=1` — force diagnostic trace and log output.

## Core technology

| Layer | Stack |
| --- | --- |
| Shared agent runtime | Node.js and ECMAScript modules, shared by CLI and Desktop |
| Terminal UI | React and Ink |
| Desktop workspace | Electron, React, TypeScript, Monaco, and xterm.js |
| Native code tools | Rust, tree-sitter, and embedded ast-grep for parsing, structural queries, and rule-based checks |
| Browser automation | Chromium and the Chrome DevTools Protocol (CDP) |
| Long-term memory | Managed local PostgreSQL with pgvector and full-text search |
| Documents | Portable OOXML and PDF tooling, plus Microsoft Office automation on Windows |

These components serve different roles: native tools analyze code, database
retrieval keeps historical context selective, and provider-specific caching
reduces repeated model processing. See [Context efficiency](context-efficiency.md)
for how they work with prompt management and compaction.

## Development

```bash
npm install
npm start

npm run smoke
npm run smoke:all
npm test                       # discovered fast-lane tests
npm test -- src/runtime/memory  # narrow to one path
npm run test:slow              # *.slow.test.mjs
npm run test:live              # built-artifact or live-system checks
npm run build:tui
npm run audit:models
```

For desktop development, install the root dependencies above, then:

```bash
cd apps/desktop
npm install
npm run dev
```

Desktop development runs in an isolated dev profile, including its own data,
daemon and tool connections. It never reads or changes the installed app's
settings, sign-ins or sessions. `npm run dev` keeps one profile
(`%LOCALAPPDATA%\mixdog-dev\default` on Windows, `~/.mixdog-dev/default`
elsewhere), so settings, sign-ins and sessions made in the dev app survive
restarts; select another kept profile with `npm run dev -- --profile <name>`.
`npm run dev:fresh` starts from an empty throwaway profile, retained in the
system temporary directory for diagnosis. CDP uses port `9342`; if it is
occupied, reuse the running dev app or choose another port with
`npm run dev -- --port 9343`.
On Windows, `npm run e2e:direct` and `npm run e2e:direct:source` also use isolated
profiles and port `9342` (override with `-- -Port 9343`).

Both packages discover `*.test.mjs` and `*-test.mjs` under their `src/` and
`scripts/` directories. Fast, slow, and live tests run in separate lanes;
live checks need their corresponding built artifacts or services. See
[testing practices](testing.md) for details.

Main directories:

```text
src/            CLI, TUI, runtime, workflows, agents, and rules
apps/desktop/   desktop app
apps/relay/     remote web app and relay
native/         native process, search, graph, patch, and support binaries
scripts/        tests, diagnostics, benchmarks, and build scripts
benchmarks/     reproducible benchmark harnesses, results, and raw artifacts
src/vendor/     vendored runtime components
```

## macOS signing and notarization

Release builds sign the macOS app with a Developer ID certificate and notarize
it when all five repository secrets below are set. With none of them the app is
packaged unsigned; a partial set fails the macOS job rather than shipping a
signed but un-notarized app.

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE_P12_BASE64` | Base64 of the exported Developer ID Application `.p12` |
| `MAC_CERTIFICATE_PASSWORD` | Password of that `.p12` |
| `APPLE_API_KEY_P8` | Contents of the App Store Connect API key (`AuthKey_*.p8`) |
| `APPLE_API_KEY_ID` | Key ID of that API key |
| `APPLE_API_ISSUER` | Issuer ID of the App Store Connect team |

The hardened-runtime entitlements live in
`apps/desktop/build/entitlements.mac.plist`.
