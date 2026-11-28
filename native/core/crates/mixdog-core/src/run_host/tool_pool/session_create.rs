use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::flow::handoff::handoff_content;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::delegation::bot_chain_of;
use mixdog_core_session::session::heartbeat_host::hidden_session_header;
use mixdog_core_session::session::heartbeat_host::model_route_fields;
use mixdog_services::task_reports::send::Origin;
use mixdog_services::task_reports::send::Submission;
use mixdog_tools::orch::session::ControlCall;
use mixdog_tools::orch::session::ProjectRow;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::session_send::SessionSend;
use super::session_send::check_effort;

/// `TITLE_LIMIT` of a task session's title.
const TITLE_LIMIT: usize = 60;
/// `LAST_USED_ROUTE_MAX_PAGES`: the last-used model search stops after this many catalog pages.
const LAST_USED_ROUTE_MAX_PAGES: usize = 20;
/// Choices an error names: a short list, never the whole catalog (`CHOICE_LIMIT`).
const CHOICE_LIMIT: usize = 6;

pub use mixdog_app_protocol::boundary::validate::worktree_name::worktree_name_error;

/// A failure of the session service as Node's error carries it: its `code`, `message` and
/// `details`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CreateFailure {
    pub code: Option<String>,
    pub message: String,
    pub details: Option<Value>,
}

impl CreateFailure {
    fn plain(message: impl Into<String>) -> Self {
        Self { message: message.into(), ..Self::default() }
    }

    fn coded(code: &str, message: impl Into<String>) -> Self {
        Self { code: Some(code.to_owned()), message: message.into(), details: None }
    }
}

/// What create needs of the process besides the send path.
#[async_trait]
pub trait CreateHost: Send + Sync {
    /// `listProjects()`: the registered Projects.
    async fn projects(&self) -> Vec<ProjectRow>;
    /// `statSync(path).isDirectory()` then `realpathSync(path)`: the directory's real path, or
    /// `None` when `path` is no directory.
    async fn directory(&self, path: &str) -> Option<String>;
    /// `loadConfig().worktree?.newTaskDefault`.
    async fn new_task_default(&self) -> Option<String>;
    /// `loadConfig().presets`.
    async fn presets(&self) -> Vec<Value>;
    /// `migrateCodexRoute(route)`: a route on a model the saved openai-oauth catalog has
    /// superseded moved to its successor, any other route as it is.
    async fn codex_route(&self, route: Value) -> Value;
    /// `configLeadRoute()`: the Main route's fields, `None` while none is chosen.
    async fn lead_route(&self) -> Result<Option<Value>, String>;
    /// `listSessionCatalog({ page: { limit, cursor } })`: a page of catalog rows and the next cursor.
    async fn catalog_page(&self, limit: usize, cursor: Option<String>) -> Result<(Vec<Value>, Option<String>), String>;
    /// `createSession(params)`: the new session's id.
    async fn create_session(&self, params: Value) -> Result<String, String>;
    /// `configureSession({ sessionId, action: 'requestWorktree', args: [input] })`: its value.
    async fn request_worktree(&self, session_id: &str, input: Value) -> Result<Value, CreateFailure>;
    /// `configureSession({ sessionId, action: 'deleteSession', args: [sessionId] })`: its value.
    async fn delete_session(&self, session_id: &str) -> Result<Value, String>;
}

/// `clean(value)`: `String(value ?? '').trim()`.
fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::js_trim(&mixdog_js::value_to_string(value)).to_owned(),
    }
}

/// Where create's `worktree` option starts the task session (`taskLocation`).
#[derive(Clone, Debug, PartialEq)]
enum Location {
    Default,
    Branch,
    Worktree(Option<String>),
}

fn task_location(option: Option<&Value>) -> Result<Location, String> {
    let Some(option) = option.filter(|o| !o.is_null()) else {
        return Ok(Location::Default);
    };
    let mode = option.as_object().and_then(|o| o.get("mode")).and_then(Value::as_str);
    if !matches!(mode, Some("branch" | "worktree")) {
        return Err("session: worktree.mode must be \"branch\" or \"worktree\"".into());
    }
    let Some(name) = option.get("name") else {
        return Ok(if mode == Some("branch") { Location::Branch } else { Location::Worktree(None) });
    };
    if mode != Some("worktree") {
        return Err("session: worktree.name applies only to mode \"worktree\"".into());
    }
    if let Some(reason) = worktree_name_error(name) {
        return Err(format!("session: worktree.name is invalid: {reason}"));
    }
    Ok(Location::Worktree(name.as_str().map(str::to_owned)))
}

/// `megabytes(bytes)`.
fn megabytes(bytes: f64) -> String {
    format!("{} MB", mixdog_js::number_to_string((bytes / (1024.0 * 1024.0) + 0.5).floor()))
}

