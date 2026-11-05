//! The one decision every notification channel makes (notification-decision.ts, issue #221),
//! pure: the caller supplies the device's preferences, the conversation overrides, the clock and
//! what the device is showing. Order: 1 quiet hours, 2 conversation override, 3 device scope,
//! 4 event toggle, 5 automatic runs, 6 presence.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    All,
    Bots,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Event {
    Finished,
    Question,
    Approval,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuietDays {
    Every,
    Weekdays,
    Weekends,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuietHours {
    pub enabled: bool,
    /// `HH:MM` on the PC's local clock; an end at or before the start spans midnight.
    pub start: String,
    pub end: String,
    pub days: QuietDays,
    pub allow_waiting: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Events {
    pub finished: bool,
    pub question: bool,
    pub approval: bool,
    pub error: bool,
}

impl Events {
    fn allows(&self, event: Event) -> bool {
        match event {
            Event::Finished => self.finished,
            Event::Question => self.question,
            Event::Approval => self.approval,
            Event::Error => self.error,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePreferences {
    pub scope: Scope,
    pub events: Events,
    pub automatic_runs: bool,
    pub quiet_hours: QuietHours,
    pub hold_while_desktop_active: bool,
    pub taskbar_flash: bool,
}

impl Default for DevicePreferences {
    fn default() -> Self {
        Self {
            scope: Scope::All,
            events: Events { finished: true, question: true, approval: true, error: false },
            automatic_runs: true,
            quiet_hours: QuietHours {
                enabled: false,
                start: "23:00".into(),
                end: "08:00".into(),
                days: QuietDays::Every,
                allow_waiting: false,
            },
            hold_while_desktop_active: true,
            taskbar_flash: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConversationKind {
    Bot,
    Room,
    Task,
    Coding,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    User,
    Schedule,
    Webhook,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conversation {
    pub session_id: String,
    pub kind: ConversationKind,
    pub origin: Origin,
    /// The bot an agent override reaches; '' for none.
    pub agent_id: String,
    /// The room a room override reaches; '' for none.
    pub room_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    Session,
    Room,
    Agent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Setting {
    Always,
    /// `until`: epoch ms, or None for no end.
    Muted { until: Option<u64> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Override {
    pub kind: TargetKind,
    pub id: String,
    pub setting: Setting,
}

/// The PC's local wall clock at the decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalTime {
    /// Minutes since local midnight.
    pub minute: u32,
    /// 0 = Sunday.
    pub weekday: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    QuietHours,
    Muted,
    Scope,
    Event,
    AutomaticRuns,
    Foreground,
    DesktopActive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Notify,
    Skip(SkipReason),
}

pub struct DecisionInput<'a> {
    pub event: Event,
    pub conversation: &'a Conversation,
    pub preferences: &'a DevicePreferences,
    pub overrides: &'a [Override],
    /// Epoch ms.
    pub now: u64,
    pub local: LocalTime,
    /// That device shows this conversation in the foreground.
    pub foreground: bool,
    /// A paired device's push: this PC had OS user input in the last 3 minutes.
    pub desktop_active: bool,
}

/// A paired device holding pushes while this PC is in use looks back this far.
pub const DESKTOP_ACTIVE_WINDOW_SECONDS: u64 = 180;
/// How long a held push waits for the user to see it on the PC before it goes after all.
pub const DESKTOP_HOLD_MS: u64 = 60_000;

fn minutes_of(value: &str) -> u32 {
    let bytes = value.as_bytes();
    let digit = |i: usize| bytes.get(i).filter(|b| b.is_ascii_digit()).map(|b| u32::from(b - b'0'));
    match (bytes.len(), digit(0), digit(1), bytes.get(2), digit(3), digit(4)) {
        (5, Some(a), Some(b), Some(b':'), Some(c), Some(d)) => (a * 10 + b) * 60 + c * 10 + d,
        _ => 0,
    }
}

fn day_matches(days: QuietDays, weekday: u32) -> bool {
    match days {
        QuietDays::Weekdays => (1..=5).contains(&weekday),
        QuietDays::Weekends => weekday == 0 || weekday == 6,
        QuietDays::Every => true,
    }
}

/// Inside the quiet hours on this PC's local clock; `days` names the day the quiet period starts on.
pub fn in_quiet_hours(quiet: &QuietHours, local: LocalTime) -> bool {
    if !quiet.enabled {
        return false;
    }
    let (start, end) = (minutes_of(&quiet.start), minutes_of(&quiet.end));
    if start < end {
        return local.minute >= start && local.minute < end && day_matches(quiet.days, local.weekday);
    }
    if local.minute >= start {
        return day_matches(quiet.days, local.weekday);
    }
    if local.minute < end {
        return day_matches(quiet.days, (local.weekday + 6) % 7);
    }
    false
}

fn in_force(entry: &Override, now: u64) -> bool {
    match entry.setting {
        Setting::Muted { until: Some(until) } => until > now,
        _ => true,
    }
}

/// The most specific override in force: the session, then its room, then its bot.
pub fn conversation_override<'a>(conversation: &Conversation, overrides: &'a [Override], now: u64) -> Option<&'a Override> {
    let find = |kind: TargetKind, id: &str| {
        (!id.is_empty())
            .then(|| overrides.iter().find(|entry| entry.kind == kind && entry.id == id && in_force(entry, now)))
            .flatten()
    };
    find(TargetKind::Session, &conversation.session_id)
        .or_else(|| find(TargetKind::Room, &conversation.room_id))
        .or_else(|| find(TargetKind::Agent, &conversation.agent_id))
}

pub fn decide(input: &DecisionInput<'_>) -> Decision {
    let prefs = input.preferences;
    let waiting = matches!(input.event, Event::Question | Event::Approval);
    if in_quiet_hours(&prefs.quiet_hours, input.local) && !(prefs.quiet_hours.allow_waiting && waiting) {
        return Decision::Skip(SkipReason::QuietHours);
    }
    let override_ = conversation_override(input.conversation, input.overrides, input.now);
    if matches!(override_.map(|o| o.setting), Some(Setting::Muted { .. })) {
        return Decision::Skip(SkipReason::Muted);
    }
    if !matches!(override_.map(|o| o.setting), Some(Setting::Always)) {
        if prefs.scope == Scope::Off {
            return Decision::Skip(SkipReason::Scope);
        }
        if prefs.scope == Scope::Bots
            && !matches!(input.conversation.kind, ConversationKind::Bot | ConversationKind::Room)
        {
            return Decision::Skip(SkipReason::Scope);
        }
        if !prefs.events.allows(input.event) {
            return Decision::Skip(SkipReason::Event);
        }
    }
    let automatic = input.conversation.origin != Origin::User;
    let result = matches!(input.event, Event::Finished | Event::Error);
    if automatic && result && !prefs.automatic_runs {
        return Decision::Skip(SkipReason::AutomaticRuns);
    }
    // A schedule's or webhook's result notifies even on screen: nobody asked for it in that moment.
    if input.foreground && !(automatic && result) {
        return Decision::Skip(SkipReason::Foreground);
    }
    if prefs.hold_while_desktop_active && input.desktop_active {
        return Decision::Skip(SkipReason::DesktopActive);
    }
    Decision::Notify
}

/// Notices that belong to no conversation (a server window's link dropping or coming back).
pub fn allows_device_notice(preferences: &DevicePreferences, local: LocalTime) -> bool {
    preferences.scope != Scope::Off && !in_quiet_hours(&preferences.quiet_hours, local)
}
