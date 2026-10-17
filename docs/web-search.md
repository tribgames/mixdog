# Web search: current behavior and MCP proposal

This page records how `web_search` works today and proposes an optional
search path for models without provider-hosted search. The proposal is not
implemented; this change adds documentation only.

## Current behavior (source-verified)

`web_search` runs provider-hosted (native) search only. The request is sent
to the provider with that provider's search tool. No MCP tool loop is part of
this path.

- **Eligible providers.** [`WEB_SEARCH_PROVIDER_FAMILIES`](../src/runtime/agent/orchestrator/runtime-core/workflow.mjs)
  maps `openai` and `openai-oauth`, `xai` and `grok-oauth`, `gemini` and
  `antigravity-oauth`, and `anthropic` and `anthropic-oauth`. `command-code-oauth`
  and user-defined `custom-*` providers are not in the map.
- **Eligible models.** The [search catalog](../src/session-runtime/provider-models/web-search-catalog.mjs)
  lists models from enabled eligible providers whose catalog row sets
  `supportsWebSearch`.
- **Route candidates.** [`routes.mjs`](../src/session-runtime/native-web-search/routes.mjs)
  uses the configured search route. An unset route follows the main model and
  yields no candidate if that model is not search-capable. An explicit route
  yields no candidate if its provider is not eligible.
- **Execution.** [`native-web-search.mjs`](../src/session-runtime/native-web-search.mjs)
  returns content, citations, and search calls. With no candidate it throws a
  route error. A failing candidate is reported with its provider, model, and
  tool type.
- **Settings UI.** In [`WorkflowsView.tsx`](../apps/desktop/src/renderer/WorkflowsView.tsx),
  the Web Search route picker uses the search-capable list. Other agent routes
  use the general configured model list, so the restriction applies to the Web
  Search route, not to every built-in agent.
- **Direct MCP calls are separate.** An exposed MCP tool call uses the existing
  [policy and cancellation pipeline](../src/runtime/agent/orchestrator/session/loop/tool-exec.mjs),
  then the [MCP dispatcher](../src/runtime/agent/orchestrator/session/loop/tool-exec/dispatch.mjs)
  passes its session scope and abort signal to `executeMcpTool`. This is not an
  automatic fallback from `web_search`, nor proof that a particular model can
  complete a search-and-answer task.
- **MCP discovery does not require native search.** [Session creation](../src/session-runtime/session-create/materialize.mjs)
  adds connected, project-scoped MCP tools to the
  [tool catalog](../src/runtime/agent/orchestrator/runtime-core/tool-catalog.mjs)
  without a hosted-search capability check. Provider-specific tool exposure
  and normal session policy still apply. Tool-capable Command Code sessions
  can therefore use this existing route; it does not make them eligible for
  the native Web Search picker.

## External documented facts (not run against Mixdog)

Nothing below was executed against Mixdog. No paid or live gateway search was
run, and no model is claimed to pass.

### Command Code

- The CLI's [`web_search` and `web_fetch`](https://commandcode.ai/docs/reference/tools#web)
  are "client-executed through Command Code's own server routes", "not a
  provider-side feature", and every model gets web access. That statement covers
  the CLI tools.
- On the [Provider API](https://commandcode.ai/docs/provider#quickstart), the
  Responses endpoint forwards built-in declarations such as `web_search` for the
  upstream to accept or refuse. This is not an all-model guarantee. Remote
  `type: "mcp"` tools are rejected. With `x-cmd-zdr: 1`, only client-executed
  tool types are accepted, so hosted `web_search` is refused.
- Claude models answer only on `/v1/messages`. For other models, the
  `supported_endpoints` field in the models list shows the served routes.
- The endpoint table lists no standalone search endpoint.

### Brave Search MCP server

[`brave/brave-search-mcp-server`](https://github.com/brave/brave-search-mcp-server)
(package `@brave/brave-search-mcp-server`, MIT) is an official Brave project.

- Tool `brave_web_search`. Tool `brave_llm_context` returns search-grounded
  context, not an arbitrary URL fetch. Use the existing `web_fetch` when page
  text is needed.
- Requires `BRAVE_API_KEY`, or `BRAVE_API_KEY_FILE` as an alternative. Usage is
  governed by plan and account quotas. See the [plans](https://api-dashboard.search.brave.com/app/plans)
  and [rate limiting guide](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting).
  This document states no prices or query counts.
- STDIO is the default transport. The HTTP transport is unauthenticated and
  binds to `127.0.0.1` by default. An API key authenticates calls to Brave; it
  does not control access to the MCP server.

### DuckDuckGo MCP server (community)

[`nickclyde/duckduckgo-mcp-server`](https://github.com/nickclyde/duckduckgo-mcp-server)
(package `duckduckgo-mcp-server`, MIT) is a community project, not an official
DuckDuckGo product.

- Documented setup is `uvx duckduckgo-mcp-server`, with no API key. STDIO is the
  default transport.
- Tools are `search`, `fetch_content`, and `expand_link`. `fetch_content`
  refuses loopback, private, and link-local targets by default.
- The README says DuckDuckGo's HTML endpoint can block plain HTTP clients with
  HTTP 202 or 403. A 202 page can silently yield no results. The browser
  fallback needs the optional `[browser]` extra. Without it, the default `auto`
  search backend returns a message asking for the install.
- No availability or quota guarantee is documented. Its rate limits are local
  throttles, not service quotas.

## Proposal (not implemented)

Distinguish **native search** (provider-hosted, through the search route) from
**host-executed search** (an MCP tool that the host runs, with its output
returned to the model). General MCP execution already exists; this proposal
asks for clearer guidance and consideration of an explicit search-backend
choice, not a new MCP execution engine. A tool-capable model without native
search could use an exposed search MCP server that the user has explicitly
configured and allowed, independent of the native route.

Options for maintainers to consider:

1. **Explicit backend choice.** The user selects and enables a search MCP
   server, such as Brave or DuckDuckGo. Mixdog does not enable it for every
   Command Code model, and does not silently substitute a service when native
   search is unavailable.
2. **Existing MCP controls.** Scope, permissions, deny rules, cancellation, and
   error reporting apply unchanged. Service selection is explicit configuration,
   not a tool-name substring heuristic.
3. **Visible backend details.** The UI shows the backend, its plan and quota
   terms, auth requirements, and local dependencies such as `uvx` or Node.js.
   Secrets are entered through the existing UI and never written to committed
   config.
4. **Trust boundary.** Local stdio is not a sandbox and does not make search
   offline. Queries go to the search service, and returned page text goes to the
   model. Treat that content as untrusted input.
5. **No automatic fallback.** After a denial, auth error, or rate limit, the
   runtime reports the failure. It does not switch services or tiers.

Any unified search-backend option would need to reuse the existing scoped MCP
pipeline. Discovery, backend selection, result formatting, and the selected
model's tool loop still need integration design and validation; adding a
provider to the native-search allowlist alone would not implement this.

## Validation needed

Runtime behavior below is unverified. Nothing here has been run.

- Native search: unchanged for eligible providers and routes.
- A model without native search and with a configured search MCP server can
  call the tool, receive content with source URLs as citations, and read a
  cited page through the existing `web_fetch`.
- MCP server absent, denied, cancelled, or erroring: the call fails with an
  honest error, and no other service is used.
- Results return to the model through its provider's normal tool loop.
  Native-search models are not moved onto the MCP path.
- Isolation: enabling MCP search does not change the native route, the picker,
  or other agents' routes.
- No secrets appear in committed config, logs, or tool output.
- Real-service reliability, quota, and cost behavior: not measured.
