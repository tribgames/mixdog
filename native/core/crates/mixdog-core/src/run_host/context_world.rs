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
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::support::failed;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_core_ports::ports::route::RouteSession;
use mixdog_core_ports::ports::route::is_summary_anchor;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_ports::ports::tools_status::SurfaceHost;
use mixdog_core_session::session::thread_context::ContextSnapshot;
use mixdog_core_session::session::thread_context::ContextWorld;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::message_row::message_of;
use super::session_cache_opts::is_agent_mode_session;
use super::tool_surface::parse_tool_selection;
use super::tool_exposure::native_provider_family;
use super::tool_exposure::native_request_tools;

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
/// the session's messages carry them in Node.
pub(super) struct StoredBodies;

impl MessageRows for StoredBodies {
    fn row(&self, message: &mixdog_agent::message::AgentMessage) -> Value {
        message.stored.as_ref().map_or(Value::Null, |row| Value::Object((**row).clone()))
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
    }
}

/// `isDeferredToolAvailable`: an `mcp__` tool only while the session's deferred MCP list (when it
/// has one) names it.
fn available(header: &serde_json::Map<String, Value>, name: &str) -> bool {
    !name.starts_with("mcp__") || header.get("deferredMcpToolNames").and_then(Value::as_array).is_none_or(|names| names.iter().any(|n| n.as_str() == Some(name)))
}

/// `messageToolReferences`: the tool names a message's native tool search referenced, when it ran
/// on this provider (or the other first-party Anthropic one).
fn message_tool_references(row: &Value, provider: &str) -> Vec<String> {
    let native = row.get("nativeToolSearch");
    let source = mixdog_js::js_trim(native.and_then(|n| n.get("provider")).and_then(Value::as_str).unwrap_or_default()).to_lowercase();
    let anthropic = |p: &str| matches!(p, "anthropic" | "anthropic-oauth");
    if !source.is_empty() && source != provider && !(anthropic(&source) && anthropic(provider)) {
        return Vec::new();
    }
    parse_tool_selection(native.and_then(|n| n.get("toolReferences")))
}

