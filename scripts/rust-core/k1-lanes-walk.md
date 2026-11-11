# K1 lanes: the old Node step's assertions against the Rust tests

Each lane of `k1-lanes.mjs` against the Node step it replaces (Node at `b6f10295a`, `D:\mixdog-build\tmp\b6f-tree`).
This is the work list for closing the lanes: each lane's section lists every Node assertion without a full Rust
counterpart. The walk was done on the tree after the o1 `6bf0a5bbf` merge.

Status per Node assertion: **none** means no Rust test proves it. **partial** means a Rust test proves part of it; the
row says what is left. Assertions that are proven are named in a "Proven" line above the table. The **owner** is the
crate and file where the Rust behaviour lives, which would hold the test or replay; "no Rust counterpart" means no such
code was found. **Recording** is a Node recording that already exists for the case (`native/core/fixtures/` unless the
row says otherwise), or `—` if there is none.

How each row was decided: both sides were opened. The Node test at the cited line was read for what it asserts. A Rust
test is cited only after its body was read and, where it reads a fixture, the fixture was checked for the cited input;
when a test or fixture covers the behaviour with other literals, the row says which. A row marked none was searched
for in the Rust tree by behaviour, not by the Node name; where untested Rust code exists, the row names it as the owner.
"outside lane" marks a Rust test that proves the row but that the lane does not select.

