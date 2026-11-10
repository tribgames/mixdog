//! The channel admin surface behind the `channel/*` methods (channel-admin.mjs and
//! channel-config-api.mjs): saving, listing, switching and deleting schedules and webhook
//! endpoints, the webhook settings, "Run now", the signed test request and the retry of an
//! undelivered result. Every mutation re-reads the runtime afterwards ("reload soon"), and
//! saving automation starts the runtime when it is not up.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::Tz;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::ports::{ChannelSettings, ProbeError, PublicBase, WebhookPatch, WebhookProbe, is_truthy};
use super::runtime::ChannelRuntime;
use crate::bots::attachments::normalize_attachments;
use crate::bots::ids::{MIXY_AGENT_ID, agent_home_session_id};
use crate::bots::owned::never_cancelled;
use crate::bots::{
    OwnedOutcome, OwnerProblem, RoutineKind, RoutineRuntime, ScheduleRunOpts, Skip, WebhookRun,
};
use crate::scheduler::cron::CronExpr;
use crate::scheduler::{Clock, Schedule, ScheduleError, ScheduleRecords};
use crate::webhooks::prompt::{webhook_event_summary, webhook_run_prompt};
use crate::webhooks::signature::hmac_hex;
use crate::webhooks::{EndpointRecord, EndpointRecords};

const PARSERS: [&str; 4] = ["github", "generic", "stripe", "sentry"];
const TEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Why an admin call failed: a message for the person, or a coded schedule refusal that keeps
/// its code and public `name`.
#[derive(Debug, Clone, PartialEq)]
pub enum AdminError {
    Message(String),
    Schedule(ScheduleError),
}

impl From<String> for AdminError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<&str> for AdminError {
    fn from(message: &str) -> Self {
        Self::Message(message.to_string())
    }
}

impl From<ScheduleError> for AdminError {
    fn from(error: ScheduleError) -> Self {
        Self::Schedule(error)
    }
}

impl std::fmt::Display for AdminError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(m) => f.write_str(m),
            Self::Schedule(e) => e.fmt(f),
        }
    }
}

type Done<T = Value> = Result<T, AdminError>;

pub struct AdminDeps {
    pub schedules: Arc<dyn ScheduleRecords>,
    pub webhooks: Arc<dyn EndpointRecords>,
    pub routines: Arc<RoutineRuntime>,
    pub runtime: Arc<ChannelRuntime>,
    pub settings: Arc<dyn ChannelSettings>,
    pub base: Arc<dyn PublicBase>,
    pub probe: Arc<dyn WebhookProbe>,
    pub clock: Arc<dyn Clock>,
    /// The zone a schedule without one runs in.
    pub local_tz: Tz,
    /// `envFlag('MIXDOG_DISABLE_CHANNEL_START')`: the runtime is never started on its own.
    pub channel_start_disabled: bool,
    /// `isCloseRequested()`: cancelled when the app starts closing.
    pub close_requested: CancellationToken,
}

pub struct ChannelAdmin {
    d: AdminDeps,
    /// Itself, for the deferred start that outlives a save call.
    this: std::sync::Weak<ChannelAdmin>,
}

/// `String(value)` for the values a save may carry.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn trimmed(value: Option<&Value>) -> String {
    mixdog_js::js_trim(&js_text(value)).to_string()
}

fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(is_truthy)
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn iso_or_none(at: Option<DateTime<Utc>>) -> Option<String> {
    at.map(iso)
}

/// Schedule names are display names, not URL identifiers: Unicode letters and digits plus
/// space, dot, underscore and hyphen, 1–64 characters.
fn assert_schedule_name(name: Option<&Value>) -> Done<String> {
    let value = trimmed(name);
    let mut chars = value.chars();
    let ok = matches!(chars.next(), Some(c) if c.is_alphanumeric())
        && mixdog_js::utf16_len(&value) <= 64
        && chars.all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'));
    if ok { Ok(value) } else { Err("schedule name must be 1-64 letters, digits, spaces, dots, underscores, or hyphens".into()) }
}

/// Webhook names are URL identifiers: `[a-z0-9][a-z0-9-]{0,63}`.
fn assert_webhook_name(name: Option<&Value>) -> Done<String> {
    let value = trimmed(name);
    let mut chars = value.chars();
    let ok = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && value.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok { Ok(value) } else { Err("webhook name must match /^[a-z0-9][a-z0-9-]{0,63}$/".into()) }
}

fn normalize_cron(time: Option<&Value>) -> Done<String> {
    let value = trimmed(time);
    match mixdog_js::js_words(&value).count() {
        5 | 6 => Ok(value),
        _ => Err("time must be a 5- or 6-field cron expression".into()),
    }
}

