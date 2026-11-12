//! `session action=bots` (`createBotStatus` of `bot-status.mjs`): the state of the user's bots,
//! read on demand. One line per bot (its home chat, last activity and latest line, whether it
//! works now, approvals waiting, routines and what needs attention); with one bot (`session_id`:
//! its id or chat id) its routines, held requests and recent sessions. Read-only over the bot
//! definitions, the session catalog with its live overlay, the report watches of task turns, the
//! held requests of unattended runs, the live approval cards and the automation store.
//! Replayed against Node's answers: `fixtures/session-tool-control/golden.json` (`bots-*`).

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::session_control::PAGE_BYTES;
use super::session_control::Row;
use super::session_control::SessionListing;
use super::session_control::UNTRUSTED_NOTE;
use super::session_control::bot_of;
use super::session_control::output_bytes;
use super::session_control::quoted_text;
use super::session_control::scan_catalog;

const BOT_LINE_LIMIT: i64 = 170;
/// Catalog rows read at most per call.
const SCAN_ROWS: usize = 2000;
const PREVIEW_LIMIT: usize = 100;
const MIN_PREVIEW: i64 = 16;
const MAX_BOTS: usize = 30;
const MAX_ROUTINES: usize = 20;
const MAX_HELD: usize = 10;
const ERROR_LIMIT: usize = 200;
const DEFAULT_SESSIONS: f64 = 10.0;
const READ_HINT: &str = "session action=read session_id=<id> reads one.";
const NO_SERVICE: &str = "session: session service is unavailable";

fn detail_hint() -> String {
    format!("session action=bots session_id=<bot id or chat id>: its routines and recent sessions; {READ_HINT}")
}

fn scan_note() -> String {
    format!("older sessions were not scanned (newest {SCAN_ROWS} only)")
}

/// What bot status reads besides the session catalog.
#[async_trait]
pub trait BotSources: Send + Sync {
    /// `listBots()` (`defaultListBots`): each contact bot `{ id, name, disabled? }`.
    async fn bots(&self) -> Result<Vec<Value>, String>;
    /// `agentTaskWatches()`: the report watches of task turns.
    async fn task_watches(&self) -> Result<Vec<Value>, String>;
    /// `pendingHeldRequests()`.
    async fn held(&self) -> Result<Vec<Value>, String>;
    /// The automation store's schedules then webhooks, each with its `kind` (`defaultRoutines`).
    async fn routines(&self) -> Result<Vec<Value>, String>;
    /// `mixyDisplayName()`.
    async fn mixy_name(&self) -> Result<String, String>;
    /// `liveSessionAwaitingApproval(sessionId) === true`.
    fn awaiting_approval(&self, session_id: &str) -> bool;
    /// `Date.now()`.
    fn now_ms(&self) -> i64;
}

/// `String(value ?? '')`.
fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// `oneLine(value)`: white space runs one space, trimmed.
fn one_line(value: Option<&Value>) -> String {
    let text = text_of(value);
    text.split(mixdog_js::is_js_space).filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ")
}

/// `quotedText(value, max)`.
fn quoted(value: Option<&Value>, max: usize) -> String {
    quoted_text(&text_of(value), max)
}

/// `cut(text, max)`.
fn cut(text: &str, max: usize) -> String {
    if utf16_len(text) > max { format!("{}…", mixdog_js::js_trim_end(&slice_utf16(text, max.saturating_sub(1)))) } else { text.to_owned() }
}

fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

fn number(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, mixdog_js::to_number)
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let n = number(value);
    if n.is_nan() { 0.0 } else { n }
}

/// `isWorking(row)`.
fn is_working(row: Option<&Row>) -> bool {
    row.is_some_and(|row| row.get("working") == Some(&Value::Bool(true)) || row.get("agentWorking") == Some(&Value::Bool(true)))
}

/// `activityOf(row)`: `Number(row?.lastUsedAt) || Number(row?.updatedAt) || 0`.
fn activity_of(row: Option<&Row>) -> f64 {
    let Some(row) = row else { return 0.0 };
    ["lastUsedAt", "updatedAt"].iter().map(|key| number(row.get(*key))).find(|n| *n != 0.0 && !n.is_nan()).unwrap_or(0.0)
}

