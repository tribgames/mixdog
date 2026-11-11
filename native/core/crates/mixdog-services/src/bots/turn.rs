//! A routine fire as a TURN in its owner bot's home thread (routine-home-turn.mjs): the
//! routine's instructions are delivered there as a queued turn the bot handles itself —
//! doing it or delegating as in any turn — and its reply in the chat is the result. Nothing
//! else is created: no run session, no result card.
//!
//! The turn waits behind the thread's own work (a user turn, another routine), shows as a
//! routine marker row, and selects skills only from the routine's instructions, never from a
//! webhook payload. With an `executor_agent_id` the fire is first carried out by that
//! sub-agent and the turn holds only its final report, which the bot relays; the quiet marker
//! as the report wakes nobody and resolves it. A heartbeat turn past its wall-clock cap is
//! aborted and resolves with no reply.

use std::time::Duration;

use serde_json::{Value, json};
use mixdog_rt::CancelView;
use uuid::Uuid;

use super::attachments::prompt_content;
use super::host::{RoutineTurn, TurnSettle};
use super::ids::{agent_home_session_id, schedule_owner_agent_id};
use super::owned::RoutineRun;
use super::routine::{
    HEARTBEAT_WALL_CLOCK_MS, ROUTINE_QUIET, RoutineKind, RoutineTrigger, is_routine_quiet_reply, normalize_routine_trigger,
    routine_relay_header, routine_trigger_header,
};
use super::runtime::RoutineRuntime;
use crate::scheduler::model::HOME_QUEUE_LIMIT;

#[derive(Debug, Clone)]
pub struct TurnArgs {
    pub kind: RoutineKind,
    pub name: String,
    pub owner_agent_id: Option<String>,
    /// The model-visible body: instructions, plus a webhook's fenced payload.
    pub prompt: String,
    /// The trusted part of the body; default the whole body.
    pub skill_selection: Option<String>,
    pub attachments: Option<Value>,
    pub cwd: Option<String>,
    /// A short label for the marker (a webhook's event).
    pub event: String,
    /// A session the caller created for this turn, and the turn's opening line (the
    /// heartbeat's hidden session and header); default the owner's home thread and the
    /// routine trigger header.
    pub session_id: Option<String>,
    pub header: Option<String>,
    /// A workflow sub-agent that carries the fire out first.
    pub executor_agent_id: Option<String>,
}

/// `abortError(signal)`: the reason the cancel was given, else Node's own fallback text.
pub(super) fn abort_error(cancel: &CancelView) -> String {
    cancel.reason().map_or_else(|| "routine run aborted".into(), |reason| reason.to_string())
}

/// One slot in a home thread's queue; released on drop.
struct QueueSlot<'a> {
    rt: &'a RoutineRuntime,
    home: String,
}

impl Drop for QueueSlot<'_> {
    fn drop(&mut self) {
        let mut waiting = self.rt.waiting.lock().unwrap();
        match waiting.get(&self.home).copied().unwrap_or(1) {
            1 | 0 => {
                waiting.remove(&self.home);
            }
            n => {
                waiting.insert(self.home.clone(), n - 1);
            }
        }
    }
}