fn day_of_week(token: &str) -> Option<u8> {
    Some(match token {
        "sun" | "sunday" => 0,
        "mon" | "monday" => 1,
        "tue" | "tues" | "tuesday" => 2,
        "wed" | "weds" | "wednesday" => 3,
        "thu" | "thur" | "thurs" | "thursday" => 4,
        "fri" | "friday" => 5,
        "sat" | "saturday" => 6,
        digit if digit.len() == 1 && digit.as_bytes()[0] <= b'6' && digit.as_bytes()[0].is_ascii_digit() => digit.parse().ok()?,
        _ => return None,
    })
}

/// Folds a legacy `days` selector into the day-of-week (last) field of a cron expression:
/// daily → `*`, weekday → `1-5`, weekend → `0,6`, explicit lists → comma-joined numbers. An
/// unmappable token is an error, so bad combinations never silently mis-schedule.
fn fold_days_into_cron(cron: &str, days: Option<&Value>) -> Done<String> {
    let mut parts: Vec<String> = mixdog_js::js_words(cron).map(String::from).collect();
    let raw = trimmed(days).to_lowercase();
    // `days` absent keeps the cron's own day-of-week field.
    if raw.is_empty() {
        return Ok(parts.join(" "));
    }
    let dow = match raw.as_str() {
        "daily" | "everyday" | "every day" => "*".to_string(),
        "weekday" | "weekdays" => "1-5".to_string(),
        "weekend" | "weekends" => "0,6".to_string(),
        list => {
            let nums = list
                .split(|c: char| mixdog_js::is_js_space(c) || c == ',')
                .filter(|t| !t.is_empty())
                .map(day_of_week)
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| format!("days \"{}\" is not a recognizable day selector", js_text(days)))?;
            nums.iter().map(u8::to_string).collect::<Vec<_>>().join(",")
        }
    };
    if let Some(last) = parts.last_mut() {
        *last = dow;
    }
    Ok(parts.join(" "))
}

fn validate_schedule_cron(value: &str) -> Done<String> {
    let expression = mixdog_js::js_trim(value);
    let fields = mixdog_js::js_words(expression).count();
    if fields != 5 && fields != 6 {
        return Err(format!("invalid cron expression \"{expression}\": expected 5 or 6 fields").into());
    }
    CronExpr::parse(expression).map_err(|_| format!("invalid cron expression \"{expression}\""))?;
    Ok(expression.to_string())
}

fn resolve_schedule_timezone(value: Option<&Value>, local: Tz) -> Done<String> {
    let text = trimmed(value);
    let zone = if text.is_empty() { local.name().to_string() } else { text };
    zone.parse::<Tz>().map_err(|_| format!("invalid schedule timezone \"{zone}\""))?;
    Ok(zone)
}

/// `new Date(at)`: whatever `Date.parse` reads, with local time in `local`.
fn parse_at_datetime(at: &str, local: Tz) -> Done<DateTime<Utc>> {
    let raw = mixdog_js::js_trim(at);
    if raw.is_empty() {
        return Err("at must be a datetime".into());
    }
    let ms = mixdog_js::time::date_parse_in(local, raw);
    DateTime::from_timestamp_millis(ms as i64)
        .filter(|_| ms.is_finite())
        .ok_or_else(|| AdminError::from(format!("at \"{at}\" is not a valid datetime")))
}

/// Failures in a row and the results of finished runs still not queued for the owner.
fn routine_health(consecutive_failures: u32, result_delivery: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("consecutiveFailures".into(), consecutive_failures.into());
    let entries: Vec<&Value> =
        result_delivery.and_then(Value::as_object).map(|m| m.values().filter(|v| !v.is_null()).collect()).unwrap_or_default();
    if !entries.is_empty() {
        let refused = entries.iter().rev().find(|e| e["state"] == "failed");
        let mut undelivered = json!({"count": entries.len(), "failed": refused.is_some()});
        if let Some(error) = refused.and_then(|e| e["error"].as_str()).filter(|e| !e.is_empty()) {
            undelivered["error"] = error.into();
        }
        out.insert("undelivered".into(), undelivered);
    }
    out
}

fn put(out: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        out.insert(key.into(), value.into());
    }
}

/// A stored schedule as the flat display shape every reader consumes.
pub fn schedule_to_display(s: &Schedule, owner_problem: Option<OwnerProblem>) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), s.name.clone().into());
    out.insert("description".into(), s.description.clone().into());
    let time = s.when_cron.clone().or_else(|| s.when_at.map(|t| format!("at {}", iso(t)))).unwrap_or_default();
    out.insert("time".into(), time.into());
    put(&mut out, "whenAt", iso_or_none(s.when_at));
    put(&mut out, "whenCron", s.when_cron.clone());
    put(&mut out, "timezone", s.timezone.clone().filter(|t| !t.is_empty()));
    put(&mut out, "cwd", s.cwd.clone().filter(|c| !c.is_empty()));
    if let Some(attachments) = s.attachments.clone().filter(|a| !a.is_null()) {
        out.insert("attachments".into(), attachments);
    }
    out.insert("enabled".into(), s.enabled.into());
    out.insert("instructions".into(), s.prompt.clone().into());
    // The bot it belongs to: each run is a turn in that bot's chat.
    let owner = if s.owner_agent_id.is_empty() { MIXY_AGENT_ID } else { &s.owner_agent_id };
    out.insert("owner".into(), owner.into());
    out.insert("executorAgentId".into(), s.executor_agent_id.clone().filter(|e| !e.is_empty()).into());
    if let Some(problem) = owner_problem {
        out.insert("ownerProblem".into(), problem.code().into());
    }
    put(&mut out, "nextFireAt", iso_or_none(s.next_fire_at));
    put(&mut out, "lastSuccessAt", iso_or_none(s.last_success_at));
    put(&mut out, "lastFailedAt", iso_or_none(s.last_failed_at));
    put(&mut out, "lastSkippedAt", iso_or_none(s.last_skipped_at));
    out.extend(routine_health(s.consecutive_failures, s.result_delivery.as_ref()));
    Value::Object(out)
}

