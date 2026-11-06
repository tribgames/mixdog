//! The real [`RouteExclusions`]: the tools a provider route left out of a session's requests
//! (Node `session/loop/provider-tool-exclusions.mjs`, kept in memory per session).
//!
//! Two kinds, as in Node: the ones the current request left out (`beginProviderToolExclusions`
//! empties them at each request; `recordProviderToolExclusion` adds), and the ones the provider
//! rejected with an HTTP 400 naming the schema, dropped for the session on the schema rule of the
//! wire family they were rejected on (`dropSessionTool`; a route on another family sends the tool
//! again). The user is told once per session and tool: recording returns the notice text the first
//! time and the caller shows it.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::surface::RouteExclusions;

/// A tool the provider left out: `{ name, pointer, reason }`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ExcludedTool {
    pub name: String,
    pub pointer: String,
    pub reason: String,
}

impl ExcludedTool {
    fn pointer(&self) -> &str {
        if self.pointer.is_empty() { "/" } else { &self.pointer }
    }

    /// `unavailableText`: what a call to the tool is answered with.
    pub fn unavailable_text(&self) -> String {
        format!(
            "tool \"{}\" is unavailable with the current model: the provider rejected its input schema at {} ({}), so it was left out of the request; no call was sent. Use another tool, or ask the user to fix the tool's schema or disable it.",
            self.name,
            self.pointer(),
            self.reason
        )
    }

    /// `excludedToolNoticeText`: the display-only notice.
    fn notice_text(&self) -> String {
        format!(
            "Tool \"{}\" was excluded from this session's requests: its input schema is invalid at {} ({}). Fix the tool's schema or disable the tool.",
            self.name,
            self.pointer(),
            self.reason
        )
    }
}

#[derive(Default)]
struct Session {
    /// Tools already told to the user.
    noticed: Vec<String>,
    /// What the latest request left out.
    current: Vec<ExcludedTool>,
    /// What the provider rejected, with the wire family it was rejected on.
    dropped: Vec<(ExcludedTool, &'static str)>,
}

#[derive(Default)]
pub struct SessionToolExclusions {
    sessions: Mutex<HashMap<ThreadId, Session>>,
}

impl SessionToolExclusions {
    pub fn new() -> Self {
        Self::default()
    }

    fn with<R>(&self, thread: &ThreadId, f: impl FnOnce(&mut Session) -> R) -> R {
        f(self.sessions.lock().unwrap_or_else(PoisonError::into_inner).entry(thread.clone()).or_default())
    }

    /// `beginProviderToolExclusions`: a new provider request; exclusions describe the latest one.
    pub fn begin_request(&self, thread: &ThreadId) {
        if let Some(session) = self.sessions.lock().unwrap_or_else(PoisonError::into_inner).get_mut(thread) {
            session.current.clear();
        }
    }

    /// `recordProviderToolExclusion`: the request left `tool` out. The notice to show the user,
    /// the first time the session sees this tool excluded.
    pub fn record(&self, thread: &ThreadId, tool: ExcludedTool) -> Option<String> {
        if tool.name.is_empty() {
            return None;
        }
        self.with(thread, |session| {
            let notice = (!session.noticed.contains(&tool.name)).then(|| {
                session.noticed.push(tool.name.clone());
                tool.notice_text()
            });
            match session.current.iter_mut().find(|t| t.name == tool.name) {
                Some(entry) => *entry = tool,
                None => session.current.push(tool),
            }
            notice
        })
    }

    /// `dropSessionTool`: the provider rejected `tool`'s schema; it stays out of the session's
    /// later requests on the wire family of `header`'s route. The notice, as for `record`.
    pub fn drop_tool(&self, thread: &ThreadId, header: &Header, tool: ExcludedTool) -> Option<String> {
        if tool.name.is_empty() {
            return None;
        }
        let family = route_schema_family(header);
        self.with(thread, |session| match session.dropped.iter_mut().find(|(t, _)| t.name == tool.name) {
            Some(entry) => *entry = (tool.clone(), family),
            None => session.dropped.push((tool.clone(), family)),
        });
        self.record(thread, tool)
    }
}

/// `String(value || '')`.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

/// `routeSchemaFamily`: the schema rule of the wire a session's requests use.
pub fn route_schema_family(header: &Header) -> &'static str {
    let provider = js_text(header.get("provider")).to_lowercase();
    let model = js_text(header.get("model")).to_lowercase();
    let wire = header.get("wireRoute").and_then(|route| route.get("wire")).and_then(Value::as_str);
    if provider == "antigravity-oauth" && model.starts_with("claude-") {
        "antigravity-claude"
    } else if provider == "gemini" || model.starts_with("gemini-") || model.contains("/gemini-") {
        "gemini"
    } else if matches!(provider.as_str(), "anthropic" | "anthropic-oauth") || wire == Some("messages") {
        "anthropic"
    } else {
        "openai"
    }
}

