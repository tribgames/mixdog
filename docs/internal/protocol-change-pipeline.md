# Protocol change pipeline (migration waves)

How a protocol change travels from a leaf task to the generated clients while the desktop migration runs in waves.
Written by PROTO-WIRE-G1; later PROTO-WIRE tasks keep it current.

## Why fragments

The protocol table files are touched by almost every task of a wave. Leaf tasks therefore never edit them; they write a
fragment, and the single wiring task of the wave pastes every fragment, regenerates and deletes the fragments.

Hot protocol files (only the PROTO-WIRE task of a wave edits them):

- `native/core/crates/mixdog-app-protocol/src/`: `methods.rs`, `server_requests.rs`, `notifications.rs`, `inventory.rs`,
  `free_text.rs`, `v1.rs`, `v2/mod.rs`, `v2/host.rs`, `v2/params.rs`
- `native/core/crates/mixdog-app-protocol/tests/it/free_text_fields.json`, `schema/*.json` (generated)
- `native/core/crates/mixdog-protocol/src/section.rs`, `native/core/crates/mixdog-core-api/src/host.rs`
- `packages/protocol/src/index.ts` (generated), `packages/protocol-client/src/method-table.ts`,
  `packages/protocol-client/src/actions/method-args.generated.{mjs,d.mts}` (generated)
- `native/core/crates/mixdog-app-server/src/outgoing.rs` (the `serves` capability map; owned by PROTO-WIRE-G1 in G1 and by
  x-proto-gating-core in G2)

## Fragment conventions

### Protocol: `native/core/crates/mixdog-app-protocol/pending-rows/<task-id>.rows`

A leaf task puts its new types in its own module file (`src/v2/<module>.rs`) and lists everything else here, in sections:

| section | content |
|---|---|
| `[methods]` | client method rows for `client_request_definitions!`, with the anchor row to paste after (by symbol, e.g. `SystemPortsUnsubscribe => "system/ports/unsubscribe"`) |
| `[server_requests]` | rows for `server_request_definitions!`, with their anchor |
| `[notifications]` | server notification rows (`notification_definitions!`), `ClientNotification` variants and `CLIENT_NOTIFICATIONS` specs, each with its anchor |
| `[inventory]` | rows for `inventory.rs`, or why there are none (the inventory is the frozen 1.4.5 list) |
| `[free_text]` | `FREE_TEXT` rows for `src/free_text.rs`, and the field entries for `tests/it/free_text_fields.json` (`classes`, by the reason text of an existing class or as a new class; `payloads` for untyped values) |
| `[type_edits]` | exact Rust text for edits of existing types, with the file and the type name |
| `[remove]` | rows to remove |
| `[window]` | one line per new client -> core method: `<method> allow <reason>` or `<method> deny <reason>` |

Lines starting with `#` are instructions to the wiring task. A row names a new type either by path (`v2::<module>::Type`)
or by the glob `use crate::v2::<module>::*;` the header asks the wiring task to add.

Rules learned in G1:

- Every string field the schema has, including the open parts of a `payloads` entry (`<pointer>/**`), must be in exactly
  one class of `free_text_fields.json`; the `free` ones must equal `FREE_TEXT`. A field added to an existing struct by a
  `[type_edits]` line needs its class line too (e.g. `initialize /capabilities/host/<capability>/...`).
- `#[ts(type = "X | null")]` hides the dependency on `X` from ts-rs, so `X` is missing from `index.ts`. For a nullable
  field that must be written (`X | null`, not `x?:`) inside an `optional_fields` struct, use `#[ts(optional = false)]`
  without `type`; keep `type = "..."` only for primitives.
- A new field on a struct built by field elsewhere needs `<field>: None` at each literal (grep `<Struct> {`).

### Core: `native/core/crates/pending-wire/<task-id>.wire`

