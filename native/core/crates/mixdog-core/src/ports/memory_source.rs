//! `SessionSource` over the session runtime: the thread's model messages and cwd for the
//! current-session recall rows, its cwd, and the configured profile identity, as Node's
//! `createRecallResourceApi` reads them (`resource-recall-api.mjs`).
//!
//! The messages come from `thread/messages/read` (`{ messages: [...] }`), which the session
//! actor must serve; until it does the thread has no readable session and recall falls
//! through to memory, as it does for Node with no session.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_js::js_trim;
use mixdog_js::slice_utf16;
use mixdog_js::value_to_string;
use mixdog_services::memory::service::SessionData;
use mixdog_services::memory::service::SessionSource;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;
use serde_json::json;

use super::threads::SessionThreads;
use super::threads::ThreadState;

/// `PROFILE_TITLE_MAX` of `profile-config.cjs`.
const PROFILE_TITLE_MAX: usize = 64;

/// A thread's model messages (Node's `session.messages`).
#[async_trait]
pub trait ThreadMessages: Send + Sync {
    async fn messages(&self, thread: &ThreadId) -> Result<Vec<Value>, PortError>;
}

#[async_trait]
impl ThreadMessages for SessionThreads {
    async fn messages(&self, thread: &ThreadId) -> Result<Vec<Value>, PortError> {
        let value = self.call(thread, "thread/messages/read", json!({ "threadId": thread })).await?;
        Ok(value.get("messages").and_then(Value::as_array).cloned().unwrap_or_default())
    }
}

/// The live config document (`getConfig()`).
pub trait ConfigSource: Send + Sync {
    fn config(&self) -> Value;
}

pub struct SessionRecallSource {
    threads: Arc<dyn ThreadState>,
    messages: Arc<dyn ThreadMessages>,
    config: Arc<dyn ConfigSource>,
}

impl SessionRecallSource {
    pub fn new(threads: Arc<dyn ThreadState>, messages: Arc<dyn ThreadMessages>, config: Arc<dyn ConfigSource>) -> Self {
        Self { threads, messages, config }
    }
}

/// `String(raw.title ?? raw.name ?? '').trim().slice(0, 64)` of `normalizeProfileConfig`.
fn profile_title_of(profile: &Value) -> String {
    let Some(raw) = profile.as_object() else { return String::new() };
    let text = ["title", "name"]
        .iter()
        .find_map(|key| raw.get(*key).filter(|v| !v.is_null()))
        .map(value_to_string)
        .unwrap_or_default();
    js_trim(&slice_utf16(js_trim(&text), PROFILE_TITLE_MAX)).to_owned()
}

#[async_trait]
impl SessionSource for SessionRecallSource {
    async fn session(&self, thread_id: Option<&str>) -> Option<SessionData> {
        let thread = ThreadId::from(thread_id.filter(|id| !id.is_empty())?);
        self.threads.header(&thread).await.ok()?;
        let messages = self.messages.messages(&thread).await.ok()?;
        Some(SessionData { id: thread.as_str().to_owned(), messages })
    }

    /// `rt.currentCwd`: the thread's working directory.
    async fn current_cwd(&self, thread_id: Option<&str>) -> Option<String> {
        let thread = ThreadId::from(thread_id.filter(|id| !id.is_empty())?);
        let header = self.threads.header(&thread).await.ok()?;
        header.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()).map(str::to_owned)
    }

    async fn profile_title(&self) -> String {
        let config = self.config.config();
        let stored = config
            .get("profile")
            .filter(|v| !v.is_null())
            .or_else(|| config.pointer("/agent/profile"));
        stored.map(profile_title_of).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use mixdog_store::schema::record::Header;
    use crate::session::Section;
    use serde_json::Map;

    use super::*;

    struct Threads(Option<Header>);
    #[async_trait]
    impl ThreadState for Threads {
        async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
            self.0.clone().ok_or(PortError::NotFound { target: thread.as_str().into(), message: "gone".into() })
        }
        async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
            Ok(())
        }
        async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
            Ok(())
        }
    }
    struct Messages;
    #[async_trait]
    impl ThreadMessages for Messages {
        async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(vec![json!({"role": "user", "content": "hi"})])
        }
    }
    struct Config(Value);
    impl ConfigSource for Config {
        fn config(&self) -> Value {
            self.0.clone()
        }
    }

    fn source(header: Option<Value>, config: Value) -> SessionRecallSource {
        let header = header.map(|h| h.as_object().unwrap().clone());
        SessionRecallSource::new(Arc::new(Threads(header)), Arc::new(Messages), Arc::new(Config(config)))
    }

    #[tokio::test]
    async fn the_session_is_the_threads_messages_and_cwd() {
        let s = source(Some(json!({"cwd": "C:\\work"})), json!({}));
        let data = s.session(Some("t1")).await.unwrap();
        assert_eq!((data.id.as_str(), data.messages.len()), ("t1", 1));
        assert_eq!(s.current_cwd(Some("t1")).await.as_deref(), Some("C:\\work"));
        assert_eq!(s.current_cwd(None).await, None);
        assert!(s.session(None).await.is_none());
        assert!(source(None, json!({})).session(Some("t1")).await.is_none());
    }

    #[tokio::test]
    async fn the_profile_title_is_trimmed_capped_and_falls_back_to_name_and_agent_profile() {
        let long = format!("  {}  ", "x".repeat(80));
        assert_eq!(source(None, json!({"profile": {"title": long}})).profile_title().await.len(), 64);
        assert_eq!(source(None, json!({"profile": {"name": " Ann "}})).profile_title().await, "Ann");
        assert_eq!(source(None, json!({"agent": {"profile": {"title": "Bob"}}})).profile_title().await, "Bob");
        assert_eq!(source(None, json!({"profile": "oops"})).profile_title().await, "");
        assert_eq!(source(None, json!({})).profile_title().await, "");
    }
}