/// `snapshotProviderRequestTools` over the session's stored tools (no native tools ride a
/// conversation's request): `baseToolSnapshot` (object entries with a name, once each, `mcp__`
/// ones only while listed), then, for a native-deferred Anthropic-family session, the catalog tools
/// the session discovered (`deferredDiscoveredTools`, tool references in the transcript, and the
/// one anchor that keeps tool-search mode in the cached prefix), each marked `defer_loading`.
pub(super) fn request_definitions(header: &serde_json::Map<String, Value>, docs: &[Value], rows: &[Value], provider: &str) -> Vec<ToolDefinition> {
    let mut names = HashSet::new();
    let mut out: Vec<ToolDefinition> = docs
        .iter()
        .filter(|doc| doc.is_object())
        .filter_map(|doc| {
            let tool = definition(doc);
            let name = mixdog_js::js_trim(&tool.name).to_owned();
            (!name.is_empty() && available(header, &tool.name) && names.insert(name)).then_some(tool)
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
    for row in rows {
        discovered.extend(message_tool_references(row, &provider));
    }
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
        if !tool.is_object() || !discovered.contains(&name) || names.contains(&name) || !available(header, &name) {
            continue;
        }
        names.insert(name);
        let mut deferred = definition(&tool);
        deferred.defer_loading = true;
        out.push(deferred);
    }
    out
}
#[async_trait]
impl ContextWorld for LiveContextWorld {
    async fn snapshot(&self, thread: Option<&ThreadId>) -> Result<Option<ContextSnapshot>, CoreError> {
        // The daemon addresses every session by thread id; there is no ambient current session.
        let Some(thread) = thread else { return Ok(None) };
        let Ok(header) = self.threads.header(thread).await else { return Ok(None) };
        let route = self.routes.route(thread);
        let live = self.session.live_turn_messages(thread).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?;
        let rows = if live.is_empty() {
            self.messages.messages(thread).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?
        } else {
            live
        };
        let active = self.session.has_user_conversation(&rows) || rows.iter().any(is_summary_anchor);
        let messages = rows.iter().map(|row| message_of(row).map_err(|e| failed(DOMAIN, e))).collect::<Result<Vec<_>, _>>()?;
        let provider = Some(text(&header, "provider")).filter(|p| !p.is_empty()).unwrap_or_else(|| text(&route, "provider"));
        let model = Some(text(&header, "model")).filter(|m| !m.is_empty()).unwrap_or_else(|| text(&route, "model"));
        let docs: Vec<Value> = header.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        let request_defined = request_definitions(&header, &docs, &rows, &provider);
        let annotations: HashMap<String, ToolAnnotations> = docs
            .iter()
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
            .collect();
        let (media, images) = (self.lowering)(thread, &provider);
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
mod tests {
    use mixdog_agent::compact::estimate::PartMeter;
    use mixdog_core_api::domain::provider::ContentPart;
    use mixdog_core_ports::ports::threads::Section;
    use mixdog_core_session::session::thread_context::ContextStatusHost;
    use mixdog_core_session::session::thread_context::LiveContextStatus;
    use mixdog_store::schema::record::Header;
    use mixdog_tools::orch::status::StatusSurface;
    use mixdog_tools::orch::util::PortError;
    use serde_json::Map;
    use serde_json::json;

    use super::*;
    use mixdog_core_ports::ports::route::Route;

    struct TextOnly;
    impl MediaMeter for TextOnly {
        fn part(&self, part: &ContentPart) -> PartMeter {
            panic!("media part in a text-only golden: {part:?}")
        }
    }
    impl ImageIdentities for TextOnly {
        fn images(&self, _: &mixdog_agent::message::AgentMessage) -> Vec<mixdog_agent::compact::pressure::ImageDescriptor> {
            Vec::new()
        }
    }

    /// One golden case as a live session: the stored header, the committed rows, the live route.
    struct Live {
        case: Value,
    }

    #[async_trait]
    impl ThreadState for Live {
        async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
            if thread.as_str() != self.case["name"] {
                return Err(PortError::Denied("no such thread".into()));
            }
            let mut header = self.case["header"].as_object().cloned().ok_or_else(|| PortError::Denied("no session".into()))?;
            // The stored header carries the session's tool list and cwd (`tools`, `cwd`).
            header.insert("tools".into(), self.case["tools"].clone());
            header.insert("cwd".into(), self.case["cwd"].clone());
            Ok(header)
        }
        async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
            Ok(())
        }
        async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
            Ok(None)
        }
        async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
            Ok(())
        }
    }

    #[async_trait]
    impl ThreadMessages for Live {
        async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(self.case["messages"].as_array().cloned().unwrap_or_default())
        }
    }

    impl LiveRoute for Live {
        fn route(&self, _: &ThreadId) -> Route {
            json!({ "contextWindow": self.case["route"]["contextWindow"], "provider": self.case["route"]["provider"], "model": self.case["route"]["model"] })
                .as_object()
                .cloned()
                .expect("route")
        }
        fn adopt_held(&self, _: &ThreadId, _: &Route) {}
    }

    #[async_trait]
    impl RouteSession for Live {
        fn generation(&self, _: &ThreadId) -> u64 {
            0
        }
        async fn live_turn_messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(Vec::new())
        }
        fn has_user_conversation(&self, messages: &[Value]) -> bool {
            messages.iter().any(|m| m["role"] == "user" && !is_summary_anchor(m))
        }
        async fn update_route(&self, _: &ThreadId, _: Route, _: bool) -> Result<bool, PortError> {
            Ok(true)
        }
        async fn record_boundary(&self, _: &ThreadId, _: &str, _: Value) -> Result<bool, PortError> {
            Ok(true)
        }
        async fn rebuild_tool_surface(&self, _: &ThreadId, _: &str) -> Result<(), PortError> {
            Ok(())
        }
        async fn owner_fallbacks(&self, _: &ThreadId, _: &Header, _: &str, _: &str) -> Result<Option<Vec<Value>>, PortError> {
            Ok(None)
        }
        fn write_statusline(&self, _: &ThreadId, _: &Route) {}
        fn invalidate_context_status(&self, _: &ThreadId) {}
    }

    #[async_trait]
    impl SurfaceHost for Live {
        fn mode(&self, _: Option<&serde_json::Map<String, Value>>) -> String {
            self.case["mode"].as_str().expect("mode").to_owned()
        }
        async fn preview(&self) -> Result<StatusSurface, CoreError> {
            Ok(StatusSurface::default())
        }
        async fn reconcile_empty(&self, _: &ThreadId) -> Result<(), CoreError> {
            Ok(())
        }
    }

    fn world(case: &Value) -> LiveContextWorld {
        let live = Arc::new(Live { case: case.clone() });
        LiveContextWorld {
            threads: live.clone(),
            messages: live.clone(),
            routes: live.clone(),
            session: live.clone(),
            host: live,
            lowering: Arc::new(|_, _| (Arc::new(TextOnly), Arc::new(TextOnly))),
        }
    }

    /// A loaded session answers Node's `contextStatusForSession` record for every golden case
    /// (the transcript read from its stored rows, the request tools made of its stored tools);
    /// a thread that is not loaded answers `null`.
    #[tokio::test]
    async fn live_session_status_equals_nodes() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/context-status/golden.json")).expect("golden");
        let mut compared = 0;
        for case in golden["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("name");
            let host = LiveContextStatus::new(Arc::new(world(case)));
            let answer = host.context_status(Some(ThreadId::from(name.to_owned())), None).await.expect("status");
            assert_eq!(answer, case["status"], "{name}");
            compared += 1;
        }
        assert_eq!(compared, 15);
        let host = LiveContextStatus::new(Arc::new(world(&golden["cases"][1])));
        assert_eq!(host.context_status(Some(ThreadId::from("absent".to_owned())), None).await.expect("status"), Value::Null);
    }
}