impl RoutineRuntime {
    fn take_slot(&self, home: &str) -> Result<QueueSlot<'_>, String> {
        let mut waiting = self.waiting.lock().unwrap();
        let queued = waiting.get(home).copied().unwrap_or(0);
        if queued >= HOME_QUEUE_LIMIT {
            return Err(format!("{HOME_QUEUE_LIMIT} routine runs already wait in this bot's chat"));
        }
        waiting.insert(home.to_string(), queued + 1);
        Ok(QueueSlot { rt: self, home: home.to_string() })
    }

    /// Delivers one fire of routine `args.name` to its owner's home thread and resolves the
    /// bot's reply. Rejects when the turn fails, is cancelled, or `cancel` fires.
    pub async fn run_routine_turn(&self, args: TurnArgs, cancel: &CancelView) -> Result<RoutineRun, String> {
        let kind = args.kind;
        let name = args.name.as_str();
        let mut body = mixdog_js::js_trim(&args.prompt).to_string();
        if body.is_empty() {
            return Err(format!("{} \"{name}\" has no instructions", kind.word()));
        }
        if cancel.is_cancelled() {
            return Err(abort_error(cancel));
        }
        let agent_id = schedule_owner_agent_id(args.owner_agent_id.as_deref());
        let home_id = match &args.session_id {
            Some(id) => id.clone(),
            None => {
                let home = agent_home_session_id(&agent_id).expect("an owner id is normalized");
                if !self.host.home_thread_open(&home).await? {
                    return Err(format!("the bot \"{agent_id}\" has no chat yet: open it once in the app"));
                }
                home
            }
        };
        let project = args.cwd.clone().unwrap_or_default();
        let now = self.clock.now();
        let mut opening = args
            .header
            .clone()
            .unwrap_or_else(|| routine_trigger_header(kind, name, &project, now, self.tz));
        let mut selection = args.skill_selection.clone().unwrap_or_else(|| body.clone());
        let mut attachments = args.attachments.clone().unwrap_or(Value::Null);
        if let Some(executor) = args.executor_agent_id.as_deref().filter(|e| !e.is_empty()) {
            let report = self
                .run_executor_fire(executor, kind, name, &agent_id, &body, &selection, &attachments, args.cwd.as_deref(), cancel)
                .await?;
            let report = mixdog_js::js_trim(&report).to_string();
            if cancel.is_cancelled() {
                return Err(abort_error(cancel));
            }
            if report.is_empty() {
                return Err(format!("{} \"{name}\": executor agent \"{executor}\" returned no report", kind.word()));
            }
            // Nothing to tell: the bot is not woken.
            if is_routine_quiet_reply(&report) {
                return Ok(RoutineRun { session_id: home_id, result: ROUTINE_QUIET.into(), timed_out: false });
            }
            // The bot only relays the report: it is derived from whatever the executor read (a
            // webhook's payload included), so it selects no skill.
            body = report;
            opening = routine_relay_header(kind, name, executor, &project, self.clock.now(), self.tz);
            selection = String::new();
            attachments = Value::Null;
        }
        let slot = self.take_slot(&home_id)?;
        let trigger = normalize_routine_trigger(&json!({"kind": kind, "name": name, "event": args.event}))
            .unwrap_or(RoutineTrigger { kind, name: name.to_string(), event: None });
        let turn = RoutineTurn {
            id: format!("routine_{}", Uuid::new_v4()),
            session_id: home_id.clone(),
            agent_id,
            kind,
            name: name.to_string(),
            content: prompt_content(&format!("{opening}\n\n{body}"), &attachments),
            skill_selection: selection,
            trigger,
        };
        let heartbeat = args.session_id.is_some() && self.host.is_heartbeat_session(&home_id);
        let turn_cancel = cancel.token().child_token();
        let settle = self.host.run_turn(turn, turn_cancel.clone());
        tokio::pin!(settle);
        let (settle, timed_out) = if heartbeat {
            // The heartbeat turn is cut off at its wall-clock cap: it is aborted and ends
            // cleanly with no reply.
            let cap = mixdog_rt::time::sleep(Duration::from_millis(HEARTBEAT_WALL_CLOCK_MS));
            tokio::pin!(cap);
            let early = tokio::select! {
                settle = &mut settle => Some(settle),
                () = &mut cap => None,
            };
            match early {
                Some(settle) => (settle, false),
                None => {
                    mixdog_rt::node_stderr!(
                        "mixdog routines: {} \"{name}\" in {home_id} passed {}s: ended without a reply",
                        kind.word(),
                        HEARTBEAT_WALL_CLOCK_MS / 1000
                    );
                    turn_cancel.cancel();
                    (settle.await, true)
                }
            }
        } else {
            (settle.await, false)
        };
        drop(slot);
        if timed_out {
            return Ok(RoutineRun { session_id: home_id, result: String::new(), timed_out: true });
        }
        if cancel.is_cancelled() {
            return Err(abort_error(cancel));
        }
        match settle {
            TurnSettle::Done { result } => Ok(RoutineRun { session_id: home_id, result, timed_out: false }),
            TurnSettle::HumanNeeded(text) => Err(text),
            TurnSettle::Cancelled => Err("the routine turn was cancelled".into()),
            TurnSettle::Rejected => Err("the bot's chat closed before the routine ran".into()),
            TurnSettle::Failed(message) if message.is_empty() => Err("the routine turn failed".into()),
            TurnSettle::Failed(message) => Err(message),
            TurnSettle::NotAccepted => Err(format!("the bot's chat did not accept the {} \"{name}\"", kind.word())),
        }
    }
}