/// `taskWorktreeFailure(error)`: a typed worktree failure as the model should read it.
fn task_worktree_failure(error: &CreateFailure) -> String {
    let details = error.details.as_ref();
    let number = |key: &str| details.and_then(|d| d.get(key)).and_then(Value::as_f64).filter(|n| n.is_finite());
    let size = match (error.code.as_deref(), number("estimateBytes")) {
        (Some("WORKTREE_LARGE_REPO_CONFIRM"), Some(estimate)) => format!(
            " The repository is about {} (warning threshold {}). Ask the user whether to create the worktree anyway; only if they confirm, call create again with confirm_large: true.",
            megabytes(estimate),
            number("thresholdBytes").map_or_else(|| "NaN MB".to_owned(), megabytes)
        ),
        _ => String::new(),
    };
    format!("session: {}: {}{size}", error.code.as_deref().unwrap_or_default(), error.message)
}

/// `pathKey`: case-insensitive on Windows, trailing separators dropped.
fn path_key(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = path.trim_end_matches('/');
    if cfg!(windows) { path.to_lowercase() } else { path.to_owned() }
}

/// Where a task session starts (`resolveTaskProject`).
struct Where {
    cwd: String,
    desktop_session: Value,
    /// The Project's path.
    project: Option<String>,
}

/// `routeByDisplayName`'s and `withEffort`'s view of a catalog row.
fn row_id(row: &Value) -> String {
    let id = clean(row.get("id"));
    if id.is_empty() { clean(row.get("model")) } else { id }
}

fn choices(rows: &[&Value]) -> String {
    let label = |row: &&Value| {
        let display = clean(row.get("display"));
        let id = row_id(row);
        format!(
            "{} ({}/{id})",
            if display.is_empty() { id.clone() } else { display },
            row.get("provider").map(mixdog_js::value_to_string).unwrap_or_else(|| "undefined".into())
        )
    };
    let shown = rows.iter().take(CHOICE_LIMIT).map(label).collect::<Vec<_>>().join("; ");
    if rows.len() > CHOICE_LIMIT { format!("{shown}; … ({} total)", rows.len()) } else { shown }
}

/// `withEffort(route, value, rows)`: the route with the effort level `value` ("auto" clears it);
/// a chosen level turns Auto effort off.
fn with_effort(mut route: Map<String, Value>, value: &Value, rows: &[Value]) -> Result<Map<String, Value>, String> {
    let level = check_effort(value, &clean(route.get("provider")), &clean(route.get("model")), rows)?;
    route.shift_remove("effort");
    if let Some(level) = level {
        route.insert("effort".into(), json!(level));
    }
    if let Some(mode) = mixdog_ai::effort::EffortAuto::implied_by_effort(Some(value)) {
        mode.write_to(&mut route);
    }
    Ok(route)
}

/// `routeByDisplayName(text, rows, explicitEffort)`: the route of a catalog display name, a
/// trailing effort word read as the effort only when the whole text names no model.
fn route_by_display_name(text: &str, rows: &[Value], explicit_effort: bool) -> Result<Map<String, Value>, String> {
    let lower = |v: Option<&Value>| clean(v).to_lowercase();
    let wanted = mixdog_js::js_trim(text).to_lowercase();
    let cut = wanted.rfind(' ').filter(|cut| *cut > 0);
    let word = cut.map_or("", |cut| &wanted[cut + 1..]);
    let is_word = word == "auto" || mixdog_ai::effort::normalize_effort_input(Some(&json!(word))).ok().flatten().is_some();
    let suffix = is_word.then_some(word);
    let mut hits: Vec<&Value> = rows.iter().filter(|row| lower(row.get("display")) == wanted).collect();
    let mut effort = None;
    if hits.is_empty()
        && let (Some(suffix), Some(cut)) = (suffix, cut)
    {
        let base = mixdog_js::js_trim(&wanted[..cut]).to_owned();
        hits = rows.iter().filter(|row| lower(row.get("display")) == base).collect();
        effort = Some(suffix);
    }
    if hits.is_empty() {
        let words: Vec<&str> = wanted.split(mixdog_js::is_js_space).filter(|w| !w.is_empty()).collect();
        let near: Vec<&Value> = rows.iter().filter(|row| words.iter().all(|w| lower(row.get("display")).contains(w))).collect();
        let all: Vec<&Value> = rows.iter().collect();
        return Err(format!(
            "session: model \"{}\" is neither a provider/model route, a preset name nor a model display name. Choices: {}{}",
            mixdog_js::js_trim(text),
            choices(if near.is_empty() { &all } else { &near }),
            if suffix.is_some() { ". To set the reasoning effort, pass it as the effort field" } else { "" }
        ));
    }
    let mut distinct: Vec<&Value> = Vec::new();
    for row in hits {
        let key = |r: &Value| format!("{}/{}", r.get("provider").map(mixdog_js::value_to_string).unwrap_or_default(), row_id(r));
        match distinct.iter().position(|seen| key(seen) == key(row)) {
            Some(at) => distinct[at] = row,
            None => distinct.push(row),
        }
    }
    if distinct.len() > 1 {
        return Err(format!("session: model \"{}\" is ambiguous; use provider/model: {}", mixdog_js::js_trim(text), choices(&distinct)));
    }
    let route = Map::from_iter([
        ("provider".to_owned(), distinct[0].get("provider").cloned().unwrap_or(Value::Null)),
        ("model".to_owned(), json!(row_id(distinct[0]))),
    ]);
    match effort {
        Some(effort) if !explicit_effort => with_effort(route, &json!(effort), rows),
        _ => Ok(route),
    }
}

