//! The exec flow (`runHeadlessExec`): validate, build the pristine boundary, start the core on it,
//! ask once, re-ask for completions that already arrived, shut down in order, report.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use serde_json::json;
use tokio::sync::OnceCell;
use tokio::sync::mpsc;

use super::ExecOptions;
use super::Route;
use super::Sink;
use super::boundary::Boundary;
use super::boundary::BoundaryRequest;
use super::boundary::Cleanup;
use super::boundary::HostCredentials;
use super::feed::FeedTap;
use super::feed::Obs;
use super::feed::TurnStatus;
use super::lifecycle::Clock;
use super::lifecycle::Lifecycle;
use super::lifecycle::ResultInfo;
use super::lifecycle::ThreadInfo;
use super::route::clean;
use super::route::validate_explicit_route;
use super::seams::CoreLauncher;
use super::seams::CoreSession;
use super::usage::SessionStats;
use super::usage::UsageDelta;
use super::usage::UsageSession;
use super::usage::usage_document;
use super::usage::write_usage_document;

/// The signal-driven shutdown gets this long (`installProcessSignalCleanup` in exec).
const SIGNAL_CLEANUP_BUDGET: Duration = Duration::from_secs(20);
/// A background completion carries one of these statuses (`meta.status`, lower-cased).
const TERMINAL_STATUSES: [&str; 5] = ["completed", "failed", "cancelled", "canceled", "timed_out"];

/// Everything outside the exec the flow depends on.
pub struct Host<'a> {
    pub launcher: &'a dyn CoreLauncher,
    pub credentials: &'a dyn HostCredentials,
    pub host_env: BTreeMap<String, String>,
    pub host_data_dir: PathBuf,
    pub temp_dir: PathBuf,
    pub sink: Arc<dyn Sink>,
    pub now: Clock,
}

/// Resolves with the exit code of a termination signal.
pub type Signal = Pin<Box<dyn Future<Output = i32> + Send>>;

/// The handles the shutdown reads at exit time.
struct Handles {
    boundary: Mutex<Option<Arc<Boundary>>>,
    session: Mutex<Option<Arc<dyn CoreSession>>>,
    shutdown: OnceCell<Result<(), String>>,
}

fn held<T: Clone>(slot: &Mutex<Option<T>>) -> Option<T> {
    slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
}

fn set<T>(slot: &Mutex<Option<T>>, value: T) {
    *slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(value);
}

/// What the run has accumulated.
struct RunState {
    stats: SessionStats,
    observed_models: Vec<String>,
    lifecycle: Option<Lifecycle>,
    completion_pending: bool,
    /// The session's id and model, once the session exists.
    session_id: String,
    session_model: String,
    usage_log: Option<PathBuf>,
}

impl RunState {
    fn write_usage(&self) -> std::io::Result<()> {
        let Some(path) = self.usage_log.as_ref().filter(|path| !clean(Some(&path.to_string_lossy())).is_empty()) else { return Ok(()) };
        let tool_calls = self.lifecycle.as_ref().map_or(0, Lifecycle::tool_call_count) as f64;
        let document = usage_document(
            &self.stats,
            &UsageSession { session_id: &self.session_id, model: &self.session_model, observed_models: &self.observed_models, tool_calls },
        );
        write_usage_document(path, &document)
    }
}

enum Step {
    Continue,
    End(TurnStatus, ResultInfo),
}

/// `recordUsage` (`headless-exec.mjs`): the observed model, the totals, and the usage document rewritten.
fn record_usage(state: &mut RunState, delta: &UsageDelta) {
    if let Some(model) = delta.model.as_deref().map(|model| clean(Some(model))).filter(|model| !model.is_empty()) {
        if !state.observed_models.iter().any(|seen| seen == model) {
            state.observed_models.push(model.to_owned());
        }
    }
    state.stats.apply(delta);
    // Telemetry must never break the run; the exit path reports.
    let _ = state.write_usage();
}