fn webhook_to_display(e: &EndpointRecord, owner_problem: Option<OwnerProblem>) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), e.name.clone().into());
    out.insert("description".into(), e.description.clone().into());
    out.insert("parser".into(), e.parser.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| "github".into()).into());
    put(&mut out, "cwd", e.cwd.clone().filter(|c| !c.is_empty()));
    if let Some(attachments) = e.attachments.clone().filter(|a| !a.is_null()) {
        out.insert("attachments".into(), attachments);
    }
    out.insert("enabled".into(), e.enabled.into());
    // The list never carries the plaintext secret, only whether one is set.
    out.insert("secretSet".into(), e.secret.as_deref().is_some_and(|s| !mixdog_js::js_trim(s).is_empty()).into());
    out.insert("instructions".into(), e.instructions.clone().into());
    let owner = if e.owner_agent_id.is_empty() { MIXY_AGENT_ID } else { &e.owner_agent_id };
    out.insert("owner".into(), owner.into());
    out.insert("executorAgentId".into(), e.executor_agent_id.clone().filter(|x| !x.is_empty()).into());
    if let Some(problem) = owner_problem {
        out.insert("ownerProblem".into(), problem.code().into());
    }
    put(&mut out, "lastEventAt", iso_or_none(e.last_event_at));
    put(&mut out, "lastSuccessAt", iso_or_none(e.last_success_at));
    put(&mut out, "lastFailedAt", iso_or_none(e.last_failed_at));
    put(&mut out, "lastSkippedAt", iso_or_none(e.last_skipped_at));
    // Whether "Run now" has a received payload to re-run (never the payload).
    out.insert("hasLastPayload".into(), e.last_payload.is_some().into());
    out.extend(routine_health(e.consecutive_failures, e.result_delivery.as_ref()));
    Value::Object(out)
}

/// Why a "Run now" did not run: its owner bot is missing, or a run is going.
fn skipped_run_message(name: &str, skip: Skip) -> String {
    match skip {
        Skip::Owner(problem) => format!("\"{name}\" is paused: {}", problem.message()),
        _ => format!("\"{name}\" is still running; this run was skipped"),
    }
}

/// Whether `a` fires when `b` does: the same cron in the same zone, or the same instant.
fn same_timing(existing: &Schedule, when_cron: &Option<String>, when_at: Option<DateTime<Utc>>, timezone: &Option<String>, local: Tz) -> bool {
    if &existing.when_cron != when_cron {
        return false;
    }
    if when_cron.is_some() {
        // A stored row without a zone runs in the default one.
        let stored = existing.timezone.clone().filter(|t| !mixdog_js::js_trim(t).is_empty()).unwrap_or_else(|| local.name().to_string());
        if Some(&stored) != timezone.as_ref() {
            return false;
        }
    }
    existing.when_at == when_at
}

impl ChannelAdmin {
    pub fn new(deps: AdminDeps) -> Arc<Self> {
        Arc::new_cyclic(|this| Self { d: deps, this: this.clone() })
    }

    // ---- reads -------------------------------------------------------------------------

    pub fn get_channel_worker_status(&self) -> Value {
        self.d.runtime.status().to_json()
    }

    pub fn get_channel_settings(&self, options: &Value) -> Value {
        if options["includeStatus"] == Value::Bool(false) { json!({}) } else { json!({"status": self.get_channel_worker_status()}) }
    }

    async fn owner_problem_of(&self, owner: &str) -> Option<OwnerProblem> {
        let owner = if owner.is_empty() { MIXY_AGENT_ID } else { owner };
        self.d.routines.host().owner_problem(owner, true).await.ok().flatten()
    }

    pub async fn list_schedules(&self) -> Done<Vec<Value>> {
        let rows = self.d.schedules.list().await?;
        let mut seen = std::collections::HashMap::new();
        let mut shown = Vec::new();
        for row in &rows {
            let owner = if row.owner_agent_id.is_empty() { MIXY_AGENT_ID } else { row.owner_agent_id.as_str() };
            if !seen.contains_key(owner) {
                seen.insert(owner.to_string(), self.owner_problem_of(owner).await);
            }
            let problem = seen[owner];
            // An archived bot's routines are hidden until it is restored.
            if problem != Some(OwnerProblem::OwnerArchived) {
                shown.push(schedule_to_display(row, problem));
            }
        }
        Ok(shown)
    }