/// `parseScheduleModelRef(ref)`: a direct route object of a `provider/model[@effort][+fast][+noauto][?k=v]`
/// ref, else the ref itself (a preset id or name).
pub fn parse_schedule_model_ref(raw: &str) -> Result<Map<String, Value>, String> {
    let (route_ref, query) = raw.split_once('?').unwrap_or((raw, ""));
    let Some(slash) = route_ref.find('/').filter(|slash| *slash > 0) else {
        return Err(raw.to_owned());
    };
    let mut rest = &route_ref[slash + 1..];
    let no_auto = match rest.strip_suffix("+noauto") {
        Some(stripped) => {
            rest = stripped;
            true
        }
        None => false,
    };
    let fast = match rest.strip_suffix("+fast") {
        Some(stripped) => {
            rest = stripped;
            true
        }
        None => false,
    };
    let mut effort = "";
    if let Some(at) = rest.rfind('@').filter(|at| *at > 0) {
        effort = &rest[at + 1..];
        rest = &rest[..at];
    }
    let mut route = Map::new();
    route.insert("provider".into(), json!(&route_ref[..slash]));
    route.insert("model".into(), json!(rest));
    if !effort.is_empty() {
        route.insert("effort".into(), json!(effort));
    }
    if fast {
        route.insert("fast".into(), json!(true));
    }
    if no_auto {
        mixdog_ai::effort::EffortAuto::Manual.write_to(&mut route);
    }
    if !query.is_empty() {
        let mut parameters = Map::new();
        for pair in query.split('&').filter(|pair| !pair.is_empty()) {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            parameters.insert(form_decode(key), json!(form_decode(value)));
        }
        route.insert("modelParameters".into(), Value::Object(parameters));
    }
    Ok(route)
}