/// `epoch(value)`: epoch ms of a number or ISO string; 0 when absent or invalid.
fn epoch(value: Option<&Value>) -> f64 {
    let at = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(value) if truthy(Some(value)) => mixdog_js::time::date_parse(&value_to_string(value)),
        _ => f64::NAN,
    };
    if at.is_finite() && at > 0.0 { at } else { 0.0 }
}

/// `Math.round` of a nonnegative number.
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn span(ms: f64) -> String {
    let minutes = round(ms.abs() / 60_000.0);
    if minutes < 1.0 {
        return "<1m".into();
    }
    if minutes < 60.0 {
        return format!("{}m", mixdog_js::number_to_string(minutes));
    }
    let hours = round(minutes / 60.0);
    if hours < 48.0 { format!("{}h", mixdog_js::number_to_string(hours)) } else { format!("{}d", mixdog_js::number_to_string(round(hours / 24.0))) }
}

fn ago(at: f64, now: f64) -> String {
    format!("{} ago", span(now - at))
}

fn until(at: f64, now: f64) -> String {
    if at <= now { "due now".into() } else { format!("in {}", span(at - now)) }
}

/// JavaScript's `<` on two strings: UTF-16 code unit order.
fn js_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `routine.owner || MIXY_AGENT_ID`.
fn owner_of(routine: &Value) -> String {
    routine.get("owner").filter(|owner| truthy(Some(owner))).map(value_to_string).unwrap_or_else(|| MIXY_AGENT_ID.to_owned())
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
    title: Option<Value>,
    at: f64,
}

struct Ctx {
    bots: Vec<Bot>,
    own: String,
    owned: HashMap<String, Vec<Row>>,
    rows: HashMap<String, Row>,
    capped: bool,
    watches: Vec<Value>,
    held: Vec<Value>,
    routines: Vec<Value>,
    routines_error: Option<String>,
    mixy: String,
    at: f64,
}

struct State {
    bot: Bot,
    home_id: Option<String>,
    home: Option<Row>,
    owned: Vec<Row>,
    running: Vec<Task>,
    held: Vec<Value>,
    approvals: usize,
    routines: Vec<Value>,
    flags: Vec<String>,
    working: bool,
    last_at: f64,
}

/// `routineTrouble(routine)`: why it is paused, failing, or holding results.
fn routine_trouble(routine: &Value) -> Vec<String> {
    let mut words = Vec::new();
    let failures = number_or_zero(routine.get("consecutiveFailures"));
    if truthy(routine.get("ownerProblem")) {
        words.push("paused".to_owned());
    } else if failures > 0.0 {
        words.push(format!("failed {}x", mixdog_js::number_to_string(failures)));
    } else if epoch(routine.get("lastFailedAt")) > epoch(routine.get("lastSuccessAt")) {
        words.push("last run failed".to_owned());
    }
    let count = routine.get("undelivered").and_then(|u| u.get("count"));
    if truthy(count) {
        words.push(format!("{} undelivered", text_of(count)));
    }
    words
}

fn routine_detail(routine: &Value, now: f64) -> String {
    let mut parts = Vec::new();
    let off = routine.get("enabled") == Some(&Value::Bool(false));
    if off {
        parts.push("off".to_owned());
    }
    let next = epoch(routine.get("nextFireAt"));
    if next != 0.0 && !off {
        parts.push(format!("next {}", until(next, now)));
    }
    if truthy(routine.get("time")) {
        parts.push(one_line(routine.get("time")));
    }
    let success = epoch(routine.get("lastSuccessAt"));
    let failed = epoch(routine.get("lastFailedAt"));
    if success != 0.0 {
        parts.push(format!("last ok {}", ago(success, now)));
    }
    if failed != 0.0 {
        parts.push(format!("last failed {}", ago(failed, now)));
    }
    if success == 0.0 && failed == 0.0 {
        parts.push("never ran".to_owned());
    }
    if number(routine.get("consecutiveFailures")) > 0.0 {
        parts.push(format!("failed {}x in a row", text_of(routine.get("consecutiveFailures"))));
    }
    let undelivered = routine.get("undelivered");
    let count = undelivered.and_then(|u| u.get("count"));
    if truthy(count) {
        let undelivered = undelivered.expect("a count is in it");
        let refused = if truthy(undelivered.get("failed")) {
            let error = if truthy(undelivered.get("error")) { format!(": {}", quoted(undelivered.get("error"), 80)) } else { String::new() };
            format!(" (refused{error})")
        } else {
            String::new()
        };
        parts.push(format!("{} result(s) undelivered{refused}", text_of(count)));
    }
    if truthy(routine.get("ownerProblem")) {
        parts.push(format!("paused: {}", quoted(routine.get("ownerProblem"), 80)));
    }
    cut(&format!("{} {}: {}", text_of_kind(routine.get("kind")), quoted(routine.get("name"), 64), parts.join(", ")), 240)
}