    pub async fn list_webhooks(&self) -> Done<Vec<Value>> {
        let rows = self.d.webhooks.list().await?;
        let mut seen = std::collections::HashMap::new();
        let mut shown = Vec::new();
        for row in &rows {
            let owner = if row.owner_agent_id.is_empty() { MIXY_AGENT_ID } else { row.owner_agent_id.as_str() };
            if !seen.contains_key(owner) {
                seen.insert(owner.to_string(), self.owner_problem_of(owner).await);
            }
            let problem = seen[owner];
            if problem != Some(OwnerProblem::OwnerArchived) {
                shown.push(webhook_to_display(row, problem));
            }
        }
        Ok(shown)
    }

    /// Any enabled schedule or webhook endpoint: what decides whether the runtime boots.
    pub async fn has_active_automation(&self) -> bool {
        let (Ok(schedules), Ok(webhooks)) = (self.list_schedules().await, self.list_webhooks().await) else {
            return false;
        };
        schedules.iter().chain(webhooks.iter()).any(|row| row["enabled"] != Value::Bool(false))
    }

    pub async fn get_channel_setup(&self) -> Done {
        let webhook = self.d.settings.webhook().await?;
        let mut view = serde_json::to_value(webhook).map_err(|e| e.to_string())?;
        // `channelSetup` (channel-admin.mjs:707-715) reads the rows first and the identity file
        // after them, so a start that lands in between shows its identity with the older rows.
        let schedules = self.list_schedules().await?;
        let webhooks = self.list_webhooks().await?;
        view["publicUrl"] = self.d.base.hook_public_base().await?.into();
        Ok(json!({"webhook": view, "schedules": schedules, "webhooks": webhooks}))
    }

    // ---- the settings and the runtime --------------------------------------------------

    /// Re-reads the runtime in the background, as the app does after any change.
    fn reload_soon(&self) {
        let runtime = Arc::clone(&self.d.runtime);
        tokio::spawn(async move {
            if let Err(error) = runtime.reload_runtime().await {
                tracing::warn!("mixdog channels: reload failed: {error}");
            }
        });
    }

    /// `scheduleChannelStart(0)` / `scheduleAutomationAutostart`: returns at once; the start
    /// happens afterwards, owned by the runtime (a shutdown ends and joins it). When the
    /// deferred callback runs it asks `hasActiveAutomation` (`onChannelStartTimer`): only enabled
    /// schedules or webhooks start the runtime (a no-op when it is up), and
    /// `MIXDOG_DISABLE_CHANNEL_START` or a close in progress starts nothing. A save calls it after
    /// its reload request (`ensureAutomationRuntime`); the daemon calls it once it is serving,
    /// which is the boot-time start check.
    pub fn schedule_automation_start(&self) {
        self.schedule_start(true);
    }

    /// The session directory's busy state (`getActiveTurnCount() > 0` / `getSessionCreatePromise()`).
    pub fn bind_busy(&self, probe: super::runtime::BusyProbe) {
        self.d.runtime.bind_busy(probe);
    }

    /// `wakeDeferredWarmups()`: the busy state changed.
    pub fn wake_deferred_start(&self) {
        self.d.runtime.wake_parked_start();
    }

    /// `scheduleAutomationAutostart`: the boot-time start, which does not wait for an idle runtime.
    pub fn schedule_automation_autostart(&self) {
        self.schedule_start(false);
    }

    fn schedule_start(&self, busy_aware: bool) {
        if self.d.channel_start_disabled {
            return;
        }
        let Some(admin) = self.this.upgrade() else { return };
        let active: super::runtime::ActiveProbe = Arc::new(move || {
            let admin = Arc::clone(&admin);
            Box::pin(async move { admin.has_active_automation().await })
        });
        self.d.runtime.schedule_automation_start(&self.d.close_requested, active, busy_aware);
    }

    pub async fn set_webhook_config(&self, patch: &Value) -> Done {
        let settings = self.d.settings.update_webhook(&WebhookPatch::from_params(patch)).await?;
        self.reload_soon();
        Ok(json!({"webhook": settings}))
    }

    // ---- schedules ---------------------------------------------------------------------

    fn schedule_owner(owner: Option<&Value>, existing: Option<&str>) -> Done<String> {
        let value = trimmed(owner);
        if !value.is_empty() {
            if agent_home_session_id(&value).is_none() {
                return Err(format!("schedule owner \"{value}\" is not a valid agent id").into());
            }
            return Ok(value);
        }
        Ok(existing.filter(|e| !e.is_empty()).unwrap_or(MIXY_AGENT_ID).to_string())
    }

    async fn assert_owner(&self, owner: &str) -> Done<()> {
        match self.d.routines.host().owner_problem(owner, false).await? {
            Some(problem) => Err(problem.message().into()),
            None => Ok(()),
        }
    }

