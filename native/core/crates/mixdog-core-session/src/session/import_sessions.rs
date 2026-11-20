//! The session layer's side of a conversation import (`imported-session.mjs`
//! `createImportedSession`, `apis.mjs` `createConversationImportApi`): an imported conversation
//! becomes an ordinary Lead session on the current Main route, its tools and prompt seeded as
//! `createSession` seeds them, its turns stored as plain user/assistant rows after the session
//! header, with `importOrigin` provenance in the header.
//!
//! A turn is stored through the same internal row append the room log uses
//! (`thread/roomRows/append`): rows of no turn, durable once the append answers.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::ProviderReadiness;
use mixdog_core_domains::domains::ai_admin::chain::RouteContext;
use mixdog_rt::CancellationToken;
use mixdog_services::import::ImportSessions;
use mixdog_services::import::ImportedSession;
use mixdog_store::schema::record::Header;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::sqlite::lead::LeadFilter;
use mixdog_store::sqlite::lead::decode_catalog_cursor;
use mixdog_store::sqlite::lead::encode_catalog_cursor;
use serde_json::Value;
use serde_json::json;

use super::Clock;
use super::SessionDirectory;
use super::heartbeat_host::hidden_session_header;
use super::room_log::RoomLog;
use super::room_log::SessionRoomLog;
use super::seams::TurnIngest;
use super::sub_agent_retention::activity_at;
use mixdog_core_api::ids::ThreadId;

/// `IMPORTED_MESSAGE_SOURCE` (`imported-message.mjs`).
const IMPORTED_MESSAGE_SOURCE: &str = "import";
/// `store-summary-reader.mjs` `MAX_PAGE_LIMIT`: the catalog is read a page at a time.
const CATALOG_PAGE: usize = 1000;

/// [`ImportSessions`] over the session directory and the catalog index.
pub struct DirectoryImportSessions {
    directory: Arc<SessionDirectory>,
    catalog: Arc<SqliteStore>,
    routes: Arc<dyn RouteContext>,
    clock: Arc<dyn Clock>,
    ingest: Arc<dyn TurnIngest>,
    providers: Arc<ProviderReadiness>,
}

impl DirectoryImportSessions {
    /// `routes`: the runtime's route context (`resolveRoute(config, {})`); `ingest`: the session
    /// search ingest a finished turn gets (`ingestSessionTurn`); `providers`: what
    /// `prepareLeadOptions` awaits after it reads the route.
    pub fn new(
        directory: Arc<SessionDirectory>,
        catalog: Arc<SqliteStore>,
        routes: Arc<dyn RouteContext>,
        clock: Arc<dyn Clock>,
        ingest: Arc<dyn TurnIngest>,
        providers: Arc<ProviderReadiness>,
    ) -> Self {
        Self { directory, catalog, routes, clock, ingest, providers }
    }
}

impl DirectoryImportSessions {
    /// `deleteSession(id)` of a session this import just made: nobody has it open, so the
    /// activity the guard compares is the header's own.
    async fn remove(&self, id: &ThreadId) {
        let Some(stored) = self.directory.stored_header(id).await else { return };
        let activity = activity_at(&stored);
        // Rust's own cleanup, with no Node counterpart (decisions.md D-import-cleanup-log-1): a failure to
        // delete is logged, not lost.
        if let Err(error) = self.directory.delete_stored(id.as_str(), activity, &[], &CancellationToken::new()).await {
            tracing::warn!(session = %id, "a half-imported session was not deleted: {error:?}");
        }
    }
}