/// `${value}` of a field that may be missing.
fn text_of_kind(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `botState(bot, ctx)`: everything known about one bot.
fn bot_state(bot: &Bot, ctx: &Ctx, approval: &dyn Fn(&str) -> bool) -> State {
    let home_id = agent_home_session_id(&bot.id);
    let owned = ctx.owned.get(&bot.id).cloned().unwrap_or_default();
    let home = home_id.as_ref().and_then(|id| ctx.rows.get(id)).cloned();
    // Work this bot sent that is running now (`handedBy`); a turn the user typed is the user's.
    let sent_work = |row: Option<&Row>| {
        is_working(row) && row.and_then(|row| row.get("handedBy")).and_then(Value::as_array).is_some_and(|bots| bots.iter().any(|b| b.as_str() == Some(&bot.id)))
    };
    let mut tasks: Vec<Task> = Vec::new();
    let mut add_task = |id: String, title: Option<Value>, at: f64| match tasks.iter_mut().find(|task| task.id == id) {
        None => tasks.push(Task { id, title, at }),
        Some(known) => {
            if at != 0.0 && (known.at == 0.0 || at < known.at) {
                known.at = at;
            }
        }
    };
    for watch in &ctx.watches {
        let task = watch.get("taskSessionId");
        if str_of(watch, "agentId") != Some(bot.id.as_str()) || str_of(watch, "target") == Some("session") || !truthy(task) {
            continue;
        }
        add_task(text_of(task), watch.get("title").cloned(), number_or_zero(watch.get("at")));
    }
    for row in &owned {
        let id = text_of(row.get("id"));
        if Some(&id) == home_id.as_ref() || room_member_of_session(&id).is_some() || !sent_work(Some(row)) {
            continue;
        }
        add_task(id, row.get("title").cloned(), number_or_zero(row.get("createdAt")));
    }
    let mut running = tasks;
    running.sort_by(|left, right| left.at.total_cmp(&right.at).then_with(|| js_cmp(&left.id, &right.id)));
    let held: Vec<Value> = ctx.held.iter().filter(|entry| str_of(entry, "agentId") == Some(bot.id.as_str())).cloned().collect();
    let approvals = held.len() + home_id.iter().map(String::as_str).chain(running.iter().map(|task| task.id.as_str())).filter(|id| approval(id)).count();
    let mut routines: Vec<Value> = ctx.routines.iter().filter(|routine| owner_of(routine) == bot.id).cloned().collect();
    routines.sort_by(|left, right| match (left.get("name").and_then(Value::as_str), right.get("name").and_then(Value::as_str)) {
        (Some(left), Some(right)) => js_cmp(left, right),
        _ => std::cmp::Ordering::Equal,
    });
    let mut flags = Vec::new();
    if approvals > 0 {
        flags.push(format!("{} waiting", plural(approvals, "approval")));
    }
    for routine in &routines {
        let trouble = routine_trouble(routine);
        if !trouble.is_empty() {
            flags.push(format!("{} {}", quoted(routine.get("name"), 20), trouble.join(", ")));
        }
    }
    if bot.disabled {
        flags.push("disabled".to_owned());
    }
    let working = is_working(home.as_ref()) || running.iter().any(|task| sent_work(ctx.rows.get(&task.id)));
    let last_at = activity_of(home.as_ref());
    State { bot: bot.clone(), home_id, home, owned, running, held, approvals, routines, flags, working, last_at }
}

fn bot_line(state: &State, now: f64) -> String {
    let bot = &state.bot;
    let mut parts = vec![format!("{} ({})", quoted_text(&bot.name, 40), bot.id), format!("chat {}", state.home_id.as_deref().unwrap_or("null"))];
    if bot.is_self {
        parts.push("you".into());
    }
    parts.push(if state.working { "working" } else { "idle" }.into());
    if !state.flags.is_empty() {
        parts.push(format!("attention: {}", state.flags.join("; ")));
    }
    parts.push(if state.last_at != 0.0 { format!("last {}", ago(state.last_at, now)) } else { "no chat yet".into() });
    if let Some(first) = state.running.first() {
        let count = state.running.len();
        let more = if count > 1 { format!(" +{}", count - 1) } else { String::new() };
        let label = if count > 1 { format!("{count} tasks:") } else { "task".into() };
        let at = if first.at != 0.0 { format!(" {}", span(now - first.at)) } else { String::new() };
        parts.push(format!("{label} \"{}\"{at}{more}", quoted(first.title.as_ref(), 24)));
    }
    if !state.routines.is_empty() {
        let mut next: Option<&Value> = None;
        for routine in &state.routines {
            let at = epoch(routine.get("nextFireAt"));
            if routine.get("enabled") == Some(&Value::Bool(false)) || at == 0.0 {
                continue;
            }
            if next.is_none_or(|seen| at < epoch(seen.get("nextFireAt"))) {
                next = Some(routine);
            }
        }
        let next = next.map_or_else(String::new, |next| format!(", next {} {}", quoted(next.get("name"), 20), until(epoch(next.get("nextFireAt")), now)));
        parts.push(format!("{}{next}", plural(state.routines.len(), "routine")));
    }
    let fixed = parts.join(" · ");
    let home = state.home.as_ref();
    let preview = home.and_then(|home| home.get("lastMessagePreview").filter(|p| truthy(Some(p))).or_else(|| home.get("preview")));
    let preview = one_line(preview.filter(|p| truthy(Some(p))));
    let room = BOT_LINE_LIMIT - utf16_len(&fixed) as i64 - 5;
    let line = if !preview.is_empty() && room >= MIN_PREVIEW { format!("{fixed} · \"{}\"", quoted_text(&preview, room as usize)) } else { fixed };
    cut(&line, BOT_LINE_LIMIT as usize)
}

fn mixy_bot(ctx: &Ctx) -> Bot {
    Bot { id: MIXY_AGENT_ID.to_owned(), name: ctx.mixy.clone(), disabled: false, is_self: true }
}

/// `visibleStates(ctx)`: every bot then Mixy when she has something to show, or the caller's own.
fn visible_states(ctx: &Ctx, approval: &dyn Fn(&str) -> bool) -> Vec<State> {
    if !ctx.own.is_empty() {
        let bot = if ctx.own == MIXY_AGENT_ID { Some(mixy_bot(ctx)) } else { ctx.bots.first().cloned() };
        return bot.map(|bot| vec![bot_state(&bot, ctx, approval)]).unwrap_or_default();
    }
    let mut states: Vec<State> = ctx.bots.iter().map(|bot| bot_state(bot, ctx, approval)).collect();
    states.sort_by(|left, right| {
        (!right.flags.is_empty())
            .cmp(&!left.flags.is_empty())
            .then(right.working.cmp(&left.working))
            .then(right.last_at.total_cmp(&left.last_at))
            .then_with(|| js_cmp(&left.bot.id, &right.bot.id))
    });
    let mixy = bot_state(&mixy_bot(ctx), ctx, approval);
    if !mixy.routines.is_empty() || !mixy.running.is_empty() || mixy.approvals > 0 {
        states.push(mixy);
    }
    states
}

/// `fitPage(result, lists)`: drop from the end of each list in turn until `result` fits one
/// output page, counting what was dropped.
fn fit_page(mut result: Map<String, Value>, lists: &[(&str, &str, usize, usize)]) -> Result<Value, String> {
    for (key, more_key, total, keep) in lists {
        loop {
            if output_bytes(&Value::Object(result.clone())) <= PAGE_BYTES {
                break;
            }
            let Some(list) = result.get_mut(*key).and_then(Value::as_array_mut).filter(|list| list.len() > *keep) else { break };
            list.pop();
            let left = list.len();
            result.insert((*more_key).to_owned(), json!(total - left));
        }
    }
    let result = Value::Object(result);
    if output_bytes(&result) > PAGE_BYTES {
        return Err("session: bot status exceeds the output budget".into());
    }
    Ok(result)
}

/// `gather(own)`: the state of the bots `own` sees (`""` = every bot and Mixy).
async fn gather(sources: &dyn BotSources, listing: &dyn SessionListing, own: &str) -> Result<Ctx, String> {
    let all = sources.bots().await?;
    let watches = sources.task_watches().await?;
    let held = sources.held().await?;
    // The automation store can be down while sessions are not: say so.
    let (routines, routines_error) = match sources.routines().await {
        Ok(rows) => (rows, None),
        Err(error) => (Vec::new(), Some(cut(&format!("routines unavailable: {}", one_line(Some(&json!(error)))), ERROR_LIMIT))),
    };
    let mixy = sources.mixy_name().await?;
    let bots: Vec<Bot> = all
        .iter()
        .filter(|bot| own.is_empty() || str_of(bot, "id") == Some(own))
        .map(|bot| Bot {
            id: text_of(bot.get("id")),
            name: text_of(bot.get("name")),
            disabled: truthy(bot.get("disabled")),
            is_self: false,
        })
        .collect();
    let mut ids: HashSet<String> = bots.iter().map(|bot| bot.id.clone()).collect();
    ids.insert(if own.is_empty() { MIXY_AGENT_ID.to_owned() } else { own.to_owned() });
    // Only the visible bots' sessions are kept from the bounded scan.
    let scan = scan_catalog(listing, |listed| ids.contains(&bot_of(&listed.row)), None, usize::MAX, SCAN_ROWS).await?;
    let mut owned: HashMap<String, Vec<Row>> = HashMap::new();
    let mut rows: HashMap<String, Row> = HashMap::new();
    for listed in &scan.rows {
        owned.entry(bot_of(&listed.row)).or_default().push(listed.row.clone());
        rows.insert(text_of(listed.row.get("id")), listed.row.clone());
    }
    let seen = |value: &Value, key: &str| str_of(value, key).is_some_and(|id| ids.contains(id));
    let mixy = one_line(Some(&json!(mixy)));
    Ok(Ctx {
        bots,
        own: own.to_owned(),
        owned,
        rows,
        capped: scan.next_cursor.is_some(),
        watches: watches.into_iter().filter(|watch| seen(watch, "agentId")).collect(),
        held: held.into_iter().filter(|entry| seen(entry, "agentId")).collect(),
        routines: routines.into_iter().filter(|routine| ids.contains(&owner_of(routine))).collect(),
        routines_error,
        mixy: if mixy.is_empty() { MIXY_AGENT_ID.to_owned() } else { mixy },
        at: sources.now_ms() as f64,
    })
}

async fn overview(sources: &dyn BotSources, listing: &dyn SessionListing, own: &str) -> Result<Value, String> {
    let ctx = gather(sources, listing, own).await?;
    let approval = |id: &str| sources.awaiting_approval(id);
    let states = visible_states(&ctx, &approval);
    let lines: Vec<Value> = states.iter().take(MAX_BOTS).map(|state| json!(bot_line(state, ctx.at))).collect();
    let mut result = Map::new();
    let shown = lines.len();
    result.insert("bots".into(), Value::Array(lines));
    if states.len() > shown {
        result.insert("more".into(), json!(states.len() - shown));
    }
    if let Some(error) = &ctx.routines_error {
        result.insert("routinesError".into(), json!(error));
    }
    if ctx.capped {
        result.insert("scanNote".into(), json!(scan_note()));
    }
    if shown > 0 {
        result.insert("note".into(), json!(UNTRUSTED_NOTE));
        result.insert("next".into(), json!(detail_hint()));
    } else {
        result.insert("note".into(), json!("No bots yet."));
    }
    fit_page(result, &[("bots", "more", states.len(), 1)])
}

async fn detail(sources: &dyn BotSources, listing: &dyn SessionListing, target: &str, own: &str, limit: usize) -> Result<Value, String> {
    let id = agent_id_of_home_session(target).filter(|id| !id.is_empty()).unwrap_or_else(|| target.to_owned());
    if !own.is_empty() && id != own {
        return Err("session: this chat sees only its own bot status".into());
    }
    let ctx = gather(sources, listing, own).await?;
    let approval = |id: &str| sources.awaiting_approval(id);
    let bot = if id == MIXY_AGENT_ID { Some(mixy_bot(&ctx)) } else { ctx.bots.iter().find(|bot| bot.id == id).cloned() };
    let Some(bot) = bot else {
        return Err(format!("session: no bot \"{}\"; session action=bots lists them", quoted_text(&id, 64)));
    };
    let state = bot_state(&bot, &ctx, &approval);
    let mut known = state.owned.clone();
    known.sort_by(|left, right| {
        activity_of(Some(right)).total_cmp(&activity_of(Some(left))).then_with(|| js_cmp(&text_of(left.get("id")), &text_of(right.get("id"))))
    });
    let sessions: Vec<Value> = known
        .iter()
        .take(limit)
        .map(|row| {
            let id = text_of(row.get("id"));
            let preview = row.get("lastMessagePreview").filter(|p| truthy(Some(p))).or_else(|| row.get("preview"));
            let at = activity_of(Some(row));
            let kind = if Some(&id) == state.home_id.as_ref() {
                "chat"
            } else if room_member_of_session(&id).is_some() {
                "room"
            } else {
                "task"
            };
            let title = one_line(row.get("title"));
            let title = if !title.is_empty() {
                title
            } else if kind == "chat" {
                bot.name.clone()
            } else {
                id.clone()
            };
            let mut out = Map::new();
            out.insert("id".into(), row.get("id").cloned().unwrap_or(Value::Null));
            out.insert("kind".into(), json!(kind));
            out.insert("title".into(), json!(quoted_text(&title, 80)));
            if at != 0.0 {
                out.insert("last".into(), json!(ago(at, ctx.at)));
            }
            if !one_line(preview).is_empty() {
                out.insert("preview".into(), json!(quoted(preview, PREVIEW_LIMIT)));
            }
            if is_working(Some(row)) {
                out.insert("working".into(), json!(true));
            }
            if approval(&id) {
                out.insert("approvalWaiting".into(), json!(true));
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
            let run_name = run.and_then(|run| run.get("name"));
            let run = if truthy(run_name) { format!(" in {} {}", text_of_kind(run.and_then(|run| run.get("kind"))), quoted(run_name, 40)) } else { String::new() };
            let expires = epoch(entry.get("expiresAt"));
            let expires = if expires != 0.0 { format!(", expires {}", until(expires, ctx.at)) } else { String::new() };
            json!(cut(&format!("{} {}{run}{expires}", quoted(entry.get("kind"), 20), quoted(entry.get("tool"), 60)), 160))
        })
        .collect();
    let mut result = Map::new();
    result.insert("bot".into(), json!(bot_line(&state, ctx.at)));
    let (routines_shown, held_shown, sessions_shown) = (routines.len(), held.len(), sessions.len());
    if routines_shown > 0 {
        result.insert("routines".into(), Value::Array(routines));
    }
    if state.routines.len() > routines_shown {
        result.insert("moreRoutines".into(), json!(state.routines.len() - routines_shown));
    }
    if held_shown > 0 {
        result.insert("held".into(), Value::Array(held));
    }
    if state.held.len() > held_shown {
        result.insert("moreHeld".into(), json!(state.held.len() - held_shown));
    }
    if let Some(error) = &ctx.routines_error {
        result.insert("routinesError".into(), json!(error));
    }
    if ctx.capped {
        result.insert("scanNote".into(), json!(scan_note()));
    }
    result.insert("sessions".into(), Value::Array(sessions));
    if known.len() > sessions_shown {
        result.insert("moreSessions".into(), json!(known.len() - sessions_shown));
    }
    result.insert("note".into(), json!(UNTRUSTED_NOTE));
    result.insert("read".into(), json!(READ_HINT));
    fit_page(result, &[("sessions", "moreSessions", known.len(), 1), ("held", "moreHeld", state.held.len(), 0), ("routines", "moreRoutines", state.routines.len(), 0)])
}

/// `botStatus(args, { callerScope })`: `own` is the caller's `scopedBot` (`None`: a background run).
pub async fn status(sources: &dyn BotSources, listing: &dyn SessionListing, args: &Value, own: Option<String>) -> Result<Value, String> {
    let Some(own) = own else {
        return Err("session: a background run cannot read bot status".into());
    };
    let limit = match args.get("limit") {
        None | Some(Value::Null) => DEFAULT_SESSIONS,
        Some(value) => value.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0 && (1.0..=100.0).contains(n)).ok_or("session: limit must be an integer from 1 to 100")?,
    };
    let target = args.get("session_id").and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_owned()).unwrap_or_default();
    if target.is_empty() { overview(sources, listing, &own).await } else { detail(sources, listing, &target, &own, limit as usize).await }
}

