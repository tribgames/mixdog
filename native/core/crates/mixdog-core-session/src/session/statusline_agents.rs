//! The agent workers of the footer's second line (`ui/statusline-agents.mjs`): the workers and the bridge jobs
//! merged into one payload, the running ones told from the hidden maintenance workers, the live hidden
//! sub-sessions of a lead, and the lead's sub-sessions that are searching the web right now.

use std::collections::HashMap;
use std::collections::HashSet;

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::gateway_usage::event::truthy;

/// `MAINTENANCE_AGENT_LABELS`: the agents hidden from the worker list by default, and the short label each one renders as.
const MAINTENANCE_AGENT_LABELS: [(&str, &str); 1] = [("cycle1-agent", "cycle1")];

/// What a worker or a job of the footer shows.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRow {
    pub tag: String,
    pub task_id: Option<String>,
    /// `running`, `idle`, `queued` or `finished`.
    pub status: &'static str,
    pub final_status: Option<String>,
    pub started_at_ms: f64,
    pub finished_at_ms: Option<f64>,
    pub agent: Option<Value>,
    pub stage: Option<Value>,
    pub session_id: Option<Value>,
    pub provider: Option<Value>,
    pub model: Option<Value>,
}

impl AgentRow {
    fn json(&self) -> Value {
        let mut out = Map::new();
        out.insert("tag".into(), json!(self.tag));
        if let Some(task) = &self.task_id {
            out.insert("taskId".into(), json!(task));
        }
        out.insert("status".into(), json!(self.status));
        if let Some(status) = &self.final_status {
            out.insert("finalStatus".into(), json!(status));
        }
        out.insert("startedAtMs".into(), mixdog_js::json_number(self.started_at_ms));
        if let Some(at) = self.finished_at_ms {
            out.insert("finishedAtMs".into(), mixdog_js::json_number(at));
        }
        for (key, value) in [("agent", &self.agent), ("stage", &self.stage), ("sessionId", &self.session_id), ("provider", &self.provider), ("model", &self.model)] {
            out.insert(key.into(), value.clone().unwrap_or(Value::Null));
        }
        Value::Object(out)
    }
}

/// `agentStatuslinePayload`'s result.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentPayload {
    pub workers: Vec<AgentRow>,
    /// Finished jobs, the latest first.
    pub finished_jobs: Vec<AgentRow>,
}

impl AgentPayload {
    /// The payload as Node builds it, with `sessions: { roles, workers }`.
    pub fn json(&self) -> Value {
        let workers: Vec<Value> = self.workers.iter().map(AgentRow::json).collect();
        let roles: Vec<Value> = self.workers.iter().filter(|worker| worker.status != "idle").map(|worker| json!(worker.tag)).collect();
        json!({
            "workers": workers,
            "finishedJobs": self.finished_jobs.iter().map(AgentRow::json).collect::<Vec<_>>(),
            "sessions": { "roles": roles, "workers": workers },
        })
    }
}

/// `String(value || '').trim()` of a member.
fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(member) if truthy(Some(member)) => js_trim(&value_to_string(member)).to_owned(),
        _ => String::new(),
    }
}

/// `String(a || b || '').trim()`: the first truthy member as text, trimmed (a blank one is not passed over).
fn first_text(value: &Value, keys: &[&str]) -> String {
    keys.iter().find(|key| value.get(**key).is_some_and(|member| truthy(Some(member)))).map(|key| text(value, key)).unwrap_or_default()
}

/// `value[key] || null`.
fn or_null(value: &Value, key: &str) -> Option<Value> {
    value.get(key).filter(|member| truthy(Some(member))).cloned()
}

/// `timeMs(value)`: epoch ms from a positive number or a date string; 0 when neither parses.
fn time_ms(value: Option<&Value>) -> f64 {
    if let Some(Value::Number(number)) = value
        && let Some(n) = number.as_f64().filter(|n| n.is_finite() && *n > 0.0)
    {
        return n;
    }
    let text = value.filter(|v| truthy(Some(v))).map(value_to_string).unwrap_or_default();
    let parsed = mixdog_js::time::date_parse(&text);
    if parsed.is_finite() { parsed } else { 0.0 }
}

