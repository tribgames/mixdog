//! Continuing a reaped tag's own saved session (Node `agent-tool/execute-resume.mjs`): the
//! prompt is appended to the stored transcript as one more turn, so the worker keeps its
//! context and a provider's prompt cache keeps its prefix. One instance is shared by `send`
//! and `spawn`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_tools::orch::agent::AgentReply;
use serde_json::Value;

use super::host::DispatchOptions;
use super::host::Environment;
use super::host::Prepared;
use super::host::Registry;
use super::host::SendFlow;
use super::scope::Caller;
use super::scope::TagRecord;
use super::scope::clean;
use super::scope::clean_str;
use super::scope::normalize_agent_name;
use super::scope::resolve_path;

/// `resolvePrompt`: `prompt`/`message` text, or the text of `file`.
pub async fn resolve_prompt(args: &Value, cwd: &str, env: &dyn Environment) -> Result<String, String> {
    let prompt_value = args.get("prompt").or_else(|| args.get("message"));
    if let Some(v) = prompt_value
        && !v.is_string()
    {
        return Err("agent: prompt/message must be a string".into());
    }
    let file_value = args.get("file");
    if let Some(v) = file_value
        && !v.is_string()
    {
        return Err("agent: file must be a string".into());
    }
    let prompt = prompt_value.and_then(Value::as_str).map(clean_str).unwrap_or_default();
    let file = file_value.and_then(Value::as_str).map(clean_str).unwrap_or_default();
    if !prompt.is_empty() && !file.is_empty() {
        return Err("agent: provide only one of prompt/message or file".into());
    }
    if !prompt.is_empty() {
        return Ok(prompt);
    }
    if !file.is_empty() {
        let base = if cwd.is_empty() { env.current_dir() } else { cwd.to_owned() };
        return env.read_text(&resolve_path(&base, &file)).await;
    }
    Err("agent: prompt/message/file is required".into())
}

/// What a resume asks of the caller and the registry.
pub struct ResumeRequest<'a> {
    /// `send` or `spawn`.
    pub operation: &'static str,
    pub args: &'a Value,
    pub caller_cwd: &'a str,
    pub caller: &'a Caller,
    pub notify: &'a Caller,
    /// The reap record the resume replaces.
    pub tombstone: Option<&'a TagRecord>,
    pub route: Option<Value>,
}

pub struct TagResume {
    registry: Arc<dyn Registry>,
    send_flow: Arc<dyn SendFlow>,
    env: Arc<dyn Environment>,
    default_cwd: String,
    /// Owner scope + tag -> a lock every decision on that tag passes through, in order.
    in_flight: Mutex<HashMap<String, Arc<tokio::sync::Semaphore>>>,
}

impl TagResume {
    pub fn new(registry: Arc<dyn Registry>, send_flow: Arc<dyn SendFlow>, env: Arc<dyn Environment>, default_cwd: String) -> Self {
        Self { registry, send_flow, env, default_cwd, in_flight: Mutex::new(HashMap::new()) }
    }

    pub fn default_cwd(&self) -> &str {
        &self.default_cwd
    }

    pub fn env(&self) -> &dyn Environment {
        self.env.as_ref()
    }

