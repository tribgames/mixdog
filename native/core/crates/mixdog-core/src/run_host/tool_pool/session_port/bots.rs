//! `session action=bots` and `session action=status` of another session: `session-runtime/bot-status.mjs` (`createBotStatus`)
//! and `daemon-session-control.mjs` (`readSessionStatus`) over the catalog, the bots' definitions, their routines, held requests
//! and report watches.
//!
//! What the core has not got a store for answers as Node answers it when that store is empty: the work a Lead has handed to
//! agent sessions is known from the sessions with a turn in flight (`ThreadCatalog::live`); the agent pool rows, the owed
//! agent results and the background agent tasks (Node `store-agent-worker-rows.mjs`, `pending-messages.mjs`,
//! `background-tasks.mjs`, read by `taskSessionPendingWork`) have no store here yet and count as none.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::collections::HashSet;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_js::js_words;
use mixdog_js::slice_utf16;
use mixdog_js::time::date_parse;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use mixdog_tools::exec::escape_harness_tags;
use mixdog_tools::orch::session::ControlCall;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::DirectorySessionPort;
use super::actions;
use super::failed;
use super::super::session_output::PAGE_BYTES;
use super::super::session_output::UNTRUSTED_NOTE;
use super::super::session_output::number_of;
use super::super::session_output::quoted_title;
use super::super::session_output::session_bot_of;

const BOT_LINE_LIMIT: i64 = 170;
const SCAN_PAGE_ROWS: usize = 2000;
const PREVIEW_LIMIT: usize = 100;
const MIN_PREVIEW: i64 = 16;
const MAX_BOTS: usize = 30;
const MAX_ROUTINES: usize = 20;
const MAX_HELD: usize = 10;
const ERROR_LIMIT: usize = 200;
const DEFAULT_SESSIONS: f64 = 10.0;
const READ_HINT: &str = "session action=read session_id=<id> reads one.";
const DETAIL_HINT: &str = "session action=bots session_id=<bot id or chat id>: its routines and recent sessions; session action=read session_id=<id> reads one.";
const SCAN_NOTE: &str = "older sessions were not scanned (newest 2000 only)";

/// A bot as `listBots` gives it: a contact agent with its display name, off the roster or not.
#[derive(Clone, Debug)]
pub struct BotRow {
    pub id: String,
    pub name: String,
    pub disabled: bool,
}

/// The state `session bots` reads besides the catalog: the bots, the routines (`channelSetup`'s schedules then webhooks), the
/// held requests of unattended runs (`pendingHeldRequests`) and the report watches of task turns (`agentTaskWatches`), each as
/// Node's rows (camelCase objects).
#[async_trait]
pub trait BotWorld: Send + Sync {
    async fn bots(&self) -> Result<Vec<BotRow>, String>;
    /// The routine rows, each stamped with its `kind` (`schedule` or `webhook`).
    async fn routines(&self) -> Result<Vec<Value>, String>;
    async fn held_requests(&self) -> Result<Vec<Value>, String>;
    async fn task_watches(&self) -> Result<Vec<Value>, String>;
}

#[derive(Clone)]
struct Bot {
    id: String,
    name: String,
    disabled: bool,
    is_self: bool,
}

struct Task {
    id: String,
    title: String,
    at: f64,
}

struct BotState {
    bot: Bot,
    home_id: String,
    home: Option<Value>,
    owned: Vec<Value>,
    running: Vec<Task>,
    held: Vec<Value>,
    approvals: usize,
    routines: Vec<Value>,
    flags: Vec<String>,
    working: bool,
    last_at: f64,
}

struct Gathered {
    bots: Vec<Bot>,
    own: String,
    owned: HashMap<String, Vec<Value>>,
    rows: HashMap<String, Value>,
    capped: bool,
    watches: Vec<Value>,
    held: Vec<Value>,
    routines: Vec<Value>,
    routines_error: Option<String>,
    mixy: Bot,
    at: f64,
}

fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// `a || b` over stored values.
fn either<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(first) { first } else { second }
}

fn one_line(value: &str) -> String {
    js_words(value).collect::<Vec<_>>().join(" ")
}

fn cut(value: &str, max: usize) -> String {
    if utf16_len(value) > max { format!("{}…", js_trim_end(&slice_utf16(value, max.saturating_sub(1)))) } else { value.to_owned() }
}

/// `quotedText(value, max)`: text a bot or session wrote, one line, tag-shaped text escaped, bounded.
fn quoted(value: &str, max: usize) -> String {
    cut(&escape_harness_tags(&one_line(value)), max)
}

fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

fn is_working(row: Option<&Value>) -> bool {
    row.is_some_and(|row| row.get("working") == Some(&Value::Bool(true)) || row.get("agentWorking") == Some(&Value::Bool(true)))
}

/// `activityOf(row)`: the last activity, epoch ms, 0 when unknown.
fn activity_of(row: Option<&Value>) -> f64 {
    let Some(row) = row else { return 0.0 };
    let at = number_of(row.get("lastUsedAt"));
    if at != 0.0 { at } else { number_of(row.get("updatedAt")) }
}

/// Epoch ms of a number or ISO string; 0 when absent or invalid.
fn epoch(value: Option<&Value>) -> f64 {
    let at = match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        other => date_parse(&if truthy(other) { text(other) } else { String::new() }),
    };
    if at.is_finite() && at > 0.0 { at } else { 0.0 }
}

fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn span(ms: f64) -> String {
    let minutes = round(ms.abs() / 60_000.0);
    if minutes < 1.0 {
        return "<1m".to_owned();
    }
    if minutes < 60.0 {
        return format!("{minutes}m");
    }
    let hours = round(minutes / 60.0);
    if hours < 48.0 { format!("{hours}h") } else { format!("{}d", round(hours / 24.0)) }
}

fn ago(at: f64, now: f64) -> String {
    format!("{} ago", span(now - at))
}

fn until(at: f64, now: f64) -> String {
    if at <= now { "due now".to_owned() } else { format!("in {}", span(at - now)) }
}