impl RouteExclusions for SessionToolExclusions {
    /// `providerToolExclusionReason` for every tool: the current request's, then the ones dropped
    /// on this route that the request did not name.
    fn excluded(&self, thread: &ThreadId, header: &Header) -> Vec<(String, String)> {
        let sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(session) = sessions.get(thread) else { return Vec::new() };
        let family = route_schema_family(header);
        let mut out: Vec<(String, String)> = session.current.iter().map(|t| (t.name.clone(), t.unavailable_text())).collect();
        for (tool, dropped_on) in &session.dropped {
            if *dropped_on == family && !out.iter().any(|(name, _)| name == &tool.name) {
                out.push((tool.name.clone(), tool.unavailable_text()));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn header(value: Value) -> Header {
        value.as_object().cloned().unwrap()
    }

    fn broken() -> ExcludedTool {
        ExcludedTool { name: "mcp__x__broken".into(), pointer: "/allOf".into(), reason: "unsupported root \"allOf\"".into() }
    }

    /// The strings and the once-per-session-and-tool notice are Node's (`recordProviderToolExclusion`,
    /// `providerToolExclusionReason`), run on the same exclusion.
    #[test]
    fn an_excluded_tool_is_noticed_once_and_refused_until_a_request_keeps_it() {
        let store = SessionToolExclusions::new();
        let (s1, s2) = (ThreadId::from("s1"), ThreadId::from("s2"));
        let route = header(json!({ "provider": "antigravity-oauth", "model": "claude-sonnet-4-6" }));
        assert!(store.excluded(&s1, &route).is_empty());
        let notice = store.record(&s1, broken()).expect("first notice");
        assert_eq!(
            notice,
            "Tool \"mcp__x__broken\" was excluded from this session's requests: its input schema is invalid at /allOf (unsupported root \"allOf\"). Fix the tool's schema or disable the tool."
        );
        assert_eq!(
            store.excluded(&s1, &route),
            [(
                "mcp__x__broken".to_owned(),
                "tool \"mcp__x__broken\" is unavailable with the current model: the provider rejected its input schema at /allOf (unsupported root \"allOf\"), so it was left out of the request; no call was sent. Use another tool, or ask the user to fix the tool's schema or disable it.".to_owned()
            )]
        );
        // The next request: reset, excluded again, no second notice; another session is told again.
        store.begin_request(&s1);
        assert!(store.excluded(&s1, &route).is_empty());
        assert_eq!(store.record(&s1, broken()), None);
        assert!(store.record(&s2, broken()).is_some());
        // A request that keeps the tool lifts the refusal.
        store.begin_request(&s1);
        assert!(store.excluded(&s1, &route).is_empty());
        // An empty pointer reads as the root.
        let root = ExcludedTool { pointer: String::new(), ..broken() };
        assert!(store.record(&ThreadId::from("s3"), root).unwrap().contains("invalid at / ("));
    }

    /// `dropSessionTool` / `droppedOnRoute`: a tool the provider rejected stays out on the wire
    /// family it was rejected on (`routeSchemaFamily`) and is sent again on another.
    #[test]
    fn a_dropped_tool_stays_out_on_its_wire_family_only() {
        let store = SessionToolExclusions::new();
        let thread = ThreadId::from("s1");
        let openai = header(json!({ "provider": "openai-oauth", "model": "gpt-5" }));
        assert!(store.drop_tool(&thread, &openai, broken()).is_some());
        store.begin_request(&thread);
        assert_eq!(store.excluded(&thread, &openai).len(), 1, "dropped for the session, not only the request");
        let families = [
            (json!({ "provider": "anthropic", "model": "claude-x" }), false),
            (json!({ "provider": "anthropic-oauth", "model": "claude-x" }), false),
            (json!({ "provider": "custom-gw", "model": "m", "wireRoute": { "wire": "messages" } }), false),
            (json!({ "provider": "gemini", "model": "gemini-3" }), false),
            (json!({ "provider": "antigravity-oauth", "model": "models/Gemini-3" }), false),
            (json!({ "provider": "antigravity-oauth", "model": "Claude-opus" }), false),
            (json!({ "provider": "custom-gw", "model": "m", "wireRoute": { "wire": "chat" } }), true),
            (json!({ "provider": "antigravity-oauth", "model": "gpt-oss" }), true),
            (json!({}), true),
        ];
        for (route, same_family) in families {
            assert_eq!(!store.excluded(&thread, &header(route.clone())).is_empty(), same_family, "{route}");
        }
        // The request's own exclusion wins over a dropped one of the same name, and a second drop
        // of the tool replaces the first (its family moves with it).
        let gemini = header(json!({ "provider": "gemini", "model": "gemini-3" }));
        store.drop_tool(&thread, &gemini, ExcludedTool { reason: "again".into(), ..broken() });
        store.begin_request(&thread);
        assert!(store.excluded(&thread, &openai).is_empty());
        assert_eq!(store.excluded(&thread, &gemini).len(), 1);
        assert!(store.excluded(&thread, &gemini)[0].1.contains("(again)"));
        assert_eq!(store.record(&thread, ExcludedTool { reason: "now".into(), ..broken() }), None);
        assert!(store.excluded(&thread, &gemini)[0].1.contains("(now)"));
    }
}