/// `URLSearchParams`' decoding of one name or value: `+` is a space, `%XX` a byte.
fn form_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() && hex(bytes[i + 1]).is_some() && hex(bytes[i + 2]).is_some() => {
                out.push((hex(bytes[i + 1]).unwrap_or(0) * 16 + hex(bytes[i + 2]).unwrap_or(0)) as u8);
                i += 2;
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `modelRouteFields(slot)` as an object.
fn route_fields(slot: &Map<String, Value>) -> Map<String, Value> {
    model_route_fields(slot).as_object().cloned().unwrap_or_default()
}

/// The answer of a created task session (`createTaskSession`'s return).
fn created_answer(session_id: &str, title: &str, project: Option<&str>, sent: &Map<String, Value>, notify: bool) -> Value {
    let mut out = Map::new();
    out.insert("session_id".into(), json!(session_id));
    out.insert("status".into(), json!("started"));
    out.insert("title".into(), json!(title));
    out.insert("project".into(), project.map_or(Value::Null, |p| json!(p)));
    if notify && sent.get("reportsBack") != Some(&Value::Bool(true)) {
        out.insert("reportsBack".into(), json!(false));
        out.insert("reportsBackReason".into(), sent.get("reportsBackReason").cloned().unwrap_or(Value::Null));
    }
    Value::Object(out)
}

impl SessionSend {
    /// `resolveTaskProject(project, { projects, cwd })` and `createWhere`'s registration check.
    async fn task_where(&self, args: &Value, projects: &[ProjectRow], cwd: &str, location: &Location) -> Result<Where, String> {
        let requested = clean(args.get("project"));
        let place = if requested.is_empty() {
            Where { cwd: cwd.to_owned(), desktop_session: json!({ "classification": "task", "projectPath": null }), project: None }
        } else {
            let key = requested.to_lowercase();
            let named: Vec<&ProjectRow> = projects.iter().filter(|p| mixdog_js::js_trim(&p.name).to_lowercase() == key).collect();
            if named.len() > 1 {
                return Err(format!("session: Project \"{requested}\" is ambiguous; ask the user which one is meant"));
            }
            let path = match named.first().map(|p| p.path.clone()).filter(|p| !p.is_empty()) {
                Some(path) => path,
                None => {
                    let candidate = mixdog_agent::agent_tool::scope::resolve_path(cwd, &requested);
                    self.create
                        .directory(&candidate)
                        .await
                        .ok_or_else(|| format!("session: \"{requested}\" is neither a registered Project nor an existing directory; run list-projects"))?
                }
            };
            Where { cwd: path.clone(), desktop_session: json!({ "classification": "project", "projectPath": path }), project: Some(path) }
        };
        let registered = place.project.as_deref().is_some_and(|path| projects.iter().any(|p| path_key(&p.path) == path_key(path)));
        if matches!(location, Location::Worktree(_)) && !registered {
            return Err(task_worktree_failure(&CreateFailure::coded("WORKTREE_PROJECT_UNKNOWN", "A worktree needs a registered Project; run list-projects.")));
        }
        Ok(place)
    }

    /// `taskRoute`: an explicit model wins, else the Lead route, else the last-used model; an
    /// explicit effort is applied last. The catalog is read only when a name or an effort needs it.
    async fn task_route(&self, args: &Value) -> Result<Map<String, Value>, String> {
        let mut catalog: Option<Vec<Value>> = None;
        let effort = args.get("effort");
        let model = clean(args.get("model"));
        let route = if !model.is_empty() {
            match parse_schedule_model_ref(&model) {
                // `modelRouteFields(migrateCodexRoute(ref))`: only an explicit provider/model ref is migrated.
                Ok(route) => Some(route_fields(self.create.codex_route(Value::Object(route)).await.as_object().unwrap_or(&Map::new()))),
                Err(name) => {
                    let presets = self.create.presets().await;
                    let preset =
                        presets.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(&name) || p.get("name").and_then(Value::as_str) == Some(&name));
                    match preset.and_then(Value::as_object) {
                        Some(preset) => Some(route_fields(preset)),
                        None => {
                            let rows = catalog.insert(self.catalog.rows().await?);
                            Some(route_by_display_name(&name, rows, effort.is_some())?)
                        }
                    }
                }
            }
        } else {
            match self.create.lead_route().await?.and_then(|r| r.as_object().cloned()) {
                Some(lead) => Some(lead),
                None => self.last_used_route().await?,
            }
        };
        let Some(route) = route else {
            return Err("session: no model to start the task session on. Choose a Lead model first.".into());
        };
        match effort {
            Some(effort) => {
                let rows = match catalog {
                    Some(rows) => rows,
                    None => self.catalog.rows().await?,
                };
                with_effort(route, effort, &rows)
            }
            None => Ok(route),
        }
    }

    /// `lastUsedSessionRoute`: the first catalog row of a coding session with a model.
    async fn last_used_route(&self) -> Result<Option<Map<String, Value>>, String> {
        let mut cursor = None;
        for _ in 0..LAST_USED_ROUTE_MAX_PAGES {
            let (rows, next) = self.create.catalog_page(50, cursor).await?;
            let used = rows.iter().find(|row| {
                row.get("sessionMode").and_then(Value::as_str) != Some("agent") && !clean(row.get("provider")).is_empty() && !clean(row.get("model")).is_empty()
            });
            if let Some(used) = used {
                return Ok(Some(Map::from_iter([
                    ("provider".to_owned(), json!(clean(used.get("provider")))),
                    ("model".to_owned(), json!(clean(used.get("model")))),
                ])));
            }
            match next {
                Some(next) => cursor = Some(next),
                None => return Ok(None),
            }
        }
        Ok(None)
    }

    /// `requestTaskWorktree`: the new session enters its own worktree before the brief; unless
    /// `explicit`, a repository that cannot have one keeps the Project folder.
    async fn request_task_worktree(&self, session_id: &str, input: Value, explicit: bool) -> Result<(), CreateFailure> {
        let failure = match self.create.request_worktree(session_id, input).await {
            Ok(value) if value.get("pending") == Some(&Value::Bool(false)) && value.pointer("/workspace/worktreeId").is_some_and(Value::is_string) => {
                return Ok(());
            }
            Ok(_) => CreateFailure::coded("WORKTREE_NOT_IMPLEMENTED", "The session did not enter its worktree before the brief."),
            Err(failure) => failure,
        };
        if !explicit && failure.code.as_deref() == Some("WORKTREE_UNSUPPORTED_REPO") {
            return Ok(());
        }
        Err(failure)
    }

    /// `dropEmptyTaskSession`: nothing was sent after the worktree failure `error`; the empty
    /// task session is dropped so a retry starts clean.
    async fn drop_empty_task_session(&self, session_id: &str, error: String) -> String {
        let failure = match self.create.delete_session(session_id).await {
            Ok(Value::Bool(false)) => Some("the session service refused the deletion".to_owned()),
            Ok(_) => None,
            Err(message) => Some(message),
        };
        let Some(failure) = failure else { return error };
        mixdog_rt::node_stderr!("mixdog task sessions: dropping {session_id} failed: {failure}");
        format!(
            "{error} The empty task session {session_id} could not be deleted either ({failure}); delete it with session action=delete session_id={session_id}."
        )
    }

    /// Puts the new task session into its worktree before the brief; on a failure the empty session is dropped.
    async fn enter_worktree(&self, session_id: &str, args: &Value, location: &Location, title: &str, request_id: &str) -> Result<(), String> {
        let explicit = matches!(location, Location::Worktree(_));
        let mut input = Map::from_iter([
            ("provision".to_owned(), json!(true)),
            ("carryChanges".to_owned(), json!("leave")),
            ("prompt".to_owned(), json!(title)),
            ("txId".to_owned(), json!(request_id)),
        ]);
        if let Location::Worktree(Some(name)) = location {
            input.insert("name".into(), json!(name));
        }
        if args.get("confirm_large") == Some(&Value::Bool(true)) {
            input.insert("confirmLarge".into(), json!(true));
        }
        if let Err(failure) = self.request_task_worktree(session_id, Value::Object(input), explicit).await {
            let error =
                if failure.code.as_deref().is_some_and(|code| code.starts_with("WORKTREE_")) { task_worktree_failure(&failure) } else { failure.message };
            return Err(self.drop_empty_task_session(session_id, error).await);
        }
        Ok(())
    }

    /// The "started" line that reaches the bot's home before any report of the turn.
    async fn announce_started(&self, agent_id: &str, caller: &str, session_id: &str, request_id: &str, title: &str) {
        let mut line = Map::from_iter([
            ("runId".to_owned(), json!(format!("{request_id}_started"))),
            ("taskSessionId".to_owned(), json!(session_id)),
            ("title".to_owned(), json!(title)),
            ("status".to_owned(), json!("started")),
        ]);
        if room_member_of_session(caller).is_some() {
            line.insert("from".into(), json!(caller));
        }
        if let Err(error) = self.tasks.deliver_once(agent_id, Value::Object(line)).await {
            mixdog_rt::node_stderr!("mixdog task sessions: start line of {session_id} failed: {error}");
        }
    }

    /// `createTaskSession(args, caller)`: `attended` is the caller's worktree scope.
    pub async fn create(&self, call: &ControlCall, attended: bool) -> Result<Value, String> {
        let (args, caller) = (&call.args, call.caller_thread.as_str());
        // A bot's conversation owns the task session and gets its result reported back; any other caller (a Lead session, a
        // delegated worker, a task session, a schedule or webhook run) starts an independent session it follows by reading it.
        let agent_id = call.caller.attended_agent.as_str();
        let owned = !agent_id.is_empty();
        // Every session a session creates is one step further down its chain, so creates cannot go on without the user.
        let independent_hop = if owned { 0 } else { super::session_send::chained_hop(self.chains.hop(caller) + 1, (self.hop_limit)())? };
        let brief = args.get("brief").and_then(Value::as_str).map(|b| mixdog_js::js_trim(b).to_owned()).unwrap_or_default();
        if brief.is_empty() {
            return Err("session: brief is required for action=create".into());
        }
        let location = task_location(args.get("worktree"))?;
        if matches!(location, Location::Worktree(_)) && !attended {
            return Err("session: create with a worktree changes worktrees only in a conversation session (a Lead session or a bot chat); schedule, webhook, routine and room runs may only list them".into());
        }
        let projects = self.create.projects().await;
        let place = self.task_where(args, &projects, &call.cwd, &location).await?;
        let request_id = format!("atask_{}", uuid::Uuid::new_v4());
        let title = task_title(args, &brief);
        let notify = args.get("notify") != Some(&Value::Bool(false));
        let task_origin =
            if owned { json!({ "agentId": agent_id, "sessionId": caller, "requestId": request_id, "title": title, "notify": notify }) } else { Value::Null };
        let route = self.task_route(args).await?;
        let explicit = matches!(location, Location::Worktree(_));
        let in_worktree = explicit
            || (location == Location::Default && place.project.is_some() && attended && self.create.new_task_default().await.as_deref() == Some("worktree"));
        let mut params = route;
        params.insert("cwd".into(), json!(place.cwd));
        params.insert("desktopSession".into(), place.desktop_session.clone());
        params.insert("sessionProfile".into(), json!({ "taskOrigin": task_origin, "title": title }));
        let session_id = self.create.create_session(Value::Object(params)).await?;
        if session_id.is_empty() {
            return Err("session: task session creation returned no session id".into());
        }
        if in_worktree {
            self.enter_worktree(&session_id, args, &location, &title, &request_id).await?;
        }
        let prompt = handoff_content(&brief, &call.attachment_parts);
        if !owned {
            // New work from this sender: the session acts as the sender does, as a session it sends to would.
            self.rebind.rebind(&session_id, caller).await?;
            let meta = Map::from_iter([("sender".to_owned(), json!("lead"))]);
            let submission = Submission { hop: independent_hop, bot_chain: Vec::new(), meta, settled: false, follow: None };
            if self.tasks.intake().submit(&session_id, prompt, &request_id, submission).await?.is_none() {
                return Err(format!("session: task session {session_id} did not accept the brief"));
            }
            let sent = Map::from_iter([("reportsBackReason".to_owned(), json!(super::session_send::NOT_BOT_REASON))]);
            return Ok(created_answer(&session_id, &title, place.project.as_deref(), &sent, true));
        }
        let (started, ready) = tokio::sync::watch::channel(false);
        let bot_chain = bot_chain_of(self.chains.bot_chain(caller).await.iter().map(String::as_str));
        let origin = Origin {
            agent_id: agent_id.to_owned(),
            session_id: caller.to_owned(),
            title: title.clone(),
            notify,
            target_session: false,
            text_only: false,
            envelope_name: None,
            hop: self.chains.hop(caller),
            bot_chain,
        };
        let sent = self.tasks.send_as(&session_id, &prompt, &origin, &request_id, Some(ready)).await?;
        if sent.get("accepted") != Some(&Value::Bool(true)) {
            return Err(format!("session: task session {session_id} did not accept the brief"));
        }
        if sent.get("reportsBack") == Some(&Value::Bool(true)) {
            self.announce_started(agent_id, caller, &session_id, &request_id, &title).await;
        }
        let _ = started.send(true);
        Ok(created_answer(&session_id, &title, place.project.as_deref(), &sent, notify))
    }
}