/// Folds one observation into the run. The usage snapshot is rewritten after every model
/// response, not only on the way out: a run killed mid-way never reaches the exit path and would
/// otherwise leave no document for spend that already happened.
fn apply(state: &mut RunState, last_text: &mut String, obs: Obs) -> Result<Step, String> {
    match obs {
        Obs::Usage(delta) => {
            record_usage(state, &delta);
            if let Some(lifecycle) = &mut state.lifecycle {
                lifecycle.on_usage_delta(&delta);
            }
        }
        // Native web search runs its own provider send; its spend joins the run's totals, and the lifecycle's model-request events stay untouched.
        Obs::SearchUsage(delta) => record_usage(state, &delta),
        Obs::ModelRequestStarted => {
            if let Some(lifecycle) = &mut state.lifecycle {
                lifecycle.on_provider_send_started();
            }
        }
        Obs::Reasoning(text) => {
            if let Some(lifecycle) = &mut state.lifecycle {
                lifecycle.on_reasoning_delta(&text);
            }
        }
        Obs::Assistant(text) => {
            if let Some(lifecycle) = &mut state.lifecycle {
                lifecycle.on_assistant_text(&text);
            }
            *last_text = text;
        }
        Obs::ToolObserved(call) => {
            if let Some(lifecycle) = &mut state.lifecycle {
                lifecycle.on_tool_observed(&call);
            }
        }
        Obs::ToolResult(result) => {
            if let Some(lifecycle) = &mut state.lifecycle {
                lifecycle.on_tool_result(&result);
            }
        }
        Obs::BatchStarted => {
            if let Some(lifecycle) = &mut state.lifecycle {
                lifecycle.on_tool_batch_started();
            }
        }
        Obs::BatchCompleted { iteration, calls, elapsed_ms } => {
            if let Some(lifecycle) = &mut state.lifecycle {
                lifecycle.on_tool_batch_completed(iteration, calls, elapsed_ms);
            }
        }
        Obs::Stage { stage, detail } => {
            if let Some(lifecycle) = &state.lifecycle {
                lifecycle.on_stage_change(&stage, detail.as_ref());
            }
        }
        Obs::Notification { content, meta } => {
            if let Some(lifecycle) = &state.lifecycle {
                lifecycle.on_notification(&content, &meta);
            }
            let status = meta.get("status").filter(|status| !status.is_null()).map(mixdog_js::value_to_string).unwrap_or_default();
            if TERMINAL_STATUSES.contains(&clean(Some(&status)).to_lowercase().as_str()) {
                state.completion_pending = true;
            }
        }
        Obs::TurnEnd { status, result } => return Ok(Step::End(status, result)),
        Obs::Malformed(reason) => return Err(reason),
    }
    Ok(Step::Continue)
}

/// One ask: a turn, answered by the thread's feed.
async fn ask(
    state: &mut RunState,
    session: &dyn CoreSession,
    feed: &mut mpsc::UnboundedReceiver<Obs>,
    thread_id: &str,
    prompt: &str,
) -> Result<(String, ResultInfo), String> {
    session.call("turn/start", json!({ "threadId": thread_id, "input": { "prompt": prompt } })).await?;
    let mut text = String::new();
    let (status, result) = loop {
        let obs = tokio::select! {
            obs = feed.recv() => obs.ok_or_else(|| "the event feed closed before the turn ended".to_owned())?,
            reason = session.lost() => return Err(reason),
        };
        if let Step::End(status, result) = apply(state, &mut text, obs)? {
            break (status, result);
        }
    };
    // Completions that already arrived count; nothing is waited for.
    while let Ok(obs) = feed.try_recv() {
        apply(state, &mut text, obs)?;
    }
    match status {
        TurnStatus::Completed => Ok((text, result)),
        TurnStatus::Failed(message) => Err(message),
        TurnStatus::Interrupted => Err("the turn was interrupted".into()),
    }
}

fn thread_start_params(opts: &ExecOptions, route: &Route) -> Value {
    let mut selection = json!({ "provider": route.provider, "model": route.model });
    if let Some(effort) = &route.effort {
        selection["effort"] = json!(effort);
    }
    if route.fast {
        selection["fast"] = json!(true);
    }
    let cwd = opts.cwd.to_string_lossy();
    json!({
        "kind": "task",
        "projectPath": cwd,
        "draft": { "projectPath": cwd, "route": selection, "workflowId": "headless", "orchestrationMode": "none" },
        "session": {
            "toolProfile": "headless",
            "toolMode": opts.tool_mode.as_str(),
            "approvalMode": "implicit",
            "disallowDelegation": true,
            "autoWakeCompletions": false,
            "webSearch": opts.web_search,
            "memory": false,
        },
    })
}

/// Pristine boundary, core, thread, then the asks.
async fn execute(
    state: &mut RunState,
    host: &Host<'_>,
    handles: &Handles,
    opts: &ExecOptions,
    prompt: &str,
    route: &Route,
) -> Result<(String, ResultInfo), String> {
    let boundary = Arc::new(Boundary::create(&BoundaryRequest {
        provider: &route.provider,
        model: &route.model,
        effort: route.effort.as_deref(),
        fast: route.fast,
        host_env: &host.host_env,
        host_data_dir: &host.host_data_dir,
        temp_dir: &host.temp_dir,
        credentials: host.credentials,
    })?);
    set(&handles.boundary, boundary.clone());
    let (tap, mut feed) = FeedTap::new();
    let session = host.launcher.launch(&boundary, tap).await?;
    set(&handles.session, session.clone());
    let started = session.call("thread/start", thread_start_params(opts, route)).await?;
    let thread_id = started
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or("thread/start answered without a thread id")?
        .to_owned();
    state.session_id = thread_id.clone();
    state.session_model = route.model.clone();
    if let Some(lifecycle) = &mut state.lifecycle {
        lifecycle.start(&ThreadInfo {
            id: thread_id.clone(),
            provider: route.provider.clone(),
            model: route.model.clone(),
            effort: route.effort.clone(),
            fast: route.fast,
            cwd: opts.cwd.to_string_lossy().into_owned(),
        });
    }
    // Exit never waits on running background work: a job the model left running on purpose has no
    // end. Completions that already arrived still get their follow-up turn.
    let mut answer = ask(state, session.as_ref(), &mut feed, &thread_id, prompt).await?;
    while state.completion_pending {
        state.completion_pending = false;
        answer = ask(state, session.as_ref(), &mut feed, &thread_id, "").await?;
    }
    Ok(answer)
}