/// `agentStatusValues(value)`: the distinct non-empty `stage` and `status`.
fn status_values(value: &Value) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for key in ["stage", "status"] {
        let status = text(value, key);
        if !status.is_empty() && !seen.contains(&status) {
            seen.push(status);
        }
    }
    seen
}

/// `lifecycleStatuses(value)`: the statuses that decide whether an entry is working. `status` is the lifecycle;
/// `stage` is the runtime phase copied in beside it, which can read idle, done or error mid-work, so it decides only
/// for an entry with no status. A cancel in either field still counts.
fn lifecycle_statuses(value: &Value) -> Vec<String> {
    let statuses = status_values(value);
    if statuses.iter().any(|status| contains_any(status, &["cancel", "killed"])) {
        return statuses;
    }
    let status = text(value, "status");
    if status.is_empty() { statuses } else { vec![status] }
}

fn contains_any(status: &str, words: &[&str]) -> bool {
    let lower = js_to_lowercase(status);
    words.iter().any(|word| lower.contains(word))
}

fn is_terminal(statuses: &[String]) -> bool {
    statuses.iter().any(|status| contains_any(status, &["idle", "done", "complete", "success", "closed", "error", "fail", "cancel", "killed", "timeout"]))
}

/// `^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting)$`.
fn is_active_word(status: &str) -> bool {
    let lower = js_to_lowercase(status);
    if matches!(lower.as_str(), "connecting" | "requesting" | "streaming" | "running" | "queued" | "pending" | "starting") {
        return true;
    }
    lower.strip_prefix("tool").is_some_and(|rest| {
        let mut chars = rest.chars();
        match chars.clone().next() {
            Some(c) if c == '-' || c == '_' || mixdog_js::is_js_space(c) => {
                chars.next();
                chars.as_str() == "running"
            }
            _ => rest == "running",
        }
    })
}

fn is_active(statuses: &[String]) -> bool {
    !statuses.is_empty() && !is_terminal(statuses) && statuses.iter().any(|status| is_active_word(status))
}

fn is_queued(statuses: &[String]) -> bool {
    is_active(statuses) && statuses.iter().all(|status| matches!(js_to_lowercase(status).as_str(), "queued" | "pending" | "starting"))
}

/// `normalizeAgentWorkerForStatusline`.
fn normalize_worker(worker: &Value) -> Option<AgentRow> {
    let tag = first_text(worker, &["tag", "agent", "name"]);
    if tag.is_empty() {
        return None;
    }
    let started = ["startedAt", "startTime", "createdAt"].iter().find_map(|key| worker.get(*key).filter(|v| truthy(Some(v))));
    Some(AgentRow {
        tag,
        task_id: None,
        status: if is_active(&lifecycle_statuses(worker)) { "running" } else { "idle" },
        final_status: None,
        started_at_ms: time_ms(started),
        finished_at_ms: None,
        agent: or_null(worker, "agent"),
        stage: or_null(worker, "stage").or_else(|| or_null(worker, "status")),
        session_id: or_null(worker, "sessionId"),
        provider: or_null(worker, "provider"),
        model: or_null(worker, "model"),
    })
}

/// `normalizeAgentJobForStatusline`: a finished job (terminal with a finish time), a running or a queued one, else none.
fn normalize_job(job: &Value) -> Option<AgentRow> {
    let statuses = status_values(job);
    let first = statuses.first()?;
    let task_id = first_text(job, &["task_id", "taskId"]);
    let tag = first_text(job, &["tag", "agent", "type"]);
    let tag = if tag.is_empty() { task_id.clone() } else { tag };
    if tag.is_empty() && task_id.is_empty() {
        return None;
    }
    let started = time_ms(job.get("startedAt"));
    let finished = time_ms(job.get("finishedAt"));
    let stage = or_null(job, "stage").or_else(|| or_null(job, "workerStatus")).or_else(|| or_null(job, "status"));
    let mut row = AgentRow {
        tag,
        task_id: Some(task_id),
        status: "running",
        final_status: None,
        started_at_ms: started,
        finished_at_ms: None,
        agent: or_null(job, "agent"),
        stage,
        session_id: or_null(job, "sessionId"),
        provider: or_null(job, "provider"),
        model: or_null(job, "model"),
    };
    if is_terminal(&statuses) && finished > 0.0 {
        row.status = "finished";
        row.final_status = Some(js_to_lowercase(first));
        row.finished_at_ms = Some(finished);
        return Some(row);
    }
    let lifecycle = lifecycle_statuses(job);
    if !is_active(&lifecycle) {
        return None;
    }
    row.status = if is_queued(&lifecycle) { "queued" } else { "running" };
    Some(row)
}

