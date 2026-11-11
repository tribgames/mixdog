# K1 lanes: the old Node step's assertions against the Rust tests

Each lane of `k1-lanes.mjs` against the Node step it replaces (Node at `b6f10295a`). "None" means no test the lane selects
proves it; the verdict says whether the lane is as strong as the step. Walked on the tree after the o1 `e6063bfcf` merge.

| Lane | Verdict |
| --- | --- |
| shell-direct-exe | equal (Node run through `directArgv`, exit status and stdout) |
| advisory-lock | equal after review pass 12 |
| patch-bytes | weaker: tier and content hash of an edit, and `patch-replay.mjs`, unproven (below) |
| provider-contract | weaker: many cases have no Rust test (below) |
| daemon-bootstrap | equal: a real control listener answers the attaching run; an unanswering record is not healthy |
| native-assets | Windows ARM, unsupported host and failed fetch proven; the npm staging step does not exist in Rust (lane table `unproven`) |
| compact | equal after review pass 12 |
| turn-contract | weaker: most cases have no `run_loop`/`turns::` test (below) |
| request-snapshot | not a replacement of an assertion: the Node script asserted nothing (below) |

## patch-bytes (`mixdog-tools` `fs::tests`)

`scripts/native-edit-wire-test.mjs`:

| Node assertion | Rust |
| --- | --- |
| `:23` an edit reports 2 replacements | `fs/tests.rs` `edit_and_apply_patch_match_recorded_node_cases`: the recorded answer text `Updated t.txt (2 replacements)` compared whole |
| `:26` the file then reads `omega beta omega\n` | same test: the tree after each case compared with Node's |
| `:24` the match tier is `exact` | none: no `fs::tests` test asserts a tier |
| `:25` `contentHash` is 64 hex digits | none: `fs/read_state.rs` `hash_text` is not asserted under `fs::tests` |

`scripts/patch-replay.mjs` is a developer tool (`--replay`, `--replay-all` over captured patch calls) with no `assert`: its
snapshot-path refusals (absolute, drive, UNC, `..`, NUL), the skip of legacy partial captures and the `[Error:]` result
check have no Rust counterpart, because the capture/replay tool itself has none.

## provider-contract (all of `mixdog-ai`)

| Node case | Rust |
| --- | --- |
| `openai-codex-identity.test.mjs:13-79` session id, cache key, frame and handshake identity | `tests/it/openai_metadata.rs` `the_frame_and_handshake_identity_equal_node_s` |
| `openai-codex-identity.test.mjs:149-211` turn state over WS reconnect and HTTP fallback | `providers/openai/adapter.rs` `a_turn_state_lives_as_long_as_nodes`, `a_frames_turn_state_is_what_nodes_capture_takes` |
| `openai-codex-identity.test.mjs:107-146` a compaction shares session and cache slot | none |
| `openai-ws-delta-parity.test.mjs:196-246` delta frame drops anchored reasoning | `tests/it/openai_delta.rs` `every_scripted_exchange_frames_as_node_frames_it` |
| `openai-ws-delta-parity.test.mjs:249-311` one pool key serialises owners, reconnects after close | `tests/it/openai_ws_pool.rs` `the_next_request_continues_on_the_same_socket_with_only_its_tail`, `a_response_abandoned_mid_stream_never_returns_its_socket_to_the_pool` |
| `openai-ws-delta-parity.test.mjs:19-189` reasoning replay order, full-frame fallback, prefix-mismatch report | none |
| `provider-stream-outcome-test.mjs:167,184,679,1426` visible output, complete tool calls and EOF after text are replay boundaries | `providers/compat/tests.rs` `a_cut_or_filtered_turn_never_dispatches_its_tool_calls`; `providers/anthropic/tests.rs` `a_cut_tool_stream_dispatches_the_complete_calls_as_node_does`, `a_stream_cut_after_text_is_truncated_with_exposure`; `tests/it/openai_fixtures.rs` `stream_without_terminal_is_a_truncation_after_output` (each partial) |
| `provider-stream-outcome-test.mjs:116,202,411,1013,1459` no exposure stays replayable, pending tool input stays replay-safe, `withRetry` never replays an unsafe outcome, EOF after a dispatched tool | none |
| `cursor-provider-test.mjs:90` expired access-only credential needs a new sign-in | `providers/cursor/auth.rs` `only_credential_verdicts_force_a_new_sign_in` |
| `cursor-provider-test.mjs:121-227` catalog fold, Auto, Fast | `providers/cursor/models.rs` `default_variant_and_effort_choice`, `unknown_model_is_sent_as_it_is`; `providers/cursor/listing_tests.rs` `every_recorded_case_gives_node_rows_and_request` |
| `cursor-provider-test.mjs:75,107,349-606,695,1024,1053,1370,1717,1941,2012` deep link, redirect refusal, Max mode, context recovery, quota windows, cancellation, one 401 retry, split Connect frames, end-stream flush, checkpoint resume | none |
| `provider-contract-test.mjs:67,125` Computer Use shared/bytes contract | `providers/action_input_tests.rs` `register_computer`; `tests/it/openai_custom_tools.rs` `a_freeform_tool_is_sent_as_nodes_custom_tool` (partial) |
| `provider-contract-test.mjs:224,279,310-389` catalog refresh once per process, shared read, picker waits | `catalog/composed_tests.rs` `both_tables_are_warm_from_the_disk_and_fetched_once_at_the_first_refresh`, `only_the_settled_startup_refresh_tells_the_registered_waker` (partial) |
| `provider-contract-test.mjs:457,484` Grok output ceiling and reasoning options | `providers/grok/listing_tests.rs` `an_enriched_row_loses_its_output_limit_and_follows_its_ladder` (partial) |
| `provider-contract-test.mjs:629-755` Codex reset credits | `service/oauth_usage/tests.rs` `the_reset_credit_redeem_checks_its_arguments_then_replays_once` |
| `provider-contract-test.mjs:936,987,1012,1031,1121,1434` compat thinking fields, xAI effort, reasoning replay, typed 401, xAI HTTP/WS heads | `providers/compat/tests.rs` `reasoning_text_is_kept_and_replayed_under_the_key_it_arrived_on`, `effort_folds_onto_what_the_wire_takes_and_choices_are_placed`, `recorded_401_is_a_deterministic_refusal`; `tests/it/openai_profiles.rs` `a_multi_step_reasoning_turn_replays_as_node_does`, `xai_profiles_match_the_http_and_websocket_heads` (each partial) |
| `provider-contract-test.mjs:162,440,523-596,542,783-895,911,971,1051,1072,1181,1244,1354,1365,1486` OpenRouter cutoff, daemon prefetch, provider setup and keychain, OAuth row order, Codex/Cursor usage, vendor presets, OpenRouter cost, stream reasoning, OpenCode Go usage, Grok OAuth prewarm/no replay after dispatch | none |

