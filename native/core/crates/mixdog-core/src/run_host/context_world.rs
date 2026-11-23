//! The live world of `thread/contextStatus` (`ContextWorld` of `mixdog_core_session`): what Node's
//! `createContextStatus` reads through its injected getters (`getSession`, `getRoute`,
//! `getCurrentCwd`, `getMode`, `getNativeTools`), taken from the thread's own ports, and the
//! request tools `snapshotProviderRequestTools` makes of the session's tools.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::compact::pressure::ImageIdentities;
use mixdog_agent::compact::tool_schema::ToolAnnotations;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::tool::Freeform;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::support::failed;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_core_ports::ports::route::RouteSession;
use mixdog_core_ports::ports::route::has_session;
use mixdog_core_ports::ports::route::header_names_session;
use mixdog_core_ports::ports::route::is_summary_anchor;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_ports::ports::tools_status::SurfaceHost;
use mixdog_core_session::session::thread_context::ContextSnapshot;
use mixdog_core_session::session::thread_context::ContextWorld;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::session_cache_opts::is_agent_mode_session;
use super::tool_exposure::native_provider_family;
use super::tool_exposure::native_request_tools;
use super::tool_surface::parse_tool_selection;

const DOMAIN: &str = "thread context";

/// The meters of one thread on one provider: its `MediaLowering` (the one compaction meters with),
/// handed over as both the media meter and the image identities.
pub type LoweringFor = dyn Fn(&ThreadId, &str) -> (Arc<dyn MediaMeter>, Arc<dyn ImageIdentities>) + Send + Sync;

pub struct LiveContextWorld {
    pub threads: Arc<dyn ThreadState>,
    pub messages: Arc<dyn ThreadMessages>,
    pub routes: Arc<dyn LiveRoute>,
    pub session: Arc<dyn RouteSession>,
    pub host: Arc<dyn SurfaceHost>,
    pub lowering: Arc<LoweringFor>,
}

/// The rows of the transcript signature: each message's own stored row (`message_of` keeps it), as
/// the session's messages carry them in Node. A message no row was read for (the system prompt's blocks, built from
/// the header) is its fresh row, as Node's session holds its leading system messages.
pub(super) struct StoredBodies;

impl MessageRows for StoredBodies {
    fn row(&self, message: &mixdog_agent::message::AgentMessage) -> Value {
        message.stored.as_ref().map_or_else(|| super::message_row::row_of(message), |row| Value::Object(row.to_map()))
    }
}

