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

Rules learned in G2:

- `free_text_fields.json` walks client requests (`client_request.json`), client notifications and the answers of server
  requests (`server_request_methods.json`). The params of a core -> host request (`request host/computer/...`) and the
  result of a client method (`answer migrate/profile/...`) are not walked: classing them fails as "not a string field of
  the schema", and a `FREE_TEXT` row for them is wrong too.
- A new `ClientNotification` or client method whose service registers in a later wave goes into `SERVICE_PENDING`
  (`mixdog-app-server-daemon/src/compose_flip.rs`) with the wave that registers it; the registering .wire removes it.

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

## Window rows (from G3 on)

`native/core/crates/mixdog-app-protocol/src/boundary/window_methods.json` is a refusal list (version 2): a window-scoped
connection may call every client method except the ones it names (`boundary::window_scope::allows`, checked for requests
only, not for client notifications). From G3 on the PROTO-WIRE task of the wave writes it from the `[window]` lines:

- `<method> allow <reason>`: nothing to write (default allow).
- `<method> deny <reason>`: the method is added to `methods`, and to the host-role list of the `host_role_refused` test in
  `window_scope.rs`; `tables_name_real_methods` fails on a name that is not a client method.
- Owner rule: a local window is trusted as the desktop is today, so nothing the renderer reaches today (directly or through a
  main-process IPC lane, `apps/desktop/src/shared/desktop-api-split.ts` and `preload/index.ts`) is refused. A deny line whose
  method a renderer lane reaches through main is not written; `every_direct_key_allowed` pins those names as allowed.

PROTO-WIRE-G3 applied every line kept since G1 and the G3 lines:

| method | row | why |
|---|---|---|
| `projectFs/grant/describe`, `projectFs/grant/redeem`, `projectFs/localPage/origin` | allow | renderer lanes through main |
| `projectFs/localPage/revokeOwner` | deny (already) | main revokes when a window closes |
| `projectFs/localPage/virtual` | deny | main leases visualize pages (pane preview, export); no renderer lane hands it files |
| `connections/*` (s2b-proto allow lines), `connections/ssh/openEphemeral` | allow / deny | openEphemeral opens `MIXDOG_SSH_TARGET`, main's own call |
| `connections/endpoint` | deny (already) | host claimant only |
| `remoteHosts/redeemCode`, `rename`, `forget`, `presence` | not written (allow) | s2b-proto said deny, but the renderer reaches them through main today (`connectRemoteHostByCode`, `renameRemoteHost`, `forgetRemoteHost`, `listRemoteHosts` with `online`) |
| `pcAccess/readiness`, `pcAccess/approve` | not written (allow) | x-pcaccess-core said deny, but the renderer reaches them through main (`computerReadiness`, `approvePcAccess`) |
| `test/browserEngine/run`, `dev/computer/run`, `migrate/profile/adopt` | deny (already) | test hooks, host-role |
| `migrate/profile/status` | deny | no renderer lane reaches it |
| `computer/userControl` | deny | the pill and the main process only; no renderer key |
| `computer/pointerReleased` | not written | a client notification: the table gates requests |
| `takeover/ready` | allow | the takeover card and the sign-in window wait on it |
| `desktop/workflowConfig/read` | deny | only main names a settings file |
| other x-residual-moves and x-rs-desktop-pet methods | allow | no `[window]` deny line |

Rules learned in G3:

- A `[free_text]` line that puts a field in a `free` class needs its `FREE_TEXT` row too, whatever the fragment says.
- An untyped param with fixed fields (e.g. `desktopPet/state/write /prefs`) is enumerated in `payloads` by its `fields`, not
  classed whole as `open`.
- A method row added to `client_request_definitions!` moves the pinned count of `mixdog-app-server` `tests/call_lanes.rs`.
