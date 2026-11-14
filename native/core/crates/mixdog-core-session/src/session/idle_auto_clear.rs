//! Idle auto-clear (`tui/session/session-flow/auto-clear.mjs` and `runtime/shared/idle-auto-clear-gate.mjs`): before a
//! submit or a completion wake, a thread that has sat idle past its window, with a context of some size, is compacted
//! (never cleared after the compaction: that would discard what the compactor kept). The compaction is awaited for at
//! most a minute, which bounds how long the input stays blocked, not the compaction: one that outlasts it keeps
//! running, and the late result is applied once the thread is not busy, with a notice.
//!
//! The driver works against an [`AutoClearHost`], which is the thread: its busy state, its queue, its compaction and
//! what is shown of the clear.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Value;

use super::gateway_usage::event::truthy;

/// `AUTO_CLEAR_COMPACT_TIMEOUT_MS`: the bound on the awaited idle compaction. Without one a stalled compaction wedges
/// the thread's command state and suppresses the input drain. Not to be raised to cover compaction worst cases.
pub const AUTO_CLEAR_COMPACT_TIMEOUT_MS: u64 = 60_000;

/// `LATE_COMPLETION_NOTICE`.
pub const LATE_COMPLETION_NOTICE: &str = "auto-clear completed late; compacted conversation retained";

/// The auto-clear state of the config (`autoClearState()`): `enabled`, `idleMs` and `minContextPercent`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IdleConfig {
    pub enabled: bool,
    pub idle_ms: f64,
    /// `None` is the default, ten percent.
    pub min_context_percent: Option<f64>,
}

/// What `runtime.contextStatus()` reports of a thread's context; a field that is not reported is 0.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ContextStatus {
    pub used_tokens: f64,
    pub current_estimated_tokens: f64,
    pub compaction_current_estimated_tokens: f64,
    pub compaction_trigger_tokens: f64,
    pub compaction_auto_compact_token_limit: f64,
    /// `runtime.session.autoCompactTokenLimit`.
    pub session_auto_compact_token_limit: f64,
}

/// `contextUsageBelowThreshold(runtime, minContextPercent)`: a zero is often an unavailable or stale meter field, not a
/// measurement, so it never masks the sibling live estimate; with no usable measure the context counts as below.
fn context_usage_below_threshold(status: &ContextStatus, min_percent: f64) -> bool {
    if !(min_percent > 0.0) {
        return false;
    }
    let used = [status.used_tokens, status.current_estimated_tokens, status.compaction_current_estimated_tokens].into_iter().fold(0.0_f64, |best, n| if n.is_finite() && n > best { n } else { best });
    let trigger = [status.compaction_trigger_tokens, status.compaction_auto_compact_token_limit, status.session_auto_compact_token_limit]
        .into_iter()
        .find(|n| *n != 0.0 && !n.is_nan())
        .unwrap_or(0.0);
    if !used.is_finite() || !trigger.is_finite() || !(used > 0.0 && trigger > 0.0) {
        return true;
    }
    (used / trigger) * 100.0 < min_percent
}

/// `idleAutoClearDue({ cfg, activityAt, at, runtime })`: whether the idle gate clears the thread before a submit at
/// `at`: auto-clear on, idle at least the window since the activity stamp, and a context not below the minimum share of
/// the compaction trigger. The submit gate adds its own transient conditions (busy, queued input, a clear running).
pub fn idle_auto_clear_due(config: &IdleConfig, activity_at: f64, at: f64, status: &ContextStatus) -> bool {
    if !config.enabled || activity_at == 0.0 || at - activity_at < config.idle_ms {
        return false;
    }
    !context_usage_below_threshold(status, config.min_context_percent.unwrap_or(10.0))
}