fn text(map: &serde_json::Map<String, Value>, key: &str) -> String {
    map.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

/// A session tool document as the wire serialization reads it (`serializeToolSchemas`).
fn definition(doc: &Value) -> ToolDefinition {
    let schema = ["inputSchema", "input_schema", "parameters", "schema"].into_iter().find_map(|key| present(doc.get(key)));
    ToolDefinition {
        name: doc.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
        description: doc.get("description").and_then(Value::as_str).unwrap_or_default().to_owned(),
        input_schema: schema.cloned().unwrap_or(Value::Null),
        defer_loading: doc.get("deferLoading") == Some(&Value::Bool(true)) || doc.get("defer_loading") == Some(&Value::Bool(true)),
        freeform: Freeform::from_definition(doc),
    }
}

/// `messageToolReferences`: the tool names a message's native tool search referenced, when it ran
/// on this provider (or the other first-party Anthropic one).
fn message_tool_references(row: &Value, provider: &str) -> Vec<String> {
    native_references(row.get("nativeToolSearch"), provider)
}

/// `messageToolReferences` over a message's `nativeToolSearch` record.
pub(super) fn native_references(native: Option<&Value>, provider: &str) -> Vec<String> {
    let source = mixdog_js::js_trim(native.and_then(|n| n.get("provider")).and_then(Value::as_str).unwrap_or_default()).to_lowercase();
    let anthropic = |p: &str| matches!(p, "anthropic" | "anthropic-oauth");
    if !source.is_empty() && source != provider && !(anthropic(&source) && anthropic(provider)) {
        return Vec::new();
    }
    parse_tool_selection(native.and_then(|n| n.get("toolReferences")))
}

/// `snapshotProviderRequestTools` over the session's stored tools (no native tools ride a
/// conversation's request): `baseToolSnapshot` (object entries with a name, once each; Node listed `mcp__`
/// ones only while the connected list named them, which a live epoch here never does), then, for a native-deferred Anthropic-family session, the catalog tools
/// the session discovered (`deferredDiscoveredTools`, tool references in the transcript, and the
/// one anchor that keeps tool-search mode in the cached prefix), each marked `defer_loading`.
pub(super) fn request_definitions(header: &serde_json::Map<String, Value>, docs: &[Value], rows: &[Value], provider: &str) -> Vec<ToolDefinition> {
    let provider = mixdog_js::js_trim(provider).to_lowercase();
    let base = docs.iter().filter(|doc| doc.is_object()).map(definition).collect();
    let referenced = rows.iter().flat_map(|row| message_tool_references(row, &provider)).collect();
    snapshot_tools(header, base, referenced, &provider)
}

/// The same snapshot over tool definitions the caller already holds (`base`, in session order) and the tool names
/// the transcript's native tool searches referenced: the run's request takes it at every request boundary.
///
/// Nothing here is judged against the hub: an entry its owner withdrew (an MCP server publishing a catalog without it) stays in
/// the request, as a tool that is only unavailable (its server down, its scope moved) does, until a cold fold or an explicit
/// rebuild repairs the stored lists (`ToolSurface::repair`).
pub(super) fn snapshot_tools(
    header: &serde_json::Map<String, Value>,
    base: Vec<ToolDefinition>,
    referenced: Vec<String>,
    provider: &str,
) -> Vec<ToolDefinition> {
    let mut names = HashSet::new();
    let mut out: Vec<ToolDefinition> = base
        .into_iter()
        .filter(|tool| {
            let name = mixdog_js::js_trim(&tool.name).to_owned();
            !name.is_empty() && names.insert(name)
        })
        .collect();
    let provider = mixdog_js::js_trim(provider).to_lowercase();
    if out.is_empty()
        || header.get("deferredNativeTools") != Some(&Value::Bool(true))
        || native_provider_family(&provider, header.get("wireRoute")) != "anthropic"
    {
        return out;
    }
    let catalog_of = |key: &str| header.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let catalog = catalog_of("deferredToolCatalog");
    let mut discovered: HashSet<String> = parse_tool_selection(header.get("deferredDiscoveredTools")).into_iter().collect();
    discovered.extend(referenced);
    // `deferredModeAnchor`.
    let anchor = catalog.iter().find_map(|tool| {
        let name = mixdog_js::js_trim(tool.get("name").and_then(Value::as_str)?);
        (!name.is_empty() && !name.starts_with("mcp__") && !names.contains(name)).then(|| name.to_owned())
    });
    discovered.extend(anchor);
    if discovered.is_empty() {
        return out;
    }
    // The catalog by trimmed name: a later entry of the same name replaces the earlier one in place.
    let mut by_name: Vec<(String, Value)> = Vec::new();
    for tool in catalog.into_iter().chain(catalog_of("deferredLateToolCatalog")) {
        let Some(captured) = tool.get("name").and_then(Value::as_str) else { continue };
        let name = mixdog_js::js_trim(captured).to_owned();
        if name.is_empty() {
            continue;
        }
        match by_name.iter_mut().find(|(known, _)| *known == name) {
            Some(slot) => slot.1 = tool,
            None => by_name.push((name, tool)),
        }
    }
    for (name, tool) in by_name {
        if !tool.is_object() || !discovered.contains(&name) || names.contains(&name) {
            continue;
        }
        names.insert(name);
        let mut deferred = definition(&tool);
        deferred.defer_loading = true;
        out.push(deferred);
    }
    out
}
fn tool_annotations(docs: &[Value]) -> HashMap<String, ToolAnnotations> {
    docs.iter()
        .filter_map(|doc| {
            let name = doc.get("name").and_then(Value::as_str)?;
            let annotations = doc.get("annotations");
            Some((
                name.to_owned(),
                ToolAnnotations {
                    mixdog_kind: annotations.and_then(|a| a.get("mixdogKind")).and_then(Value::as_str).map(str::to_owned),
                    agent_hidden: annotations.and_then(|a| a.get("agentHidden")).is_some_and(|v| match v {
                        Value::Null | Value::Bool(false) => false,
                        Value::String(s) => !s.is_empty(),
                        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
                        _ => true,
                    }),
                },
            ))
        })
        .collect()
}

#[async_trait]
impl ContextWorld for LiveContextWorld {
    async fn snapshot(&self, thread: Option<&ThreadId>) -> Result<Option<ContextSnapshot>, CoreError> {
        // The daemon addresses every session by thread id; there is no ambient current session.
        let Some(thread) = thread else { return Ok(None) };
        let Ok(header) = self.threads.header(thread).await else { return Ok(None) };
        self.snapshot_for(thread, header).await
    }

    async fn snapshot_for(&self, thread: &ThreadId, header: serde_json::Map<String, Value>) -> Result<Option<ContextSnapshot>, CoreError> {
        self.snapshot_of(thread, header, false).await
    }

    async fn header_snapshot(&self, thread: &ThreadId) -> Result<Option<ContextSnapshot>, CoreError> {
        let Ok(header) = self.threads.header(thread).await else { return Ok(None) };
        self.snapshot_of(thread, header, true).await
    }

    fn lowering(&self, thread: &ThreadId, provider: &str) -> (Arc<dyn MediaMeter>, Arc<dyn ImageIdentities>) {
        (self.lowering)(thread, provider)
    }
}

impl LiveContextWorld {
    /// Until a model route has created the session, the status is the live route and the folder, nothing of the record.
    fn sessionless_snapshot(&self, thread: &ThreadId, route: &serde_json::Map<String, Value>, header: &serde_json::Map<String, Value>) -> ContextSnapshot {
        let provider = text(route, "provider");
        let (media, images) = (self.lowering)(thread, &provider);
        ContextSnapshot {
            header: Default::default(),
            model: text(route, "model"),
            context_window: route.get("contextWindow").cloned().unwrap_or(Value::Null),
            cwd: Value::String(text(header, "cwd")),
            mode: Value::String(self.host.mode(Some(header))),
            messages: Vec::new(),
            active: false,
            request_native: Vec::new(),
            request_defined: Vec::new(),
            session_defined: Vec::new(),
            agent_mode: false,
            annotations: HashMap::new(),
            media,
            images,
            rows: Arc::new(StoredBodies),
            replay_owner: ProviderId::from(provider.as_str()),
            provider,
        }
    }

    /// The snapshot of `thread` under `header`. `header_only`: the snapshot a session's open reads for its measurement and display
    /// figures ([`ContextWorld::header_snapshot`]), which equal the full snapshot's: the transcript is read only up to its newest
    /// row that makes a conversation (the whole of it when none does), its counts and media are not taken, and a case in
    /// which the transcript moves the figures otherwise reads it whole as the full snapshot does.
    async fn snapshot_of(&self, thread: &ThreadId, header: serde_json::Map<String, Value>, header_only: bool) -> Result<Option<ContextSnapshot>, CoreError> {
        let route = self.routes.route(thread);
        let live = self.session.live_turn_messages(thread).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?;
        // The transcript moves the header-only figures through one answer only, whether it holds a conversation, unless a turn
        // runs, the header names no session, or its deferred native tools take the tools the transcript referenced: then it is
        // read whole.
        let header_only = header_only && live.is_empty() && header_names_session(&header) && header.get("deferredNativeTools") != Some(&Value::Bool(true));
        let rows = if !live.is_empty() {
            live
        } else if header_only {
            // The newest rows up to the newest one that makes a conversation: `active` below answers as over the whole transcript.
            let session = self.session.clone();
            let conversation = move |message: &Value| session.has_user_conversation(std::slice::from_ref(message)) || is_summary_anchor(message);
            self.messages.messages_until(thread, &conversation).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?
        } else {
            self.messages.messages(thread).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?
        };
        if !has_session(&header, &rows) {
            return Ok(Some(self.sessionless_snapshot(thread, &route, &header)));
        }
        let active = self.session.has_user_conversation(&rows) || rows.iter().any(is_summary_anchor);
        // Header-only: the rows read are a tail, which the counts below must not take for the conversation.
        let rows = if header_only { Vec::new() } else { rows };
        // Node's `session.messages` lead with the system blocks the request is sent with; the turn builds its request from the
        // same header fields (`system_messages`), so the status counts that request, not the transcript alone.
        let messages = super::factory::session_messages(&header, &rows).map_err(|e| failed(DOMAIN, e))?;
        let provider = Some(text(&header, "provider")).filter(|p| !p.is_empty()).unwrap_or_else(|| text(&route, "provider"));
        let model = Some(text(&header, "model")).filter(|m| !m.is_empty()).unwrap_or_else(|| text(&route, "model"));
        let docs: Vec<Value> = header.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        let request_defined = request_definitions(&header, &docs, &rows, &provider);
        let annotations = tool_annotations(&docs);
        let (media, images) = (self.lowering)(thread, &provider);
        // The meter is synchronous: the facts of the stored media and the counts of every inline PDF (the page counts a read's
        // document block carries) are read into it first, as the compaction does (`Compactor::prepare`). A read that fails
        // leaves that part unpriced, as there.
        if !header_only {
            let _ = media.prepare(&messages).await;
        }
        let agent_mode = is_agent_mode_session(&header);
        let request_native = native_request_tools(&Value::Object(header.clone()));
        let replay_owner = ProviderId::from(provider.as_str());
        Ok(Some(ContextSnapshot {
            provider,
            model,
            context_window: route.get("contextWindow").cloned().unwrap_or(Value::Null),
            cwd: Value::String(text(&header, "cwd")),
            mode: Value::String(self.host.mode(Some(&header))),
            messages,
            active,
            request_native,
            request_defined,
            session_defined: docs.iter().map(definition).collect(),
            agent_mode,
            annotations,
            media,
            images,
            rows: Arc::new(StoredBodies),
            replay_owner,
            header,
        }))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::json;

    use super::*;

    /// The paths at which two answers differ, in document order.
    fn differences(got: &Value, want: &Value, path: &str, out: &mut Vec<String>) {
        match (got, want) {
            (Value::Object(g), Value::Object(w)) => {
                for key in g.keys().chain(w.keys().filter(|key| !g.contains_key(*key))) {
                    let at = format!("{path}.{key}");
                    match (g.get(key), w.get(key)) {
                        (Some(g), Some(w)) => differences(g, w, &at, out),
                        (Some(g), None) => out.push(format!("{at}: rust {g} node (absent)")),
                        (None, Some(w)) => out.push(format!("{at}: rust (absent) node {w}")),
                        (None, None) => unreachable!("a key of either object"),
                    }
                }
            }
            _ if got == want => {}
            _ => out.push(format!("{path}: rust {got} node {want}")),
        }
    }

    #[test]
    fn a_missing_key_differs_from_a_null_one() {
        let mut out = Vec::new();
        differences(&json!({}), &json!({ "k": null }), "$", &mut out);
        differences(&json!({ "k": null }), &json!({}), "$", &mut out);
        assert_eq!(out, ["$.k: rust (absent) node null", "$.k: rust null node (absent)"]);
    }
    /// One provider-visible definition: name, description, schema, loading flag.
    type Row = (String, String, Value, bool);
    /// The complete expected departed request: the recording with the approved inserts, each insert's whole payload taken from
    /// the stored definition (the step's tools, else its deferred catalog) and its loading flag from the delta.
    fn expected_departure(want: &[Row], inserts: &[(usize, &str, bool)], stored_in: &dyn Fn(&str) -> Value) -> Vec<Row> {
        let mut expected = want.to_vec();
        for (at, name, deferred) in inserts {
            let doc = stored_in(name);
            let row = (name.to_string(), doc["description"].as_str().expect("description").to_owned(), doc["inputSchema"].clone(), *deferred);
            expected.insert(*at, row);
        }
        expected
    }

    /// The departure check fails on a corrupted unchanged description or schema, a corrupted retained payload, a moved retained
    /// definition, a flipped loading flag and a dropped one: the whole sequence is compared, every field of every row.
    #[test]
    fn the_departure_check_rejects_a_moved_or_flipped_definition() {
        let row = |name: &str, description: &str, deferred: bool| {
            (name.to_owned(), description.to_owned(), json!({ "type": "object", "properties": { name: {} } }), deferred)
        };
        let want = vec![row("read", "r.", false), row("office", "o.", true)];
        let stored = |name: &str| json!({ "name": name, "description": "k.", "inputSchema": { "type": "object", "properties": { name: {} } } });
        let expected = expected_departure(&want, &[(1, "mcp__alpha__list", false)], &stored);
        assert_eq!(expected, [row("read", "r.", false), row("mcp__alpha__list", "k.", false), row("office", "o.", true)]);
        let mut corrupted = expected.clone();
        corrupted[0].1 = "changed.".into();
        assert_ne!(corrupted, expected, "an unchanged definition's description");
        let mut corrupted = expected.clone();
        corrupted[0].2 = json!({ "type": "object" });
        assert_ne!(corrupted, expected, "an unchanged definition's schema");
        let mut corrupted = expected.clone();
        corrupted[1].1 = "changed.".into();
        assert_ne!(corrupted, expected, "the retained payload");
        let mut corrupted = expected.clone();
        corrupted.swap(0, 1);
        assert_ne!(corrupted, expected, "a retained definition's position");
        let mut corrupted = expected.clone();
        corrupted[1].3 = true;
        assert_ne!(corrupted, expected, "a loading flag");
        assert_ne!(expected[..2], expected[..], "a dropped definition");
    }
    /// A stored MCP entry of `publisher` (none: stored before publishers were recorded) with `description` as its payload.
    fn entry(name: &str, publisher: Option<&str>, description: &str) -> Value {
        let doc = json!({ "name": name, "description": description, "inputSchema": { "type": "object", "properties": {} } });
        match publisher {
            Some(server) => mixdog_core_api::domain::tool::StoredTool::mcp(doc, server, Some("n")).encode(),
            None => doc,
        }
    }

    /// A tool its owner withdrew is not removed at a request boundary: the request is the session's stored definitions, a
    /// discovered deferred definition included, whoever still lists them. The definition leaves with the cold fold's repair or an
    /// explicit rebuild (`ToolSurface::repair`), so a warm prefix is never rewritten between two sends.
    #[test]
    fn the_request_boundary_sends_the_stored_definitions_whatever_their_owner_publishes() {
        let catalog = vec![entry("read", None, "r."), entry("mcp__alpha__gone", Some("alpha"), "g."), entry("mcp__beta__down", Some("beta"), "d.")];
        let header = json!({
            "provider": "anthropic", "deferredNativeTools": true, "deferredMcpToolNames": [],
            "deferredDiscoveredTools": ["mcp__alpha__gone", "mcp__beta__down"], "deferredToolCatalog": catalog,
        });
        let base = vec![definition(&entry("read", None, "r.")), definition(&entry("mcp__alpha__gone", Some("alpha"), "g."))];
        let sent: Vec<String> = super::super::assemble::boundary_tools(header.as_object().expect("header"), base, &[]).into_iter().map(|t| t.name).collect();
        assert_eq!(sent, ["read", "mcp__alpha__gone", "mcp__beta__down"], "nothing is judged against the hub here");
    }
}