/// `agentStatuslinePayload(agentWorkers, agentJobs)`: a worker is authoritative over its spawn job: an active worker
/// already represents the work and an inactive one suppresses a lagging running job; only a genuinely queued reuse
/// replaces an inactive worker until the new one starts.
pub fn agent_statusline_payload(workers: &[Value], jobs: &[Value]) -> AgentPayload {
    let mut order: Vec<String> = Vec::new();
    let mut by_tag: HashMap<String, AgentRow> = HashMap::new();
    let mut worker_by_tag: HashMap<String, AgentRow> = HashMap::new();
    let mut finished: Vec<AgentRow> = Vec::new();
    let mut put = |by_tag: &mut HashMap<String, AgentRow>, row: AgentRow| {
        if !by_tag.contains_key(&row.tag) {
            order.push(row.tag.clone());
        }
        by_tag.insert(row.tag.clone(), row);
    };
    for row in workers.iter().filter_map(normalize_worker) {
        worker_by_tag.insert(row.tag.clone(), row.clone());
        put(&mut by_tag, row);
    }
    for row in jobs.iter().filter_map(normalize_job) {
        if row.status == "finished" {
            finished.push(row);
            continue;
        }
        if let Some(worker) = worker_by_tag.get(&row.tag)
            && (worker.status == "running" || row.status != "queued")
        {
            continue;
        }
        put(&mut by_tag, row);
    }
    finished.sort_by(|a, b| b.finished_at_ms.unwrap_or(0.0).partial_cmp(&a.finished_at_ms.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    let workers = order.into_iter().filter_map(|tag| by_tag.remove(&tag)).collect();
    AgentPayload { workers, finished_jobs: finished }
}

/// The colours the maintenance label is drawn with.
pub struct LabelColours<'a> {
    pub green: &'a str,
    pub reset: &'a str,
    pub bold: &'a str,
}

fn maintenance_label(name: &str) -> &'static str {
    MAINTENANCE_AGENT_LABELS.iter().find(|(agent, _)| *agent == name).map_or("", |(_, label)| label)
}

/// `hiddenWorkerLabel(worker)`: the label of a maintenance worker, by its agent or, without one, by its tag.
fn hidden_worker_label(worker: &AgentRow) -> &'static str {
    let agent = worker.agent.as_ref().map(|agent| js_trim(&value_to_string(agent)).to_owned()).unwrap_or_default();
    let label = maintenance_label(&agent);
    if !label.is_empty() || !agent.is_empty() { label } else { maintenance_label(js_trim(&worker.tag)) }
}

/// What `classifyAgentWorkers` found.
#[derive(Clone, Debug, PartialEq)]
pub struct ClassifiedWorkers {
    /// The label of each running maintenance worker, once each.
    pub maintenance: Vec<String>,
    /// The running workers, one per tag.
    pub running_workers: Vec<AgentRow>,
}

/// `classifyAgentWorkers(workers)`: running maintenance workers (hidden from the list, shown as `↻ <label>`) and the
/// other running workers.
pub fn classify_agent_workers(workers: &[AgentRow], colours: &LabelColours<'_>) -> ClassifiedWorkers {
    let mut maintenance = Vec::new();
    let mut running_workers = Vec::new();
    let mut seen_maintenance: HashSet<&'static str> = HashSet::new();
    let mut seen_running: HashSet<String> = HashSet::new();
    for worker in workers {
        let tag = js_trim(&worker.tag);
        if tag.is_empty() {
            continue;
        }
        let label = hidden_worker_label(worker);
        if !label.is_empty() {
            if worker.status != "idle" && seen_maintenance.insert(label) {
                maintenance.push(format!("{}↻{} {}{label}{}", colours.green, colours.reset, colours.bold, colours.reset));
            }
            continue;
        }
        if worker.status != "idle" && seen_running.insert(tag.to_owned()) {
            running_workers.push(worker.clone());
        }
    }
    ClassifiedWorkers { maintenance, running_workers }
}