/// JavaScript's `<` over strings: UTF-16 code units.
fn compare(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// Routine health words: why it is paused, failing, or holding results.
fn routine_trouble(routine: &Value) -> Vec<String> {
    let mut words = Vec::new();
    let failures = number_of(routine.get("consecutiveFailures"));
    if truthy(routine.get("ownerProblem")) {
        words.push("paused".to_owned());
    } else if failures > 0.0 {
        words.push(format!("failed {failures}x"));
    } else if epoch(routine.get("lastFailedAt")) > epoch(routine.get("lastSuccessAt")) {
        words.push("last run failed".to_owned());
    }
    if let Some(count) = routine.get("undelivered").and_then(|undelivered| undelivered.get("count")).filter(|count| truthy(Some(count))) {
        words.push(format!("{} undelivered", value_to_string(count)));
    }
    words
}

fn routine_detail(routine: &Value, now: f64) -> String {
    let mut parts: Vec<String> = Vec::new();
    let enabled = routine.get("enabled") != Some(&Value::Bool(false));
    if !enabled {
        parts.push("off".to_owned());
    }
    let next = epoch(routine.get("nextFireAt"));
    if next != 0.0 && enabled {
        parts.push(format!("next {}", until(next, now)));
    }
    if truthy(routine.get("time")) {
        parts.push(one_line(&text(routine.get("time"))));
    }
    let (success, failed_at) = (epoch(routine.get("lastSuccessAt")), epoch(routine.get("lastFailedAt")));
    if success != 0.0 {
        parts.push(format!("last ok {}", ago(success, now)));
    }
    if failed_at != 0.0 {
        parts.push(format!("last failed {}", ago(failed_at, now)));
    }
    if success == 0.0 && failed_at == 0.0 {
        parts.push("never ran".to_owned());
    }
    if number_of(routine.get("consecutiveFailures")) > 0.0 {
        parts.push(format!("failed {}x in a row", text(routine.get("consecutiveFailures"))));
    }
    if let Some(undelivered) = routine.get("undelivered").filter(|undelivered| truthy(undelivered.get("count"))) {
        let refused = if truthy(undelivered.get("failed")) {
            let why = if truthy(undelivered.get("error")) { format!(": {}", quoted(&text(undelivered.get("error")), 80)) } else { String::new() };
            format!(" (refused{why})")
        } else {
            String::new()
        };
        parts.push(format!("{} result(s) undelivered{refused}", text(undelivered.get("count"))));
    }
    if truthy(routine.get("ownerProblem")) {
        parts.push(format!("paused: {}", quoted(&text(routine.get("ownerProblem")), 80)));
    }
    cut(&format!("{} {}: {}", text(routine.get("kind")), quoted(&text(routine.get("name")), 64), parts.join(", ")), 240)
}

fn owner_of(routine: &Value) -> String {
    let owner = either(routine.get("owner"), None);
    if truthy(owner) { text(owner) } else { MIXY_AGENT_ID.to_owned() }
}

impl DirectorySessionPort {
    fn handed_by(&self, row: &Value) -> Vec<String> {
        match row.get("handedBy").and_then(Value::as_array) {
            Some(bots) => bots.iter().map(|bot| text(Some(bot))).collect(),
            None => self.parts.catalog.work_of(&text(row.get("id"))).handed_by,
        }
    }

    fn sent_work(&self, bot: &str, row: Option<&Value>) -> bool {
        row.is_some_and(|row| is_working(Some(row)) && self.handed_by(row).iter().any(|handed| handed == bot))
    }

    fn awaiting_approval(&self, id: &str) -> bool {
        self.parts.catalog.work_of(id).awaiting_approval
    }

    /// Everything known about one bot, from the gathered state.
    fn bot_state(&self, bot: &Bot, ctx: &Gathered) -> BotState {
        let home_id = agent_home_session_id(&bot.id).unwrap_or_default();
        let owned = ctx.owned.get(&bot.id).cloned().unwrap_or_default();
        let home = ctx.rows.get(&home_id).cloned();
        // Running task sessions: a turn whose report is still owed, or the bot's work running now. In first-seen order.
        let mut tasks: Vec<Task> = Vec::new();
        let mut add_task = |id: &str, title: String, at: f64| match tasks.iter_mut().find(|known| known.id == id) {
            None => tasks.push(Task { id: id.to_owned(), title, at }),
            Some(known) if at != 0.0 && (known.at == 0.0 || at < known.at) => known.at = at,
            Some(_) => {}
        };
        for watch in &ctx.watches {
            if text(watch.get("agentId")) != bot.id || watch.get("target") == Some(&json!("session")) || !truthy(watch.get("taskSessionId")) {
                continue;
            }
            add_task(&text(watch.get("taskSessionId")), text(watch.get("title")), number_of(watch.get("at")));
        }
        for row in &owned {
            let id = text(row.get("id"));
            if id == home_id || room_member_of_session(&id).is_some() || !self.sent_work(&bot.id, Some(row)) {
                continue;
            }
            add_task(&id, text(row.get("title")), number_of(row.get("createdAt")));
        }
        let mut running = tasks;
        running.sort_by(|left, right| left.at.partial_cmp(&right.at).unwrap_or(Ordering::Equal).then_with(|| compare(&left.id, &right.id)));
        let held: Vec<Value> = ctx.held.iter().filter(|entry| text(entry.get("agentId")) == bot.id).cloned().collect();
        let approvals = held.len() + std::iter::once(home_id.as_str()).chain(running.iter().map(|task| task.id.as_str())).filter(|id| self.awaiting_approval(id)).count();
        let mut routines: Vec<Value> = ctx.routines.iter().filter(|routine| owner_of(routine) == bot.id).cloned().collect();
        routines.sort_by(|left, right| compare(&text(left.get("name")), &text(right.get("name"))));
        let mut flags = Vec::new();
        if approvals > 0 {
            flags.push(format!("{} waiting", plural(approvals, "approval")));
        }
        for routine in &routines {
            let trouble = routine_trouble(routine);
            if !trouble.is_empty() {
                flags.push(format!("{} {}", quoted(&text(routine.get("name")), 20), trouble.join(", ")));
            }
        }
        if bot.disabled {
            flags.push("disabled".to_owned());
        }
        let working = is_working(home.as_ref()) || running.iter().any(|task| self.sent_work(&bot.id, ctx.rows.get(&task.id)));
        let last_at = activity_of(home.as_ref());
        BotState { bot: bot.clone(), home_id, home, owned, running, held, approvals, routines, flags, working, last_at }
    }

    fn bot_line(&self, state: &BotState, now: f64) -> String {
        let bot = &state.bot;
        let mut parts = vec![format!("{} ({})", quoted(&bot.name, 40), bot.id), format!("chat {}", state.home_id)];
        if bot.is_self {
            parts.push("you".to_owned());
        }
        parts.push(if state.working { "working" } else { "idle" }.to_owned());
        if !state.flags.is_empty() {
            parts.push(format!("attention: {}", state.flags.join("; ")));
        }
        parts.push(if state.last_at != 0.0 { format!("last {}", ago(state.last_at, now)) } else { "no chat yet".to_owned() });
        if let Some(first) = state.running.first() {
            let more = if state.running.len() > 1 { format!(" +{}", state.running.len() - 1) } else { String::new() };
            let count = if state.running.len() > 1 { format!("{} tasks:", state.running.len()) } else { "task".to_owned() };
            let age = if first.at != 0.0 { format!(" {}", span(now - first.at)) } else { String::new() };
            parts.push(format!("{count} \"{}\"{age}{more}", quoted(&first.title, 24)));
        }
        if !state.routines.is_empty() {
            let next = state.routines.iter().filter(|routine| routine.get("enabled") != Some(&Value::Bool(false)) && epoch(routine.get("nextFireAt")) != 0.0).min_by(|left, right| epoch(left.get("nextFireAt")).partial_cmp(&epoch(right.get("nextFireAt"))).unwrap_or(Ordering::Equal));
            let next = next.map(|routine| format!(", next {} {}", quoted(&text(routine.get("name")), 20), until(epoch(routine.get("nextFireAt")), now))).unwrap_or_default();
            parts.push(format!("{}{next}", plural(state.routines.len(), "routine")));
        }
        let fixed = parts.join(" · ");
        let home = state.home.as_ref();
        let preview = one_line(&text(either(home.and_then(|row| row.get("lastMessagePreview")), home.and_then(|row| row.get("preview")))));
        let room = BOT_LINE_LIMIT - utf16_len(&fixed) as i64 - 5;
        let line = if !preview.is_empty() && room >= MIN_PREVIEW { format!("{fixed} · \"{}\"", quoted(&preview, room as usize)) } else { fixed };
        cut(&line, BOT_LINE_LIMIT as usize)
    }

    /// The bots the caller sees: every bot then Mixy when she has something to show, or just the caller's own bot.
    fn visible_states(&self, ctx: &Gathered) -> Vec<BotState> {
        if !ctx.own.is_empty() {
            let bot = if ctx.own == MIXY_AGENT_ID { Some(ctx.mixy.clone()) } else { ctx.bots.first().cloned() };
            return bot.map(|bot| self.bot_state(&bot, ctx)).into_iter().collect();
        }
        let mut states: Vec<BotState> = ctx.bots.iter().map(|bot| self.bot_state(bot, ctx)).collect();
        states.sort_by(|left, right| {
            (right.flags.len() > 0).cmp(&(left.flags.len() > 0))
                .then_with(|| right.working.cmp(&left.working))
                .then_with(|| right.last_at.partial_cmp(&left.last_at).unwrap_or(Ordering::Equal))
                .then_with(|| compare(&left.bot.id, &right.bot.id))
        });
        let mixy = self.bot_state(&ctx.mixy, ctx);
        if !mixy.routines.is_empty() || !mixy.running.is_empty() || mixy.approvals > 0 {
            states.push(mixy);
        }
        states
    }

    async fn gather(&self, own: &str) -> Result<Gathered, PortError> {
        let world = &self.parts.world;
        let all = world.bots().await.map_err(failed)?;
        let watches = world.task_watches().await.map_err(failed)?;
        let held = world.held_requests().await.map_err(failed)?;
        // The automation store can be down while sessions are not: say so.
        let (routines, routines_error) = match world.routines().await {
            Ok(rows) => (rows, None),
            Err(error) => (Vec::new(), Some(cut(&format!("routines unavailable: {}", one_line(&error)), ERROR_LIMIT))),
        };
        let mixy_name = one_line(&self.parts.bots.name(MIXY_AGENT_ID).await);
        let bots: Vec<Bot> = all.into_iter().filter(|bot| own.is_empty() || bot.id == own).map(|bot| Bot { id: bot.id, name: bot.name, disabled: bot.disabled, is_self: false }).collect();
        let mixy = Bot { id: MIXY_AGENT_ID.to_owned(), name: if mixy_name.is_empty() { MIXY_AGENT_ID.to_owned() } else { mixy_name }, disabled: false, is_self: true };
        let mut ids: HashSet<String> = bots.iter().map(|bot| bot.id.clone()).collect();
        ids.insert(if own.is_empty() { MIXY_AGENT_ID.to_owned() } else { own.to_owned() });
        // Only the visible bots' sessions are kept from the bounded scan.
        let (rows, next) = self.scan_rows(&|row: &Value| ids.contains(&session_bot_of(row)), None, usize::MAX, SCAN_PAGE_ROWS).await?;
        let mut owned: HashMap<String, Vec<Value>> = HashMap::new();
        for row in &rows {
            owned.entry(session_bot_of(row)).or_default().push(row.clone());
        }
        Ok(Gathered {
            bots,
            own: own.to_owned(),
            owned,
            rows: rows.iter().map(|row| (text(row.get("id")), row.clone())).collect(),
            capped: next.is_some(),
            watches: watches.into_iter().filter(|watch| ids.contains(&text(watch.get("agentId")))).collect(),
            held: held.into_iter().filter(|entry| ids.contains(&text(entry.get("agentId")))).collect(),
            routines: routines.into_iter().filter(|routine| ids.contains(&owner_of(routine))).collect(),
            routines_error,
            mixy,
            at: self.parts.clock.now_ms() as f64,
        })
    }

    async fn overview(&self, own: &str) -> Result<Value, PortError> {
        let ctx = self.gather(own).await?;
        let states = self.visible_states(&ctx);
        let lines: Vec<Value> = states.iter().take(MAX_BOTS).map(|state| json!(self.bot_line(state, ctx.at))).collect();
        let mut result = Map::new();
        let shown = lines.len();
        result.insert("bots".to_owned(), Value::Array(lines));
        if states.len() > shown {
            result.insert("more".to_owned(), json!(states.len() - shown));
        }
        if let Some(error) = &ctx.routines_error {
            result.insert("routinesError".to_owned(), json!(error));
        }
        if ctx.capped {
            result.insert("scanNote".to_owned(), json!(SCAN_NOTE));
        }
        if shown > 0 {
            result.insert("note".to_owned(), json!(UNTRUSTED_NOTE));
            result.insert("next".to_owned(), json!(DETAIL_HINT));
        } else {
            result.insert("note".to_owned(), json!("No bots yet."));
        }
        fit_page(result, &[("bots", "more", states.len(), 1)])
    }

    async fn detail(&self, target: &str, own: &str, limit: usize) -> Result<Value, PortError> {
        let id = agent_id_of_home_session(target).filter(|id| !id.is_empty()).unwrap_or_else(|| target.to_owned());
        if !own.is_empty() && id != own {
            return Err(failed("session: this chat sees only its own bot status"));
        }
        let ctx = self.gather(own).await?;
        let bot = if id == MIXY_AGENT_ID { Some(ctx.mixy.clone()) } else { ctx.bots.iter().find(|entry| entry.id == id).cloned() };
        let Some(bot) = bot else {
            return Err(failed(format!("session: no bot \"{}\"; session action=bots lists them", quoted(&id, 64))));
        };
        let state = self.bot_state(&bot, &ctx);
        let mut known = state.owned.clone();
        known.sort_by(|left, right| activity_of(Some(right)).partial_cmp(&activity_of(Some(left))).unwrap_or(Ordering::Equal).then_with(|| compare(&text(left.get("id")), &text(right.get("id")))));
        let sessions: Vec<Value> = known
            .iter()
            .take(limit)
            .map(|row| {
                let row_id = text(row.get("id"));
                let preview = text(either(row.get("lastMessagePreview"), row.get("preview")));
                let at = activity_of(Some(row));
                let kind = if row_id == state.home_id { "chat" } else if room_member_of_session(&row_id).is_some() { "room" } else { "task" };
                let title = one_line(&text(row.get("title")));
                let title = if title.is_empty() { if kind == "chat" { bot.name.clone() } else { row_id.clone() } } else { title };
                let mut out = Map::new();
                out.insert("id".to_owned(), json!(row_id));
                out.insert("kind".to_owned(), json!(kind));
                out.insert("title".to_owned(), json!(quoted(&one_line(&title), 80)));
                if at != 0.0 {
                    out.insert("last".to_owned(), json!(ago(at, ctx.at)));
                }
                if !one_line(&preview).is_empty() {
                    out.insert("preview".to_owned(), json!(quoted(&preview, PREVIEW_LIMIT)));
                }
                if is_working(Some(row)) {
                    out.insert("working".to_owned(), json!(true));
                }
                if self.awaiting_approval(&row_id) {
                    out.insert("approvalWaiting".to_owned(), json!(true));
                }
                Value::Object(out)
            })
            .collect();
        let routines: Vec<Value> = state.routines.iter().take(MAX_ROUTINES).map(|routine| json!(routine_detail(routine, ctx.at))).collect();
        let held: Vec<Value> = state
            .held
            .iter()
            .take(MAX_HELD)
            .map(|entry| {
                let run = entry.get("run");
                let named = run.and_then(|run| run.get("name")).filter(|name| truthy(Some(name)));
                let run_text = named.map(|name| format!(" in {} {}", text(run.and_then(|run| run.get("kind"))), quoted(&value_to_string(name), 40))).unwrap_or_default();
                let expires = if epoch(entry.get("expiresAt")) != 0.0 { format!(", expires {}", until(epoch(entry.get("expiresAt")), ctx.at)) } else { String::new() };
                json!(cut(&format!("{} {}{run_text}{expires}", quoted(&text(entry.get("kind")), 20), quoted(&text(entry.get("tool")), 60)), 160))
            })
            .collect();
        let mut result = Map::new();
        result.insert("bot".to_owned(), json!(self.bot_line(&state, ctx.at)));
        if !routines.is_empty() {
            result.insert("routines".to_owned(), Value::Array(routines.clone()));
        }
        if state.routines.len() > routines.len() {
            result.insert("moreRoutines".to_owned(), json!(state.routines.len() - routines.len()));
        }
        if !held.is_empty() {
            result.insert("held".to_owned(), Value::Array(held.clone()));
        }
        if state.held.len() > held.len() {
            result.insert("moreHeld".to_owned(), json!(state.held.len() - held.len()));
        }
        if let Some(error) = &ctx.routines_error {
            result.insert("routinesError".to_owned(), json!(error));
        }
        if ctx.capped {
            result.insert("scanNote".to_owned(), json!(SCAN_NOTE));
        }
        let shown = sessions.len();
        result.insert("sessions".to_owned(), Value::Array(sessions));
        if known.len() > shown {
            result.insert("moreSessions".to_owned(), json!(known.len() - shown));
        }
        result.insert("note".to_owned(), json!(UNTRUSTED_NOTE));
        result.insert("read".to_owned(), json!(READ_HINT));
        fit_page(result, &[("sessions", "moreSessions", known.len(), 1), ("held", "moreHeld", state.held.len(), 0), ("routines", "moreRoutines", state.routines.len(), 0)])
    }

    /// `session action=bots` for the caller's scope (`scheduleCallerScope`): every bot's line, or one bot's detail.
    pub(super) async fn bots(&self, call: &ControlCall) -> Result<Value, PortError> {
        actions::caller_required(call)?;
        let Some(own) = self.scoped_bot(&call.caller_thread).await else {
            return Err(failed("session: a background run cannot read bot status"));
        };
        let limit = match call.args.get("limit").filter(|limit| !limit.is_null()) {
            None => DEFAULT_SESSIONS,
            Some(value) => value.as_f64().filter(|n| n.fract() == 0.0 && (1.0..=100.0).contains(n)).ok_or_else(|| failed("session: limit must be an integer from 1 to 100"))?,
        };
        let target = call.args.get("session_id").and_then(Value::as_str).map(js_trim).unwrap_or_default().to_owned();
        if target.is_empty() { self.overview(&own).await } else { self.detail(&target, &own, limit as usize).await }
    }

    /// `session action=status` of another session (`readSessionStatus`): its route, busy state and the work it waits on.
    pub(super) async fn session_status(&self, call: &ControlCall) -> Result<Value, PortError> {
        let request = actions::target_request(call, "status")?;
        let target = ThreadId::from(request.id.as_str());
        let header = self.target_header(&target).await?;
        let read = self.parts.requests.request(&target, "thread/read", json!({ "threadId": target.as_str() })).await.map_err(super::core)?;
        let kept = |key: &str| header.get(key).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
        // The session record carries the title; quoted like a listed one.
        let title = super::field(&header, "title").map_or(Value::Null, |title| json!(quoted_title(&title)));
        let mut out = Map::new();
        out.insert("sessionId".to_owned(), json!(request.id));
        out.insert("title".to_owned(), title);
        for key in ["cwd", "provider", "model", "effort", "autoEffort", "fast"] {
            out.insert(key.to_owned(), kept(key));
        }
        let live = self.parts.catalog.live();
        out.insert("busy".to_owned(), json!(read.pointer("/state/runtime/busy") == Some(&Value::Bool(true)) || live.own.iter().any(|id| *id == request.id)));
        // A Lead idle between turns while its agents run is still working: their results wake it, so `busy` alone would read as stalled.
        out.insert("agentsWorking".to_owned(), json!(live.agents.iter().any(|id| *id == request.id)));
        out.insert("quotaResume".to_owned(), self.parts.quota.entry(&request.id).map_or(Value::Null, |entry| entry.public()));
        Ok(Value::Object(out))
    }
}

/// Drops from the end of each `(key, more key, total, keep)` list in turn until the result fits one output page, counting what
/// was dropped in the more key.
fn fit_page(mut result: Map<String, Value>, lists: &[(&str, &str, usize, usize)]) -> Result<Value, PortError> {
    let bytes = |result: &Map<String, Value>| serde_json::to_string(result).map_or(usize::MAX, |text| text.len());
    for (key, more, total, keep) in lists {
        while bytes(&result) > PAGE_BYTES && result.get(*key).and_then(Value::as_array).is_some_and(|list| list.len() > *keep) {
            let Some(Value::Array(list)) = result.get_mut(*key) else { break };
            list.pop();
            let left = list.len();
            result.insert((*more).to_owned(), json!(total - left));
        }
    }
    if bytes(&result) > PAGE_BYTES {
        return Err(failed("session: bot status exceeds the output budget"));
    }
    Ok(Value::Object(result))
}