    /// A save's executor: absent keeps the saved one on an overwrite; null or `""` clears it;
    /// an id must be a delegatable sub-agent.
    async fn routine_executor(&self, value: Option<&Value>, existing: Option<&str>) -> Done<Option<String>> {
        match value {
            None => Ok(existing.filter(|e| !e.is_empty()).map(String::from)),
            Some(value) => Ok(self.d.routines.assert_routine_executor(value).await?),
        }
    }

    /// Moves a schedule row while no run of it can start or be in flight. The name is
    /// reserved against this process's runs; while the runtime is up the scheduler's owner
    /// performs the run check and the move in one step.
    async fn rename_schedule_row(&self, old: &str, def: &Schedule, timing_changed: bool) -> Done<Option<Schedule>> {
        let _reserved = self
            .d
            .routines
            .runs()
            .begin(RoutineKind::Schedule, old)
            .ok_or_else(|| ScheduleError::RenameRunning { name: old.to_string() })?;
        if !self.d.runtime.automation_running() {
            return Ok(self.d.schedules.rename(old, def, timing_changed).await?);
        }
        let def_json = serde_json::to_value(def).map_err(|e| e.to_string())?;
        let reply = crate::channels::tools::ChannelLifecycle::rename_schedule(&*self.d.runtime, old, &def_json, timing_changed).await;
        match reply {
            Ok(saved) if saved.is_null() => Ok(None),
            Ok(saved) => Ok(Some(serde_json::from_value(saved).map_err(|e| e.to_string())?)),
            Err(error) => {
                // Whatever it did, have the runtime re-read the schedules.
                self.reload_soon();
                Err(error.into())
            }
        }
    }

    /// The owner checked at save may have been deleted for good meanwhile, its routines purged
    /// before this row landed: the row then goes the way of the bot's others and the save is
    /// refused. An owner archived meanwhile keeps the row, hidden until a restore.
    async fn refuse_if_owner_deleted(&self, owner: &str) -> Done<()> {
        let problem = self.d.routines.host().owner_problem(owner, false).await.ok().flatten();
        if problem != Some(OwnerProblem::OwnerDeleted) {
            return Ok(());
        }
        self.delete_owned_routines(owner).await?;
        Err(OwnerProblem::OwnerDeleted.message().into())
    }

    /// Deletes every schedule and webhook `agent_id` owns, as its bot is deleted for good;
    /// resolves the names removed. Mixy is never a target.
    pub async fn delete_owned_routines(&self, agent_id: &str) -> Done {
        if agent_home_session_id(agent_id).is_none() || agent_id == MIXY_AGENT_ID || agent_id == crate::bots::ids::MIXY_BOT_ID {
            return Err(format!("the routines of \"{agent_id}\" cannot be deleted with a bot").into());
        }
        let (mut schedules, mut webhooks) = (Vec::new(), Vec::new());
        for row in self.d.schedules.list().await?.into_iter().filter(|s| s.owner_agent_id == agent_id) {
            self.d.schedules.delete(&row.name).await?;
            schedules.push(row.name);
        }
        for row in self.d.webhooks.list().await?.into_iter().filter(|e| e.owner_agent_id == agent_id) {
            self.d.webhooks.delete(&row.name).await?;
            webhooks.push(row.name);
        }
        Ok(json!({"schedules": schedules, "webhooks": webhooks}))
    }

    /// Registers or updates a schedule. Recurring input maps `time` (+ optional `days`) to a
    /// cron; one-shot input maps an `at` datetime; the two are mutually exclusive.
    pub async fn save_schedule(&self, entry: &Value) -> Done {
        let saved = self.save_schedule_row(entry).await?;
        self.reload_soon();
        self.schedule_automation_start();
        Ok(saved)
    }

