//! The one decision every notification channel makes. Pure: the caller supplies the device's
//! preferences, the conversation overrides, the clock and what the device is showing.
//! Order: 1 quiet hours, 2 conversation override, 3 device scope, 4 event toggle,
//! 5 automatic runs, 6 presence.

use chrono::{Datelike, Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};

use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_id_of_session;
use mixdog_core_base::rooms::ids::room_member_of_session;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Event {
    Finished,
    Question,
    Approval,
    Error,
}

impl Event {
    fn is_waiting(self) -> bool {
        matches!(self, Event::Question | Event::Approval)
    }
    fn is_result(self) -> bool {
        matches!(self, Event::Finished | Event::Error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    All,
    Bots,
    Off,
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
pub struct EventToggles {
    pub finished: bool,
    pub question: bool,
    pub approval: bool,
    pub error: bool,
}

impl EventToggles {
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
    pub events: EventToggles,
    pub automatic_runs: bool,
    pub quiet_hours: QuietHours,
    pub hold_while_desktop_active: bool,
    pub taskbar_flash: bool,
}

impl Default for DevicePreferences {
    /// This PC, and every device that was already paired before preferences existed.
    fn default() -> Self {
        Self {
            scope: Scope::All,
            events: EventToggles { finished: true, question: true, approval: true, error: false },
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

impl DevicePreferences {
    /// A phone app paired after preferences existed starts with bot chats only.
    pub fn new_phone() -> Self {
        Self { scope: Scope::Bots, ..Self::default() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Session,
    Room,
    Agent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum OverrideSetting {
    Always,
    /// `until` is epoch ms; `None` mutes with no end.
    Muted { until: Option<i64> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationOverride {
    pub kind: TargetKind,
    pub id: String,
    pub setting: OverrideSetting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConversationKind {
    /// A bot's home chat.
    Bot,
    /// A group room (its log or a member's session).
    Room,
    /// A session a bot created, or a bot's unattended run.
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
    /// The bot an agent override reaches; empty for none.
    pub agent_id: String,
    /// The room a room override reaches; empty for none.
    pub room_id: String,
}

/// What a session row says about its conversation, beyond what its id says.
#[derive(Clone, Debug, Default)]
pub struct SessionFields {
    pub agent_home: Option<String>,
    pub agent_room_id: Option<String>,
    pub task_agent: bool,
    pub agent_mode: bool,
    pub origin: Option<Origin>,
    /// The agent that owns an unattended run of this session.
    pub run_owner: Option<String>,
}

impl Conversation {
    pub fn of(session_id: &str, fields: &SessionFields) -> Self {
        let member = room_member_of_session(session_id);
        let room_id = fields
            .agent_room_id
            .clone()
            .filter(|id| !id.is_empty())
            .or_else(|| room_id_of_session(session_id))
            .or_else(|| member.as_ref().map(|m| m.room_id.clone()))
            .unwrap_or_default();
        let home_agent = fields
            .agent_home
            .clone()
            .filter(|id| !id.is_empty())
            .or_else(|| agent_id_of_home_session(session_id))
            .unwrap_or_default();
        let agent_id = if !home_agent.is_empty() {
            home_agent.clone()
        } else if let Some(member) = &member {
            member.agent_id.clone()
        } else {
            fields.run_owner.clone().unwrap_or_default()
        };
        let kind = if !room_id.is_empty() {
            ConversationKind::Room
        } else if !home_agent.is_empty() {
            ConversationKind::Bot
        } else if fields.task_agent || fields.agent_mode || !agent_id.is_empty() {
            ConversationKind::Task
        } else {
            ConversationKind::Coding
        };
        Self {
            session_id: session_id.to_owned(),
            kind,
            origin: fields.origin.unwrap_or(Origin::User),
            agent_id,
            room_id,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PreferencesView {
    pub preferences: DevicePreferences,
    pub overrides: Vec<ConversationOverride>,
}

/// The local wall clock of this PC, as quiet hours read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalClock {
    pub minute_of_day: u32,
    /// 0 = Sunday.
    pub weekday: u32,
}

impl LocalClock {
    pub fn at(now_ms: i64) -> Self {
        let at = Local
            .timestamp_millis_opt(now_ms)
            .earliest()
            .unwrap_or_else(|| Local.timestamp_millis_opt(0).unwrap());
        Self {
            minute_of_day: at.hour() * 60 + at.minute(),
            weekday: at.weekday().num_days_from_sunday(),
        }
    }
}

fn minutes_of(value: &str) -> u32 {
    let bytes = value.as_bytes();
    if bytes.len() == 5
        && bytes[2] == b':'
        && bytes[..2].iter().all(u8::is_ascii_digit)
        && bytes[3..].iter().all(u8::is_ascii_digit)
    {
        let number = |a: u8, b: u8| u32::from(a - b'0') * 10 + u32::from(b - b'0');
        return number(bytes[0], bytes[1]) * 60 + number(bytes[3], bytes[4]);
    }
    0
}

fn day_matches(days: QuietDays, day: u32) -> bool {
    match days {
        QuietDays::Weekdays => (1..=5).contains(&day),
        QuietDays::Weekends => day == 0 || day == 6,
        QuietDays::Every => true,
    }
}

/// Inside the quiet hours on the local clock. `days` names the day the quiet period starts on.
pub fn in_quiet_hours(quiet: &QuietHours, clock: LocalClock) -> bool {
    if !quiet.enabled {
        return false;
    }
    let (start, end) = (minutes_of(&quiet.start), minutes_of(&quiet.end));
    let minute = clock.minute_of_day;
    if start < end {
        return minute >= start && minute < end && day_matches(quiet.days, clock.weekday);
    }
    if minute >= start {
        return day_matches(quiet.days, clock.weekday);
    }
    if minute < end {
        return day_matches(quiet.days, (clock.weekday + 6) % 7);
    }
    false
}

fn in_force(entry: &ConversationOverride, now_ms: i64) -> bool {
    match entry.setting {
        OverrideSetting::Muted { until: Some(until) } => until > now_ms,
        _ => true,
    }
}

/// The overrides still in force: a mute whose end has passed is gone.
pub fn active_overrides(overrides: &[ConversationOverride], now_ms: i64) -> Vec<ConversationOverride> {
    overrides.iter().filter(|entry| in_force(entry, now_ms)).cloned().collect()
}

/// The most specific override in force: the session, then its room, then its bot.
pub fn conversation_override<'a>(
    conversation: &Conversation,
    overrides: &'a [ConversationOverride],
    now_ms: i64,
) -> Option<&'a ConversationOverride> {
    let find = |kind: TargetKind, id: &str| {
        (!id.is_empty())
            .then(|| overrides.iter().find(|e| in_force(e, now_ms) && e.kind == kind && e.id == id))
            .flatten()
    };
    find(TargetKind::Session, &conversation.session_id)
        .or_else(|| find(TargetKind::Room, &conversation.room_id))
        .or_else(|| find(TargetKind::Agent, &conversation.agent_id))
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
    pub view: &'a PreferencesView,
    pub now_ms: i64,
    pub clock: LocalClock,
    /// That device shows this conversation in the foreground.
    pub foreground: bool,
    /// A paired device's push: this PC had OS user input in the last 3 minutes.
    pub desktop_active: bool,
}

pub fn decide(input: &DecisionInput<'_>) -> Decision {
    let DecisionInput { event, conversation, view, now_ms, .. } = *input;
    let prefs = &view.preferences;
    if in_quiet_hours(&prefs.quiet_hours, input.clock) && !(prefs.quiet_hours.allow_waiting && event.is_waiting()) {
        return Decision::Skip(SkipReason::QuietHours);
    }
    let setting = conversation_override(conversation, &view.overrides, now_ms).map(|o| &o.setting);
    if matches!(setting, Some(OverrideSetting::Muted { .. })) {
        return Decision::Skip(SkipReason::Muted);
    }
    if !matches!(setting, Some(OverrideSetting::Always)) {
        if prefs.scope == Scope::Off {
            return Decision::Skip(SkipReason::Scope);
        }
        if prefs.scope == Scope::Bots
            && !matches!(conversation.kind, ConversationKind::Bot | ConversationKind::Room)
        {
            return Decision::Skip(SkipReason::Scope);
        }
        if !prefs.events.allows(event) {
            return Decision::Skip(SkipReason::Event);
        }
    }
    let automatic = conversation.origin != Origin::User;
    let result = event.is_result();
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

/// This PC's taskbar flash for a finished turn: its own switch, quiet hours and a conversation mute.
pub fn allows_taskbar_flash(
    view: &PreferencesView,
    conversation: &Conversation,
    now_ms: i64,
    clock: LocalClock,
) -> bool {
    if !view.preferences.taskbar_flash || in_quiet_hours(&view.preferences.quiet_hours, clock) {
        return false;
    }
    !matches!(
        conversation_override(conversation, &view.overrides, now_ms).map(|o| &o.setting),
        Some(OverrideSetting::Muted { .. })
    )
}

/// Notices that belong to no conversation: the device's scope and quiet hours.
pub fn allows_device_notice(preferences: &DevicePreferences, clock: LocalClock) -> bool {
    preferences.scope != Scope::Off && !in_quiet_hours(&preferences.quiet_hours, clock)
}

/// A paired device holding pushes while this PC is in use looks back this far.
pub const DESKTOP_ACTIVE_WINDOW_SECONDS: u64 = 180;
/// How long a push held for an in-use PC waits for the user to see it there.
pub const DESKTOP_HOLD_MS: u64 = 60_000;

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors the Friday 2026-10-23 matrix of the desktop tests, on an explicit clock.
    const FRIDAY_NOON: LocalClock = LocalClock { minute_of_day: 12 * 60, weekday: 5 };
    const fn at(weekday: u32, hour: u32, minute: u32) -> LocalClock {
        LocalClock { minute_of_day: hour * 60 + minute, weekday }
    }

    fn convo(id: &str, fields: SessionFields) -> Conversation {
        Conversation::of(id, &fields)
    }
    fn coding() -> Conversation {
        convo("sess_desktop_a", SessionFields::default())
    }
    fn bot() -> Conversation {
        convo("sess_desktop_home", SessionFields { agent_home: Some("secretary".into()), ..Default::default() })
    }
    fn room() -> Conversation {
        convo("sess_desktop_room", SessionFields { agent_room_id: Some("r1".into()), ..Default::default() })
    }
    fn task() -> Conversation {
        convo("sess_desktop_task", SessionFields { task_agent: true, ..Default::default() })
    }
    fn run() -> Conversation {
        convo(
            "sess_desktop_run",
            SessionFields { agent_mode: true, origin: Some(Origin::Schedule), ..Default::default() },
        )
    }
    fn quiet(patch: impl FnOnce(&mut QuietHours)) -> DevicePreferences {
        let mut prefs = DevicePreferences::default();
        prefs.quiet_hours.enabled = true;
        patch(&mut prefs.quiet_hours);
        prefs
    }
    fn view(preferences: DevicePreferences, overrides: Vec<ConversationOverride>) -> PreferencesView {
        PreferencesView { preferences, overrides }
    }
    fn ov(kind: TargetKind, id: &str, setting: OverrideSetting) -> ConversationOverride {
        ConversationOverride { kind, id: id.into(), setting }
    }
    fn run_decision(
        event: Event,
        conversation: &Conversation,
        v: &PreferencesView,
        clock: LocalClock,
        foreground: bool,
        desktop_active: bool,
    ) -> Decision {
        decide(&DecisionInput { event, conversation, view: v, now_ms: 1_000, clock, foreground, desktop_active })
    }
    fn d(event: Event, conversation: &Conversation, v: &PreferencesView) -> Decision {
        run_decision(event, conversation, v, FRIDAY_NOON, false, false)
    }

    #[test]
    fn classifies_conversations() {
        let b = bot();
        assert_eq!((b.kind, b.agent_id.as_str(), b.origin), (ConversationKind::Bot, "secretary", Origin::User));
        assert_eq!(room().kind, ConversationKind::Room);
        assert_eq!(room().room_id, "r1");
        assert_eq!(task().kind, ConversationKind::Task);
        assert_eq!(task().agent_id, "");
        assert_eq!(run().kind, ConversationKind::Task);
        assert_eq!(run().origin, Origin::Schedule);
        assert_eq!(coding().kind, ConversationKind::Coding);
        let by_id = convo("sess_home_secretary", SessionFields::default());
        assert_eq!((by_id.kind, by_id.agent_id.as_str()), (ConversationKind::Bot, "secretary"));
    }

    #[test]
    fn quiet_hours_span_midnight_and_follow_start_day() {
        let night = quiet(|_| {});
        assert!(in_quiet_hours(&night.quiet_hours, at(5, 23, 30)));
        assert!(in_quiet_hours(&night.quiet_hours, at(6, 7, 59)));
        assert!(!in_quiet_hours(&night.quiet_hours, at(6, 8, 0)));
        assert!(!in_quiet_hours(&night.quiet_hours, FRIDAY_NOON));
        let day = quiet(|q| (q.start, q.end) = ("09:00".into(), "17:00".into()));
        assert!(in_quiet_hours(&day.quiet_hours, FRIDAY_NOON));
        assert!(!in_quiet_hours(&day.quiet_hours, at(5, 17, 0)));
        let weekdays = quiet(|q| q.days = QuietDays::Weekdays);
        assert!(in_quiet_hours(&weekdays.quiet_hours, at(6, 2, 0)), "Friday night into Saturday");
        assert!(!in_quiet_hours(&weekdays.quiet_hours, at(1, 2, 0)), "Sunday night into Monday");
        assert!(!in_quiet_hours(&weekdays.quiet_hours, at(6, 23, 30)), "Saturday night");
        let weekends = quiet(|q| {
            q.days = QuietDays::Weekends;
            q.start = "10:00".into();
            q.end = "14:00".into();
        });
        assert!(in_quiet_hours(&weekends.quiet_hours, at(6, 12, 0)));
        assert!(!in_quiet_hours(&weekends.quiet_hours, FRIDAY_NOON));
    }

    #[test]
    fn allow_waiting_passes_questions_not_results() {
        let v = view(quiet(|q| q.allow_waiting = true), vec![]);
        let night = at(5, 23, 30);
        for event in [Event::Question, Event::Approval] {
            assert_eq!(run_decision(event, &coding(), &v, night, false, false), Decision::Notify);
        }
        for event in [Event::Finished, Event::Error] {
            assert_eq!(
                run_decision(event, &coding(), &v, night, false, false),
                Decision::Skip(SkipReason::QuietHours)
            );
        }
        let always = view(quiet(|_| {}), vec![ov(TargetKind::Session, "sess_desktop_a", OverrideSetting::Always)]);
        assert_eq!(
            run_decision(Event::Finished, &coding(), &always, night, false, false),
            Decision::Skip(SkipReason::QuietHours)
        );
    }

    #[test]
    fn most_specific_override_wins_and_expired_mutes_are_gone() {
        let conversation = Conversation {
            session_id: "s1".into(),
            kind: ConversationKind::Room,
            origin: Origin::User,
            agent_id: "gh".into(),
            room_id: "r1".into(),
        };
        let mute_bot = ov(TargetKind::Agent, "gh", OverrideSetting::Muted { until: None });
        let always_room = ov(TargetKind::Room, "r1", OverrideSetting::Always);
        let mute_session = ov(TargetKind::Session, "s1", OverrideSetting::Muted { until: None });
        let kind = |list: &[ConversationOverride]| conversation_override(&conversation, list, 1_000).map(|o| o.kind);
        assert_eq!(kind(&[mute_bot.clone()]), Some(TargetKind::Agent));
        assert_eq!(kind(&[mute_bot.clone(), always_room.clone()]), Some(TargetKind::Room));
        assert_eq!(kind(&[always_room.clone(), mute_session, mute_bot.clone()]), Some(TargetKind::Session));
        assert_eq!(d(Event::Finished, &conversation, &view(Default::default(), vec![mute_bot.clone()])), Decision::Skip(SkipReason::Muted));
        assert_eq!(d(Event::Finished, &conversation, &view(Default::default(), vec![mute_bot, always_room])), Decision::Notify);
        let mute = |until| ov(TargetKind::Agent, "secretary", OverrideSetting::Muted { until });
        let b = bot();
        assert_eq!(d(Event::Finished, &b, &view(Default::default(), vec![mute(Some(1_001))])), Decision::Skip(SkipReason::Muted));
        assert_eq!(d(Event::Finished, &b, &view(Default::default(), vec![mute(Some(1_000))])), Decision::Notify);
        assert_eq!(active_overrides(&[mute(Some(999)), mute(None)], 1_000), vec![mute(None)]);
    }

    #[test]
    fn scope_event_and_always() {
        let off = view(DevicePreferences { scope: Scope::Off, ..Default::default() }, vec![]);
        assert_eq!(d(Event::Finished, &bot(), &off), Decision::Skip(SkipReason::Scope));
        let bots = view(DevicePreferences::new_phone(), vec![]);
        assert_eq!(d(Event::Finished, &bot(), &bots), Decision::Notify);
        assert_eq!(d(Event::Finished, &room(), &bots), Decision::Notify);
        for c in [coding(), task(), run()] {
            assert_eq!(d(Event::Finished, &c, &bots), Decision::Skip(SkipReason::Scope));
        }
        assert_eq!(d(Event::Error, &coding(), &view(Default::default(), vec![])), Decision::Skip(SkipReason::Event));
        let always = vec![ov(TargetKind::Session, "sess_desktop_a", OverrideSetting::Always)];
        assert_eq!(d(Event::Finished, &coding(), &view(off.preferences.clone(), always.clone())), Decision::Notify);
        assert_eq!(d(Event::Error, &coding(), &view(Default::default(), always.clone())), Decision::Notify);
        assert_eq!(
            run_decision(Event::Finished, &coding(), &view(Default::default(), always), FRIDAY_NOON, true, false),
            Decision::Skip(SkipReason::Foreground)
        );
    }

    #[test]
    fn automatic_runs_foreground_and_presence() {
        let no_auto = view(DevicePreferences { automatic_runs: false, ..Default::default() }, vec![]);
        assert_eq!(d(Event::Finished, &run(), &no_auto), Decision::Skip(SkipReason::AutomaticRuns));
        assert_eq!(d(Event::Question, &run(), &no_auto), Decision::Notify, "waits follow events");
        let auto = view(DevicePreferences::default(), vec![]);
        assert_eq!(
            run_decision(Event::Finished, &run(), &auto, FRIDAY_NOON, true, false),
            Decision::Notify,
            "an automatic result notifies on screen"
        );
        assert_eq!(
            run_decision(Event::Question, &run(), &auto, FRIDAY_NOON, true, false),
            Decision::Skip(SkipReason::Foreground)
        );
        assert_eq!(
            run_decision(Event::Finished, &coding(), &auto, FRIDAY_NOON, false, true),
            Decision::Skip(SkipReason::DesktopActive)
        );
        let hold_off = view(DevicePreferences { hold_while_desktop_active: false, ..Default::default() }, vec![]);
        assert_eq!(run_decision(Event::Finished, &coding(), &hold_off, FRIDAY_NOON, false, true), Decision::Notify);
    }

    #[test]
    fn step_order() {
        let muted = vec![ov(TargetKind::Session, "sess_desktop_a", OverrideSetting::Muted { until: None })];
        assert_eq!(
            run_decision(Event::Finished, &coding(), &view(quiet(|_| {}), muted.clone()), at(5, 23, 30), false, false),
            Decision::Skip(SkipReason::QuietHours)
        );
        let off = DevicePreferences { scope: Scope::Off, ..Default::default() };
        assert_eq!(d(Event::Finished, &coding(), &view(off, muted)), Decision::Skip(SkipReason::Muted));
    }

    #[test]
    fn taskbar_flash_and_device_notice() {
        let flash = |p: DevicePreferences, o: Vec<ConversationOverride>, c: LocalClock| {
            allows_taskbar_flash(&view(p, o), &coding(), 1_000, c)
        };
        assert!(flash(Default::default(), vec![], FRIDAY_NOON));
        assert!(!flash(DevicePreferences { taskbar_flash: false, ..Default::default() }, vec![], FRIDAY_NOON));
        assert!(!flash(quiet(|_| {}), vec![], at(5, 23, 30)));
        let mute = ov(TargetKind::Session, "sess_desktop_a", OverrideSetting::Muted { until: None });
        assert!(!flash(Default::default(), vec![mute], FRIDAY_NOON));
        assert!(flash(DevicePreferences { scope: Scope::Off, ..Default::default() }, vec![], FRIDAY_NOON));
        assert!(allows_device_notice(&DevicePreferences::default(), FRIDAY_NOON));
        assert!(!allows_device_notice(&DevicePreferences { scope: Scope::Off, ..Default::default() }, FRIDAY_NOON));
        assert!(!allows_device_notice(&quiet(|_| {}), at(5, 23, 30)));
    }
}