Module lines, workspace members, `[dependencies]` lines and composition calls for the core hot files (`native/core/Cargo.toml`,
`Cargo.lock`, the daemon's `compose_flip.rs` and `lib.rs`, `mixdog-tools` `desktop/mod.rs`, core-domains `domains/mod.rs`, ...).
Each entry: `file:`, `place:` (by symbol), then `add:` / `edit:` lines. Applied by the CORE-WIRE task of the wave.

### Desktop: `apps/desktop/pending-wire/<task-id>.wire`

The same form for the desktop hot files (`src/main/index.ts`, `ipc.ts`, `host/index.ts`, `host/connection.ts`, preload,
`shared/contract*.ts`, `renderer/main.tsx`, `ipc-state-bridge.ts`). Applied by the desktop wiring task of the wave.

A fragment line that cannot be applied as written is resolved from the code of the task that wrote it; one that belongs
to a later wave is kept in `<same folder>/deferred-<wave>.md` with its reason.

## Regeneration

From `native/core`, with `CARGO_TARGET_DIR` set to the integration target:

```
MIXDOG_UPDATE_PROTOCOL_GOLDEN=1 cargo test -p mixdog-app-protocol    # rewrites schema/*.json and packages/protocol/src/index.ts
cargo test -p mixdog-app-protocol                                    # must pass without the variable (goldens stable)
```

Through the gate: `pwsh -NoLogo -NoProfile -File D:\mixdog-build\tools\cargo-gate.ps1 test -p mixdog-app-protocol --locked`.

From the repository root:

```
node scripts/gen-session-method-args.mjs          # packages/protocol-client/src/actions/method-args.generated.{mjs,d.mts}
node scripts/gen-session-method-args.mjs --check  # exit 1 on drift
```

Then: `packages/protocol-client` `tsc -p .` and its tests
(`node --import <apps/desktop/node_modules/tsx> --test test/*.test.ts test/rows/*.test.mjs`), `apps/desktop`
`npx tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json`.

`packages/protocol-client/src/method-table.ts` derives everything from the generated `methodTable`: a server request is
offered only when its `requires` is null, so a `host/*` request that names a capability needs no edit there.

## Pending window rows

The `[window]` lines of the fragments, kept for PROTO-WIRE-G3, which writes them into
`native/core/crates/mixdog-app-protocol/src/boundary/window_methods.json` (owned by s2a-core-window-scope in G2).

### s1-proto

```
projectFs/grant/describe allow the renderer described and minted through main IPC describeLocalPaths today
projectFs/grant/redeem allow the renderer's page and file IPCs redeem a grant through main today
projectFs/localPage/origin allow the renderer's CSP and preview read the page origin through main today
projectFs/localPage/revokeOwner deny internal: main revokes when a window closes
```

### s2b-proto

```
connections/subscribe allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/unsubscribe allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/list allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/rename allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/forget allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/open allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/configHosts allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/inspect allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/connect allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/cancel allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/askpassReply allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/cleanup allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/updateSettings allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/diagnosticsLog allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/diagnosticsCopy allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/serverLog allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/serverLogins allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/serverLoginBegin allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/serverLoginStatus allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/serverLoginComplete allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/serverLoginCancel allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/serverLoginSaveKey allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/serverLoginLogout allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/serverLoginRemoveCustom allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ssh/openEphemeral deny host claimant only: main calls it for the window it opens; no renderer IPC reaches it
connections/link/get allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/link/retry allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/link/retryNow allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/link/requestSignIn allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ports/list allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ports/forward allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ports/stop allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/ports/dismiss allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/restore/get allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/restore/set allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/restore/progress allow renderer settings/server window; caller policy in mixdog-connections policy.rs
connections/endpoint deny host claimant only: main calls it for the window it opens; no renderer IPC reaches it
remoteHosts/list allow renderer settings/server window; caller policy in mixdog-connections policy.rs
remoteHosts/redeemCode deny host claimant only: main calls it for the window it opens; no renderer IPC reaches it
remoteHosts/rename deny host claimant only: main calls it for the window it opens; no renderer IPC reaches it
remoteHosts/forget deny host claimant only: main calls it for the window it opens; no renderer IPC reaches it
remoteHosts/presence deny host claimant only: main calls it for the window it opens; no renderer IPC reaches it
```

### s4-proto

```
# one line per new client -> core method; the host/browser/* names are core -> host requests and client notifications, not client methods.
test/browserEngine/run deny test hook: registered only under MIXDOGD_TEST_HOOKS=1, Local origin only, never offered to a window
# item/browser/requestApproval is a server request answered by the renderer (no window row); the host/browser/events, page/facts and
# userInput client notifications are sent by the host connection only (the claimant of host/claim), like host/browser/page.
```

### x-pcaccess-core

```
pcAccess/readiness deny Local-only: main reads it for the readiness row; a window reaches it only through the main IPC
pcAccess/approve deny Local-only: main runs the Approve; a window reaches it only through the main IPC
```

### wincu-int (merged by PROTO-WIRE-G1 without a fragment)

`computer/userControl` (origins Local, Ssh) came with the wincu-int protocol hunks, which carry no `[window]` line.
PROTO-WIRE-G3 decides its row from the desktop code that calls it (the Computer Use pill's Resume, Stop and Pause).