/// The sub-session behind a runtime entry.
#[derive(Clone, Debug, Default)]
pub struct RuntimeSession {
    pub id: String,
    pub closed: bool,
    pub agent: String,
    pub agent_tag: String,
    pub owner_session_id: String,
    /// `positiveInt(session.clientHostPid)`.
    pub client_host_pid: Option<u64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub stage: String,
    pub status: String,
}

/// One live session runtime (`forEachSessionRuntime`).
#[derive(Clone, Debug, Default)]
pub struct RuntimeEntry {
    pub runtime_session_id: String,
    pub closed: bool,
    pub stage: String,
    pub last_tool_call: String,
    pub tool_started_at: f64,
    pub session: Option<RuntimeSession>,
}

/// Whose sub-sessions are asked for: the lead's session id and its client host pid.
#[derive(Clone, Copy, Debug, Default)]
pub struct Owner<'a> {
    pub session_id: &'a str,
    pub client_host_pid: Option<u64>,
}

/// `ownedSubSession`: the live sub-session of a runtime entry when it is open and belongs to this lead (not the lead
/// itself, matching owner session and host pid).
fn owned_sub_session<'a>(entry: &'a RuntimeEntry, owner: Owner<'_>) -> Option<(&'a RuntimeSession, String)> {
    if entry.closed {
        return None;
    }
    let session = entry.session.as_ref().filter(|session| !session.closed)?;
    let id = if session.id.is_empty() { entry.runtime_session_id.clone() } else { session.id.clone() };
    let owner_id = js_trim(owner.session_id);
    if !owner_id.is_empty() && id == owner_id {
        return None;
    }
    let session_owner = js_trim(&session.owner_session_id);
    if !session_owner.is_empty() && !owner_id.is_empty() && session_owner != owner_id {
        return None;
    }
    if let (Some(owner_pid), Some(pid)) = (owner.client_host_pid, session.client_host_pid)
        && owner_pid != pid
    {
        return None;
    }
    Some((session, id))
}

/// `isActiveHiddenStatus`.
fn is_active_hidden_status(status: &str) -> bool {
    matches!(js_to_lowercase(js_trim(status)).as_str(), "connecting" | "requesting" | "streaming" | "tool_running" | "running")
}

/// `hiddenStatuslineAgents()`: the maintenance agents plus the hidden agent names the registry lists.
fn hidden_agents(listed: &[String]) -> HashSet<String> {
    let mut agents: HashSet<String> = MAINTENANCE_AGENT_LABELS.iter().map(|(agent, _)| (*agent).to_owned()).collect();
    agents.extend(listed.iter().map(|agent| js_trim(agent).to_owned()).filter(|agent| !agent.is_empty()));
    agents
}

/// `activeHiddenAgentWorkers({ sessionId, clientHostPid })`: the running hidden maintenance workers this lead owns.
pub fn active_hidden_agent_workers(runtimes: &[RuntimeEntry], owner: Owner<'_>, listed_hidden: &[String]) -> Vec<AgentRow> {
    let agents = hidden_agents(listed_hidden);
    let mut rows: Vec<AgentRow> = Vec::new();
    for entry in runtimes {
        let Some((session, id)) = owned_sub_session(entry, owner) else { continue };
        let agent = js_trim(&session.agent);
        if agent.is_empty() || !agents.contains(agent) {
            continue;
        }
        let first = |values: [&str; 3]| js_to_lowercase(js_trim(values.into_iter().find(|v| !v.is_empty()).unwrap_or_default()));
        let stage = first([entry.stage.as_str(), session.stage.as_str(), session.status.as_str()]);
        let status = first([session.status.as_str(), stage.as_str(), ""]);
        let shown = if stage.is_empty() { &status } else { &stage };
        if !is_active_hidden_status(shown) {
            continue;
        }
        let tag = js_trim(&if session.agent_tag.is_empty() { format!("{agent}:{}", if id.is_empty() { rows.len().to_string() } else { id.clone() }) } else { session.agent_tag.clone() }).to_owned();
        rows.push(AgentRow {
            tag,
            task_id: None,
            status: "running",
            final_status: None,
            started_at_ms: 0.0,
            finished_at_ms: None,
            agent: Some(json!(agent)),
            stage: Some(json!(if shown.is_empty() { "running" } else { shown.as_str() })),
            session_id: Some(json!(id)),
            provider: session.provider.clone().map(Value::String),
            model: session.model.clone().map(Value::String),
        });
    }
    rows
}

