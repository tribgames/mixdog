# Context efficiency

Mixdog manages context throughout a task: which instructions are loaded, how
evidence is retrieved, how results are returned, and what is carried into the
next request or session.

Three effects are distinct: **smaller prompts**, **less repeated work**, and
**cheaper reuse of cached input**. A provider cache hit can reduce input cost
without reducing the number of tokens occupying the context window. The
nine layers below address different parts of that problem.

## 1. Lightweight system instructions

Shared and role-specific rules are refined to express operating requirements
without redundant guidance. Instructions direct the agent toward decisive
evidence, the appropriate dedicated tool, and independent actions in parallel,
rather than repeated exploration.

This layer addresses the size and clarity of the instructions themselves.
Section 7 covers which instructions are loaded and when.
There is no single fixed prompt size: workflow, profile, tools, and approved
memory change what a session needs.

Implementation: [prompt composition](../src/runtime/agent/orchestrator/context/role-instructions.mjs).

## 2. Purpose-built, bounded tools

File lookup, text search, structural navigation, reading, editing, and Git
have dedicated tools. The agent can request file paths or match locations
without full contents, read selected ranges, and batch independent inputs.
Result limits and pagination keep broad queries from flooding the context.

Session read caches reuse unchanged reads; scoped caches reuse eligible
search and graph queries. File-state checks and invalidation after writes
keep cached answers tied to the files they describe.
Execution caching saves repeated work, but does not necessarily shorten the
returned text. Tool-result reduction is covered separately in section 9.

Implementation: [read cache](../src/runtime/agent/orchestrator/session/cache/read-cache.mjs),
[scoped cache](../src/runtime/agent/orchestrator/session/cache/scoped-cache.mjs).

## 3. Built-in ast-grep and AST-based code graphs

The Rust-based `mixdog-graph` engine embeds tree-sitter and ast-grep. It
extracts code structure from parsed syntax, so the model does not need to
infer that structure from repeated file reads or keyword matches.

- Outlines show declaration kinds, exports, signatures, and nested members.
- Symbol queries locate declarations and identifier references; names found
  only in comments are not identifier references.
- Callers and callees use parsed call sites.
- Import relationships support dependency and change-impact navigation.
- The installable [Code Tidy](code-tidy.md) capability also uses the embedded
  engine for structural rule checks and supported rewrites.

The engine parses 31 languages and extracts symbols and imports for 24.
Parsing support does not imply identical extraction or call-resolution
coverage in every language. Structural analysis does not replace a
whole-program type checker or establish how code will behave at runtime.

Parsed graphs and call-site data are cached separately. Queries return the
requested outlines or relationships, not the full index, reducing both
repeated analysis and the amount of code the model needs to read.

Implementation: [native dependencies](../native/mixdog-graph/Cargo.toml),
[graph tool interface](../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs).

## 4. Provider-aware prompt caching

Stable shared policy, profile and tool catalogs, workflow and role rules,
and approved memory are separated from changing session and project state.
Keeping stable material ahead of volatile content helps avoid invalidating
an otherwise reusable prompt prefix.

The runtime adapts to provider capabilities: explicit cache breakpoints,
stable prompt-cache keys, managed cache objects, or tracking cache usage
reported by providers that cache automatically. Availability, retention,
and cache hits depend on the provider.

Where supported, this can reduce repeated processing and input cost.
Cached tokens still count toward the model's context limit, and a cache hit
is not guaranteed on every request.

Implementation: [cache strategy](../src/runtime/agent/orchestrator/agent-runtime/cache-strategy.mjs),
[prompt layers](../src/runtime/agent/orchestrator/context/role-instructions.mjs).

## 5. Structured compaction for continuing work

Compaction builds a handoff organized around the task: goals, constraints,
progress, decisions, next steps, and relevant files. It combines that
handoff with the latest user request and a bounded record of recent
execution, so the next request contains more than a free-form summary.

Summary generation uses a dedicated request with low reasoning effort and
fast mode requested where supported. Large histories can be processed in
batches sized to fit the summarizer's input budget. The resulting context
preserves protected instructions and pairs each retained tool call with its
result. Recently loaded skill instructions are retained in full when they
fit, or remain available to reload.

The latest request and complete handoff take priority over the reduction
target. If mandatory context cannot fit within the allowed budget,
compaction reports an error instead of silently cutting it. Summarization
still costs time and tokens; it does not preserve every detail of the
original conversation.

Implementation: [compaction runner](../src/runtime/agent/orchestrator/session/compact/runner.mjs),
[handoff structure](../src/runtime/agent/orchestrator/session/compact/summary.mjs).