/// The bot sources, bound once the home delivery and the list overlay exist (after the tool pool
/// is built). Unbound they answer as Node does without a session service.
#[derive(Default)]
pub struct LateBotSources(OnceLock<Arc<dyn BotSources>>);

impl LateBotSources {
    pub fn bind(&self, sources: Arc<dyn BotSources>) -> Result<(), &'static str> {
        self.0.set(sources).map_err(|_| "session bot sources")
    }

    fn sources(&self) -> Result<&Arc<dyn BotSources>, String> {
        self.0.get().ok_or_else(|| NO_SERVICE.to_owned())
    }
}

#[async_trait]
impl BotSources for LateBotSources {
    async fn bots(&self) -> Result<Vec<Value>, String> {
        self.sources()?.bots().await
    }
    async fn task_watches(&self) -> Result<Vec<Value>, String> {
        self.sources()?.task_watches().await
    }
    async fn held(&self) -> Result<Vec<Value>, String> {
        self.sources()?.held().await
    }
    async fn routines(&self) -> Result<Vec<Value>, String> {
        self.sources()?.routines().await
    }
    async fn mixy_name(&self) -> Result<String, String> {
        self.sources()?.mixy_name().await
    }
    fn awaiting_approval(&self, session_id: &str) -> bool {
        self.0.get().is_some_and(|sources| sources.awaiting_approval(session_id))
    }
    fn now_ms(&self) -> i64 {
        self.0.get().map_or(0, |sources| sources.now_ms())
    }
}