## turn-contract (`mixdog-agent` `run_loop`, `turns::`)

`runtime-turn-contract-test.mjs` (run by `run-advisory-spec.mjs`):

| Node case | Rust |
| --- | --- |
| `:302,313` `runAbortable` settles and never starts cancelled work | `tests/it/run_loop.rs` `abort_while_the_provider_is_silent_returns_at_once`, `a_detached_eager_run_ends_with_the_turns_cancellation`, `an_aborted_turn_leaves_no_open_group`, `a_dropped_turn_settles_its_group_as_cancelled` (partial) |
| `:357,408` route-preparation abort; a snapshot cannot pin the ask | `tests/it/run_loop.rs` `abort_does_not_wait_for_stalled_storage` (partial) |
| `:591,636` interrupt copy and transcript markers | `tests/it/run_loop.rs` `abort_during_a_tool_cancels_its_token_and_keeps_finished_results` (partial: the marker text differs) |
| `:424` local transcript persistence | `tests/it/turns.rs` `a_workers_turn_equals_nodes_runner`, `worker_turn_rows_equal_nodes` (worker rows only) |
| `:45,56,85,136,202,289,328,351,385,449-575` completion stays with the invoking session, error text, context snapshot, Lead rows kept from closeAll, empty session id, Goal provenance, aborted lock waiter, cleanup deadline, prompt-hook abort, shell/agent envelopes and cards | none |

## request-snapshot (`mixdog-core` `run_host::request_snapshot`)

`benchmarks/terminal-bench-2.1/analysis/contract-hash.mjs` asserts nothing: it computes the benchmark's contract digest
(rules digest over `src/rules/*.md` `:31`, workflow documents `:70`, tool catalog and provider payload hashes `:168`, the
rendered prompt surface `:263`, schemaVersion 2 `:312`) and prints it; `run.ps1` and `verify-source-commit.mjs` read it.
No CI step ran it. The Rust side builds the same digest from the core's request snapshot
(`contract-hash-rust.mjs`, checked by `contract-hash-rust.test.mjs`: route contract hashes and counts, wire tools, Gemini
counting, the schemaVersion 2 shape, thread parameters, `changedContracts` ignoring description and key order). The lane's
Rust tests prove the snapshot those hashes are taken from: `request_snapshot.rs`
`the_snapshot_holds_the_requests_wire_body_its_tools_and_the_sessions_documents` (provider, model, system, tools, catalog,
active, disallowed tools, body) and `a_session_without_deferred_documents_snapshots_empty_lists`. That the Rust digest of
a session equals Node's digest of the same session is not proven.