/// `timestampMs(value)`: a positive number or a date string as epoch ms, else 0.
fn timestamp_ms(value: Option<&Value>) -> f64 {
    let value = match value {
        None | Some(Value::Null) => return 0.0,
        Some(Value::String(text)) if text.is_empty() => return 0.0,
        Some(value) => value,
    };
    let n = mixdog_js::to_number(value);
    if n.is_finite() && n > 0.0 {
        return n;
    }
    let parsed = mixdog_js::time::date_parse(&value_to_string(value));
    if parsed.is_finite() && parsed > 0.0 { parsed } else { 0.0 }
}

/// `promptContentText(content)`: the text a message carries; `text_of_part` answers the text of an attachment
/// reference part (`None` for any other part).
pub fn prompt_content_text(content: &Value, text_of_part: &dyn Fn(&Value) -> Option<String>) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.clone(),
                _ => match part.get("type").and_then(Value::as_str) {
                    Some("text") => text_of_part(part).unwrap_or_else(|| part_text(part)),
                    Some("image") => "[Image]".to_owned(),
                    Some("file") => "[File]".to_owned(),
                    _ => part_text(part),
                },
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => value_to_string(other),
    }
}

/// `part.text || ''`.
fn part_text(part: &Value) -> String {
    match part.get("text") {
        Some(text) if truthy(Some(text)) => value_to_string(text),
        _ => String::new(),
    }
}

/// `hasModelVisibleConversation(session)`: some message the model sees, not a system reminder or a bare `.` turn.
fn has_model_visible_conversation(messages: &[Value], text_of_part: &dyn Fn(&Value) -> Option<String>) -> bool {
    messages.iter().any(|message| {
        let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
        if !matches!(role, "user" | "assistant" | "tool") {
            return false;
        }
        let text = prompt_content_text(message.get("content").unwrap_or(&Value::Null), text_of_part);
        let text = js_trim(&text);
        if role == "user" && text.starts_with("<system-reminder>") {
            return false;
        }
        if role == "assistant" && text == "." && !message.get("toolCalls").is_some_and(Value::is_array) {
            return false;
        }
        !text.is_empty() || role == "assistant" || role == "tool"
    })
}

/// `sessionActivityTimestamp(session, fallback)`: when the session was last active (0: no model-visible conversation):
/// the latest of its own activity (`lastUsedAt`, else `updatedAt`, else the fallback) and the last successful cache
/// warm (`warm_use_at`, 0 when none). Idleness is measured from the last time the cached prompt was used, and a warm
/// that read the cache without writing used it; the session's own timestamps are never moved.
pub fn session_activity_timestamp(session: &Value, fallback: f64, warm_use_at: f64, text_of_part: &dyn Fn(&Value) -> Option<String>) -> f64 {
    let messages: &[Value] = session.get("messages").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    if !has_model_visible_conversation(messages, text_of_part) {
        return 0.0;
    }
    let own = [timestamp_ms(session.get("lastUsedAt")), timestamp_ms(session.get("updatedAt")), fallback.max(0.0)].into_iter().find(|n| *n != 0.0).unwrap_or(0.0);
    own.max(warm_use_at)
}

/// What is shown while the clear runs (`commandStatus`).
#[derive(Clone, Debug, PartialEq)]
pub struct CommandStatus {
    pub verb: &'static str,
    pub started_at: i64,
    pub mode: &'static str,
}