How far to trust it: the rows come from the author's row-by-row pass. An independent sample of 21 rows by three
reviewers found 3 wrong; those are corrected, but roughly one row in seven may still be misclassified. Rule for its use:
whoever takes a row opens both sides first (the Node file:line, and the Rust test's body and fixture) and corrects the
row in the same commit as the work.

No lane is equal to its Node step.

| Lane | Verdict | none | partial |
| --- | --- | --- | --- |
| shell-direct-exe | weaker by two partial assertions | 0 | 2 |
| advisory-lock | weaker | 1 | 1 |
| patch-bytes | weaker | 7 | 0 |
| provider-contract | weaker | 82 | 86 |
| daemon-bootstrap | weaker: the inline-host test file | 9 | 1 |
| native-assets | weaker: npm staging | 1 | 3 |
| compact | weaker by one partial assertion | 0 | 1 |
| turn-contract | weaker | 16 | 4 |
| request-snapshot | weaker: Node/Rust digest equality | 1 | 0 |

## shell-direct-exe (`mixdog-tools` `exec::direct::tests`)

`scripts/suite-shell-direct-exe-test.mjs` has six tests. Rust tests are in `mixdog-tools/src/exec/direct.rs`, and the
syntax and resolution vectors in `mixdog-tools/src/exec/testdata/direct_node_vectors.json` (59 commands).

Proven:

- `:27` tokenizing: `the_syntax_checks_equal_nodes` over the vectors, with other literals than Node's: an absolute
  Windows path (`C:\Program Files\x\y.exe a`, and quoted), a quoted argument with a space (`tool "a b" c`), and an
  unterminated quote giving no argv (`tool "unterminated`).
- `:43` the plan only on Windows with PowerShell, and never with `&&`: `a_head_that_is_a_powershell_word_or_cmdlet_stays_with_the_shell`
  (`git status` on the four host combinations, `git log | head`). The resolved `.exe` path: `exe_resolution_equals_nodes`.
- `:90` refusals: cmdlets and aliases by name before any lookup (`ls -la`, `Get-Process`; Node uses `ls` and
  `Get-ChildItem`, the same rule), and a script wrapper (`j` resolving to `j.cmd` gives no exe in the vectors; Node uses
  `npm`/`npm.cmd`).
- `:101` and `:117` a real `.exe` named by a quoted absolute path runs without the shell and returns its exit status and
  stdout: `a_native_exe_runs_without_the_shell_and_returns_its_exit_status_and_stdout` (Windows only, as Node's `:101`).
  It runs `cmd.exe /d /c "echo ok& exit 3"` instead of `node -e`, with a shell that does not exist, and asserts
  `[exit code: 3]` and `ok`; the argv is proven by its effect, not compared as an array.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `suite-shell-direct-exe-test.mjs:33-40` | `&` inside double quotes (`git commit -m "a & b"`) needs no shell | partial: `the_syntax_checks_equal_nodes` covers the operators (`a && b`, `a; b`, `& tool`, pipes) and expansion in quotes (`echo "$HOME"`, `$env:PATH`); left: no vector has an `&` inside quotes | `mixdog-tools` `exec/direct.rs` `command_needs_shell` | `exec/testdata/direct_node_vectors.json` (no such case) |
| `suite-shell-direct-exe-test.mjs:43-88` | `MIXDOG_SHELL_DIRECT_EXE=0` turns the plan off | partial: the gating test passes the disabled flag to `direct_exe_tokens` directly; left: `disabled_by_env` reading the variable | `mixdog-tools` `exec/direct.rs` `disabled_by_env` | — |

## compact (`mixdog-agent` `compact_*`)

`scripts/compact-smoke.mjs` (one script, no `test()` blocks). Rust tests are in `mixdog-agent/tests/it/`, fixtures in
`agent/compact/golden/`.

Proven:

- `:61-62` the handoff is generated and carries the provider's summary: `compact_handoff.rs`
  `handoff_generation_equals_node` over `handoff.json` (each run's summary, calls and usage equal Node's).
- `:110-113` the worker policy has no `compactType`, `semantic` or `recallFastTrack`: structural, `mixdog-agent/src/boundary.rs`
  `CompactPolicy` has no such field.
- `:124` the retired compaction keys are dropped: `compact_commit.rs` `the_retired_compaction_keys_are_dropped`, with
  Node's input.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `compact-smoke.mjs:83-93` | the fresh context ends on the latest request although a `[mixdog-runtime]` marker follows it, holds the summary message, keeps the Windows reference path escaped (`C:\\Project\\refs\\guide.md`), and drops `REFERENCE_BODY` and `providerReplay` | partial: `compact_fresh.rs` `fresh_context_equals_node` over `fresh.json` proves the fresh flag, the tail and the summary (`fresh_handoff`) and reference bodies dropped with their paths listed (`fresh_protected_prefix`, POSIX paths `src/a.rs`); left: `fresh.json` has no Windows path, no `providerReplay` field and no `[mixdog-runtime]` marker after the latest request | `mixdog-agent` `compact/` `fresh_context_compact_messages` | `agent/compact/golden/fresh.json` (without these inputs) |

## advisory-lock (`mixdog-tools` `fs::tests`)

Node's `advisory-lock.slow.test.mjs` has two tests (`:100-136`, `:139-152`). Rust tests are in `mixdog-tools/src/fs/tests.rs`.

Proven:

- Exclusion, an independent file entering while the lock is held, the holder's pid in the token, the token untouched by
  a blocked waiter, release on stop, and no lock file left:
  `the_advisory_lock_waits_for_a_live_holder_reclaims_a_dead_one_and_releases_only_its_own`.
- Reclaiming after the holder crashed (`:139-152`): the same test, with a dead-pid token (`2147483646.deadbeef`) planted
  in place of a killed process.
- Edit and patch wait for the lock: `edit_and_apply_patch_wait_for_the_advisory_lock_of_their_file`.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `advisory-lock.slow.test.mjs:115-136` | two profiles (different `MIXDOG_HOME`) share one lock directory, so they exclude each other | none: the tests pass the directory to `lock_in`; `lock_directory()` (OS home or `LOCALAPPDATA`, not the profile) is not asserted to ignore the profile | `mixdog-tools` `fs/advisory.rs` `lock_directory` | — |
| `advisory-lock.slow.test.mjs:115-136` | the blocked second profile fails with `code: 'EAGAIN'` | partial: the Rust test asserts the timeout message naming the holder's pid; left: an error code a caller can test, as Node's `EAGAIN` | `mixdog-tools` `fs/advisory.rs` | — |

## patch-bytes (`mixdog-tools` `fs::tests`)

`scripts/native-edit-wire-test.mjs` (one test, `:10-27`):

Proven: `:23` (a replace-all edit of a word found twice reports 2 replacements) and `:26` (the file holds the result),
by `fs/tests.rs` `edit_and_apply_patch_match_recorded_node_cases` over `mixdog-tools/src/fs/golden/cases.json` case
`edit-replace-all`. That case replaces `dup` with `one` (answer `Updated t.txt (2 replacements)`, tree after
`one\nmid\none\n`); Node's test uses `alpha` and `omega`.

In Node, an edit ran through the native patch server's wire, which returned `tier` and `contentHash`. In Rust the edit
runs in-process: the tier is internal (`edit_plan.rs` `Tier`), and the content hash after the edit goes to the read
state (`patch_review.rs:165`, `read.rs` `content_hash_of`).

`scripts/patch-replay.mjs` replays captured patch calls (`--replay`, `--replay-all`). Rust has no capture/replay tool.
If the tool is ported it belongs to `mixdog-tools` (`fs/patch.rs`); none of the capture checks exists in Rust.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `native-edit-wire-test.mjs:24` | an exact match reports tier `exact` | none: no test reads the tier an edit matched at | `mixdog-tools` `fs/edit_plan.rs` (`Tier::Exact`) | — (`fs/golden/cases.json` and `tools/apply_patch/*.json` record text, `isError` and the tree, not the tier) |
| `native-edit-wire-test.mjs:25` | the edit returns `contentHash`, 64 lowercase hex digits of the written file | none: no test asserts the hash an edit records | `mixdog-tools` `fs/patch_review.rs:165`, `fs/read.rs` `content_hash_of` | — |
| `patch-replay.mjs:44-46` | a snapshot path is refused ("unsafe snapshot path") when it is empty, holds a NUL, is absolute for the platform (`path.isAbsolute`), is drive-absolute (`C:\…` or `C:/…`) or UNC (`//`, `\\`) whatever the platform, or has a `..` segment between `\` or `/`. A drive-relative path (`C:relative`, `C:..\x`) passes this guard; the next one (`:50-51`) refuses it if it resolves outside the root | none | no Rust counterpart (`mixdog-tools` if ported) | — |
| `patch-replay.mjs:50-51` | a snapshot path that escapes the replay root after resolution is refused | none | no Rust counterpart | — |
| `patch-replay.mjs:56-63` | a legacy partial capture (no `snapshot_phase: 'pre'`) is skipped with its reason, not replayed | none | no Rust counterpart | — |
| `patch-replay.mjs:38-39,100` | a replayed result is ok only if it does not start with `Error` followed by whitespace, `:` or `[` | none | no Rust counterpart | — |
| `patch-replay.mjs:143,166` | the exit code is 1 when no capture matches or a replay fails | none | no Rust counterpart | — |

## provider-contract (all of `mixdog-ai`)

This lane replaces five Node files with 172 tests in all. Paths below are under `native/core/crates/mixdog-ai/` unless
a row names another crate, and recordings under `native/core/fixtures/` unless a row says otherwise. Node's
stream-outcome record (`replaySafe`, `dispatchAmbiguous`, `streamOutcome` aliases) has no Rust type of its own. Rust
keeps exposure as decoder flags (`providers/anthropic/decoder.rs:215-243`, `accounts/rotation.rs:798`) and gates
retries on them in `retry/decider.rs:52-56`. Rust has no transport switch: the only fallback in `retry/decider.rs` is
the overload model switch, so rows about switching transport have no Rust counterpart.

### `scripts/provider-contract-test.mjs` (38 tests: 0 proven, 22 partial, 16 none)

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `:67` | Computer Use: one action enum (11 actions with `set_value`, no `computer_20250124`) on every provider's schema | partial: `providers/action_input_tests.rs` `the_flat_projection_is_the_one_node_advertises`; left: the OpenAI, Gemini, Grok and Anthropic wire schemas each carry it | `providers/action_input*` (schema from `mixdog-tools/src/desktop/defs/computer.json`) | — |
| `:125` | Computer Use bytes on unverified provider paths equal the pre-change flat form | partial: `the_claude_bridge_schema_is_the_one_node_builds` (Anthropic only); left: the OpenAI, Grok and Gemini bytes | `providers/action_input*` | — |
| `:162` | the OpenRouter sanitizer keeps current, text, tool-capable models under a 9-month default cutoff | partial: `catalog/sanitize.rs` `every_sanitized_list_equals_node`, `javascript_dates_and_month_settings` (default 9 months); left: the ten-month, image-only and no-tools rows as named cases | `catalog/sanitize.rs` | `mixdog-ai/fixtures/sanitize` |
| `:224` | the startup catalog refresh runs once per process; a forced refresh runs again | partial: `mixdog-core-domains` `ai_admin/catalog_refresh_start_tests.rs` `a_second_ready_call_during_a_running_refresh_joins_it`; left: the forced rerun, and the revision advancing once | `catalog/readiness.rs` | — |
| `:279` | session runtimes share one catalog read; a revision bump reads again | none | `mixdog-core-domains` `ai_admin/model_list.rs` `shared_load` | — |
| `:310` | a quick picker read seeds the secrets-aware full load, and the keychain is read once | partial: `ai_admin/model_warmup_tests.rs` `a_full_reader_overlapping_a_quick_reads_warm_shares_its_one_load`; left: the single keychain read | `mixdog-core-domains` `ai_admin/model_list.rs` | — |
| `:350` | the first full picker load waits for the startup refresh (zero list reads before it, one after) | none: `a_readiness_call_overtaken_by_a_provider_set_change_joins_the_newer_refresh` is about a provider-set change, not the picker load | `catalog/readiness.rs` | — |
| `:389` | quick picker rows come from the last native disk catalog (cached context 321000, output 24000) | partial: `ai_admin/model_list_node_tests.rs` `the_quick_rows_are_nodes_for_every_profile` (rows from a Node recording); left: rows read from a disk catalog | `mixdog-core-domains` `ai_admin/quick_rows.rs` | recording in `model_list_node_tests.rs` |
| `:440` | the daemon's catalog prefetch delay is 0 under the daemon host and 2000 ms standalone | partial: `ai_admin/model_warmup_tests.rs` `the_delay_is_nodes_env_delay_and_defaults_to_the_daemons_zero`; left: the 2000 ms standalone delay | `mixdog-core-domains` `ai_admin/model_warmup.rs` | — |
| `:457` | a cached Grok OAuth row keeps its context window (500000) and loses its output limit | partial: `providers/grok/listing_tests.rs` `an_enriched_row_loses_its_output_limit_and_follows_its_ladder` (an inline row; the output limit is dropped); left: loading the cached catalog, and the context window kept | `catalog/listing.rs` | — |
| `:484` | Grok catalog `reasoningOptions` replace stale hardcoded effort levels | partial: the same test (the ladder follows the row); left: the cache-version gate that drops stale levels | `catalog/listing.rs` | — |
| `:523` | a provider setup refresh waits for the keychain, reloads the config and bypasses stale setup state | none | `mixdog-core-domains` `ai_account/setup_cache.rs` `get_setup` | — |
| `:542` | setup lists every OAuth row in order, OpenRouter first of the API rows, no OpenCode Go API row and no separate Cursor API row | partial: `mixdog-core-domains` `ai_account/oauth_status_tests.rs` `only_the_ten_providers_are_described`; left: the API row order and the two absent rows | `mixdog-core-domains` `ai_account/provider_setup.rs` | — |
| `:561` | a forced setup waits for the snapshot in flight, then rebuilds (two builds) | none | `mixdog-core-domains` `ai_account/setup_cache.rs` | — |
| `:596` | a usage refresh falls back to the quick setup when the secrets-aware scan fails | none | `mixdog-core-domains` `ai_account/dashboards.rs` | — |
| `:629` | Codex reset credits: a scoped fetch, credits sorted, an idempotency key and the account header on the redeem | partial: `service/usage_ports_tests.rs` `a_redeem_posts_nodes_body_with_nodes_headers_and_replays_once` (body, key and headers); left: the sort and the scoped fetch | `service/oauth_usage.rs` | — |
| `:699` | a spent credit reports the server's `already_redeemed` as `alreadyRedeemed`, with an available count of 0 | partial: the same test; left: the spent outcome | `service/oauth_usage.rs` | — |
| `:727` | an interrupted redeem is replayed with the same idempotency key (two posts) | partial: the same test; left: the interruption as the trigger | `service/oauth_usage.rs` | — |
| `:755` | a completed redeem returns its outcome even when the dashboard refresh fails | none | `service/oauth_usage.rs` | — |
| `:783` | Codex usage reads the backend-api endpoints and keeps an embedded reset credit | partial: `service/oauth_usage/tests.rs` (`:122`); left: the embedded credit | `service/oauth_usage.rs` | — |
| `:833` | Cursor account usage reaches the usage dashboard through the OAuth cache | none | `service/usage_cursor.rs` | `cursor-usage/` (normalisation only) |
| `:895` | provider auth waits for the keychain before consuming a Codex reset | none | `mixdog-core-domains` `ai_account/admin.rs` `consume_codex_reset_credit` | — |
| `:911` | vendor preset defaults and OpenCode Go protocol routes are pinned | partial: `providers/compat/tests.rs` `catalog_and_roster_inputs_route_as_nodes_adapters_do`, and `registry/gateway_replay.rs` `opencode_go_*_sends_on_*` (whole requests against Node's); left: the preset defaults never sent in a recorded request | `providers/compat/profile.rs` | `provider-gateways/opencode-go-*.json` |
| `:936` | provider-specific thinking fields (DeepSeek `thinking`) do not leak onto other compat contracts | partial: `effort_reaches_the_body_by_dialect_not_by_provider_name`; left: the absence on the other contracts | `providers/compat/chat/options.rs` | `mixdog-ai/fixtures/effort` |
| `:971` | OpenRouter: the unified reasoning body, and the cost it reports (a negative cost gives none) | partial: `effort_reaches_the_body_by_dialect_not_by_provider_name`, `billed_cost_is_read_from_the_dialect_field`, and `gateway_replay.rs` `openrouter_*`; left: the negative cost | `providers/compat/chat/options.rs`, `providers/compat/chat/decode.rs` | `mixdog-ai/fixtures/effort`, `provider-gateways/openrouter-*.json` |
| `:987` | xAI sends `reasoning_effort` only for the families that accept it | partial: the same effort test; left: omission for grok-3 and grok-4 (Rust decides from the listing's reasoning support, not by family) | `providers/compat/chat/options.rs` | `mixdog-ai/fixtures/effort` |
| `:1012` | DeepSeek `reasoning_content` is replayed when asked | partial: `reasoning_text_is_kept_and_replayed_under_the_key_it_arrived_on`; left: the xAI replay | `providers/compat/chat/encode.rs` | — |
| `:1031` | OpenRouter `reasoning_details` round-trip on assistant tool turns | none | `providers/compat/chat/encode.rs`, `providers/compat/chat/decode.rs` | — |
| `:1051` | the LM Studio reasoning alias is kept apart from the answer text | none | `providers/compat/chat/decode.rs` | — |
| `:1072` | the compat stream accumulates OpenRouter `reasoning_details` beside tool calls | none | `providers/compat/chat/decode.rs` | — |
| `:1121` | API-key auth retries a typed 401 once; a text-only 401 and a 403 never reload | partial: `tests/it/openai_adapter.rs` `a_401_reloads_the_credential_once_and_replays`, `a_401_that_survives_the_reload_asks_for_a_new_login`; left: the text-only 401 and the 403 | `providers/compat/adapter.rs` | — |
| `:1181` | OpenCode Go normalises both route families to inclusive usage | partial: `gateway_replay.rs` `opencode_go_*` compare each result's input and output tokens with Node's; left: a recorded answer with cached tokens, which would tell inclusive from additive | `providers/compat/profile.rs` | `provider-gateways/opencode-go-*.json` |
| `:1244` | OpenCode Go's Anthropic delegation traces additive inner usage before inclusive normalisation | none (the replays do not compare the usage trace) | `providers/compat` | `provider-gateways/opencode-go-messages.json` (answer only) |
| `:1354` | constructing Grok OAuth prewarms only through the injected seam | none (Rust preconnects when the header is first built, `providers/grok/auth.rs`; no test) | `providers/grok/auth.rs` | — |
| `:1365` | the Grok OAuth HTTP Responses path is hermetic (no global fetch, its headers, `store: false`) | none | `providers/grok/mod.rs` | — |
| `:1434` | xAI Responses defaults to HTTP; WebSocket only on explicit opt-in | partial: `tests/it/openai_profiles.rs` `xai_profiles_match_the_http_and_websocket_heads`, and `gateway_replay.rs` `xai_sends_on_responses` (the default send is Node's HTTP request); left: WebSocket only on opt-in | `providers/compat/profile.rs` | `provider-gateways/xai-responses.json` |
| `:1445` | per provider, `response.failed`/`error` keep their typed status and never synthesise one | none | `providers/openai/decoder.rs` (`response.failed`), `retry/classify.rs` | `mixdog-ai/fixtures/error-text/cases.json` (text only) |
| `:1486` | Grok OAuth does not refresh or replay a 401 after a visible tool dispatch | none | `providers/grok/mod.rs` | — |

### `scripts/provider-stream-outcome-test.mjs` (78 tests: 0 proven, 33 partial, 45 none)

Anthropic tests cited below are in `providers/anthropic/tests.rs`.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `:69` | the transport recovery budget is shared across one logical send | none (Rust has no transport recovery budget; `retry/decider.rs` bounds waited time) | no Rust counterpart | — |
| `:116` | an error with no exposure evidence stays replayable | partial: `a_stream_cut_after_text_is_truncated_with_exposure` (the exposure flags); left: the no-evidence default | `providers/anthropic/decoder.rs` | — |
| `:129` | a terminal clears the continuation for stall signals | none | no Rust counterpart (no continuation flag) | — |
| `:136` | a terminal frame with `end_turn: false` stays a continuation | none | `providers/anthropic/decoder.rs` | — |
| `:148` | a terminal with pending tool input is never success-eligible | none | `providers/anthropic/decoder.rs` | — |
| `:156` | buffered text is distinguished from visible text | none (Rust has only `text_emitted`) | `providers/anthropic/decoder.rs` | — |
| `:167` | visible text, reasoning and dispatched tools are replay boundaries | partial: `a_failure_after_thinking_alone_is_an_exposure_and_is_not_retried`; left: the dispatched-tool boundary | `retry/decider.rs:52-56` | — |
| `:184` | complete tool calls without a dispatch report fail closed to dispatched | partial: `a_cut_tool_stream_dispatches_the_complete_calls_as_node_does`; left: failing closed with no report | `providers/anthropic/decoder.rs` | `provider-tool-cut/` |
| `:202` | pending tool input alone stays replay-safe | partial: `a_stop_with_tool_input_still_streaming_is_a_cut` (inline stream); left: the replay-safe verdict | `providers/anthropic/decoder.rs` | — |
| `:229` | `dispatchAmbiguous` survives canonical round-trips | none (no Rust ambiguity flag) | no Rust counterpart | — |
| `:252` | stamping writes every historical alias without clearing set ones | none (no Rust alias record) | no Rust counterpart | — |
| `:282` | a record-only error (no legacy flags) is permanent | none | `retry/classify.rs` | — |
| `:290` | a clean continuation keeps its transport classification | partial: `retry/classify.rs` `transport_evidence_is_transient` (transport kinds); left: the continuation | `retry/classify.rs` | — |
| `:296` | midstream WS: an observed terminal or an unsafe outcome is terminal | none (Rust has one exposure gate for every transport, `retry/decider.rs:52-56`) | `broker/send.rs`, `retry/decider.rs` | — |
| `:338` | midstream WS: a clean pre-output failure still classifies and retries | none | `retry/decider.rs` | — |
| `:366` | the midstream SSE gate mirrors the WS gate | none (the same single gate) | `retry/decider.rs` | — |
| `:385` | replay-unsafe outcomes never switch transport | none | no Rust counterpart (no transport switch) | — |
| `:411` | `withRetry` never replays a request whose outcome is not replay-safe | partial: `registry/gateway_replay.rs` `a_refusal_after_output_started_is_never_resent` (key-pool switch only); left: the `retry/decider.rs` gate | `retry/decider.rs` | `provider-gateways/custom-keys-after-output.json` |
| `:431` | a clean transient continuation still retries | partial: `tests/it/retry.rs` `terminal_and_edge_statuses_surface_even_when_transient`, `repeated_overload_falls_back_or_ends_the_send`; left: the retry count | `retry/decider.rs` | — |
| `:456` | retry exhaustion is provider-terminal; a one-shot failure is not | partial: `repeated_overload_falls_back_or_ends_the_send` (exhaustion ends the send); left: the provider-terminal mark | `retry/decider.rs` | — |
| `:495` | a nested provider-terminal failure is never retried again | none | `retry/decider.rs` | — |
| `:518` | a typed transient failure retries; an untyped one does not | partial: `tests/it/retry.rs` `retry_only_limits_statuses_but_not_transport_faults`, `a_class_without_a_row_surfaces`; left: the untyped case | `retry/classify.rs` | — |
| `:547` | typed transport failures switch transport; untyped ones do not | none | no Rust counterpart (no transport switch) | — |
| `:619` | SSE comment and named ping keepalives refresh transport activity | none: `crlf_framing_and_comments_decode_like_lf` proves decoding only; Rust treats a keepalive as not progress (`broker/send.rs:183`, `admission/lane.rs:115`), the opposite of Node's refresh | `broker/send.rs` | — |
| `:653` | real transport silence raises a stall | none (no transport-silence stall in `mixdog-ai`) | `broker/send.rs` | — |
| `:679` | a truncation after visible text is a continuation, never replayable | partial: `a_stream_cut_after_text_is_truncated_with_exposure` (the cut and the exposure); left: the class: Node classifies it permanent, the Rust test asserts `ErrorKind::Transient` | `providers/anthropic/decoder.rs` | `providers/anthropic/truncated-no-terminal` |
| `:721` | a truncation with only pending tool input stays retryable | partial: `a_stop_with_tool_input_still_streaming_is_a_cut` (the cut); left: the retryable class | `providers/anthropic/decoder.rs` | — |
| `:773` | `message_stop` with an incomplete client tool input is a truncated failure | partial: `a_cut_tool_stream_dispatches_the_complete_calls_as_node_does`; left: the failure message and side-effect fields | `providers/anthropic/decoder.rs` | `provider-tool-cut/` |
| `:806` | `message_stop` with an incomplete native server-tool input is a truncated failure | none | `providers/anthropic/decoder.rs` | — |
| `:831` | completed tools and plain terminals keep succeeding | partial: `recorded_streams_fold_to_the_recorded_results`; left: the dispatch count | `providers/anthropic/decoder.rs` | `providers/anthropic/` |
| `:881` | a terminal `message_delta` stop reason truncates at once | partial: `a_stop_with_tool_input_still_streaming_is_a_cut`; left: late frames not consumed | `providers/anthropic/decoder.rs` | — |
| `:920` | a truncation keeps the completed native `assistantBlocks` in order | none (`a_stream_cut_after_text_is_truncated_with_exposure` does not read the blocks) | `providers/anthropic/decoder.rs` | — |
| `:959` | neither wrapper round-trip downgrades the parser's pending-input verdict | none (no wrapper round-trip test) | `providers/anthropic/` | — |
| `:1013` | compat chat: a reasoning delta followed by a transport failure is never re-issued | none (`providers/compat/chat/decode.rs` does not count reasoning as exposure) | `providers/compat/chat/decode.rs` | — |
| `:1048` | compat chat: a pre-output failure stays replay-safe and stamped | none | `providers/compat/chat/decode.rs` | — |
| `:1075` | compat responses: a reasoning delta followed by a failure is never re-issued | none | `providers/compat` | — |
| `:1111` | compat responses: a pre-output failure stays stamped and replay-safe | none | `providers/compat` | — |
| `:1141` | compat responses: a truncation after visible text is stamped non-replayable | partial: `providers/compat/tests.rs` `a_cut_compat_responses_stream_says_what_node_says` (the message); left: the replay stamp | `providers/compat` | — |
| `:1170` | the Anthropic OAuth wrapper's catch keeps the parser's pending-input verdict | none (the cited decoder tests do not go through the OAuth path) | `providers/anthropic/` | — |
| `:1212` | the Anthropic API-key wrapper's catch keeps the pending-input verdict | none (the same, for the API-key path) | `providers/anthropic/` | — |
| `:1249` | an Anthropic API-key 401 reloads once, but never after exposed output | partial: `oauth_401_refreshes_once_and_replays_once` (OAuth); left: the API key, and no reload after exposure | `providers/anthropic/` | — |
| `:1307` | HTTP/SSE: the initial POST retry loop stamps and gates each reissue | none | `retry/decider.rs` | — |
| `:1371` | an Anthropic stall carrying only `partialContent` is still observed output | none | `retry/classify.rs` | — |
| `:1387` | an Anthropic stall with complete tool calls is not replayable | none | `retry/classify.rs` | — |
| `:1426` | HTTP/SSE: EOF after streamed text with no terminal frame always throws, stamped | partial: `tests/it/openai_fixtures.rs` `stream_without_terminal_is_a_truncation_after_output`, and `a_stream_cut_after_text_is_truncated_with_exposure` (Anthropic); left: the stamp | `providers/openai/decoder.rs` | `providers/anthropic/truncated-no-terminal` |
| `:1459` | HTTP/SSE: EOF after a dispatched tool call with no terminal frame always throws | partial: `a_cut_tool_stream_dispatches_the_complete_calls_as_node_does` (Anthropic); left: OpenAI HTTP/SSE | `providers/openai/decoder.rs` | — |
| `:1487` | HTTP/SSE: a reasoning delta is an immediate no-replay boundary | partial: `a_failure_after_thinking_alone_is_an_exposure_and_is_not_retried` (Anthropic); left: Responses over HTTP | `providers/openai/decoder.rs` | — |
| `:1503` | HTTP/SSE: a clean EOF before any output stays replay-safe and stamped | none | `providers/openai/decoder.rs` | — |
| `:1534` | send-with-recovery: a stall with partial text and no tools stays an explicit failure | none | `mixdog-agent` `send.rs` | — |
| `:1539` | send-with-recovery: a spent stall window never blocks the bounded transport replay | none | `mixdog-agent` `send.rs` | — |
| `:1558` | send-with-recovery: provider-terminal exhaustion never gains a fresh loop replay | none | `mixdog-agent` `send.rs` | — |
| `:1566` | send-with-recovery: a stall with complete tool calls recovers as a tool turn | none | `mixdog-agent` `send.rs` | — |
| `:1580` | send-with-recovery: a stall with pending tool input never becomes a response | none | `mixdog-agent` `send.rs` | — |
| `:1590` | send-with-recovery: an output-limit incomplete terminal is the only success promotion | partial (outside lane): `mixdog-agent` `tests/it/run_loop.rs` `output_limit_ladder_escalates_once_then_resumes_then_ends`; left: the promotion gate | `mixdog-agent` `send.rs` | — |
| `:1625` | context overflow: a request-level refusal may compact and retry | partial (outside lane): `run_loop.rs` `a_context_overflow_compacts_reactively_and_replays_once`; left: in the `mixdog-ai` lane | `mixdog-agent` `send.rs` | — |
| `:1633` | context overflow: a refusal with no exposure evidence still compacts and retries | none | `mixdog-agent` `send.rs` | — |
| `:1639` | context overflow: visible output, reasoning or ambiguous tools never retry | partial (outside lane): `run_loop.rs` `a_second_overflow_surfaces_with_the_overflow_text`; left: the three exposure cases | `mixdog-agent` `send.rs` | — |
| `:1660` | server message text never synthesises a status or transience | none | `service/error_text.rs` | — |
| `:1694` | only typed transient statuses or codes may switch transports | none | no Rust counterpart (no transport switch) | — |
| `:1719` | a signature-only thinking block is not exposed reasoning | partial: `thinking_blocks_replay_with_their_signature_and_never_fuse_runs` (the replay); left: the exposure verdict | `providers/anthropic/decoder.rs` | — |
| `:1753` | Gemini REST: text with no live sink is buffered, not visible, so replay stays safe | partial: `providers/google/conformance.rs` `truncated_recordings_end_as_transient_truncation`; left: buffered-not-visible | `providers/google/` | — |
| `:1795` | HTTP/SSE: an untyped pre-response failure (no errno) is surfaced after one fetch; a typed one (`ECONNRESET`) re-issues the POST, and the second fetch's answer is the result | partial: `retry/classify.rs:315` `transport_evidence_is_transient` classifies a `TransportFault::Reset` as transient (the typed half's verdict only). Left, and wider than the loop: the typed-versus-untyped distinction itself. Rust has no untyped transport fault: `transport_is_transient` (`retry/classify.rs:142`) makes every fault but a WS close transient, so nothing shows a failure surfaced after one attempt, and no test runs the pre-response loop (one fetch, then two). `codeless_wire_error_is_transient` (`:337`) is about an in-stream error event without a code, not this | `retry/classify.rs`, `retry/decider.rs` | — |
| `:1840` | midstream WS: `response.failed` picks buckets from typed codes and default-retries the rest | none | `retry/classify.rs` | — |
| `:1905` | Anthropic SSE error events take their status from the typed error type only | partial: `an_error_event_is_a_typed_provider_error`; left: the status derived from the type, and no status for an unmapped type | `providers/anthropic/errors.rs` | — |
| `:1947` | Cloudflare origin-TLS 525 and 526 are permanent | partial: `tests/it/retry.rs` `terminal_and_edge_statuses_surface_even_when_transient` (they surface); left: the permanent class (`retry/classify.rs` `status_table` expects them unknown) | `retry/classify.rs` | — |
| `:1955` | undici and TLS transport codes are transient | none | `retry/classify.rs` `transport_is_transient` | — |
| `:1983` | `isServerUnavailable`: temporarily unable to serve, never a refusal or rate limit | none (Rust's set, `service/error_text.rs` `UNAVAILABLE_STATUSES`, lacks Node's 500, 529 and 408) | `service/error_text.rs` | — |
| `:2000` | a turn that ended on a malformed or unexpected tool call is re-asked | partial: the `providers/google/decode.rs` test of `InvalidToolCall`; left: the re-ask class | `retry/classify.rs` | — |
| `:2016` | a background call gives up on an overload; a tool-input cut is never re-issued | partial: `tests/it/retry.rs` `status_429_and_529_switches…`, `repeated_overload_falls_back_or_ends_the_send`; left: both named cases | `retry/decider.rs` | — |
| `:2055` | Gemini gRPC UNAVAILABLE, DEADLINE, ABORTED and INTERNAL retry without HTTP | none (`google_resource_exhausted_follows_quota_scope` covers RESOURCE_EXHAUSTED only; ABORTED is not mapped in `retry/classify.rs`) | `retry/classify.rs` | — |
| `:2064` | Gemini 429 RESOURCE_EXHAUSTED without Retry-After is retried | partial: `google_resource_exhausted_follows_quota_scope` (classification); left: the retry | `retry/decider.rs` | — |
| `:2085` | a typed `rate_limit_exceeded` gives its try-again delay | partial: `retry/advice.rs` `millisecond_header_wins_over_seconds`, `typed_reset_seconds_only`; left: the typed body | `retry/advice.rs` | — |
| `:2107` | `anthropic-ratelimit-unified-reset` is a window reset, not retry advice | none (`providers/anthropic/errors.rs` reads the header; no test) | `providers/anthropic/errors.rs` | — |
| `:2125` | provider admission does not cache long subscription quota windows | none (`admission/lane.rs` caps cooldowns; `tests/it/admission.rs` uses a 10 s window only) | `admission/lane.rs` | — |
| `:2145` | `previous_response_not_found` (typed 400) is transient and retryable midstream | none | `retry/classify.rs` | — |
| `:2165` | SDK timeout names, 425, HTTP/2 and the WS connection limit classify | partial: `retry/classify.rs` `status_table`; left: 425 (mapped, not in the table), HTTP/2 and the timeout names | `retry/classify.rs` | — |
| `:2194` | context codes overflow; a bare 413 or a typed `request_too_large` is a size refusal | partial: `status_table` (413); left: the context codes | `retry/classify.rs` | — |
| `:2212` | backend-specific overflow wordings, never a rate limit | none (no overflow-wording matcher in Rust) | `retry/classify.rs` | `mixdog-ai/fixtures/error-text/cases.json` (other texts only) |

### `scripts/cursor-provider-test.mjs` (45 tests: 0 proven, 25 partial, 20 none)

Paths are under `providers/cursor/`, except for `tests/it/`, `catalog/` and `service/`.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `:75` | the account login wraps the browser deep-link contract (origin, path, challenge, uuid, redirect) | none | `login.rs` `login_url` | — |
| `:86` | Cursor OAuth's display name is "Cursor OAuth" | none | `mixdog-core-domains` `ai_account/provider_setup.rs:58` | — |
| `:90` | an expired access-only credential is unusable and needs a new sign-in | partial: `auth.rs` `only_credential_verdicts_force_a_new_sign_in`; left: the usable flag and the status text | `auth.rs` | — |
| `:107` | the token exchange refuses redirects that carry a bearer token | none | `auth.rs` | — |
| `:121` | the catalog folds raw effort, Fast and duplicate Auto variants | partial: `listing_tests.rs` `every_recorded_resolution_equals_nodes`, `every_recorded_case_gives_node_rows_and_request` (`roster-*` cases); left: this fold as a named case | `listing.rs` | `providers/cursor-models` |
| `:145` | a parameterised default Auto folds into one Auto | partial: `every_recorded_case_gives_node_rows_and_request`; left: as a named case | `listing.rs` | `providers/cursor-models` |
| `:191` | a live Auto is not replaced by the synthetic Auto row | partial: `every_recorded_case_gives_node_rows_and_request` (`plain-auto-*` cases; `a_server_without_auto_still_lists_it_first` is the synthetic case); left: the synthetic row's absence asserted on its own | `listing.rs` | `providers/cursor-models` |
| `:210` | a Fast combination absent from the native catalog is rejected | partial: `every_recorded_resolution_equals_nodes` (rejection texts); left: the Fast rejection | `listing.rs`, `models.rs` | `providers/cursor-models` |
| `:230` | model options are kept and sent as `RequestedModel` parameters | partial: `every_recorded_case_gives_node_rows_and_request`; left: the sent parameters | `listing.rs`, `request.rs` | `providers/cursor-models` |
| `:349` | the default context is separate from Max mode | partial: `every_recorded_resolution_equals_nodes` (asserts `maxMode`), `every_recorded_send_has_nodes_model_and_pricing_model`; left: the default context beside Max mode | `listing.rs` | `providers/cursor-models` |
| `:402` | models without tuning parameters keep their Max mode metadata | partial: `every_recorded_resolution_equals_nodes`; left: the metadata | `listing.rs` | `providers/cursor-models` |
| `:429` | Max mode selects its mode-specific default variant | partial: the same; left: the body flag | `listing.rs` | `providers/cursor-models` |
| `:547` | stored context is recovered after effort or Fast overrides, Max and non-Max | partial: the same; left: the recovery on both providers | `models.rs` | `providers/cursor-models` |
| `:574` | an explicit supported context is kept after the overrides | partial: the same; left: the body | `models.rs` | `providers/cursor-models` |
| `:592` | unsupported combinations are rejected before transport | partial: the same; left: no transport call | `models.rs` | `providers/cursor-models` |
| `:609` | developer messages keep system precedence | none | `request.rs` | — |
| `:619` | request controls keep exact models, tool choice and parameter values | partial: `request.rs` `a_named_tool_choice_narrows_the_offer_as_node_does`; left: the body values | `request.rs` | `providers/cursor-tool-choice` |
| `:666` | route parameters survive automation refs and constrain Fast | partial: `catalog/facts.rs` `cursor_fast_follows_variants_and_efforts` (Fast follows the parameter variant's `thinking` value); left: parsing the automation ref (`cursor-oauth/…@high+fast?…`), and the `context` parameter | `catalog/facts.rs` | — |
| `:695` | dashboard cents become quota windows (Basic and API lanes) | partial: `service/usage_cursor_tests.rs` `the_plan_usage_read_is_nodes_get_usage_snapshot`; left: the lane split | `service/usage_cursor.rs` | `cursor-usage/golden.json` |
| `:751` | dashboard percentage points are kept as they are | partial: the same; left: a fractional case | `service/usage_cursor.rs` | `cursor-usage/golden.json` |
| `:770` | Cursor API exchanges its key and streams text | partial: `tests/it/ai_other_fixtures.rs` (Cursor recordings); left: the key exchange | `auth.rs`, `mod.rs` | `providers-ai-other/cursor-api/text` |
| `:939` | paired tool history, error state, media and isolated fallback scope are kept | none | `request.rs` | — |
| `:945` | native tool calls reach the Mixdog harness | partial: `ai_other_fixtures.rs` (Cursor recordings); left: the mapping per call | `decoder.rs` | `providers-ai-other/cursor-api/tool-call` |
| `:994` | the Fast tier sent is stamped; pinned variants are priced as their catalog model | partial: `catalog/facts.rs` `cursor_fast_follows_variants_and_efforts`, `decoder.rs` `the_pricing_model_rides_the_completed_event`; left: the tier stamp | `decoder.rs` | — |
| `:1024` | stream cancellation reaches the wire response body | none | `mod.rs` | — |
| `:1053` | a rejected credential is retried once, never after visible output | none (`mod.rs` `retry_policy` is configuration only) | `mod.rs` | — |
| `:1130` | a stale catalog is refreshed only when `not_found` changes the routed model id | none | `models.rs` | — |
| `:1190` | rate-limit evidence is kept without replaying the turn | none (`decoder.rs` carries the retry delay; no test) | `decoder.rs` | — |
| `:1230` | the wire codec round-trips the Mixdog-facing protocol subset | partial: `schema.rs` `json_value_round_trips`; left: the message codec | `schema.rs` | — |
| `:1281` | the request context carries harness rules and MCP routing instructions | none | `request.rs` | — |
| `:1318` | checkpoint occupancy never becomes billable prompt tokens | none | `decoder.rs` (checkpoint token counts) | — |
| `:1370` | the Connect parser handles split frames without losing bytes | none | `decoder.rs` (`FrameReader`) | — |
| `:1665` | unregistered tools are rejected; repeated tool ids are deduplicated | none | `decoder.rs` | — |
| `:1672` | native shell redirects omit the unsupported `workingDirectory` | none (`decoder.rs` forwards `working_directory`, unlike Node) | `decoder.rs` | — |
| `:1717` | a clean end-stream flushes pending tool calls as a recoverable batch | partial: `ai_other_fixtures.rs` (Cursor recordings); left: the pending batch | `decoder.rs` | `providers-ai-other/cursor-api/tool-call` |
| `:1754` | a clean end-stream closes both the SSE and its transport | partial: the same; left: the closes | `mod.rs` | `providers-ai-other/cursor-api/text` |
| `:1810` | stream protocol errors are rejected, not rendered as assistant text | partial: the same (end-stream recordings); left: the rejection | `decoder.rs` | `providers-ai-other/cursor-api/bidi-end-stream-*` |
| `:1885` | interaction queries are answered, unknown native execs are rejected, and a `turnEnded` close is accepted | none | `mod.rs`, `decoder.rs` | — |
| `:1941` | a partly visible stream resumes only from a checkpoint | none | `decoder.rs` | — |
| `:2012` | a partly visible stream without a checkpoint is never replayed blindly | none | `mod.rs` | — |
| `:2043` | throttle recovery never replays visible output, with or without a checkpoint | none | `mod.rs` | — |
| `:2128` | an end-stream error after `turnEnded` completes the turn without a retry | none (`decoder.rs` gates on `saw_turn_ended`; no test) | `decoder.rs` | — |
| `:2140` | an error close after `turnEnded` never drops a pending tool call | none (same) | `decoder.rs` | — |
| `:2286` | wire guards bound schemas, tool payloads, blobs and frames | partial: `request.rs:525` `blob_store_evicts_oldest_first` proves the blob store's 512-entry cap and that the oldest blob goes (`:2266-2271`). Left: schema prose kept (`:2161`; `slim_schema_drops_annotations_and_trivia` asserts what is dropped, not descriptions, enums and `required` kept), a top-level `oneOf` flattened without mutating the input (`:2187`), tool text capped with a truncation note (`:2259`), a heartbeat counted as liveness (`:2272`), and a frame over 64 MiB refused (`:2273-2276`; the check is `request.rs:504`, untested) | `request.rs`, `schema.rs` | — |
| `:2293` | suffixed effort ids are recognised; the first alias claimant is kept | partial: `listing_tests.rs` recordings; left: the first-claimant rule | `listing.rs` | `providers/cursor-models/cases.json` |

### `openai-codex-identity.test.mjs` and `openai-ws-delta-parity.test.mjs` (11 tests: 4 proven, 6 partial, 1 none)

Both Node files are in `src/runtime/agent/orchestrator/providers/`.

Proven:

- `ws-delta:19` (reasoning, text, then reasoning replay in order): `tests/it/openai_profiles.rs`
  `a_multi_step_reasoning_turn_replays_as_node_does` over `providers/oracles/openai-reasoning-replay-golden.json`.
- `ws-delta:83` (a missing previous reasoning item gives a full frame, reason `response_output_mismatch:reasoning`, no
  `previous_response_id`): `tests/it/openai_delta.rs` `every_scripted_exchange_frames_as_node_frames_it` (mode, reason,
  stripped count and frame bytes) over `providers/oracles/openai-ws-delta-golden.json` case "response reasoning missing".
- `ws-delta:196` (the delta frame drops the anchored reasoning item, two items stripped): the same test, case "exact
  extension".
- `identity:149` (turn state over WS reconnect and HTTP fallback): `providers/openai/adapter.rs`
  `a_turn_state_lives_as_long_as_nodes`.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `identity:13` | the wire identity is a real time-based UUIDv7, stable for the session | partial: `tests/it/openai_metadata.rs` `the_frame_and_handshake_identity_equal_node_s`; left: minting a v7 | `providers/openai/client_meta.rs` | `providers/oracles/openai-codex-metadata-golden.json` |
| `identity:28` | the cache key and every wire session identity use the same UUIDv7 | partial: the same; left: the cache key | `providers/openai/client_meta.rs` | the same |
| `identity:107` | a compaction shares the session identity and cache slot, with `requestKind` compaction | none | `providers/openai/client_meta.rs` | — |
| `ws-delta:47` | a live turn-state token is never replaced by a later event token | partial: `providers/openai/adapter.rs` `a_frames_turn_state_is_what_nodes_capture_takes` (the token a frame carries); left: the later token | `providers/openai/adapter.rs` | — |
| `ws-delta:62` | reasoning stays in the logical history on every send and is suppressed on retry | partial: `a_multi_step_reasoning_turn_replays_as_node_does`; left: the suppression on retry | `providers/openai/continuation.rs` | `providers/oracles/openai-reasoning-replay-golden.json` |
| `ws-delta:144` | the input-prefix fallback reports only the first changed item's type and hashes | partial: `every_scripted_exchange_frames_as_node_frames_it` (case "prefix changed": mode, reason and frame); left: the mismatch report | `providers/openai/delta.rs` | `providers/oracles/openai-ws-delta-golden.json` |
| `ws-delta:249` | one pool key serialises live owners and reconnects only after close | partial: `tests/it/openai_ws_pool.rs` `the_next_request_continues_on_the_same_socket_with_only_its_tail`, `a_response_abandoned_mid_stream_never_returns_its_socket_to_the_pool`; left: the serialisation of owners | `providers/openai/pool.rs` | — |

## turn-contract (`mixdog-agent` `run_loop`, `turns::`)

`scripts/runtime-turn-contract-test.mjs` (run by `run-advisory-spec.mjs`) has 20 tests: none proven, 4 partial, 16
none. No Node recording exists for any of them, apart from the ones named below. Run-loop tests cited are in
`mixdog-agent/tests/it/run_loop.rs`.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `:45` | a background tool completion stays with the invoking agent session | none | `mixdog-agent` `agent_tool/board.rs` (notification to the caller's session) | — |
| `:56` | provider failures give concise capacity, session-state and retry reasons | none in lane (outside lane: `mixdog-ai` `service/error_text.rs` golden test) | `mixdog-ai` `service/error_text.rs` | `mixdog-ai/fixtures/error-text/cases.json` |
| `:85` | the canonical runtime context snapshot wins over stale published stats | none in lane (outside lane: `mixdog-core` `run_host/context_world.rs` golden test, without stale stats) | `mixdog-core` `run_host/context_world.rs` | `context-status/golden.json`, `context-status-route/golden.json` |
| `:136` | Lead pool rows never enter the agent tool's closeAll registry | none | `mixdog-core-session` `session/agent_registry/lead_row.rs` | — |
| `:202` | an explicitly addressed route change keeps an empty session id | none in lane (outside lane, partial: `mixdog-core` `run_host/resume_tools.rs` `a_lead_route_change_resolves_what_node_resolves`) | `mixdog-core` `run_host/resume_tools.rs` | — |
| `:289` | a runtime ask keeps the provenance (`goal-closeout`) of automatic Goal input for the transcript | partial (outside lane): `mixdog-core-session` `session/goal_lane_tests.rs` (the lane delivers sources `user`, `goal-closeout`); left: the transcript row | `mixdog-core-session` `session/goal_lane.rs` | — |
| `:302` | an abort-aware wait settles although the operation under it never does | partial: `abort_while_the_provider_is_silent_returns_at_once`, `a_dropped_turn_settles_its_group_as_cancelled`; left: the wait primitive on its own | `mixdog-agent` run loop | — |
| `:313` | an abort-aware wait never starts work cancelled before its first microtask | none (`a_detached_eager_run_ends_with_the_turns_cancellation` does not show the work never started) | `mixdog-agent` run loop | — |
| `:328` | an aborted lock waiter settles at once without opening the lock | none | no Rust counterpart found (no session lock with abortable waiters) | — |
| `:351` | turn cleanup settles within a finite deadline | none (`agent_tool/flow/turn.rs` `settle_cancelled`; no test) | `mixdog-agent` `agent_tool/flow/turn.rs` | — |
| `:357` | a runtime ask aborts while route preparation hangs, and no snapshot is begun | none (`abort_does_not_wait_for_stalled_storage` is about storage, not route preparation) | `mixdog-core-session` | — |
| `:385` | a runtime ask aborts while a prompt hook ignores cancellation | none | `mixdog-mcp` `hook_bus/mod.rs` (`run_prompt`) | — |
| `:408` | an optional turn-snapshot cleanup cannot pin a successful ask | none (the storage test is not the snapshot cleanup) | `mixdog-core-session` `session/worktree_snapshots.rs` | — |
| `:424` | local main turns store user and assistant rows without Remote | partial: `tests/it/turns.rs` `a_workers_turn_equals_nodes_runner`, `worker_turn_rows_equal_nodes`; left: main (not worker) turns | `mixdog-agent` turns | — |
| `:449` | running shell output is progress until the terminal completion arrives | none | `mixdog-tools` `exec/jobs.rs` (`[progress]` digest) | — |
| `:519` | the fallback shell completion wrapper renders as one UI card | none | `mixdog-tools` `exec/jobs.rs` (the background-task envelope); the card is rendered by the desktop app | — |
| `:551` | execution metadata classifies incomplete completion envelopes | none | no Rust counterpart found | — |
| `:575` | rendered background task envelopes carry the canonical surface and operation | none (`agent_tool/flow/early.rs` writes them for agents, `mixdog-tools` `exec/jobs.rs` for shells; no test) | `mixdog-agent` `agent_tool/flow/early.rs` | — |
| `:591` | interrupt display: the stall, timeout and abort copy, and the non-user markers | partial: `abort_during_a_tool_cancels_its_token_and_keeps_finished_results`, and (outside lane) `mixdog-agent` `interrupt.rs` `every_interruption_is_finalized_as_node_does`; left: the stall and timeout copy | `mixdog-agent` `interrupt.rs` | — |
| `:636` | transcript interruption markers are classified without hiding user prose | none (`every_interruption_is_finalized_as_node_does` writes markers, does not classify them) | `mixdog-protocol` `text_class.rs` | — |

## daemon-bootstrap (`mixdog-app-server-daemon` `boot_coordinator`, `server_ensure::tests::…`)

`daemon-bootstrap-test.mjs:8` is proven: a client meets a live install before its core is published, waits, and is
served. The proof is `server_ensure/tests.rs` `a_run_that_meets_a_live_install_before_its_core_is_published_waits_and_is_served_by_it`,
with a real control server answering. The core that does not answer, the one that stays silent past the 1,500 ms idle
limit, and the one that answers slowly are covered by the tests the lane also selects.

`src/standalone/session-runtime-inline-host.test.mjs` (10 tests: 1 partial, 9 none). These tests are about Node's
in-process session-runtime host: a lazily imported module, keychain prewarm, `warmLocalRuntime`. The Rust daemon has
no lazy module import or warm step (`boot_coordinator.rs:12`: no keychain step), so most rows have no Rust behaviour to
test. No recording exists.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `:53` | runtime creation cannot start after a module import outlives the closed host | none | no Rust counterpart (no lazy import) | — |
| `:73` | a runtime acquired after the host closed is disposed, not kept | none | no Rust counterpart found | — |
| `:99` | concurrent host closes join the disposal of the runtimes already owned | none | `mixdog-core` `run_host/agent_dispatch.rs` `abort_all` (aborts only; no join of a disposal) | — |
| `:131` | an agent dispatch cancelled during graph loading cannot prepare providers afterwards | partial (outside lane): `mixdog-core` `run_host/agent_dispatch/tests.rs` `the_inline_host_hands_the_dispatcher_what_nodes_host_handed_it` (abort and the closed host); left: the cancel during loading | `mixdog-core` `run_host/agent_dispatch.rs` | — |
| `:164` | cold session creation waits for shared credentials and respects shutdown | none | no Rust counterpart (no keychain step; credentials are read where used, `mixdog-ai` `registry/keys.rs`) | — |
| `:202` | the inline host keeps session actors in the daemon process and releases them | none (`the_inline_host_hands_the_dispatcher_what_nodes_host_handed_it` is about agent dispatch, not session actors) | no Rust counterpart found | — |
| `:243` | the inline host prewarms only the keychain, not the session or agent graphs | none | `boot_coordinator.rs` (no prewarm) | — |
| `:272` | `warmLocalRuntime` loads the module in the background, and create reuses it | none | no Rust counterpart (no warm step) | — |
| `:292` | `warmLocalRuntime` hands the warm-up the host's closed state | none | no Rust counterpart | — |
| `:310` | `warmLocalRuntime` tolerates a failed import and leaves create on the lazy path | none | no Rust counterpart | — |

## native-assets (`mixdog-services` `native_asset::tests`)

`scripts/prepare-native-assets-test.mjs` has 5 tests: 1 proven, 3 partial, 1 none. The unsupported host is refused
before any download (`:74`): proven by `an_unsupported_host_is_refused_before_any_download`. Tests are in
`mixdog-services/src/native_asset/tests.rs`.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `:25` | the host platforms equal the five published native-tool keys | partial: `the_bundled_manifest_publishes_every_release_platform` asserts six keys, `win32-arm64` among them; left: the five keys Node publishes, with ARM served by the x64 asset | `mixdog-services` `native_asset` | `native-asset/graph-binary.json` |
| `:32` | the npm postinstall prepares every required asset (graph, patch, spawn, supervisor) in order into one data directory | none: Rust has no postinstall; the desktop stages `native-tools` (`apps/desktop/scripts/prepare-runtime.mjs:673-702`) | `apps/desktop` packaging (not Rust) | — |
| `:59` | Windows on ARM prepares the assets it runs under x64 emulation | partial: `windows_on_arm_installs_the_x64_asset_it_runs_under_emulation` (graph only); left: patch, spawn and supervisor | `mixdog-services` `native_asset` | `native-asset/graph-binary.json` |
| `:99` | a failure of one required asset rejects the whole install step and leaves no target | partial: the graph fetch's `download-fails` and `bad-checksum` cases leave no file; left: all-or-nothing over several assets | `mixdog-services` `native_asset` | `native-asset/graph-binary.json` |

## request-snapshot (`mixdog-core` `run_host::request_snapshot`)

`benchmarks/terminal-bench-2.1/analysis/contract-hash.mjs` asserts nothing: it computes the benchmark's contract digest
(rules digest over `src/rules/*.md` `:31`, workflow documents `:70`, tool catalog and provider payload hashes `:168`,
the rendered prompt surface `:263`, schemaVersion 2 `:312`) and prints it; `run.ps1` and `verify-source-commit.mjs` read
it. No CI step ran it. The Rust side builds the same digest from the core's request snapshot in
`benchmarks/terminal-bench-2.1/analysis/contract-hash-rust.mjs` (added on this branch in `f9c05cb79d`), which its Node
test `benchmarks/terminal-bench-2.1/analysis/contract-hash-rust.test.mjs` checks over constructed snapshots (route
contract hashes and counts, wire tools, Gemini counting, the schemaVersion 2 shape, thread parameters, `changedContracts`
ignoring descriptions); the lane does not run that test. The lane's Rust tests prove the snapshot those hashes are taken
from: `mixdog-core/src/run_host/request_snapshot.rs`
`the_snapshot_holds_the_requests_wire_body_its_tools_and_the_sessions_documents` (provider, model, system, tools,
catalog, active and disallowed tools, body) and `a_session_without_deferred_documents_snapshots_empty_lists`.

| Node | Asserts | Status | Owner | Recording |
| --- | --- | --- | --- | --- |
| `contract-hash.mjs` (whole digest) | (implied by the benchmark's use) the digest of a session is the contract that session sent | none: no test shows that the Rust digest of a session equals Node's digest of the same session | `mixdog-core` `run_host/request_snapshot.rs` (snapshot), `benchmarks/terminal-bench-2.1/analysis/contract-hash-rust.mjs` (digest) | partial: `benchmarks/terminal-bench-2.1/analysis/parity/fixtures/node-recording.json` (Node `b6f10295a`, 15 scenarios, wire traffic and request bodies, no digest) |

Two things would prove the equality:

1. A Node recording of `contract-hash.mjs`'s output, at `b6f10295a`, for pinned inputs: a fixed rules and workflow tree,
   one provider and model, the tool catalog and active set, and one request.
2. A Rust test that snapshots the same session through `request_snapshot`, runs it through `contract-hash-rust.mjs`, and
   asserts each component hash equal to Node's: rules, workflow documents, tool catalog, active tools, provider payload
   and prompt surface.

The provider payload hash could be checked first, against the request bodies in `node-recording.json`: build the same
scenario's request in Rust and compare its digest with the digest of the recorded body. The rules, workflow and
prompt-surface hashes need the new Node recording, because no recorded Node digest exists.