    async fn save_schedule_row(&self, entry: &Value) -> Done {
        let id = assert_schedule_name(entry.get("name"))?;
        let rename_to = if !trimmed(entry.get("newName")).is_empty() {
            assert_schedule_name(entry.get("newName"))?
        } else {
            id.clone()
        };
        let renaming = rename_to != id;
        let body = trimmed(entry.get("instructions"));
        if body.is_empty() {
            return Err("schedule instructions are required".into());
        }
        let has_time = entry.get("time").is_some_and(|v| !v.is_null()) && !trimmed(entry.get("time")).is_empty();
        let has_at = entry.get("at").is_some_and(|v| !v.is_null()) && !trimmed(entry.get("at")).is_empty();
        if has_time && has_at {
            return Err("provide either `time` (recurring) or `at` (one-shot), not both".into());
        }
        if !has_time && !has_at {
            return Err("either `time` (recurring cron) or `at` (one-shot datetime) is required".into());
        }
        let existing = self.d.schedules.get(&id).await?;
        if renaming && existing.is_none() {
            return Err(format!("schedule \"{id}\" does not exist").into());
        }
        if entry.get("overwrite") != Some(&Value::Bool(true)) && existing.is_some() {
            return Err(ScheduleError::NameTaken { name: id }.into());
        }
        let owner = Self::schedule_owner(entry.get("owner"), existing.as_ref().map(|e| e.owner_agent_id.as_str()))?;
        self.assert_owner(&owner).await?;
        let executor = self.routine_executor(entry.get("executorAgentId"), existing.as_ref().and_then(|e| e.executor_agent_id.as_deref())).await?;
        let when_cron = if has_time {
            Some(validate_schedule_cron(&fold_days_into_cron(&normalize_cron(entry.get("time"))?, entry.get("days"))?)?)
        } else {
            None
        };
        let when_at = if has_at { Some(parse_at_datetime(&js_text(entry.get("at")), self.d.local_tz)?) } else { None };
        let timezone = if has_time { Some(resolve_schedule_timezone(entry.get("timezone"), self.d.local_tz)?) } else { None };
        let def = Schedule {
            name: rename_to.clone(),
            description: trimmed(entry.get("description")),
            when_cron: when_cron.clone(),
            when_at,
            timezone: timezone.clone(),
            cwd: truthy(entry.get("cwd")).then(|| trimmed(entry.get("cwd"))),
            attachments: normalize_attachments(entry.get("attachments").unwrap_or(&Value::Null))?,
            delivery: Some("app".into()),
            prompt: body,
            enabled: entry.get("enabled") != Some(&Value::Bool(false)),
            next_fire_at: when_at,
            owner_agent_id: owner.clone(),
            executor_agent_id: executor,
            ..Schedule::default()
        };
        let saved = if renaming {
            if self.d.schedules.get(&rename_to).await?.is_some() {
                return Err(ScheduleError::NameTaken { name: rename_to }.into());
            }
            let timing_changed = !same_timing(existing.as_ref().expect("checked above"), &when_cron, when_at, &timezone, self.d.local_tz);
            self.rename_schedule_row(&id, &def, timing_changed).await?.ok_or_else(|| format!("schedule \"{id}\" does not exist"))?
        } else {
            self.d.schedules.upsert(&def).await?
        };
        self.refuse_if_owner_deleted(&owner).await?;
        Ok(schedule_to_display(&saved, None))
    }

    pub async fn delete_schedule(&self, name: &str) -> Done {
        let id = assert_schedule_name(Some(&json!(name)))?;
        self.d.schedules.delete(&id).await?;
        self.reload_soon();
        Ok(json!({"name": id, "deleted": true}))
    }

    pub async fn set_schedule_enabled(&self, name: &str, enabled: bool) -> Done {
        let id = assert_schedule_name(Some(&json!(name)))?;
        self.d.schedules.set_enabled(&id, enabled).await?.ok_or_else(|| format!("schedule \"{id}\" does not exist"))?;
        self.reload_soon();
        if enabled {
            self.schedule_automation_start();
        }
        Ok(json!({"name": id, "enabled": enabled}))
    }

    // ---- webhooks ----------------------------------------------------------------------

    pub async fn save_webhook(&self, entry: &Value) -> Done {
        let saved = self.save_webhook_row(entry).await?;
        self.reload_soon();
        self.schedule_automation_start();
        Ok(saved)
    }

    async fn save_webhook_row(&self, entry: &Value) -> Done {
        let id = assert_webhook_name(entry.get("name"))?;
        let parser = match trimmed(entry.get("parser")).to_lowercase() {
            p if p.is_empty() => "github".to_string(),
            p => p,
        };
        if !PARSERS.contains(&parser.as_str()) {
            return Err("parser must be github, generic, stripe, or sentry".into());
        }
        let body = trimmed(entry.get("instructions"));
        if body.is_empty() {
            return Err("webhook instructions are required".into());
        }
        let overwrite = entry.get("overwrite") == Some(&Value::Bool(true));
        let existing = self.d.webhooks.load(&id).await?;
        if !overwrite && existing.is_some() {
            return Err(format!("webhook \"{id}\" already exists").into());
        }
        let owner = Self::schedule_owner(entry.get("owner"), existing.as_ref().map(|e| e.owner_agent_id.as_str()))?;
        self.assert_owner(&owner).await?;
        let executor = self.routine_executor(entry.get("executorAgentId"), existing.as_ref().and_then(|e| e.executor_agent_id.as_deref())).await?;
        // An explicit secret always wins; an EMPTY value on an overwrite PRESERVES the stored
        // one (editing instructions must not silently rotate the key the external service was
        // configured with); only a brand-new endpoint mints a random secret.
        let explicit = trimmed(entry.get("secret"));
        let secret = if !explicit.is_empty() {
            explicit
        } else {
            let stored = if overwrite { mixdog_js::js_trim(existing.as_ref().and_then(|e| e.secret.as_deref()).unwrap_or_default()).to_string() } else { String::new() };
            if stored.is_empty() { random_secret() } else { stored }
        };
        let def = EndpointRecord {
            name: id.clone(),
            description: trimmed(entry.get("description")),
            parser: Some(parser),
            secret: Some(secret.clone()),
            cwd: truthy(entry.get("cwd")).then(|| trimmed(entry.get("cwd"))),
            attachments: normalize_attachments(entry.get("attachments").unwrap_or(&Value::Null))?,
            delivery: Some("app".into()),
            instructions: body.clone(),
            enabled: entry.get("enabled") != Some(&Value::Bool(false)),
            owner_agent_id: owner.clone(),
            executor_agent_id: executor,
            ..EndpointRecord::default()
        };
        let saved = self.d.webhooks.upsert(&def).await?;
        self.refuse_if_owner_deleted(&owner).await?;
        let mut out = Map::new();
        out.insert("name".into(), id.into());
        out.insert("owner".into(), if saved.owner_agent_id.is_empty() { owner } else { saved.owner_agent_id.clone() }.into());
        out.insert("executorAgentId".into(), saved.executor_agent_id.clone().filter(|e| !e.is_empty()).into());
        out.insert("description".into(), saved.description.clone().into());
        out.insert("parser".into(), saved.parser.clone().into());
        if let Some(cwd) = saved.cwd.clone().filter(|c| !c.is_empty()) {
            out.insert("cwd".into(), cwd.into());
        }
        if let Some(attachments) = saved.attachments.clone().filter(|a| !a.is_null()) {
            out.insert("attachments".into(), attachments);
        }
        if entry.get("enabled") == Some(&Value::Bool(false)) {
            out.insert("enabled".into(), false.into());
        }
        out.insert("secret".into(), secret.into());
        out.insert("instructions".into(), body.into());
        Ok(Value::Object(out))
    }