/// `prepareLeadOptions` fails with `noModelRoute` when no provider and model resolve.
fn main_route(routes: &dyn RouteContext) -> Result<Value, String> {
    match routes.resolve_main() {
        Ok(route) if route.get("provider").is_some_and(truthy) && route.get("model").is_some_and(truthy) => Ok(Value::Object(route)),
        _ => Err("noModelRoute".to_owned()),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `importedSessionOptions(leadOptions, { cwd, desktopSession })` as the stored header: the Lead
/// header on `route`, minus what the importing runtime must not lend (its host pid), with the
/// session's project placement, the conversation title and the provenance.
fn imported_header(route: &Value, session: &ImportedSession, now_ms: i64) -> Header {
    let mut header = hidden_session_header(route, &json!({}), now_ms);
    // Ownership, live binding and placement the importing runtime must not lend are stored null.
    for key in ["clientHostPid", "parentSessionId", "ownerSessionId", "mcpScopeId", "visibility"] {
        header.insert(key.into(), Value::Null);
    }
    if let Some(project) = &session.project_path {
        header.insert("cwd".into(), json!(project));
        header.insert("desktopSession".into(), json!({ "classification": "project", "projectPath": project }));
    } else {
        header.insert("desktopSession".into(), json!({ "classification": "task", "projectPath": Value::Null }));
    }
    if let Some(title) = session.conversation.title.as_deref().filter(|title| !title.is_empty()) {
        header.insert("title".into(), json!(title));
    }
    header.insert("importOrigin".into(), serde_json::to_value(&session.origin).unwrap_or(Value::Null));
    header
}

/// `importedTranscriptMessages(turns, importedAt)`: plain transcript messages marked as imported prose.
fn imported_messages(session: &ImportedSession, new_message_id: impl Fn() -> String) -> Vec<Value> {
    session
        .conversation
        .turns
        .iter()
        .map(|turn| {
            let mut meta = json!({ "source": IMPORTED_MESSAGE_SOURCE });
            if !turn.tool_runs.is_empty() {
                meta["importedToolRuns"] = serde_json::to_value(&turn.tool_runs).unwrap_or(Value::Null);
            }
            let at = turn.at.filter(|at| *at != 0).unwrap_or(session.origin.imported_at);
            meta["transcript"] = json!({ "messageId": new_message_id(), "at": at });
            json!({ "role": turn.role, "content": turn.text, "meta": meta })
        })
        .collect()
}

#[async_trait]
impl ImportSessions for DirectoryImportSessions {
    async fn imported_sessions(&self) -> Vec<(String, String)> {
        let mut found = Vec::new();
        let mut after = None;
        loop {
            let Ok(page) = self.catalog.lead_page(after, LeadFilter::default(), CATALOG_PAGE).await else {
                return found;
            };
            for listed in &page.rows {
                let key = listed.row.get("importKey").and_then(Value::as_str);
                let id = listed.row.get("id").and_then(Value::as_str);
                if let (Some(key), Some(id)) = (key, id) {
                    found.push((key.to_owned(), id.to_owned()));
                }
            }
            match page.rows.last() {
                Some(last) if page.more => {
                    let cursor = encode_catalog_cursor(&last.row);
                    after = decode_catalog_cursor(Some(cursor.as_str())).ok().flatten();
                }
                _ => return found,
            }
        }
    }

    async fn session_exists(&self, id: &str) -> bool {
        self.directory.stored_header(&ThreadId::from(id)).await.is_some()
    }

    /// `prepareLeadOptions`: the route, then every configured provider ready; any failure is
    /// `noModelRoute` (`error?.code || 'noModelRoute'`). Node first awaits
    /// `awaitKeychainPrewarm()` (`provider-readiness.mjs`), which waits at most 5 s for
    /// `keychain-cjs.cjs` to warm its secret read cache and never fails: every platform's warm-up
    /// catches its own errors. The secret store here keeps no read cache and needs no warm-up
    /// (the registry reads each key from the store when it builds), so nothing is awaited.
    async fn prepare_lead(&self) -> Result<(), String> {
        main_route(self.routes.as_ref())?;
        self.providers.ensure_providers_ready(None).await.map(|_| ()).map_err(|_| "noModelRoute".to_owned())
    }

    async fn create_imported_session(&self, session: ImportedSession) -> Result<String, String> {
        let failed = || "importFailed".to_owned();
        let route = main_route(self.routes.as_ref())?;
        let header = imported_header(&route, &session, self.clock.now_ms());
        // The manager's `createSession` seeds the Lead's tools and prompt; `importedSessionOptions` dropped `mcpScopeId`,
        // so the seed opens no scope of its own.
        let id = self.directory.create_imported_session(header.clone(), json!({})).await.map_err(|_| failed())?;
        let messages = imported_messages(&session, || format!("msg_{}", uuid::Uuid::new_v4().simple()));
        if SessionRoomLog::new(self.directory.clone()).append_rows(id.as_str(), messages.clone()).await.is_err() {
            // The half-made record is removed (`deleteSession`); a refusal leaves it for the retention sweep.
            self.remove(&id).await;
            return Err(failed());
        }
        self.ingest.ingest_turn(&id, &header, messages);
        Ok(id.to_string())
    }
}

#[cfg(test)]
mod tests {
    use mixdog_services::import::Conversion;
    use mixdog_services::import::ImportOrigin;
    use mixdog_services::import::Source;

    use super::*;

    fn session(project: Option<&str>, title: Option<&str>) -> ImportedSession {
        let conversation = Conversion {
            source: Source::Claude,
            error_code: None,
            foreign_session_id: Some("f1".into()),
            cwd: None,
            internal_kind: None,
            history_base: None,
            turns: Vec::new(),
            title: title.map(str::to_owned),
            message_count: 0,
            warnings: Vec::new(),
        };
        let origin = ImportOrigin::new(Source::Claude, "/x/f1.jsonl".into(), Some("f1".into()), None, 7);
        ImportedSession { conversation, origin, project_path: project.map(str::to_owned) }
    }

    #[test]
    fn the_header_is_a_lead_session_with_provenance_and_no_host_pid() {
        let route = json!({ "provider": "p", "model": "m" });
        let header = imported_header(&route, &session(Some("C:/proj"), Some("Hello")), 100);
        assert_eq!(header["agent"], "lead");
        assert_eq!(header["sourceType"], "lead");
        assert_eq!(header["cwd"], "C:/proj");
        assert_eq!(header["desktopSession"], json!({ "classification": "project", "projectPath": "C:/proj" }));
        assert_eq!(header["title"], "Hello");
        assert_eq!(header["importOrigin"]["key"], "claude:f1");
        assert_eq!(header["importOrigin"]["importedAt"], 7);
        assert_eq!(header["clientHostPid"], Value::Null);
        let task = imported_header(&route, &session(None, None), 100);
        assert_eq!(task["desktopSession"], json!({ "classification": "task", "projectPath": Value::Null }));
        assert!(!task.contains_key("cwd") && !task.contains_key("title"));
    }
}