impl crate::run_host::late::Bound for LateBotSources {
    fn cell(&self) -> &'static str {
        "session bot sources"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// [`BotSources`] over the agent definitions and config, the home delivery's watches, the held
/// requests, the automation store, the list overlay's approval cards and the clock.
pub struct LiveBotSources {
    pub definitions: Arc<mixdog_core_agents::agents::AgentDefinitions>,
    pub config: mixdog_core_config::config::Config,
    pub delivery: Arc<mixdog_services::bots::delivery::home::AgentHomeDelivery>,
    pub held: Arc<dyn Fn() -> Vec<Value> + Send + Sync>,
    pub automation: Arc<dyn mixdog_services::channels::setup::AutomationAdmin>,
    pub overlay: Arc<dyn mixdog_core_session::session::thread_list::ListOverlay>,
    pub data_dir: std::path::PathBuf,
    pub io: mixdog_rt::InteractiveIo,
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
}

#[async_trait]
impl BotSources for LiveBotSources {
    async fn bots(&self) -> Result<Vec<Value>, String> {
        let config = self.config.agent();
        let mut bots = Vec::new();
        for id in self.definitions.custom_agent_ids().await.map_err(|e| e.to_string())? {
            let Some(definition) = self.definitions.load(&id).await.map_err(|e| e.to_string())? else { continue };
            if !mixdog_core_agents::agents::is_contact(&id, definition.kind.as_deref()) {
                continue;
            }
            let name = if definition.name.is_empty() { id.clone() } else { definition.name.clone() };
            let mut bot = Map::from_iter([("id".to_owned(), json!(id)), ("name".to_owned(), json!(name))]);
            if mixdog_core_config::config::agent_disabled(&config, &id) {
                bot.insert("disabled".into(), json!(true));
            }
            bots.push(Value::Object(bot));
        }
        Ok(bots)
    }