/// `agentWebSearchStatus({ sessionId, clientHostPid })`: how many live sub-sessions of this lead are in a web research
/// tool call now, and when the earliest began. The lead's own calls arrive through its active tools, so they are not
/// counted here.
pub fn agent_web_search_status(runtimes: &[RuntimeEntry], owner: Owner<'_>) -> (u32, f64) {
    let mut count = 0;
    let mut started_at = 0.0_f64;
    for entry in runtimes {
        if js_to_lowercase(js_trim(&entry.stage)) != "tool_running" || owned_sub_session(entry, owner).is_none() {
            continue;
        }
        let tool = js_trim(&entry.last_tool_call);
        if tool.is_empty() || mixdog_protocol::tool_units::surfaced_tool_units(tool, &Value::Null).map(|(category, _)| category) != Some("Web Research") {
            continue;
        }
        count += 1;
        let started = if entry.tool_started_at.is_finite() { entry.tool_started_at } else { 0.0 };
        if started > 0.0 && (started_at == 0.0 || started < started_at) {
            started_at = started;
        }
    }
    (count, started_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(rows: &[AgentRow]) -> Vec<(&str, &str)> {
        rows.iter().map(|row| (row.tag.as_str(), row.status)).collect()
    }

    #[test]
    fn a_worker_is_authoritative_over_its_spawn_job_unless_the_job_is_a_queued_reuse() {
        let workers = [json!({ "tag": "scout", "status": "running" }), json!({ "agent": "writer", "status": "done" }), json!({ "name": " ", "status": "running" })];
        let jobs = [
            json!({ "tag": "scout", "status": "running" }),
            json!({ "tag": "writer", "status": "queued" }),
            json!({ "tag": "fresh", "stage": "streaming", "status": "running", "startedAt": 5 }),
            json!({ "task_id": "t-9", "status": "pending" }),
            json!({ "tag": "gone", "status": "completed", "finishedAt": 100 }),
            json!({ "tag": "later", "status": "error", "finishedAt": "1970-01-01T00:00:01Z" }),
            json!({ "tag": "stale", "status": "completed" }),
        ];
        let payload = agent_statusline_payload(&workers, &jobs);
        assert_eq!(tags(&payload.workers), vec![("scout", "running"), ("writer", "queued"), ("fresh", "running"), ("t-9", "queued")]);
        assert_eq!(payload.finished_jobs.iter().map(|job| (job.tag.as_str(), job.final_status.clone(), job.finished_at_ms)).collect::<Vec<_>>(), vec![("later", Some("error".to_owned()), Some(1000.0)), ("gone", Some("completed".to_owned()), Some(100.0))]);
        let json = payload.json();
        assert_eq!(json["sessions"]["roles"], json!(["scout", "writer", "fresh", "t-9"]));
        assert_eq!(json["workers"][2]["startedAtMs"], 5);
    }

    #[test]
    fn a_stage_that_reads_idle_mid_work_does_not_end_a_workers_status_but_a_cancel_does() {
        let working = normalize_worker(&json!({ "tag": "a", "stage": "idle", "status": "running" })).unwrap();
        assert_eq!(working.status, "running");
        let cancelled = normalize_worker(&json!({ "tag": "b", "stage": "cancelled", "status": "running" })).unwrap();
        assert_eq!(cancelled.status, "idle");
        let by_stage = normalize_worker(&json!({ "tag": "c", "stage": "tool running" })).unwrap();
        assert_eq!(by_stage.status, "running");
        assert!(is_active_word("Tool-Running") && is_active_word("tool_running") && is_active_word("toolrunning") && !is_active_word("tool--running"));
    }

    #[test]
    fn maintenance_workers_leave_the_list_and_show_as_a_label_once() {
        let rows = [
            normalize_worker(&json!({ "tag": "cycle1-agent", "status": "running" })).unwrap(),
            normalize_worker(&json!({ "tag": "x", "agent": "cycle1-agent", "status": "running" })).unwrap(),
            normalize_worker(&json!({ "tag": "cycle1-agent#2", "agent": "cycle1-agent", "status": "running" })).unwrap(),
            normalize_worker(&json!({ "tag": "scout", "status": "running" })).unwrap(),
            normalize_worker(&json!({ "tag": "scout", "status": "running" })).unwrap(),
            normalize_worker(&json!({ "tag": "napping", "status": "done" })).unwrap(),
        ];
        let colours = LabelColours { green: "<g>", reset: "</>", bold: "<b>" };
        let classified = classify_agent_workers(&rows, &colours);
        assert_eq!(classified.maintenance, vec!["<g>↻</> <b>cycle1</>".to_owned()]);
        assert_eq!(classified.running_workers.iter().map(|worker| worker.tag.as_str()).collect::<Vec<_>>(), vec!["scout"]);
    }

    fn runtime(id: &str, stage: &str, session: RuntimeSession) -> RuntimeEntry {
        RuntimeEntry { runtime_session_id: id.into(), stage: stage.into(), session: Some(session), ..RuntimeEntry::default() }
    }

    fn sub(agent: &str, owner: &str, pid: Option<u64>) -> RuntimeSession {
        RuntimeSession { agent: agent.into(), owner_session_id: owner.into(), client_host_pid: pid, status: "running".into(), ..RuntimeSession::default() }
    }

    #[test]
    fn hidden_workers_of_this_lead_are_listed_while_they_are_active() {
        let owner = Owner { session_id: "lead", client_host_pid: Some(7) };
        let mut closed = runtime("c1", "streaming", sub("cycle1-agent", "lead", Some(7)));
        closed.closed = true;
        let runtimes = [
            runtime("s1", "streaming", sub("cycle1-agent", "lead", Some(7))),
            runtime("s2", "idle", sub("cycle1-agent", "lead", Some(7))),
            runtime("s3", "running", sub("cycle1-agent", "other", Some(7))),
            runtime("s4", "running", sub("cycle1-agent", "lead", Some(8))),
            runtime("lead", "running", sub("cycle1-agent", "lead", Some(7))),
            runtime("s5", "running", sub("scout", "lead", Some(7))),
            runtime("s6", "running", sub("memory-keeper", "", None)),
            closed,
        ];
        let rows = active_hidden_agent_workers(&runtimes, owner, &["memory-keeper".to_owned()]);
        assert_eq!(rows.iter().map(|row| (row.tag.as_str(), row.stage.clone())).collect::<Vec<_>>(), vec![("cycle1-agent:s1", Some(json!("streaming"))), ("memory-keeper:s6", Some(json!("running")))]);
        assert_eq!(rows[0].session_id, Some(json!("s1")));
        assert!(active_hidden_agent_workers(&runtimes, owner, &[]).iter().all(|row| row.agent != Some(json!("memory-keeper"))));
    }

    #[test]
    fn web_searches_of_a_leads_sub_sessions_are_counted_with_the_earliest_start() {
        let owner = Owner { session_id: "lead", client_host_pid: None };
        let searching = |id: &str, tool: &str, at: f64| RuntimeEntry { last_tool_call: tool.into(), tool_started_at: at, ..runtime(id, "tool_running", sub("scout", "lead", None)) };
        let runtimes = [
            searching("a", "web_search", 300.0),
            searching("b", "web_fetch", 200.0),
            searching("c", "shell", 100.0),
            searching("d", "", 50.0),
            RuntimeEntry { stage: "streaming".into(), ..searching("e", "web_search", 10.0) },
            searching("f", "mcp__other__web_search", 5.0),
        ];
        assert_eq!(agent_web_search_status(&runtimes, owner), (2, 200.0));
        assert_eq!(agent_web_search_status(&[], owner), (0, 0.0));
    }
}