/// The one-shot shutdown, run once whichever path reaches it first: close the session (in-flight
/// writes drained, ledger released), stop the services the run started, remove the root.
async fn shutdown(handles: &Handles, sink: &dyn Sink) -> Result<(), String> {
    handles
        .shutdown
        .get_or_init(|| async {
            let mut errors: Vec<String> = Vec::new();
            let mut services_failed = false;
            if let Some(session) = held(&handles.session) {
                if let Err(error) = session.close().await {
                    errors.push(error);
                }
                if let Err(error) = session.stop_services().await {
                    errors.push(error);
                    services_failed = true;
                }
            }
            if let Some(boundary) = held(&handles.boundary) {
                let how = if services_failed { Cleanup::PRESERVE } else { Cleanup::AFTER_ANSWER };
                match boundary.cleanup(how).await {
                    Ok(None) => {}
                    Ok(Some(error)) => sink.err(&format!("mixdog: shutdown cleanup failed (result unaffected): {error}\n")),
                    Err(error) => errors.push(error.to_string()),
                }
            }
            match errors.len() {
                0 => Ok(()),
                1 => Err(errors.remove(0)),
                _ => Err("headless shutdown failed".into()),
            }
        })
        .await
        .clone()
}

/// Runs the exec; the return value is the process exit code.
pub async fn run_exec(opts: ExecOptions, host: Host<'_>, signal: Signal) -> i32 {
    let sink = host.sink.clone();
    let prompt = clean(Some(&opts.message)).to_owned();
    if prompt.is_empty() {
        sink.err("mixdog: message is required\n");
        return 1;
    }
    if let Err(error) = validate_explicit_route(opts.provider.as_deref(), opts.model.as_deref(), opts.effort.as_deref()) {
        sink.err(&format!("mixdog: {error}\n"));
        return 1;
    }
    let route = Route {
        provider: clean(opts.provider.as_deref()).to_owned(),
        model: clean(opts.model.as_deref()).to_owned(),
        effort: Some(clean(opts.effort.as_deref()).to_lowercase()).filter(|effort| !effort.is_empty()),
        fast: opts.fast,
    };
    let lifecycle = opts.json.then(|| {
        Lifecycle::new(
            sink.clone(),
            host.now.clone(),
            format!("exec_{}", uuid::Uuid::new_v4().simple()),
            &route,
            &opts.cwd.to_string_lossy(),
            opts.tool_mode.as_str(),
            opts.web_search,
        )
    });
    let mut state = RunState {
        stats: SessionStats::default(),
        observed_models: Vec::new(),
        lifecycle,
        completion_pending: false,
        session_id: String::new(),
        session_model: String::new(),
        usage_log: opts.usage_log.clone(),
    };
    let handles = Handles { boundary: Mutex::new(None), session: Mutex::new(None), shutdown: OnceCell::new() };

    let finished = {
        let running = execute(&mut state, &host, &handles, &opts, &prompt, &route);
        tokio::select! {
            result = running => Some(result),
            code = signal => {
                if let Ok(Err(error)) = tokio::time::timeout(SIGNAL_CLEANUP_BUDGET, shutdown(&handles, sink.as_ref())).await {
                    sink.err(&format!("[mixdog-exec] cleanup failed: {error}\n"));
                }
                return code;
            }
        }
    };
    let (mut code, mut text, mut result, mut error) = (1, String::new(), ResultInfo::default(), None);
    match finished.expect("the signal branch returned") {
        Ok((answer, info)) => {
            if !opts.json && !answer.is_empty() {
                sink.out(&if answer.ends_with('\n') { answer.clone() } else { format!("{answer}\n") });
            }
            (code, text, result) = (0, answer, info);
        }
        Err(message) => {
            sink.err(&format!("mixdog: {message}\n"));
            error = Some(message);
        }
    }
    if let Err(failure) = state.write_usage() {
        sink.err(&format!("mixdog: usage log write failed: {failure}\n"));
    }
    if let Err(failure) = shutdown(&handles, sink.as_ref()).await {
        sink.err(&format!("mixdog: shutdown failed: {failure}\n"));
        error.get_or_insert(failure);
        code = 1;
    }
    if let Some(lifecycle) = &mut state.lifecycle {
        if code == 0 {
            lifecycle.succeed(&state.stats, &text, &result);
        } else {
            lifecycle.fail(&state.stats, error.as_deref().unwrap_or("execution failed"));
        }
    }
    code
}
