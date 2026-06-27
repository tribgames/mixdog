# Feature Map

Mixdog is currently best understood as a developer-preview coding-agent
workspace: it has a broad feature surface and a useful multi-provider structure,
but some areas still rely on smoke coverage and careful operator judgment rather
than polished product hardening.

## Core Experience

- CLI and full-screen TUI entry points from `mixdog`.
- Plain REPL mode for simple command-line interaction.
- Resumable sessions, context compaction, idle auto-clear, and transcript
  management.
- Slash-command control for models, providers, workflows, output styles, agents,
  tools, MCP, skills, plugins, hooks, channels, schedules, and webhooks.
- Statusline integration for current model, working directory, context, usage,
  and running agent tasks.

## Provider Runtime

- Provider registry with multi-provider routing across Anthropic, OpenAI,
  OpenAI-compatible endpoints, Google, XAI/Grok, OAuth routes, OpenCode Go, and
  local endpoints.
- Model and effort selection, Fast mode, provider usage dashboards, retry
  classification, and API/OAuth setup flows.
- Per-agent preset routing so workflow agents can run on different providers,
  models, efforts, and tool permissions.

## Repo Tools

- File and code navigation: `read`, `list`, `grep`, `glob`, `code_graph`.
- Mutation and verification: `apply_patch`, `shell`, `cwd`.
- Broad repo discovery: `explore`.
- Web and external research: `search`, `web_fetch`.
- Memory retrieval: `recall` and optional memory tools.
- Deferred tool loading through `tool_search` to keep the default surface small.

## Agent Workflow

- Lead stays responsible for user discussion, planning, final integration, git,
  builds, tests, and release decisions.
- Agent tasks are used for scoped implementation, research, review, debugging,
  maintenance, and heavier independent work.
- Default workflow agents include web research, maintenance, worker, heavy
  worker, reviewer, and debugger roles.
- Async agent tasks return a `task_id`; completion is delivered back to the owner
  session so Lead can continue independent work.

## Memory

- Runtime memory status, recall, maintenance cycles, embedding support, and
  optional PostgreSQL-backed maintenance paths.
- Core memory and recall are useful for session continuity, but memory quality
  depends on populated data and retrieval tuning.

## Channels And Automation

- Discord/channel integration, webhook handling, schedule status/control, and
  inbound event flows.
- Channel forwarding and runtime ownership are present, but these paths should
  be treated as advanced/operator features until deployment and auth flows are
  hardened for broader users.

## Product Readiness Notes

- Strong fit: developers who want to try one coding-agent shell across several
  providers, route different roles to different models, and inspect how the
  runtime behaves.
- Good early-user profile: technical users comfortable with CLI setup, provider
  credentials, smoke tests, and rough edges.
- Not yet ideal: non-technical users, teams that need strict enterprise admin
  controls, or workflows that require fully polished onboarding and exhaustive
  regression coverage.
- Main stabilization priorities: keep smoke tests green, clarify docs, reduce
  old terminology, strengthen channel/provider failure handling, and add more
  end-to-end coverage around agent tasks.