fn task_title(args: &Value, brief: &str) -> String {
    let title = clean(args.get("title"));
    let title = if title.is_empty() { clean(Some(&json!(brief.split('\n').next().unwrap_or_default()))) } else { title };
    mixdog_js::slice_utf16(&title, TITLE_LIMIT)
}

/// `taskOriginSuffix(taskOrigin)`: where a bot created its task session, after its id in the
/// session's `sourceName`. A create comes only from an attended conversation, so never a run's.
fn task_origin_suffix(origin: &Value) -> &'static str {
    let from = clean(origin.get("sessionId"));
    if room_member_of_session(&from).is_some() {
        return "@room";
    }
    if agent_id_of_home_session(&from).unwrap_or_default() == clean(origin.get("agentId")) { "@home" } else { "" }
}

/// [`CreateHost`] over the session directory, the registered Projects, the config, the route
/// context and the session catalog.
pub struct DirectoryCreate {
    pub directory: Arc<SessionDirectory>,
    pub projects: Arc<dyn super::session_port::ProjectList>,
    pub config: mixdog_core_config::config::Config,
    pub routes: Arc<dyn mixdog_core_domains::domains::ai_admin::chain::RouteContext>,
    pub listing: Arc<dyn super::session_control::SessionListing>,
    /// Where the saved openai-oauth catalog lives (`getPluginData()`).
    pub data_dir: std::path::PathBuf,
    pub io: mixdog_rt::InteractiveIo,
}