/// The thread an idle auto-clear works on.
#[async_trait]
pub trait AutoClearHost: Send + Sync + 'static {
    /// What a compaction returns.
    type Outcome: Send + 'static;
    /// The id of the thread shown now (`runtime.session?.id`).
    fn session_id(&self) -> Option<String>;
    /// Whether a turn is in flight (`getState().busy`).
    fn busy(&self) -> bool;
    /// How many inputs are queued (`pending.length`).
    fn pending_len(&self) -> usize;
    fn now_ms(&self) -> i64;
    /// `autoClearState()`.
    fn config(&self) -> IdleConfig;
    /// `sessionActivityTimestamp(runtime.session, fallback)`.
    fn activity_at(&self, fallback: i64) -> i64;
    /// `runtime.contextStatus()`.
    fn context_status(&self) -> ContextStatus;
    /// `runtime.compact({ requireReduction: true })`: an error covers a rejected call, no active session and an error
    /// result alike, so neither normal nor late completion can reset the UI over one.
    async fn compact(&self) -> Result<Self::Outcome, String>;
    /// `applyAutoClearUi(result)`: only an actual compaction resets the visible activity (the compacted rows stay in view,
    /// archived above the divider; the model transcript belongs to the compaction); false when nothing changed.
    fn apply_cleared_ui(&self, outcome: &Self::Outcome) -> bool;
    /// Blocks concurrent session commands and new submits while the clear runs (the compaction swaps the live session,
    /// so racing commands could act on the wrong one); `None` lifts it.
    fn set_command_status(&self, status: Option<CommandStatus>);
    /// `pushNotice(text, level)`.
    fn push_notice(&self, text: &str, level: &str);
    /// The `Auto-clear skipped` status row.
    fn push_skipped(&self, detail: &str);
    /// `presentErrorText(error, { surface: 'compact' })`.
    fn present_error(&self, error: &str) -> String;
    /// `kickDrain()`: the queued input may go now.
    fn kick_drain(&self);
}

struct Flags<O> {
    auto_clear_running: bool,
    /// A compaction the timeout abandoned is still running or its result waits for the turn to settle.
    auto_clear_in_flight: bool,
    /// `pendingClearedSessionUi`: a late result and the thread it belongs to.
    pending_cleared_session_ui: Option<(O, String)>,
    last_user_activity_at: i64,
}

/// The idle auto-clear of one thread.
pub struct AutoClear<H: AutoClearHost> {
    host: Arc<H>,
    flags: Arc<Mutex<Flags<H::Outcome>>>,
}

impl<H: AutoClearHost> Clone for AutoClear<H> {
    fn clone(&self) -> Self {
        Self { host: self.host.clone(), flags: self.flags.clone() }
    }
}

