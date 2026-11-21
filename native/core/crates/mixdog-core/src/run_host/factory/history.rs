//! The stored history a turn starts from and reloads, and the rows' conversions to messages.

use super::*;

// ---- the turn ----------------------------------------------------------------------------------------

/// A message of the turn's context as the turn keeps it: its stored row, which the message shares, or the message itself
/// when it has none.
pub(super) enum HistoryRow {
    Stored(Arc<serde_json::Map<String, Value>>),
    Message(Box<AgentMessage>),
}

impl HistoryRow {
    /// The message: the row read back as it was read when the turn began (the same row, the same codec).
    pub(super) fn message(&self) -> AgentMessage {
        match self {
            HistoryRow::Stored(stored) => mixdog_agent::message_row::message_of_stored(stored).expect("a row the turn read once reads again"),
            HistoryRow::Message(message) => (**message).clone(),
        }
    }
}

/// Responses projects from stamped rows, not from the current request option
/// alone. The current row must supersede an earlier turn even at saved effort.
pub(super) fn stamp_outgoing_effort(row: &mut Value, config: &RunConfig) {
    if let Some(seed) = config.effort.as_ref().and_then(|wiring| wiring.route.seed.as_ref())
        && let Some(row) = row.as_object_mut()
        && let Some(meta) = row.entry("meta").or_insert_with(|| json!({})).as_object_mut()
    {
        meta.insert("effortConfiguration".into(), seed.to_value());
    }
}

/// `promptContentText(input.prompt).trim()`: a string, or the text parts joined by a newline.
pub(super) fn prompt_text(body: &Value) -> String {
    match body.get("content") {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Array(parts)) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n").trim().to_owned(),
        _ => String::new(),
    }
}

/// The run's [`McpCatalog`]: the parts' refresh for this thread. A refresh that fails is logged; like Node's
/// (`catch` around the reconcile in `foldMcpSurface`), it never breaks the turn.
pub(super) struct ThreadMcp {
    pub(super) parts: Arc<dyn RunParts>,
    pub(super) thread: ThreadId,
    pub(super) surface: tokio::sync::watch::Receiver<Arc<SessionSurface>>,
}

/// The native tool-search records of a transcript, which the request boundary's tool snapshot reads its references from.
pub(crate) fn native_searches(messages: &[AgentMessage]) -> Vec<Value> {
    messages.iter().filter_map(|m| m.message.native_tool_search.clone()).collect()
}

/// `session.messages`: the system blocks the session's requests lead with, then its stored conversation rows.
pub(crate) fn session_messages(header: &mixdog_store::schema::record::Header, rows: &[Value]) -> Result<Vec<AgentMessage>, String> {
    let mut messages = system_messages(header);
    let mut leading = true;
    for row in rows {
        let message = super::super::message_row::message_of(row)?;
        if leading && is_stale_system_row(&message) {
            continue;
        }
        leading = false;
        messages.push(message);
    }
    Ok(messages)
}

/// A system row an earlier build stored at the head of the context: the header's prompt is the request's system set, so the
/// stored copy is dropped on load and the next rewrite does not change what the request leads with.
pub(super) fn is_stale_system_row(message: &AgentMessage) -> bool {
    message.role() == Role::System
}

/// The request's system messages: the header's prompt fields, in Node's order and tiers (WP-PROMPT).
pub(crate) fn system_messages(header: &mixdog_store::schema::record::Header) -> Vec<AgentMessage> {
    mixdog_core_prompt::prompt::blocks::request_system_messages(header)
        .into_iter()
        .map(|wire| {
            let mut message = AgentMessage::user_content(Content::Text(String::new()));
            message.message = wire;
            message
        })
        .collect()
}

#[async_trait]
impl mixdog_agent::env::McpCatalog for ThreadMcp {
    async fn refresh(&self) {
        if let Err(error) = self.parts.refresh_mcp(&self.thread).await {
            tracing::warn!("[mcp] catalog refresh failed: {error:?}");
        }
    }

    async fn tools(&self) -> Result<Option<ToolSet>, String> {
        let surface = self.surface.borrow().clone();
        self.parts.request_tools(&self.thread, &surface).await.map_err(|error| error.message)
    }

    async fn snapshot(
        &self,
        tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
        messages: &[AgentMessage],
    ) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, String> {
        self.parts.request_snapshot(&self.thread, tools, native_searches(messages)).await.map_err(|error| error.message)
    }

    async fn migrate(&self, messages: &[AgentMessage]) -> Result<Option<Vec<AgentMessage>>, String> {
        let rows = messages.iter().map(super::super::message_row::row_of).collect();
        self.parts.migrate_exposure(&self.thread, rows).await.map_err(|error| error.message)
    }
}

/// The session's history read back from its store for a run whose transcript a rewrite it did not make retired: once every
/// row the run queued has landed, the stored rows as the turn's start reads them (each registered with the run's sink, so a
/// later rewrite names its item), with the generation of the history they are.
pub(super) struct ReloadedHistory {
    pub(super) sink: Arc<PortSink>,
    pub(super) context: mixdog_core_session::session::run::ModelContext,
    /// The run's gate: its session's book is open, and its generation is the history's.
    pub(super) gate: mixdog_core_api::domain::cache_tail::TailGateHandle,
}

#[async_trait]
impl mixdog_agent::env::StoredHistory for ReloadedHistory {
    async fn reload(&self) -> Result<(Vec<AgentMessage>, u64), String> {
        TranscriptSink::drafted(&*self.sink).await;
        let generation = self.gate.0.generation();
        let stored = self.context.read().await.map_err(|error| format!("model context unreadable: {error:?}"))?;
        let mut messages = Vec::new();
        for (iid, body) in stored {
            let message = mixdog_agent::message_row::message_of_owned(body)
                .map_err(|(error, _)| format!("the model context holds a row this build cannot read: {error}"))?;
            if messages.is_empty() && is_stale_system_row(&message) {
                continue;
            }
            if let Some(id) = &message.message_id {
                lock(&self.sink.iids).insert(id.clone(), iid);
            }
            self.sink.rows.record_stored(&message);
            messages.push(message);
        }
        Ok((messages, generation))
    }
}