#[async_trait]
impl CreateHost for DirectoryCreate {
    async fn projects(&self) -> Vec<ProjectRow> {
        self.projects.list().await
    }

    async fn directory(&self, path: &str) -> Option<String> {
        let path = std::path::PathBuf::from(path);
        let cancel = mixdog_rt::CancellationToken::new();
        let job = mixdog_rt::LaneToken::submit(self.io, &cancel, move |lane| {
            let metadata = mixdog_statefile::metadata(lane, &path).ok()?;
            #[allow(clippy::disallowed_methods, reason = "runs as an interactive-lane job")]
            let real = metadata.is_dir().then(|| std::fs::canonicalize(&path).ok()).flatten()?;
            let real = real.to_string_lossy().into_owned();
            // `realpathSync` names a local drive without the verbatim prefix.
            Some(real.strip_prefix(r"\\?\").filter(|rest| !rest.starts_with("UNC")).map(str::to_owned).unwrap_or(real))
        });
        job.ok()?.await.ok().flatten()
    }

    async fn new_task_default(&self) -> Option<String> {
        self.config.agent().get("worktree").and_then(|w| w.get("newTaskDefault")).and_then(Value::as_str).map(str::to_owned)
    }

    async fn presets(&self) -> Vec<Value> {
        self.config.agent().get("presets").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    async fn codex_route(&self, route: Value) -> Value {
        let (data_dir, now) = (self.data_dir.clone(), self.directory.deps().clock.now_ms());
        let cancel = mixdog_rt::CancellationToken::new();
        let unchanged = route.clone();
        let job = mixdog_rt::LaneToken::submit(self.io, &cancel, move |_| mixdog_core_config::config::migrate_codex_route(&route, &data_dir, now));
        match job {
            Ok(job) => job.await.unwrap_or(unchanged),
            Err(_) => unchanged,
        }
    }

    async fn lead_route(&self) -> Result<Option<Value>, String> {
        let route = self.routes.resolve_main()?;
        let chosen = !clean(route.get("provider")).is_empty() && !clean(route.get("model")).is_empty();
        Ok(chosen.then(|| model_route_fields(&route)))
    }

    async fn catalog_page(&self, limit: usize, cursor: Option<String>) -> Result<(Vec<Value>, Option<String>), String> {
        let page = self.listing.page(limit, cursor.as_deref()).await?;
        Ok((page.rows.into_iter().map(|listed| Value::Object(listed.row)).collect(), page.next_cursor))
    }

    async fn create_session(&self, params: Value) -> Result<String, String> {
        let origin = params.pointer("/sessionProfile/taskOrigin").cloned().unwrap_or(Value::Null);
        let now = self.directory.deps().clock.now_ms();
        // A session no bot owns is a Lead session of its own: no origin, the source name of any other.
        let source_name = if origin.is_object() { format!("agent:{}{}", clean(origin.get("agentId")), task_origin_suffix(&origin)) } else { String::new() };
        let mut header = hidden_session_header(&params, &json!({ "sourceName": source_name }), now);
        header.insert("cwd".into(), params.get("cwd").cloned().unwrap_or(Value::Null));
        header.insert("desktopSession".into(), params.get("desktopSession").cloned().unwrap_or(Value::Null));
        if origin.is_object() {
            header.insert("taskOrigin".into(), origin.clone());
        }
        header.insert("title".into(), params.pointer("/sessionProfile/title").cloned().unwrap_or(Value::Null));
        header.insert("titleLocked".into(), json!(true));
        header.insert("titleSource".into(), json!("ai"));
        header.insert("titleUpdatedAt".into(), json!(now));
        let id = self.directory.create_session(header, params).await.map_err(|e| format!("{e:?}"))?;
        Ok(id.as_str().to_owned())
    }

    async fn request_worktree(&self, session_id: &str, input: Value) -> Result<Value, CreateFailure> {
        let params = json!({ "threadId": session_id, "opId": uuid::Uuid::now_v7().to_string(), "input": input });
        super::session_port::directory_call(&self.directory, &ThreadId::from(session_id), "thread/requestWorktree", params).await.map_err(|error| match error {
            CoreError::DomainError { code, message, detail, .. } => CreateFailure {
                code: code.map(|c| c.to_string()),
                message: message.map(|m| m.to_string()).unwrap_or_default(),
                details: detail.and_then(|d| serde_json::to_value(*d).ok()),
            },
            other => CreateFailure::plain(format!("{other:?}")),
        })
    }

    async fn delete_session(&self, session_id: &str) -> Result<Value, String> {
        let params = json!({ "threadId": session_id, "opId": uuid::Uuid::now_v7().to_string() });
        super::session_port::directory_call(&self.directory, &ThreadId::from(session_id), "thread/delete", params).await.map_err(|e| format!("{e:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worktree_name_is_a_short_git_safe_slug() {
        let rows: [(Value, Option<&str>); 9] = [
            (json!("fix-1_2.3"), None),
            (json!(""), Some("a name is required")),
            (json!(5), Some("a name is required")),
            (json!("a".repeat(65)), Some("at most 64 characters")),
            (json!("-lead"), Some("use letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit")),
            (json!("a/b"), Some("use letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit")),
            (json!("a..b"), Some("not a valid git branch component")),
            (json!("a."), Some("not a valid git branch component")),
            (json!("x.LOCK"), Some("not a valid git branch component")),
        ];
        for (name, expected) in rows {
            assert_eq!(worktree_name_error(&name).as_deref(), expected, "{name}");
        }
        assert_eq!(worktree_name_error(&json!("a".repeat(64))), None, "sixty-four is the limit");
    }

    #[test]
    fn the_worktree_option_picks_where_a_task_session_starts() {
        let rows: [(Option<Value>, Result<Location, &str>); 9] = [
            (None, Ok(Location::Default)),
            (Some(Value::Null), Ok(Location::Default)),
            (Some(json!({ "mode": "branch" })), Ok(Location::Branch)),
            (Some(json!({ "mode": "worktree" })), Ok(Location::Worktree(None))),
            (Some(json!({ "mode": "worktree", "name": "fix-1" })), Ok(Location::Worktree(Some("fix-1".into())))),
            (Some(json!({ "mode": "copy" })), Err("session: worktree.mode must be \"branch\" or \"worktree\"")),
            (Some(json!("worktree")), Err("session: worktree.mode must be \"branch\" or \"worktree\"")),
            (Some(json!({ "mode": "branch", "name": "x" })), Err("session: worktree.name applies only to mode \"worktree\"")),
            (
                Some(json!({ "mode": "worktree", "name": "bad name" })),
                Err("session: worktree.name is invalid: use letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit"),
            ),
        ];
        for (option, expected) in rows {
            assert_eq!(task_location(option.as_ref()), expected.map_err(str::to_owned), "{option:?}");
        }
    }

    #[test]
    fn a_model_ref_is_a_provider_and_model_with_optional_effort_fast_noauto_and_query_parameters() {
        let route = |raw: &str| parse_schedule_model_ref(raw).map(Value::Object);
        assert_eq!(route("openai/gpt-5"), Ok(json!({ "provider": "openai", "model": "gpt-5" })));
        assert_eq!(route("openai/gpt-5@high+fast"), Ok(json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "fast": true })));
        assert_eq!(route("x/m@low+fast+noauto"), Ok(json!({ "provider": "x", "model": "m", "effort": "low", "fast": true, "effortAuto": false })));
        assert_eq!(route("p/m?a=1&b=x+y%21&flag"), Ok(json!({ "provider": "p", "model": "m", "modelParameters": { "a": "1", "b": "x y!", "flag": "" } })));
        assert_eq!(route("a-preset"), Err("a-preset".to_owned()), "no provider: the text is a preset's id or name");
        assert_eq!(route("/m"), Err("/m".to_owned()), "an empty provider is none");
    }

    fn catalog() -> Vec<Value> {
        vec![json!({ "id": "gpt-5", "provider": "openai", "display": "GPT 5" }), json!({ "id": "claude-x", "provider": "anthropic", "display": "Claude X" })]
    }

    #[test]
    fn a_display_name_names_its_route_whatever_its_case() {
        let route = route_by_display_name("  gpt 5 ", &catalog(), false).expect("one model is named");
        assert_eq!(Value::Object(route), json!({ "provider": "openai", "model": "gpt-5" }));
    }

    #[test]
    fn an_unknown_display_name_lists_every_choice_and_a_trailing_effort_word_points_at_the_effort_field() {
        let choices = "GPT 5 (openai/gpt-5); Claude X (anthropic/claude-x)";
        let lead = "is neither a provider/model route, a preset name nor a model display name. Choices: ";
        assert_eq!(route_by_display_name("nothing", &catalog(), false), Err(format!("session: model \"nothing\" {lead}{choices}")));
        assert_eq!(
            route_by_display_name("nothing high", &catalog(), false),
            Err(format!("session: model \"nothing high\" {lead}{choices}. To set the reasoning effort, pass it as the effort field"))
        );
    }

    #[test]
    fn a_display_name_two_models_share_is_ambiguous_and_names_them() {
        let rows = vec![json!({ "id": "m1", "provider": "a", "display": "Dup" }), json!({ "id": "m2", "provider": "b", "display": "Dup" })];
        assert_eq!(
            route_by_display_name("Dup", &rows, false),
            Err("session: model \"Dup\" is ambiguous; use provider/model: Dup (a/m1); Dup (b/m2)".to_owned())
        );
    }

    #[test]
    fn an_error_names_six_choices_and_the_total() {
        let rows: Vec<Value> = (1..=7).map(|n| json!({ "id": format!("m{n}"), "provider": "p" })).collect();
        let refs: Vec<&Value> = rows.iter().collect();
        assert_eq!(choices(&refs), "m1 (p/m1); m2 (p/m2); m3 (p/m3); m4 (p/m4); m5 (p/m5); m6 (p/m6); … (7 total)");
        assert_eq!(choices(&refs[..6]), "m1 (p/m1); m2 (p/m2); m3 (p/m3); m4 (p/m4); m5 (p/m5); m6 (p/m6)");
    }

    #[test]
    fn a_large_repository_worktree_failure_asks_the_user_before_it_may_be_confirmed() {
        let large = CreateFailure {
            code: Some("WORKTREE_LARGE_REPO_CONFIRM".into()),
            message: "big".into(),
            details: Some(json!({ "estimateBytes": 3145728.0, "thresholdBytes": 1048576.0 })),
        };
        assert_eq!(
            task_worktree_failure(&large),
            "session: WORKTREE_LARGE_REPO_CONFIRM: big The repository is about 3 MB (warning threshold 1 MB). Ask the user whether to create the worktree anyway; only if they confirm, call create again with confirm_large: true."
        );
        assert_eq!(task_worktree_failure(&CreateFailure::coded("WORKTREE_DIRTY", "uncommitted changes")), "session: WORKTREE_DIRTY: uncommitted changes");
    }

    #[test]
    fn a_project_path_is_compared_without_its_trailing_separator() {
        assert_eq!(path_key("/work/repo/"), path_key("/work/repo"));
        assert_eq!(path_key("C:\\Work\\Repo\\"), if cfg!(windows) { "c:/work/repo" } else { "C:/Work/Repo" });
    }
}