fn lock<O>(flags: &Mutex<Flags<O>>) -> MutexGuard<'_, Flags<O>> {
    flags.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<H: AutoClearHost> AutoClear<H> {
    pub fn new(host: Arc<H>) -> Self {
        let flags = Flags { auto_clear_running: false, auto_clear_in_flight: false, pending_cleared_session_ui: None, last_user_activity_at: 0 };
        Self { host, flags: Arc::new(Mutex::new(flags)) }
    }

    /// `flags.lastUserActivityAt = at`: the user was active.
    pub fn note_user_activity(&self, at: i64) {
        lock(&self.flags).last_user_activity_at = at;
    }

    /// `flushDeferredClearedSessionUi`: a cleared-session UI deferred while a turn ran is applied once it has settled.
    /// Never forces the thread idle mid-turn: it waits while one is in flight.
    pub fn flush_deferred_cleared_session_ui(&self) {
        if self.host.busy() {
            return;
        }
        let pending = {
            let mut flags = lock(&self.flags);
            let Some(pending) = flags.pending_cleared_session_ui.take() else { return };
            flags.auto_clear_in_flight = false;
            pending
        };
        let (outcome, session_id) = pending;
        if self.host.session_id().as_deref() != Some(session_id.as_str()) {
            return;
        }
        if self.host.apply_cleared_ui(&outcome) {
            self.host.push_notice(LATE_COMPLETION_NOTICE, "info");
        }
    }

    /// `onLateCompact(lateResult, sessionId)`: a compaction the timeout abandoned has finished. When the shown thread
    /// changed meanwhile the result belongs to one no longer shown; during a turn it is held, never wiping the items
    /// or the queue mid-turn.
    fn on_late_compact(&self, outcome: H::Outcome, session_id: String) {
        if self.host.session_id().as_deref() != Some(session_id.as_str()) {
            return;
        }
        if self.host.busy() {
            lock(&self.flags).pending_cleared_session_ui = Some((outcome, session_id));
        } else if self.host.apply_cleared_ui(&outcome) {
            self.host.push_notice(LATE_COMPLETION_NOTICE, "info");
        }
    }

    /// `compactWithinTimeout`: the compaction awaited for `timeout`; one that outlasts it keeps running, and its late
    /// result is applied by [`Self::on_late_compact`].
    async fn compact_within_timeout(&self, timeout: Duration, session_id: String) -> Result<H::Outcome, String> {
        let host = self.host.clone();
        let mut compaction = tokio::spawn(async move { host.compact().await });
        match mixdog_rt::time::timeout(timeout, &mut compaction).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(format!("compaction task failed: {error}")),
            Err(_) => {
                lock(&self.flags).auto_clear_in_flight = true;
                let this = self.clone();
                tokio::spawn(async move {
                    if let Ok(Ok(late)) = compaction.await {
                        this.on_late_compact(late, session_id);
                    }
                    let mut flags = lock(&this.flags);
                    if flags.pending_cleared_session_ui.is_none() {
                        flags.auto_clear_in_flight = false;
                    }
                });
                Err(format!("compaction timed out after {}ms; auto-clear deferred to next idle", timeout.as_millis()))
            }
        }
    }

    /// `autoClearBeforeSubmit({ ignorePending })`: compacts the idle thread before a submit. `ignore_pending`: a
    /// completion-wake drain has already dequeued its own batch, so other queued entries must not veto the idle check.
    pub async fn auto_clear_before_submit(&self, ignore_pending: bool) -> bool {
        self.flush_deferred_cleared_session_ui();
        let config = self.host.config();
        let now = self.host.now_ms();
        let fallback = lock(&self.flags).last_user_activity_at;
        let activity_at = self.host.activity_at(fallback);
        let blocked = {
            let flags = lock(&self.flags);
            self.host.busy() || (!ignore_pending && self.host.pending_len() > 0) || flags.auto_clear_running || flags.auto_clear_in_flight
        };
        if blocked || !idle_auto_clear_due(&config, activity_at as f64, now as f64, &self.host.context_status()) {
            if activity_at == 0 {
                lock(&self.flags).last_user_activity_at = now;
            }
            return false;
        }
        self.perform_auto_clear(Duration::from_millis(AUTO_CLEAR_COMPACT_TIMEOUT_MS)).await
    }

    /// `autoClearBeforeWake()`: the same eligibility as a user submit, run before a completion wake turn so a cold cache
    /// after a long idle is compacted first. A skipped or failed auto-clear still lets the wake run.
    pub async fn auto_clear_before_wake(&self) -> bool {
        self.auto_clear_before_submit(true).await
    }

    /// `performAutoClear({ compactTimeoutMs })`: the idle cleanup keeps the compactor's complete result, rules-only
    /// results without a summary included; a plain `/clear` remains a separate explicit wipe.
    pub async fn perform_auto_clear(&self, timeout: Duration) -> bool {
        lock(&self.flags).auto_clear_running = true;
        let session_id = self.host.session_id().unwrap_or_default();
        self.host.set_command_status(Some(CommandStatus { verb: "Auto-clearing idle conversation", started_at: self.host.now_ms(), mode: "auto-clear" }));
        // One scheduler turn for the status to be painted before the compaction starts its synchronous session work.
        tokio::task::yield_now().await;
        let cleared = match self.compact_within_timeout(timeout, session_id).await {
            Ok(outcome) => self.host.apply_cleared_ui(&outcome),
            Err(error) => {
                let message = self.host.present_error(&error);
                self.host.push_skipped(&format!("conversation kept · {message}"));
                self.host.push_notice(&format!("auto-clear skipped: {message}"), "error");
                false
            }
        };
        {
            let mut flags = lock(&self.flags);
            flags.last_user_activity_at = self.host.now_ms();
            flags.auto_clear_running = false;
        }
        self.host.set_command_status(None);
        self.host.kick_drain();
        cleared
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicI64;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use serde_json::json;

    use super::*;

    const IDLE: IdleConfig = IdleConfig { enabled: true, idle_ms: 1000.0, min_context_percent: None };

    fn half_full() -> ContextStatus {
        ContextStatus { used_tokens: 500.0, compaction_trigger_tokens: 1000.0, ..ContextStatus::default() }
    }

    #[test]
    fn the_gate_needs_an_enabled_window_an_idle_thread_and_a_context_of_some_size() {
        let at = 10_000.0;
        assert!(idle_auto_clear_due(&IDLE, 5000.0, at, &half_full()));
        assert!(!idle_auto_clear_due(&IdleConfig { enabled: false, ..IDLE }, 5000.0, at, &half_full()));
        assert!(!idle_auto_clear_due(&IDLE, 9500.0, at, &half_full()));
        assert!(!idle_auto_clear_due(&IDLE, 0.0, at, &half_full()));
        // Below the minimum share (ten percent by default) of the trigger: not worth a clear.
        let small = ContextStatus { used_tokens: 50.0, compaction_trigger_tokens: 1000.0, ..ContextStatus::default() };
        assert!(!idle_auto_clear_due(&IDLE, 5000.0, at, &small));
        assert!(idle_auto_clear_due(&IdleConfig { min_context_percent: Some(4.0), ..IDLE }, 5000.0, at, &small));
        // No usable measure counts as below the threshold; a zero meter field does not mask the live estimate.
        assert!(!idle_auto_clear_due(&IDLE, 5000.0, at, &ContextStatus::default()));
        let masked = ContextStatus { used_tokens: 0.0, current_estimated_tokens: 400.0, session_auto_compact_token_limit: 1000.0, ..ContextStatus::default() };
        assert!(idle_auto_clear_due(&IDLE, 5000.0, at, &masked));
        // A zero minimum disables the size check.
        assert!(idle_auto_clear_due(&IdleConfig { min_context_percent: Some(0.0), ..IDLE }, 5000.0, at, &ContextStatus::default()));
    }

    #[test]
    fn activity_is_the_latest_use_of_a_session_with_a_visible_conversation() {
        let no_attachments = |_: &Value| -> Option<String> { None };
        let reminder_only = json!({ "lastUsedAt": 500, "messages": [{ "role": "user", "content": "<system-reminder>x</system-reminder>" }, { "role": "assistant", "content": "." }] });
        assert_eq!(session_activity_timestamp(&reminder_only, 9.0, 0.0, &no_attachments), 0.0);
        let session = json!({ "updatedAt": "1970-01-01T00:00:02Z", "messages": [{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }] });
        assert_eq!(session_activity_timestamp(&session, 9.0, 0.0, &no_attachments), 2000.0);
        assert_eq!(session_activity_timestamp(&session, 9.0, 7000.0, &no_attachments), 7000.0);
        let bare = json!({ "messages": [{ "role": "tool", "content": "" }] });
        assert_eq!(session_activity_timestamp(&bare, 9.0, 0.0, &no_attachments), 9.0);
        let by_attachment = json!({ "lastUsedAt": 4, "messages": [{ "role": "user", "content": [{ "type": "text", "ref": "a" }, { "type": "image" }] }] });
        assert_eq!(prompt_content_text(&by_attachment["messages"][0]["content"], &|part: &Value| part.get("ref").map(|_| "attached".to_owned())), "attached\n[Image]");
        assert_eq!(prompt_content_text(&json!(7), &no_attachments), "7");
    }

    struct Host {
        session: Mutex<String>,
        busy: AtomicBool,
        pending: AtomicUsize,
        now: AtomicI64,
        activity: AtomicI64,
        compaction_ms: u64,
        fail: Option<&'static str>,
        compactions: AtomicUsize,
        applied: AtomicUsize,
        drains: AtomicUsize,
        statuses: Mutex<Vec<bool>>,
        notices: Mutex<Vec<(String, String)>>,
        skipped: Mutex<Vec<String>>,
    }

    impl Host {
        fn new(compaction_ms: u64, fail: Option<&'static str>) -> Arc<Self> {
            Arc::new(Self {
                session: Mutex::new("thread-1".into()),
                busy: AtomicBool::new(false),
                pending: AtomicUsize::new(0),
                now: AtomicI64::new(100_000),
                activity: AtomicI64::new(1000),
                compaction_ms,
                fail,
                compactions: AtomicUsize::new(0),
                applied: AtomicUsize::new(0),
                drains: AtomicUsize::new(0),
                statuses: Mutex::new(Vec::new()),
                notices: Mutex::new(Vec::new()),
                skipped: Mutex::new(Vec::new()),
            })
        }

        fn notices(&self) -> Vec<(String, String)> {
            self.notices.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl AutoClearHost for Host {
        type Outcome = u32;
        fn session_id(&self) -> Option<String> {
            Some(self.session.lock().unwrap().clone())
        }
        fn busy(&self) -> bool {
            self.busy.load(Ordering::SeqCst)
        }
        fn pending_len(&self) -> usize {
            self.pending.load(Ordering::SeqCst)
        }
        fn now_ms(&self) -> i64 {
            self.now.load(Ordering::SeqCst)
        }
        fn config(&self) -> IdleConfig {
            IDLE
        }
        fn activity_at(&self, fallback: i64) -> i64 {
            let own = self.activity.load(Ordering::SeqCst);
            if own != 0 { own } else { fallback }
        }
        fn context_status(&self) -> ContextStatus {
            half_full()
        }
        async fn compact(&self) -> Result<u32, String> {
            self.compactions.fetch_add(1, Ordering::SeqCst);
            mixdog_rt::time::sleep(Duration::from_millis(self.compaction_ms)).await;
            self.fail.map_or(Ok(7), |error| Err(error.to_owned()))
        }
        fn apply_cleared_ui(&self, _outcome: &u32) -> bool {
            self.applied.fetch_add(1, Ordering::SeqCst);
            true
        }
        fn set_command_status(&self, status: Option<CommandStatus>) {
            self.statuses.lock().unwrap().push(status.is_some());
        }
        fn push_notice(&self, text: &str, level: &str) {
            self.notices.lock().unwrap().push((text.to_owned(), level.to_owned()));
        }
        fn push_skipped(&self, detail: &str) {
            self.skipped.lock().unwrap().push(detail.to_owned());
        }
        fn present_error(&self, error: &str) -> String {
            error.to_owned()
        }
        fn kick_drain(&self) {
            self.drains.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn an_idle_thread_is_compacted_before_a_submit_and_the_input_drains_after() {
        let host = Host::new(0, None);
        let clear = AutoClear::new(host.clone());
        assert!(clear.auto_clear_before_submit(false).await);
        assert_eq!((host.compactions.load(Ordering::SeqCst), host.applied.load(Ordering::SeqCst), host.drains.load(Ordering::SeqCst)), (1, 1, 1));
        assert_eq!(*host.statuses.lock().unwrap(), vec![true, false]);
        assert!(host.notices().is_empty());
    }

    #[tokio::test]
    async fn a_busy_thread_or_queued_input_blocks_it_unless_the_wake_drained_its_own_batch() {
        let host = Host::new(0, None);
        let clear = AutoClear::new(host.clone());
        host.busy.store(true, Ordering::SeqCst);
        assert!(!clear.auto_clear_before_submit(false).await);
        host.busy.store(false, Ordering::SeqCst);
        host.pending.store(2, Ordering::SeqCst);
        assert!(!clear.auto_clear_before_submit(false).await);
        assert_eq!(host.compactions.load(Ordering::SeqCst), 0);
        assert!(clear.auto_clear_before_wake().await);
        // A thread with no activity stamp is stamped now, so it is idle from here on.
        host.activity.store(0, Ordering::SeqCst);
        let fresh = AutoClear::new(host.clone());
        assert!(!fresh.auto_clear_before_submit(true).await);
        assert_eq!(lock(&fresh.flags).last_user_activity_at, 100_000);
    }

    #[tokio::test]
    async fn a_failed_compaction_keeps_the_conversation_and_says_why() {
        let host = Host::new(0, Some("nothing to reduce"));
        let clear = AutoClear::new(host.clone());
        assert!(!clear.auto_clear_before_submit(false).await);
        assert_eq!(*host.skipped.lock().unwrap(), vec!["conversation kept · nothing to reduce".to_owned()]);
        assert_eq!(host.notices(), vec![("auto-clear skipped: nothing to reduce".to_owned(), "error".to_owned())]);
        assert_eq!((host.applied.load(Ordering::SeqCst), host.drains.load(Ordering::SeqCst)), (0, 1));
        assert_eq!(*host.statuses.lock().unwrap(), vec![true, false]);
    }

    #[tokio::test]
    async fn a_compaction_that_outlasts_the_timeout_is_applied_late_with_a_notice() {
        let host = Host::new(80, None);
        let clear = AutoClear::new(host.clone());
        assert!(!clear.perform_auto_clear(Duration::from_millis(10)).await);
        assert_eq!(host.notices()[0].0, "auto-clear skipped: compaction timed out after 10ms; auto-clear deferred to next idle");
        // The abandoned compaction blocks another clear while it runs.
        assert!(!clear.auto_clear_before_submit(false).await);
        assert_eq!(host.compactions.load(Ordering::SeqCst), 1);
        let waited = mixdog_rt::time::timeout(Duration::from_secs(5), async {
            while host.notices().len() < 2 || lock(&clear.flags).auto_clear_in_flight {
                mixdog_rt::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(waited.is_ok());
        assert_eq!(host.applied.load(Ordering::SeqCst), 1);
        assert_eq!(host.notices()[1], (LATE_COMPLETION_NOTICE.to_owned(), "info".to_owned()));
    }

    #[tokio::test]
    async fn a_late_result_waits_for_the_turn_and_is_dropped_for_another_thread() {
        let host = Host::new(40, None);
        let clear = AutoClear::new(host.clone());
        host.busy.store(true, Ordering::SeqCst);
        assert!(!clear.perform_auto_clear(Duration::from_millis(5)).await);
        mixdog_rt::time::timeout(Duration::from_secs(5), async {
            while lock(&clear.flags).pending_cleared_session_ui.is_none() {
                mixdog_rt::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("held");
        // Still busy: nothing applied, nothing forced.
        clear.flush_deferred_cleared_session_ui();
        assert_eq!(host.applied.load(Ordering::SeqCst), 0);
        host.busy.store(false, Ordering::SeqCst);
        clear.flush_deferred_cleared_session_ui();
        assert_eq!(host.applied.load(Ordering::SeqCst), 1);
        assert!(!lock(&clear.flags).auto_clear_in_flight);
        // The shown thread changed while a compaction ran: its result belongs to one no longer shown.
        let other = Host::new(30, None);
        let clear = AutoClear::new(other.clone());
        assert!(!clear.perform_auto_clear(Duration::from_millis(5)).await);
        *other.session.lock().unwrap() = "thread-2".into();
        mixdog_rt::time::timeout(Duration::from_secs(5), async {
            while lock(&clear.flags).auto_clear_in_flight {
                mixdog_rt::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("settled");
        assert_eq!(other.applied.load(Ordering::SeqCst), 0);
    }
}