    async fn task_watches(&self) -> Result<Vec<Value>, String> {
        self.delivery.task_watches().await
    }

    async fn held(&self) -> Result<Vec<Value>, String> {
        Ok((self.held)())
    }

    async fn routines(&self) -> Result<Vec<Value>, String> {
        let setup = self.automation.get_channel_setup().await?;
        let mut rows = Vec::new();
        for (key, kind) in [("schedules", "schedule"), ("webhooks", "webhook")] {
            for row in setup.get(key).and_then(Value::as_array).into_iter().flatten() {
                let mut row = row.as_object().cloned().unwrap_or_default();
                row.insert("kind".into(), json!(kind));
                rows.push(Value::Object(row));
            }
        }
        Ok(rows)
    }

    async fn mixy_name(&self) -> Result<String, String> {
        let dir = self.data_dir.clone();
        mixdog_core_base::support::on_lane(self.io, &mixdog_rt::CancellationToken::new(), move |lane| mixdog_core_config::config::mixy_display_name(lane, &dir))
            .await
            .map_err(|error| format!("{error:?}"))
    }

    fn awaiting_approval(&self, session_id: &str) -> bool {
        self.overlay.of(&mixdog_core_api::ids::ThreadId::from(session_id)).awaiting_approval == Some(true)
    }

    fn now_ms(&self) -> i64 {
        (self.now_ms)()
    }
}