    pub async fn delete_webhook(&self, name: &str) -> Done {
        let id = assert_webhook_name(Some(&json!(name)))?;
        self.d.webhooks.delete(&id).await?;
        self.reload_soon();
        Ok(json!({"name": id, "deleted": true}))
    }

    pub async fn set_webhook_enabled(&self, name: &str, enabled: bool) -> Done {
        let id = assert_webhook_name(Some(&json!(name)))?;
        self.d.webhooks.set_enabled(&id, enabled).await?.ok_or_else(|| format!("webhook \"{id}\" does not exist"))?;
        self.reload_soon();
        if enabled {
            self.schedule_automation_start();
        }
        Ok(json!({"name": id, "enabled": enabled}))
    }

    /// Sends a correctly signed, test-flagged request to the endpoint's real public URL. The
    /// receiver verifies the signature and answers without dispatching. Failures carry a
    /// stable `code` (relay-unavailable | timeout | network | rejected) for localized UI text;
    /// `error` stays the English detail.
    pub async fn test_webhook(&self, name: &str) -> Done {
        use crate::webhooks::handler::{WEBHOOK_TEST_FIELD, WEBHOOK_TEST_HEADER};
        let id = assert_webhook_name(Some(&json!(name)))?;
        let endpoint = self.d.webhooks.load(&id).await?.ok_or_else(|| format!("webhook \"{id}\" does not exist"))?;
        let secret = endpoint.secret.clone().unwrap_or_default();
        let base = self.d.base.hook_public_base().await?.unwrap_or_default().trim_end_matches('/').to_string();
        if base.is_empty() {
            return Ok(json!({
                "name": id, "ok": false, "status": 0, "url": "", "code": "relay-unavailable",
                "error": "Endpoint URL is not available yet — the relay is not connected.",
            }));
        }
        let url = format!("{base}/webhook/{}", percent_encode(&id));
        let sent_at = iso(self.d.clock.now());
        let mut probe = Map::new();
        probe.insert(WEBHOOK_TEST_FIELD.into(), true.into());
        probe.insert("webhook".into(), id.clone().into());
        probe.insert("sentAt".into(), sent_at.into());
        let body = Value::Object(probe).to_string();
        let sign = |data: &str| hmac_hex(&secret, data.as_bytes());
        let mut headers = vec![("content-type".to_string(), "application/json".to_string()), (WEBHOOK_TEST_HEADER.to_string(), "1".to_string())];
        match endpoint.parser.as_deref().filter(|p| !p.is_empty()).unwrap_or("github") {
            "stripe" => {
                let t = self.d.clock.now().timestamp();
                headers.push(("stripe-signature".into(), format!("t={t},v1={}", sign(&format!("{t}.{body}")))));
            }
            "sentry" => headers.push(("sentry-hook-signature".into(), sign(&body))),
            "generic" => headers.push(("x-signature-256".into(), format!("sha256={}", sign(&body)))),
            _ => {
                headers.push(("x-hub-signature-256".into(), format!("sha256={}", sign(&body))));
                headers.push(("x-github-event".into(), "ping".into()));
            }
        }
        Ok(match self.d.probe.post(&url, &headers, body, TEST_TIMEOUT).await {
            Ok(response) => {
                let parsed: Value = serde_json::from_str(&response.body).unwrap_or_else(|_| json!({}));
                let ok = response.status == 200 && parsed["status"] == "verified";
                let mut result = json!({"name": id, "ok": ok, "status": response.status, "url": url});
                if !ok {
                    result["code"] = "rejected".into();
                    result["error"] = match parsed["error"].as_str().filter(|e| !e.is_empty()) {
                        Some(error) => error.to_string(),
                        None => format!("Unexpected response (HTTP {})", response.status),
                    }
                    .into();
                }
                result
            }
            Err(ProbeError::TimedOut) => json!({
                "name": id, "ok": false, "status": 0, "url": url, "code": "timeout",
                "error": "Request timed out after 15 seconds.",
            }),
            Err(ProbeError::Network(message)) => json!({
                "name": id, "ok": false, "status": 0, "url": url, "code": "network", "error": message,
            }),
        })
    }