    /// Runs `run` after every earlier call for this owner's `tag` settled, so a competing send
    /// or spawn sees the tag the first one resumed (or respawned) instead of resuming it twice.
    pub async fn serialized<T, F: Future<Output = T>>(&self, tag: &str, caller: &Caller, run: F) -> T {
        let owner = match &caller.scope.caller_session_id {
            Some(id) if !id.is_empty() => id.clone(),
            _ => format!("pid:{}", caller.scope.host_pid.unwrap_or(0)),
        };
        let key = format!("{owner}\0{tag}");
        let lock = Arc::clone(
            self.in_flight
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .entry(key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(1))),
        );
        let result = {
            // A semaphore is never closed here, so the wait only ends with a permit.
            let _turn = lock.acquire().await;
            run.await
        };
        let mut map = self.in_flight.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // The map and this call hold it: nobody else is waiting on the tag.
        if map.get(&key).is_some_and(|held| Arc::strong_count(held) == 2) {
            map.remove(&key);
        }
        result
    }

    /// A request naming another agent or directory asks for different work than the saved
    /// session did; that gets a fresh session instead.
    fn request_fits(&self, session_agent: &str, session_cwd: &str, args: &Value, caller_cwd: &str) -> bool {
        let agent = clean(args.get("agent"));
        if !agent.is_empty() && normalize_agent_name(&agent) != normalize_agent_name(session_agent) {
            return false;
        }
        let cwd = clean(args.get("cwd"));
        if cwd.is_empty() {
            return true;
        }
        let base = if caller_cwd.is_empty() { self.default_cwd.as_str() } else { caller_cwd };
        let saved = clean_str(session_cwd);
        !saved.is_empty() && resolve_path(base, &cwd) == resolve_path("", &saved)
    }

    /// The saved working directory is gone: a fresh session may start only in a directory the
    /// caller names that exists, never in the missing one.
    async fn refuse_missing_cwd(
        &self,
        operation: &str,
        tag: &str,
        missing_cwd: Option<&str>,
        args: &Value,
        caller_cwd: &str,
    ) -> Result<(), String> {
        let cwd = clean(args.get("cwd"));
        let base = if caller_cwd.is_empty() { self.default_cwd.as_str() } else { caller_cwd };
        let named = if cwd.is_empty() { String::new() } else { resolve_path(base, &cwd) };
        if !named.is_empty() && self.env.is_directory(&named).await {
            return Ok(());
        }
        let gone = match missing_cwd.filter(|c| !c.is_empty()) {
            Some(c) => format!("\"{c}\""),
            None => "(unknown)".to_owned(),
        };
        let not_dir = if named.is_empty() { String::new() } else { format!(" and cwd \"{named}\" is not a directory") };
        Err(format!(
            "agent {operation}: tag \"{tag}\" cannot continue: its working directory {gone} no longer exists{not_dir}; pass an existing cwd to start a fresh session there"
        ))
    }

    /// Dispatches `args` onto `session_id` under `tag` and returns the result, or `None` when
    /// that session cannot be resumed for this caller (the caller then starts a fresh one).
    /// Errors when only its working directory is gone and the caller named no existing one.
    /// Call inside [`Self::serialized`] for this tag.
    pub async fn resume_tag(&self, tag: &str, session_id: &str, request: ResumeRequest<'_>) -> Result<Option<AgentReply>, String> {
        let Some(found) = self.registry.resumable_tag_session(tag, session_id, &request.caller.scope).await else {
            return Ok(None);
        };
        let Some(session) = found.session else {
            self.refuse_missing_cwd(request.operation, tag, found.missing_cwd.as_deref(), request.args, request.caller_cwd).await?;
            return Ok(None);
        };
        if !self.request_fits(&session.agent, &session.cwd, request.args, request.caller_cwd) {
            return Ok(None);
        }
        let prompt_cwd = if session.cwd.is_empty() { self.default_cwd.as_str() } else { session.cwd.as_str() };
        let prompt = resolve_prompt(request.args, prompt_cwd, self.env.as_ref()).await?;
        let mut args = request.args.clone();
        args["tag"] = Value::String(tag.to_owned());
        let prepared = Prepared { args, session_id: session.id.clone(), session, prompt: Some(prompt), route: request.route };
        self.send_flow.adopt_caller(&prepared, request.notify).await?;
        let result = self
            .send_flow
            .dispatch_to_existing_session(&prepared, request.notify, DispatchOptions { resumed: true, ..DispatchOptions::default() })
            .await?;
        // Only once the turn was admitted on the session: the tag resolves to it again (its row
        // is stamped fresh, so nothing ages it out before the turn writes its own), and the
        // reap record goes.
        self.registry.bind_tag(tag, &prepared.session, &self.env.now_iso());
        if let Some(tombstone) = request.tombstone {
            self.registry.consume_tag_tombstone(tombstone);
        }
        Ok(Some(result))
    }
}
