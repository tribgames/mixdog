//! The fields of Node's recorded provider errors and results, each with what the core compares it as and the Node
//! code that reads it (b6f10295a): the one table every provider replay (`mixdog-ai`, `mixdog-core`) compares through.

/// Every own property a group's recorded errors carry (an `Exact::Error` prop, its `code`, `cause`, `name` and
/// `message`, and each field of `streamOutcome`), what the core compares it as, and the Node code that reads it
/// (b6f10295a, `o/` = `src/runtime/agent/orchestrator/`). The one place a field can be left out of a comparison: a
/// field whose mapping starts with `unread` has no reader in Node's source outside tests, by the search
/// `\b<error receiver>\s*\??\.<field>\b` not followed by an assignment, or `{ ... <field> ... } = <receiver>`, with
/// receivers `err|error|e|ex|cause|lastError|failure|...Err|...Error|...Failure` (`outcome|streamOutcome|...Outcome`
/// for the streamOutcome fields), widened to any receiver `[.?]<field>\b` for a field the first search did not find;
/// every other field is compared as the mapping names. A replay looks a field up with [rror_field].
pub const ERROR_FIELDS: &[(&str, &str, &str)] = &[
    ("acquireTimeoutMs", "unread", ""),
    ("attempts", "observable: the attempts on the wire (requests/dials counted by the endpoint)", "o/providers/openai-ws-send-attempts/handshake-failure.mjs:27 o/session/manager/ask-turn-failure.mjs:66 src/runtime/shared/err-text.mjs:219"),
    ("connectCode", "unread", ""),
    ("data", "the response body as served (its RetryInfo is ProviderError.retry_after; the cached-content check reads it)", "o/providers/gemini.mjs:225 o/providers/provider-error-kind.mjs:83 o/providers/provider-error-kind.mjs:188 o/providers/anthropic-fast-mode.mjs:76 o/providers/anthropic-fast-mode.mjs:107 o/providers/vertex-ai-models.mjs:380 o/providers/vertex-ai-models.mjs:383 o/mcp/client.mjs:161 o/mcp/client.mjs:162"),
    ("detail", "ProviderError.message (the Devin wire error's detail: the opaque-rejection check reads it, and the message carries it)", "o/providers/devin.mjs:260"),
    ("details", "ProviderError.retry_after (the RetryInfo `providerErrorKind` reads behind the stamped retryAfterMs)", "o/providers/provider-error-kind.mjs:186 o/providers/provider-error-kind.mjs:187 o/providers/provider-error-kind.mjs:188 o/providers/vertex-ai-models.mjs:384 o/providers/devin-wire-transport.mjs:378 o/session/manager/ask-turn-failure.mjs:53 (+13 more)"),
    ("emittedText","ProviderError.exposure.text_emitted", "o/providers/anthropic-midstream-recovery.mjs:177 o/providers/anthropic-midstream-recovery.mjs:270 o/providers/anthropic-sse-turn/turn-outcome.mjs:31 o/providers/anthropic-sse.mjs:549 o/providers/lib/stream-outcome.mjs:106 o/providers/openai-compat-chat-stream/stream-result.mjs:24 o/providers/openai-compat-chat-stream/stream-result.mjs:60 o/providers/openai-compat-chat-stream/stream-result.mjs:71 o/providers/openai-compat-chat-stream/stream-state.mjs:188 o/providers/openai-compat-chat-stream.mjs:112 (+7 more)"),
    ("emittedToolCall", "ProviderError.exposure.tool_dispatched", "o/providers/account-pool.mjs:519 o/providers/antigravity-oauth.mjs:201 o/providers/effort-configuration.mjs:99 o/providers/effort-rejection.mjs:225 o/providers/gemini.mjs:661 o/providers/grok-oauth.mjs:469 o/providers/grok-oauth.mjs:484 o/providers/openai-compat.mjs:176 o/providers/openai-oauth-dispatch.mjs:31 o/providers/openai-oauth-dispatch.mjs:145 (+4 more)"),
    ("error", "ProviderError.code + message (the provider body's error object)", "o/providers/anthropic-error-contract.mjs:82 o/providers/anthropic.mjs:357 o/providers/antigravity-oauth-login.mjs:83 o/providers/antigravity-oauth-login.mjs:93 o/providers/command-code-oauth.mjs:160 o/providers/effort-rejection.mjs:118 o/providers/effort-rejection.mjs:119 o/providers/grok-oauth.mjs:65 o/providers/mimo-oauth-profile.mjs:142 o/providers/mimo-oauth.mjs:66 (+33 more)"),
    ("finishReason", "ProviderError.finish_reason","o/providers/retry-classification.mjs:164 o/session/send-with-recovery.mjs:543 o/session/send-with-recovery.mjs:559"),
    ("firstByteTimeout", "ProviderError.timed_out + kind", "o/providers/provider-error-kind.mjs:776 o/providers/retry-midstream.mjs:170 o/providers/retry-midstream.mjs:371"),
    ("geminiStatus", "ProviderError.code / kind (a native code `providerErrorKind` reads: the contract's code when no ErrorInfo reason names one)", "o/providers/provider-error-kind.mjs:495 o/providers/retry-classification.mjs:385 o/providers/retry-classification.mjs:558"),
    ("headers", "ProviderError.retry_after / reset_at / quota_scope (the readers take retry-after and rate-limit headers)", "o/providers/admission-scheduler.mjs:61 o/providers/anthropic-api-transport.mjs:106 o/providers/anthropic-error-contract.mjs:89 o/providers/anthropic-error-contract.mjs:90 o/providers/anthropic-fast-mode.mjs:76 o/providers/anthropic-fast-mode.mjs:107 o/providers/openai-compat-error-contract.mjs:37 o/providers/openai-error-contract.mjs:208 o/providers/openai-error-contract.mjs:212 o/providers/openai-error-contract.mjs:230 (+6 more)"),
    ("httpBody", "unread", ""),
    ("httpStatus", "ProviderError.status", "o/providers/admission-scheduler.mjs:366 o/providers/anthropic-api-transport.mjs:105 o/providers/anthropic-api-transport.mjs:106 o/providers/anthropic-api-transport.mjs:201 o/providers/anthropic-error-contract.mjs:75 o/providers/anthropic-fast-mode.mjs:69 o/providers/anthropic-midstream-recovery.mjs:196 o/providers/anthropic-midstream-recovery.mjs:285 o/providers/anthropic-oauth-request.mjs:141 o/providers/anthropic-overload-fallback.mjs:27 (+59 more)"),
    ("incompleteReason", "StreamEvent::Completed stop (max_output_tokens)", "o/providers/openai-http-sse-response-state/response-outcome.mjs:79"),
    ("initialResponseError", "ProviderError.kind (the first refusal kept over a later transport error)", "o/providers/anthropic-midstream-recovery.mjs:193 o/providers/anthropic.mjs:356 o/providers/anthropic.mjs:365"),
    ("liveTextEmitted", "ProviderError.exposure.text_emitted", "o/providers/account-pool.mjs:519 o/providers/antigravity-oauth.mjs:201 o/providers/effort-configuration.mjs:99 o/providers/effort-rejection.mjs:225 o/providers/gemini.mjs:661 o/providers/grok-oauth.mjs:468 o/providers/grok-oauth.mjs:484 o/providers/openai-compat.mjs:176 o/providers/openai-oauth-dispatch.mjs:30 o/providers/openai-oauth-dispatch.mjs:132 (+6 more)"),
    ("malformedStream", "unread", ""),
    ("midstreamClassifier", "unread outside traces: transport-fallback-trace rows (core: no trace rows, K1 G12)", "o/providers/lib/transport-fallback-trace.mjs:19 o/providers/openai-compat.mjs:225 o/providers/openai-compat.mjs:241 o/providers/openai-oauth-dispatch.mjs:130 o/providers/openai-oauth-dispatch.mjs:166 o/providers/openai-oauth.mjs:330 o/providers/retry-midstream.mjs:368 o/session/manager/ask-turn-failure.mjs:68 o/session/send-with-recovery.mjs:850"),
    ("midstreamRetries", "observable: the attempts on the wire", "o/providers/openai-oauth-dispatch.mjs:131 o/session/manager/ask-turn-failure.mjs:67"),
    ("model", "ProviderError.partial_model, else the send's own model (the model usage and a promoted partial are booked to)", "o/providers/lib/note-error-usage.mjs:7 o/session/send-with-recovery.mjs:556 src/runtime/shared/llm/usage-accounting.mjs:222 src/runtime/shared/llm/usage-accounting.mjs:229 src/runtime/shared/llm/usage-ledger-rollup.mjs:130 src/runtime/shared/llm/usage-ledger-rollup.mjs:137"),
    ("name", "ProviderError.kind / timed_out (AbortError, StreamStalledError, StreamInterruptedError)", "o/cache-mtime.mjs:66 o/cache-mtime.mjs:69 o/mcp/client-transport.mjs:101 o/mcp/client.mjs:958 o/providers/anthropic-oauth-credentials.mjs:407 o/providers/anthropic-oauth-request/abort-wiring.mjs:59 o/providers/anthropic-sse.mjs:181 o/providers/cursor-wire-guards.mjs:300 o/providers/cursor-wire-guards.mjs:308 o/providers/cursor-wire-guards.mjs:351 (+64 more)"),
    ("param", "ProviderError.rejected_tool", "o/providers/wire-route.mjs:298 o/session/tool-schema-rejection.mjs:26 o/session/tool-schema-rejection.mjs:32"),
    ("partialContent", "the attempt's StreamEvent::TextDelta events", "o/providers/gemini-stream.mjs:117 o/providers/gemini.mjs:155 o/providers/gemini.mjs:156 o/providers/openai-http-sse-response-state/response-stamps.mjs:92 o/providers/openai-ws-stream.mjs:214 o/session/send-with-recovery.mjs:544 o/session/send-with-recovery.mjs:545 o/session/send-with-recovery.mjs:555 o/session/send-with-recovery.mjs:579 o/session/send-with-recovery.mjs:580 (+3 more)"),
    ("partialModel", "ProviderError.partial_model", "o/providers/anthropic-midstream-recovery.mjs:331 o/providers/cursor.mjs:756 o/providers/cursor.mjs:766 o/providers/cursor.mjs:771 o/providers/lib/note-error-usage.mjs:7 o/providers/openai-compat-responses-state.mjs:105 o/providers/openai-compat-responses-state.mjs:107 o/session/send-with-recovery.mjs:667 o/session/send-with-recovery.mjs:741 src/runtime/shared/llm/usage-accounting.mjs:204 (+1 more)"),
    ("partialProviderReplay", "ProviderError.partial_replay", "o/providers/openai-http-sse-response-state/response-stamps.mjs:69 o/session/send-with-recovery.mjs:553 o/session/send-with-recovery.mjs:735"),
    ("partialToolCall", "ProviderError.exposure.tool_input_cut", "o/providers/anthropic-midstream-recovery.mjs:156 o/providers/anthropic-midstream-recovery.mjs:272 o/providers/anthropic-sse-turn/turn-outcome.mjs:66 o/providers/anthropic-sse-turn/turn-outcome.mjs:124 o/providers/anthropic-sse.mjs:533 o/providers/cursor-wire-guards.mjs:258 o/providers/lib/stream-outcome.mjs:127"),
    ("partialToolCallStarted", "ProviderError.exposure.tool_input_cut", "o/providers/lib/stream-outcome.mjs:129"),
    ("partialToolCalls", "the attempt's StreamEvent::ToolCallDone events", "o/providers/openai-compat-response-normalization.mjs:163 o/providers/retry-classification.mjs:168 o/session/send-with-recovery.mjs:721 o/session/send-with-recovery.mjs:722"),
    ("partialUsage", "ProviderError.partial_usage", "o/providers/anthropic-midstream-recovery.mjs:331 o/providers/cursor-wire-stream-sink.mjs:70 o/providers/cursor.mjs:756 o/providers/cursor.mjs:766 o/providers/cursor.mjs:771 o/providers/devin.mjs:435 o/providers/gemini-stream.mjs:79 o/providers/lib/inclusive-usage.mjs:35 o/providers/lib/note-error-usage.mjs:7 o/providers/openai-compat-chat-stream/stream-state.mjs:151 (+5 more)"),
    ("payload", "ProviderError.code + message (a response.failed frame's error)", "o/providers/openai-ws-send-attempts/policy.mjs:143 o/providers/provider-error-kind.mjs:87 o/providers/retry-midstream.mjs:117"),
    ("pendingToolUse", "ProviderError.exposure.tool_input_cut", "o/providers/gemini-stream.mjs:118 o/providers/gemini.mjs:177"),
    ("previousTransportError", "unread", ""),
    ("providerError", "ProviderError.code + message", "o/providers/catalog-failures.mjs:17 o/providers/openai-compat-error-contract.mjs:26 o/providers/provider-error-kind.mjs:73 o/providers/provider-error-kind.mjs:86 o/providers/wire-route.mjs:282 o/providers/wire-route.mjs:283 o/providers/wire-route.mjs:301 o/session/image-strip-recovery.mjs:162 o/session/thinking-replay-recovery.mjs:19 o/session/tool-schema-rejection.mjs:17 (+2 more)"),
    ("providerErrorCode", "ProviderError.code", "o/providers/grok-oauth.mjs:65 o/providers/openai-compat-stream-common.mjs:26 o/providers/provider-error-kind.mjs:104 o/providers/wire-route.mjs:278 o/session/image-strip-recovery.mjs:167 src/runtime/shared/error-presentation.mjs:185"),
    ("providerIncomplete", "ProviderError.finish_reason is set (the turn ended on a finish other than a clean stop)", "o/providers/retry-classification.mjs:163 o/session/send-with-recovery.mjs:541"),
    ("providerMetadata", "the text parts' metadata, carried in the attempt's StreamEvent::ReasoningReplay parts (none when the turn kept no parts)", "o/providers/gemini.mjs:159 o/providers/gemini.mjs:164 o/session/send-with-recovery.mjs:562 o/session/send-with-recovery.mjs:762"),
    ("providerRecoveryAttempts","unread", ""),
    ("providerRecoveryExhausted", "SendError::Exhausted (a ladder ran out)", "o/providers/retry-executor.mjs:99"),
    ("providerRecoveryOwner", "unread", ""),
    ("providerRecoveryTerminal", "SendError::Exhausted with no re-issue after it (the arrivals, compared whole, hold none)", "o/providers/retry-executor.mjs:106 o/providers/retry-classification.mjs:414"),
    ("providerWireError", "ProviderError.kind (an in-band error frame)", "o/providers/openai-compat-stream-common.mjs:19 o/providers/provider-error-kind.mjs:719 o/providers/retry-classification.mjs:585 o/providers/retry-classification.mjs:610"),
    ("quotaScope", "ProviderError.quota_scope", "o/providers/antigravity-retry-policy.mjs:165 o/providers/antigravity-retry-policy.mjs:166"),
    ("rawUsage", "ProviderError.partial_usage (the turn's usageMetadata; null: none reported)", "o/session/send-with-recovery.mjs:558"),
    ("requestID","unread", ""),
    ("resetAt", "ProviderError.reset_at", "o/providers/openai-compat-error-contract.mjs:42 o/providers/openai-error-contract.mjs:231"),
    ("responseDoneStatus", "unread", ""),
    ("responseFailed", "ProviderError.kind (a response.failed frame)", "o/providers/provider-error-kind.mjs:72 o/providers/provider-error-kind.mjs:719 o/providers/retry-classification.mjs:585 o/providers/retry-midstream.mjs:197 o/session/image-strip-recovery.mjs:162 o/session/thinking-replay-recovery.mjs:19"),
    ("retryable", "ProviderError.kind (a retryable Devin protocol fault is a truncated stream)", "o/providers/devin.mjs:249 o/providers/anthropic-oauth.mjs:903"),
    ("retryAfterAt", "ProviderError.retry_after", "o/providers/openai-error-contract.mjs:223"),
    ("retryAfterMs", "ProviderError.retry_after", "o/providers/admission-scheduler.mjs:59 o/providers/anthropic-error-contract.mjs:91 o/providers/anthropic-fast-mode.mjs:103 o/providers/openai-compat-error-contract.mjs:38 o/providers/retry-midstream.mjs:140 src/runtime/shared/err-text.mjs:205 src/runtime/web-search/lib/fetch-pipeline.mjs:54 src/runtime/web-search/lib/fetch-pipeline.mjs:151"),
    ("retryClassifier", "unread outside traces: transport-fallback-trace rows (core: no trace rows, K1 G12)", "o/providers/lib/transport-fallback-trace.mjs:16 o/providers/lib/transport-fallback-trace.mjs:19 o/providers/openai-compat.mjs:225 o/providers/openai-compat.mjs:241 o/providers/openai-oauth-dispatch.mjs:130 o/providers/openai-oauth-dispatch.mjs:166 o/providers/openai-oauth.mjs:303 o/providers/openai-oauth.mjs:330 o/providers/openai-ws-send-attempts/handshake-failure.mjs:12 o/providers/retry-executor.mjs:369 (+2 more)"),
    ("status", "ProviderError.status", "o/providers/admission-scheduler.mjs:366 o/providers/anthropic-api-transport.mjs:105 o/providers/anthropic-api-transport.mjs:106 o/providers/anthropic-api-transport.mjs:131 o/providers/anthropic-api-transport.mjs:201 o/providers/anthropic-error-contract.mjs:75 o/providers/anthropic-fast-mode.mjs:69 o/providers/anthropic-midstream-recovery.mjs:196 o/providers/anthropic-midstream-recovery.mjs:285 o/providers/anthropic-oauth-request.mjs:141 (+80 more)"),
    ("streamInterrupted", "unread", ""),
    ("streamOutcome", "the 23 streamOutcome fields below", "o/providers/anthropic-sse.mjs:544"),
    ("streamStalled", "ProviderError.timed_out + kind; on a cut stream (TransportFault::TruncatedStream) the partial-final stamp: the attempt's text kept (exposure.text_emitted)", "o/providers/openai-compat-chat-send.mjs:211 o/providers/openai-compat-responses.mjs:259 o/providers/openai-compat-xai-send.mjs:144 o/providers/provider-error-kind.mjs:261 o/providers/retry-midstream.mjs:102 o/providers/retry-midstream.mjs:266 o/providers/wire-route.mjs:295 o/session/manager/turn-reap.mjs:34"),
    ("timeoutPhase", "ProviderError.timeout phase", "o/providers/provider-error-kind.mjs:767 o/providers/provider-error-kind.mjs:769 src/runtime/shared/err-text.mjs:228 src/runtime/shared/provider-timeout-phase.mjs:17"),
    ("toolCallEmitted", "ProviderError.exposure.tool_dispatched", "o/providers/openai-oauth-dispatch.mjs:32 o/providers/openai-oauth-dispatch.mjs:146"),
    ("transportTiming", "read by session telemetry only (real-clock durations, masked by the manifests); core field to add with the telemetry rows", "o/session/manager/ask-turn-commit.mjs:140 o/session/manager/status-telemetry.mjs:84"),
    ("truncatedStream", "ProviderError.kind (truncation) + delivery", "o/providers/anthropic-midstream-recovery.mjs:246 o/providers/gemini-stream.mjs:114 o/providers/gemini.mjs:175 o/providers/openai-compat-chat-stream/stream-result.mjs:55 o/providers/provider-error-kind.mjs:261 o/providers/retry-classification.mjs:100"),
    ("type", "ProviderError.code", "o/providers/anthropic-error-contract.mjs:48 o/providers/anthropic-sse.mjs:91 o/providers/grok-oauth.mjs:65 o/providers/openai-compat-error-contract.mjs:32 o/providers/openai-compat-models.mjs:89 o/providers/openai-error-contract.mjs:28 o/providers/openai-error-contract.mjs:214 o/providers/openai-error-contract.mjs:225 o/providers/openai-http-sse-response-state/response-events/terminal-frames.mjs:177 o/providers/openai-ws-terminal.mjs:21 (+12 more)"),
    ("unsafeToRetry", "ProviderError.unsafe_to_retry", "o/providers/account-pool.mjs:599 o/providers/account-pool.mjs:614 o/providers/antigravity-oauth.mjs:201 o/providers/cursor.mjs:710 o/providers/effort-configuration.mjs:99 o/providers/effort-rejection.mjs:225 o/providers/gemini.mjs:661 o/providers/gemini.mjs:895 o/providers/grok-oauth.mjs:484 o/providers/openai-compat.mjs:176 (+13 more)"),
    ("userMessage", "unread", ""),
    ("wsCloseCode", "ProviderError.transport = WsClose { code }", "o/providers/openai-oauth-dispatch.mjs:129 o/providers/openai-ws-send-attempts/attempt-context.mjs:27 o/providers/openai-ws-terminal.mjs:94 o/providers/provider-error-kind.mjs:262 o/providers/retry-classification.mjs:246 o/providers/retry-midstream.mjs:186 o/providers/retry-midstream.mjs:346 o/session/send-with-recovery.mjs:376 o/session/send-with-recovery.mjs:842 o/session/send-with-recovery.mjs:847"),
    ("wsCloseReason", "unread", ""),
    ("wsFailurePhase", "ProviderError.delivery (handshake: NotSent)", "o/providers/openai-oauth-dispatch.mjs:39 o/providers/openai-ws.mjs:43"),
    ("wsHttpFallbackEligible", "observable: the HTTP fallback request on the wire", "o/providers/openai-oauth-dispatch.mjs:40 o/providers/openai-ws.mjs:43"),
    ("wsRetriesExhausted", "observable: the HTTP fallback request on the wire", "o/providers/openai-oauth-dispatch.mjs:86"),
    ("code", "ProviderError.code", "o/context/instruction-files.mjs:105 o/context/instruction-files.mjs:106 o/context/instruction-files.mjs:134 o/context/instruction-files.mjs:135 o/dispatch-persist.mjs:123 o/dispatch-persist.mjs:124 o/mcp/agent-connectors.mjs:119 o/mcp/agent-connectors.mjs:133 o/mcp/child-tree.mjs:76 o/mcp/child-tree.mjs:422 (+506 more)"),
    ("cause", "ProviderError.transport (the socket error code under cause)", "o/mcp/client.mjs:942 o/mcp/oauth-probe.mjs:51 o/providers/devin-wire-transport.mjs:241 o/providers/devin-wire-transport.mjs:251 o/providers/lib/oauth-token-utils.mjs:247 o/providers/openai-http-sse-request.mjs:178 o/providers/openai-ws-terminal.mjs:120 o/providers/retry-classification.mjs:485 o/providers/retry-midstream.mjs:273 o/providers/vertex-ai-maas.mjs:114 (+8 more)"),
    ("message", "ProviderError.message", "src/app.mjs:170 src/cli.mjs:91 src/headless-exec.mjs:208 src/headless-exec.mjs:247 src/headless-exec.mjs:253 src/headless-exec.mjs:357 src/headless-json-lifecycle.mjs:385 src/headless-role.mjs:200 src/repl.mjs:114 o/agent-runtime/agent-progress-watchdog.mjs:52 (+1194 more)"),
    ("errno", "unread on a provider error (the socket cause's libuv number; the cause is compared by its code): its only readers take Postgres errors", "src/runtime/memory/lib/pg/adapter.mjs:10 src/runtime/memory/lib/pg/adapter.mjs:32 src/runtime/memory/lib/pg/adapter.mjs:41"),
    ("syscall", "unread on a provider error (the socket cause's call; the cause is compared by its code): its only reader takes a spawn error", "o/tools/lib/shell-spawn-retry.mjs:51"),
    ("address", "unread", ""),
    ("port", "unread", ""),
    ("streamOutcome.version", "unread beyond the version check of anthropic-sse.mjs:544 (a constant 1)", "o/providers/anthropic-sse.mjs:544"),
    ("streamOutcome.provider", "unread", ""),
    ("streamOutcome.transport", "unread", ""),
    ("streamOutcome.terminalObserved", "ProviderError.delivery (Accepted after a terminal)", "o/providers/retry-classification.mjs:248 o/providers/retry-classification.mjs:314 o/providers/retry-classification.mjs:406 o/providers/retry-midstream.mjs:165 o/providers/retry-midstream.mjs:244 o/session/send-with-recovery.mjs:393 o/session/send-with-recovery.mjs:578 o/session/send-with-recovery.mjs:617 src/runtime/shared/model-route-fallback.mjs:88"),
    ("streamOutcome.continuation", "ProviderError.kind (a continuation, not a fresh failure)", "src/runtime/shared/model-route-fallback.mjs:87"),
    ("streamOutcome.declaredContinuation", "unread outside stream-outcome.mjs normalization", ""),
    ("streamOutcome.textEmitted", "ProviderError.exposure.text_emitted", "o/providers/lib/stream-outcome.mjs:315"),
    ("streamOutcome.textObservedChars", "unread outside stream-outcome.mjs normalization", ""),
    ("streamOutcome.reasoningEmitted", "ProviderError.unsafe_to_retry (reasoning already streamed)", "o/providers/lib/stream-outcome.mjs:319 o/session/send-with-recovery.mjs:404 o/session/send-with-recovery.mjs:412"),
    ("streamOutcome.toolCallsStarted", "ProviderError.exposure.tool_input_cut", "o/providers/lib/stream-outcome.mjs:320 o/session/send-with-recovery.mjs:547 o/session/send-with-recovery.mjs:651 src/runtime/shared/model-route-fallback.mjs:51 src/runtime/shared/model-route-fallback.mjs:85"),
    ("streamOutcome.toolCallsComplete", "the attempt's StreamEvent::ToolCallDone events", "o/providers/anthropic-recovery-guards.mjs:71 o/session/send-with-recovery.mjs:397 o/session/send-with-recovery.mjs:581 o/session/send-with-recovery.mjs:653 o/session/send-with-recovery.mjs:885"),
    ("streamOutcome.toolCallsDispatched", "ProviderError.exposure.tool_dispatched", "o/session/send-with-recovery.mjs:396 o/session/send-with-recovery.mjs:884"),
    ("streamOutcome.dispatchAmbiguous", "ProviderError.delivery (Ambiguous)", "o/providers/anthropic-recovery-guards.mjs:70 o/session/send-with-recovery.mjs:395"),
    ("streamOutcome.pendingToolInput", "ProviderError.exposure.tool_input_cut", "o/providers/lib/stream-outcome.mjs:325 o/providers/retry-classification.mjs:331 o/session/send-with-recovery.mjs:615 o/session/send-with-recovery.mjs:724 o/session/send-with-recovery.mjs:739 o/session/send-with-recovery.mjs:768 src/runtime/shared/model-route-fallback.mjs:51 src/runtime/shared/model-route-fallback.mjs:86"),
    ("streamOutcome.userAbort", "SendError::Cancelled", "o/providers/retry-classification.mjs:406 src/runtime/shared/model-route-fallback.mjs:50 src/runtime/shared/model-route-fallback.mjs:81"),
    ("streamOutcome.stallObserved", "ProviderError.timed_out", "o/providers/retry-classification.mjs:316 o/providers/retry-classification.mjs:415 o/session/send-with-recovery.mjs:577 o/session/send-with-recovery.mjs:607 src/runtime/shared/model-route-fallback.mjs:50 src/runtime/shared/model-route-fallback.mjs:81"),
    ("streamOutcome.truncatedStream", "ProviderError.kind (truncation)", "o/providers/lib/stream-outcome.mjs:326 o/providers/retry-classification.mjs:317 o/providers/retry-classification.mjs:415"),
    ("streamOutcome.visibleOutput", "unread for OpenAI and compat: its only readers are the Cursor bridge", "o/providers/cursor-wire-stream-bridge.mjs:86 o/providers/cursor-wire-stream-bridge.mjs:135"),
    ("streamOutcome.observedOutput", "ProviderError.delivery", "o/providers/lib/stream-outcome.mjs:351 o/session/manager/ask-turn-failure.mjs:70 o/session/manager/ask-turn-failure.mjs:228 src/runtime/shared/model-route-fallback.mjs:51 src/runtime/shared/model-route-fallback.mjs:84"),
    ("streamOutcome.sideEffectDispatched", "ProviderError.exposure.tool_dispatched", "o/providers/anthropic-recovery-guards.mjs:69 o/providers/lib/stream-outcome.mjs:321 o/providers/lib/stream-outcome.mjs:356 o/session/send-with-recovery.mjs:394 o/session/send-with-recovery.mjs:548 o/session/send-with-recovery.mjs:616 o/session/send-with-recovery.mjs:652 o/session/send-with-recovery.mjs:883"),
    ("streamOutcome.replayUnsafe", "ProviderError.unsafe_to_retry", "o/providers/anthropic-midstream-recovery.mjs:186 o/providers/lib/stream-outcome.mjs:327 o/providers/lib/stream-outcome.mjs:341 o/providers/retry-classification.mjs:125 o/session/manager/ask-turn-failure.mjs:71 o/session/manager/ask-turn-failure.mjs:231 o/session/send-with-recovery.mjs:940"),
    ("streamOutcome.replaySafe", "ProviderError.unsafe_to_retry (negated) + exposure", "o/providers/anthropic.mjs:170 o/providers/antigravity-retry-policy.mjs:160 o/providers/gemini-retry-policy.mjs:70 o/providers/lib/stream-outcome.mjs:336 o/providers/openai-http-sse-request.mjs:189 o/providers/retry-classification.mjs:409 o/providers/retry-executor.mjs:206 o/providers/retry-midstream.mjs:166 o/providers/retry-midstream.mjs:246 o/providers/retry-midstream.mjs:355 (+9 more)"),
    ("streamOutcome.successEligible", "StreamEvent::Completed (a success)", "o/providers/lib/stream-outcome.mjs:346 o/session/send-with-recovery.mjs:546"),
];