    // ---- run now -----------------------------------------------------------------------

    pub async fn run_schedule_now(&self, name: &str) -> Done {
        let id = mixdog_js::js_trim(name).to_string();
        // The name is held from the read of the row through the outcome stamps, so a rename
        // can neither move the row this run read nor slip in before its stamps are written.
        let Some(_held) = self.d.routines.runs().begin(RoutineKind::Schedule, &id) else {
            // A run or a rename holding it: not run, recorded as an overlap skip.
            let _ = self.d.schedules.mark_skipped(&id, self.d.clock.now()).await;
            return Err(skipped_run_message(&id, Skip::Overlap).into());
        };
        let schedule = self.d.schedules.get(&id).await?.ok_or_else(|| format!("schedule \"{id}\" does not exist"))?;
        // Asked for by a person: no failure backoff.
        let opts = ScheduleRunOpts { attended: true, reserved: true, ..ScheduleRunOpts::default() };
        let outcome = match self.d.routines.run_schedule(&schedule, opts).await {
            Ok(outcome) => outcome,
            Err(error) => {
                let _ = self.d.schedules.mark_failure(&schedule.name, self.d.clock.now()).await;
                return Err(error.into());
            }
        };
        match outcome {
            OwnedOutcome::Skipped(skip) => Err(skipped_run_message(&schedule.name, skip).into()),
            OwnedOutcome::Ran(run) => {
                // The run's outcome shows as the schedule's last run, like a timed fire.
                let _ = self.d.schedules.mark_success(&schedule.name, self.d.clock.now()).await;
                Ok(json!({"name": schedule.name, "ok": true, "sessionId": run.session_id, "result": run.result}))
            }
        }
    }

    /// Re-runs the endpoint on its latest received payload, with its current instructions,
    /// behind the same untrusted-data fence as a live delivery.
    pub async fn run_webhook_now(&self, name: &str) -> Done {
        let id = mixdog_js::js_trim(name).to_string();
        let endpoint = self.d.webhooks.load(&id).await?.ok_or_else(|| format!("webhook \"{id}\" does not exist"))?;
        let payload = self
            .d
            .webhooks
            .last_payload(&id)
            .await?
            .ok_or_else(|| format!("webhook \"{id}\" has not received a payload yet"))?;
        let headers: std::collections::BTreeMap<String, String> = payload["headers"]
            .as_object()
            .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
            .unwrap_or_default();
        let body = if payload["body"].is_null() { json!({}) } else { payload["body"].clone() };
        let run = webhook_run_prompt(&endpoint.instructions, &body, &headers);
        let outcome = self
            .d
            .routines
            .run_webhook(
                WebhookRun {
                    name: endpoint.name.clone(),
                    owner_agent_id: Some(endpoint.owner_agent_id.clone()).filter(|o| !o.is_empty()),
                    executor_agent_id: endpoint.executor_agent_id.clone().filter(|e| !e.is_empty()),
                    cwd: endpoint.cwd.clone().filter(|c| !c.is_empty()),
                    attachments: endpoint.attachments.clone(),
                    event: webhook_event_summary(&headers, &body),
                    prompt: run.prompt,
                    skill_selection: run.skill_selection,
                },
                true,
                never_cancelled(),
            )
            .await?;
        match outcome {
            OwnedOutcome::Skipped(skip) => Err(skipped_run_message(&endpoint.name, skip).into()),
            OwnedOutcome::Ran(run) => Ok(json!({"name": endpoint.name, "ok": true, "sessionId": run.session_id, "result": run.result})),
        }
    }

    /// Queues again the result a finished run could not deliver; never reruns it.
    pub async fn retry_routine_delivery(&self, kind: &str, name: &str) -> Done {
        Ok(self.d.routines.retry_routine_delivery(kind, mixdog_js::js_trim(name)).await?)
    }
}

/// 24 random bytes as hex.
fn random_secret() -> String {
    let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    a.as_bytes().iter().chain(b.as_bytes()).take(24).map(|byte| format!("{byte:02x}")).collect()
}

/// `encodeURIComponent` for a name already limited to `[a-z0-9-]`.
fn percent_encode(name: &str) -> String {
    name.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}