## 6. Idle-time reduction of cache-miss cost

When enabled, auto-clear uses the configured idle duration and a minimum
context-usage check to decide whether to compact before work resumes.
It skips busy sessions and contexts below the configured minimum. Despite
the name, auto-clear retains the compacted conversation rather than
discarding it to start an empty chat.

The aim is to avoid resending an unnecessarily large history after a long
gap, when provider caches may have expired. This is an idle-time policy,
not an automatic response to every individual cache miss.
Actual cache lifetimes and savings depend on the provider and workload.

Use `/autoclear` to manage the policy, `/compact` for manual compaction, and
`/context` to inspect the active context.

Implementation: [idle-time session flow](../src/tui/session/session-flow.mjs),
[configuration](../src/session-runtime/config-helpers.mjs).

## 7. On-demand loading and layered prompt management

Available skills and deferred tools are listed in compact catalogs.
Full skill instructions and deferred tool schemas load when needed instead
of placing every optional capability into every initial request. Loaded
instructions can be reused rather than repeatedly inserted unchanged.

Prompt composition also separates shared policy, persistent settings and
catalogs, workflow and role instructions, approved memory, and changing
environment state. This controls what enters the prompt and how it is
arranged; section 1 addresses how concisely each instruction is written.

On-demand loading reduces initial overhead. Once a capability is used, its
loaded instructions, schemas, and results still occupy context.

Implementation: [deferred-tool catalogs](../src/runtime/agent/orchestrator/context/deferred-tools.mjs),
[skill loading](../src/runtime/agent/orchestrator/context/skill-catalog.mjs),
[prompt composition](../src/runtime/agent/orchestrator/context/role-instructions.mjs).

## 8. Database-backed long-term memory

Conversation history is stored in a managed local PostgreSQL database rather
than inserted wholesale into each new prompt. The memory system uses pgvector
for semantic retrieval and PostgreSQL full-text indexes for lexical search.
`recall` retrieves relevant prior work. Maintenance summarizes and indexes
history and links duplicates or continuations without promoting generated
summaries into standing instructions.

Standing preferences and constraints are separate, user-curated `memory`
records. Only approved shared and current-project entries are injected as
core memory. The archive can grow without making every historical record a
per-request instruction.

This reduces context overhead rather than eliminating it: core memory and
retrieved history both consume tokens. See [Memory maintenance](memory-cycles.md)
for ownership and history-retention details. Headless `mixdog exec` does not
load personal memory or prior sessions.

Implementation: [database setup](../src/runtime/memory/lib/pg/adapter.mjs),
[memory indexes](../src/runtime/memory/lib/memory.mjs),
[session memory selection](../src/runtime/memory/lib/core-memory-file.mjs).

## 9. Tool-result reduction, deduplication, and offloading

Tool output has its own reduction layer, separate from choosing the right
tool or compacting the conversation:

- **Repeated calls and bodies:** eligible repeated read-only calls can return
  a short reference instead of running again. During context reduction,
  sufficiently large identical result bodies can also be replaced with a
  reference to the first occurrence. Error results are excluded from this
  body-deduplication pass.
- **Large-output offloading:** eligible oversized text is saved to a
  session file. The prompt receives a short preview, the file path, output
  size and line count, and a content hash. The full saved text can be read when
  needed instead of occupying every subsequent request.
- **Per-tool and aggregate budgets:** limits account for tool type and the
  combined output of a batch. Structured results can offload large text
  parts while retaining image parts and the surrounding result structure.

Reduction has safeguards. Offloading replaces text only after the file is
saved and verified; otherwise the original text remains. Short error
messages stay in the prompt so the agent can act on them without another
read. File reads with their own output limits and loaded skill instructions
are exempt from offloading to avoid repeatedly saving and rereading the
same output.

Here, “compression” means less text in the active prompt, not a claim that
all results undergo lossless encoding or AI summarization. Tool-level output
limits may already have shortened a result; offloading preserves the text it
receives, not output omitted before it reaches this layer.

Implementation: [tool execution and reuse](../src/runtime/agent/orchestrator/session/tool-batch.mjs),
[body deduplication](../src/runtime/agent/orchestrator/session/context-utils.mjs),
[output persistence and budgets](../src/runtime/agent/orchestrator/session/tool-result-offload.mjs).

## Reading the results

These layers work together; their individual savings are not additive
percentages. Effects vary with the model, provider, task, enabled features,
and amount of repeated or retrieved content. The
[README benchmarks](../README.md#benchmarks) measure complete harness runs
at pinned revisions, not a separate speed or savings guarantee for each
mechanism described here.