/// The mapping of a recorded error field (`streamOutcome.<field>` for an outcome field); panics for a field the table
/// does not hold, so no field is left out silently.
pub fn error_field(field: &str) -> &'static str {
    ERROR_FIELDS.iter().find(|(name, _, _)| *name == field).map(|(_, mapping, _)| *mapping).unwrap_or_else(|| panic!("error field {field} is not in ERROR_FIELDS"))
}

/// Whether the table leaves a recorded error field out of the comparison.
pub fn error_field_unread(field: &str) -> bool {
    error_field(field).starts_with("unread")
}

/// Every field of a recorded provider result that has no field of the same name in the core's outcome: what the core
/// compares it as and the Node code that reads it (b6f10295a, `o/` = `src/runtime/agent/orchestrator/`). A replay
/// compares each such field exactly as its row maps it; a recorded field no Node code reads is not a row here but a line
/// of the set's manifest exclusions (``` `name` is not compared: <reason> ```, read by the replay driver), the one place a
/// recorded property is left out. A path names a nested field (`response.candidates[].content.parts`).
pub const RESULT_FIELDS: &[(&str, &str, &str)] = &[
    // Anthropic (`AnthropicProvider#send`, anthropic-turn-result.mjs).
    ("hasThinkingContent", "StreamEvent::ContentSummary.has_thinking", "o/session/manager/ask-turn-commit.mjs:65 o/providers/anthropic-turn-result.mjs:62"),
    ("contentBlockTypes", "StreamEvent::ContentSummary.block_types", "o/session/manager/ask-turn-commit.mjs:66 o/providers/anthropic-message-threads.mjs:333 o/providers/anthropic-turn-result.mjs:63"),
    // A `fetch` Response the Anthropic client's `fetch` returns (`createAnthropicApiKeyFetch`).
    ("response.status", "HttpResponse.status", "node_modules/@anthropic-ai/sdk/client.mjs (makeRequest: response.ok / status)"),
    ("response.headers", "HttpResponse.headers, in order", "node_modules/@anthropic-ai/sdk/client.mjs (retry-after, request-id)"),
    // Gemini (`consumeGeminiRestStreamResponse`'s aggregated response).
    ("response.candidates[].content.parts", "StreamEvent::ReasoningReplay items.parts", "o/providers/gemini-response.mjs:23 o/providers/antigravity-response.mjs:53"),
    ("response.candidates[].finishReason", "StreamEvent::Completed stop: STOP and none are None (both a delivered turn: gemini-response.mjs:63), MAX_TOKENS MaxTokens, any other a typed failure", "o/providers/gemini-response.mjs:63 o/providers/antigravity-response.mjs:77 o/providers/antigravity-response.mjs:105 o/providers/gemini-stream.mjs:625"),
    ("leakedToolCalls", "the calls the decoder's guard recovered ({id, name, arguments} each, GeminiDecoder::recovered_calls), whole and in order; a failed stream releases none of them (no ToolCallDone)", "o/providers/gemini-stream.mjs:87 o/providers/gemini-response.mjs:37 o/providers/antigravity-response.mjs:71"),
];

/// The mapping of a recorded result field; panics for a field the table does not hold.
pub fn result_field(field: &str) -> &'static str {
    RESULT_FIELDS.iter().find(|(name, _, _)| *name == field).map(|(_, mapping, _)| *mapping).unwrap_or_else(|| panic!("result field {field} is not in RESULT_FIELDS"))
}
