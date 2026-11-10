//! Turns one thread event plus the current audience into a delivery plan: host toast requests
//! (`host/notification/show`), relay pushes and in-app notices. The plan is pure data; the
//! transport layer delivers it. The only state is the set of toasts that had no host to show
//! them, held until a host attaches or the thread is read.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use super::decision::{
    Conversation, Decision, DecisionInput, Event, LocalClock, Origin, PreferencesView, SkipReason,
    allows_device_notice, decide, DESKTOP_HOLD_MS,
};
use super::held::{HELD_PUSH_TITLE, HeldRequestEvent, held_request_push_text};
use super::preview::notification_preview;

/// The tool approval a push is about, and whether the phone may offer Allow on it
/// (push-notifier.ts `PushApproval`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushApproval {
    pub id: String,
    pub allow_once: bool,
}

/// `approval.id.slice(0, 120)`.
const APPROVAL_ID_UNITS: usize = 120;

#[derive(Clone, Debug)]
pub struct ThreadEvent {
    pub thread_id: String,
    pub event: Event,
    /// The approval of an `Event::Approval`; ignored for every other event.
    pub approval: Option<PushApproval>,
    pub conversation: Conversation,
    pub title: String,
    /// The event's text as Markdown (a final answer, a question); shown as a plain-text preview.
    pub body_markdown: String,
    pub now_ms: i64,
}

/// A connection that declared `capabilities.host.notifications`.
#[derive(Clone, Debug)]
pub struct HostConnection {
    pub connection_id: String,
    /// The thread this connection shows in the foreground, if any.
    pub foreground_thread: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PairedDevice {
    pub device_id: String,
    pub view: PreferencesView,
    pub foreground_thread: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Audience {
    /// This PC's preferences, used for every host connection.
    pub pc: PreferencesView,
    pub hosts: Vec<HostConnection>,
    pub devices: Vec<PairedDevice>,
    /// This PC had OS user input within `DESKTOP_ACTIVE_WINDOW_SECONDS`.
    pub desktop_active: bool,
}

/// The sound the host plays with a toast: `desktop.notificationVolume` percent (0..=400) and the
/// sound's name. A host plays unless `sound` is absent or `none`; Node plays nothing at volume 0
/// (`index.ts` `playNotificationSound`: `suppressed:volume-muted`) and its one sound is
/// `soft-rise.wav` (`notification-sound.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct ToastStyle {
    pub sound: Option<String>,
    pub volume: f64,
}

impl ToastStyle {
    pub const SOUND: &'static str = "soft-rise";
    pub const MUTED: &'static str = "none";

    /// The style for the saved volume in percent.
    pub fn for_volume(percent: i64) -> Self {
        let sound = if percent == 0 { Self::MUTED } else { Self::SOUND };
        Self { sound: Some(sound.to_owned()), volume: percent as f64 }
    }
}

/// Reads the toast style when a toast is made, so a changed setting applies to the next toast.
pub type ToastStyleReader = std::sync::Arc<dyn Fn() -> ToastStyle + Send + Sync>;

/// Params of the `host/notification/show` server notification.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostToast {
    pub title: String,
    pub body: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sound: Option<String>,
    pub volume: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushSchedule {
    Now,
    /// The PC is in use: push at this instant only if the conversation is still unread (a result)
    /// or the wait still open (a question or approval).
    HoldUntil(i64),
}

#[derive(Clone, Debug, PartialEq)]
pub struct PushRequest {
    pub device_id: String,
    pub thread_id: String,
    pub event: Event,
    pub title: String,
    pub body: String,
    pub schedule: PushSchedule,
    /// Set only for an approval wait; the sink puts it inside the encrypted native content
    /// (the relay never learns whether Allow is offered). The id is already clipped.
    pub approval: Option<PushApproval>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    /// (connection id, toast)
    pub toasts: Vec<(String, HostToast)>,
    pub pushes: Vec<PushRequest>,
}

#[derive(Clone, Debug)]
pub enum TestTarget {
    Desktop,
    Device(String),
    All,
}

pub struct NotificationEngine {
    style: ToastStyleReader,
    /// Toasts the PC wanted while no host was attached, newest per thread.
    pending: Mutex<HashMap<String, HostToast>>,
}

impl NotificationEngine {
    pub fn new(style: ToastStyleReader) -> Self {
        Self { style, pending: Mutex::new(HashMap::new()) }
    }

    fn toast(&self, thread_id: &str, title: &str, body: &str) -> HostToast {
        let style = (self.style)();
        HostToast {
            title: title.to_owned(),
            body: body.to_owned(),
            thread_id: thread_id.to_owned(),
            sound: style.sound,
            volume: style.volume,
        }
    }

    pub fn on_event(&self, event: &ThreadEvent, audience: &Audience) -> Plan {
        let body = notification_preview(&event.body_markdown);
        let clock = LocalClock::at(event.now_ms);
        let mut plan = Plan::default();
        let decide_for = |view: &PreferencesView, foreground: bool, desktop_active: bool| {
            decide(&DecisionInput {
                event: event.event,
                conversation: &event.conversation,
                view,
                now_ms: event.now_ms,
                clock,
                foreground,
                desktop_active,
            })
        };
        let is_foreground = |shown: &Option<String>| shown.as_deref() == Some(event.thread_id.as_str());

        if audience.hosts.is_empty() {
            // No UI attached: the PC's decision is kept for the next host that attaches.
            if decide_for(&audience.pc, false, false) == Decision::Notify {
                let toast = self.toast(&event.thread_id, &event.title, &body);
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(event.thread_id.clone(), toast);
            }
        } else {
            for host in &audience.hosts {
                if decide_for(&audience.pc, is_foreground(&host.foreground_thread), false) == Decision::Notify {
                    plan.toasts.push((
                        host.connection_id.clone(),
                        self.toast(&event.thread_id, &event.title, &body),
                    ));
                }
            }
            // The thread was shown now; nothing older is owed to a later attach.
            if !plan.toasts.is_empty() {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&event.thread_id);
            }
        }

        plan.pushes = device_pushes(event, &body, audience);
        plan
    }

    /// A held request of an unattended run (push-notifier.ts `onHeldRequest`): the phones are
    /// told that `agent_name` waits, in `held_request_push_text`'s words and nothing else, with no
    /// Allow on it. It is an approval wait of an automatic run: `conversation` is the session's
    /// own, its origin is a schedule's and its bot is the session's, else the run's agent. No host
    /// toast: only phones hear it. A request with no session or no id is not pushed.
    pub fn on_held_request(
        &self,
        held: &HeldRequestEvent,
        conversation: &Conversation,
        audience: &Audience,
        now_ms: i64,
    ) -> Plan {
        if held.session_id.is_empty() || held.request_id.is_empty() {
            return Plan::default();
        }
        let conversation = Conversation {
            origin: Origin::Schedule,
            agent_id: if conversation.agent_id.is_empty() { held.agent_id.clone() } else { conversation.agent_id.clone() },
            ..conversation.clone()
        };
        let event = ThreadEvent {
            thread_id: held.session_id.clone(),
            event: Event::Approval,
            approval: Some(PushApproval { id: held.request_id.clone(), allow_once: false }),
            conversation,
            title: HELD_PUSH_TITLE.to_owned(),
            body_markdown: String::new(),
            now_ms,
        };
        Plan { toasts: Vec::new(), pushes: device_pushes(&event, &held_request_push_text(&held.agent_name), audience) }
    }

    /// A host connection attached: the toasts that waited for one, each exactly once.
    pub fn host_attached(&self) -> Vec<HostToast> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.drain().map(|(_, toast)| toast).collect()
    }

    /// The thread's read state advanced: an older toast for it is no longer owed.
    pub fn thread_read(&self, thread_id: &str) {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(thread_id);
    }

    /// `notify/test`: reaches the desktop hosts and the paired devices named, bypassing the decision.
    pub fn test(&self, target: &TestTarget, audience: &Audience) -> Plan {
        // Node's words: the PC's toast (index.ts `showTestNotification`, b6f10295a) and a device's push
        // (push-notifier.ts `TEST_PUSH_TEXT`), both titled "Mixdog".
        let (title, body) = ("Mixdog", "Notifications from this PC reach this device.");
        let mut plan = Plan::default();
        if matches!(target, TestTarget::Desktop | TestTarget::All) {
            for host in &audience.hosts {
                plan.toasts.push((host.connection_id.clone(), self.toast("", title, "Notifications from Mixdog appear like this.")));
            }
        }
        for device in &audience.devices {
            let wanted = match target {
                TestTarget::All => true,
                TestTarget::Desktop => false,
                TestTarget::Device(id) => *id == device.device_id,
            };
            if wanted {
                plan.pushes.push(PushRequest {
                    device_id: device.device_id.clone(),
                    thread_id: String::new(),
                    event: Event::Finished,
                    title: title.to_owned(),
                    body: body.to_owned(),
                    schedule: PushSchedule::Now,
                    approval: None,
                });
            }
        }
        plan
    }
}

/// The relay pushes of one event with its banner text `body`: each paired device decides for
/// itself (`sendPush` through `deliveryGate`).
fn device_pushes(event: &ThreadEvent, body: &str, audience: &Audience) -> Vec<PushRequest> {
    let clock = LocalClock::at(event.now_ms);
    let approval = match (event.event, &event.approval) {
        (Event::Approval, Some(shown)) => Some(PushApproval {
            id: mixdog_js::slice_utf16(&shown.id, APPROVAL_ID_UNITS),
            allow_once: shown.allow_once,
        }),
        _ => None,
    };
    let mut pushes = Vec::new();
    for device in &audience.devices {
        let decision = decide(&DecisionInput {
            event: event.event,
            conversation: &event.conversation,
            view: &device.view,
            now_ms: event.now_ms,
            clock,
            foreground: device.foreground_thread.as_deref() == Some(event.thread_id.as_str()),
            desktop_active: audience.desktop_active,
        });
        let schedule = match decision {
            Decision::Notify => PushSchedule::Now,
            Decision::Skip(SkipReason::DesktopActive) => PushSchedule::HoldUntil(event.now_ms + DESKTOP_HOLD_MS as i64),
            Decision::Skip(_) => continue,
        };
        pushes.push(PushRequest {
            device_id: device.device_id.clone(),
            thread_id: event.thread_id.clone(),
            event: event.event,
            title: event.title.clone(),
            body: body.to_owned(),
            schedule,
            approval: approval.clone(),
        });
    }
    pushes
}

/// An in-app notice that belongs to no conversation (a server window's link dropping or coming
/// back): the device's scope and quiet hours decide.
pub fn device_notice(view: &PreferencesView, title: &str, body: &str, now_ms: i64) -> Option<Notice> {
    allows_device_notice(&view.preferences, LocalClock::at(now_ms))
        .then(|| Notice { title: title.to_owned(), body: body.to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::decision::{DevicePreferences, Origin, Scope};

    fn view(preferences: DevicePreferences) -> PreferencesView {
        PreferencesView { preferences, overrides: vec![] }
    }
    fn conversation() -> Conversation {
        Conversation {
            session_id: "t1".into(),
            kind: crate::notify::decision::ConversationKind::Coding,
            origin: Origin::User,
            agent_id: String::new(),
            room_id: String::new(),
        }
    }
    fn event() -> ThreadEvent {
        ThreadEvent {
            thread_id: "t1".into(),
            event: Event::Finished,
            approval: None,
            conversation: conversation(),
            title: "Title".into(),
            body_markdown: "**Done** now".into(),
            now_ms: 1_700_000_000_000,
        }
    }
    fn audience(hosts: &[&str], devices: Vec<PairedDevice>) -> Audience {
        Audience {
            pc: view(DevicePreferences::default()),
            hosts: hosts
                .iter()
                .map(|id| HostConnection { connection_id: (*id).into(), foreground_thread: None })
                .collect(),
            devices,
            desktop_active: false,
        }
    }
    fn device(id: &str, preferences: DevicePreferences) -> PairedDevice {
        PairedDevice { device_id: id.into(), view: view(preferences), foreground_thread: None }
    }
    fn engine() -> NotificationEngine {
        NotificationEngine::new(std::sync::Arc::new(|| ToastStyle::for_volume(50)))
    }

    #[test]
    fn toast_goes_to_every_host_not_showing_the_thread() {
        let mut a = audience(&["c1", "c2"], vec![]);
        a.hosts[1].foreground_thread = Some("t1".into());
        let plan = engine().on_event(&event(), &a);
        assert_eq!(plan.toasts.len(), 1);
        assert_eq!(plan.toasts[0].0, "c1");
        assert_eq!(plan.toasts[0].1.body, "Done now");
        assert_eq!(plan.toasts[0].1.sound.as_deref(), Some("soft-rise"));
    }

    #[test]
    fn the_volume_is_read_when_the_toast_is_made_and_zero_mutes_the_sound() {
        let percent = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(100));
        let read = percent.clone();
        let e = NotificationEngine::new(std::sync::Arc::new(move || ToastStyle::for_volume(read.load(std::sync::atomic::Ordering::SeqCst))));
        let a = audience(&["c1"], vec![]);
        let loud = e.on_event(&event(), &a).toasts.remove(0).1;
        assert_eq!((loud.sound.as_deref(), loud.volume), (Some("soft-rise"), 100.0));
        percent.store(0, std::sync::atomic::Ordering::SeqCst);
        let muted = e.on_event(&event(), &a).toasts.remove(0).1;
        assert_eq!((muted.sound.as_deref(), muted.volume), (Some("none"), 0.0));
        let wire = serde_json::to_value(&muted).unwrap();
        assert_eq!(wire["sound"], "none");
        assert_eq!(wire["threadId"], "t1");
    }

    #[test]
    fn toast_without_a_host_is_delivered_once_on_attach() {
        let e = engine();
        let plan = e.on_event(&event(), &audience(&[], vec![]));
        assert!(plan.toasts.is_empty());
        let first = e.host_attached();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].thread_id, "t1");
        assert!(e.host_attached().is_empty(), "exactly once");
    }

    #[test]
    fn a_read_thread_owes_nothing_on_attach() {
        let e = engine();
        e.on_event(&event(), &audience(&[], vec![]));
        e.thread_read("t1");
        assert!(e.host_attached().is_empty());
    }

    #[test]
    fn a_skipped_pc_decision_keeps_nothing() {
        let e = engine();
        let mut a = audience(&[], vec![]);
        a.pc = view(DevicePreferences { scope: Scope::Off, ..Default::default() });
        e.on_event(&event(), &a);
        assert!(e.host_attached().is_empty());
    }

    #[test]
    fn pushes_follow_each_devices_preferences_and_hold_while_the_pc_is_in_use() {
        let mut a = audience(
            &["c1"],
            vec![
                device("phone", DevicePreferences::default()),
                device("off", DevicePreferences { scope: Scope::Off, ..Default::default() }),
            ],
        );
        let e = engine();
        let plan = e.on_event(&event(), &a);
        assert_eq!(plan.pushes.len(), 1);
        assert_eq!(plan.pushes[0].device_id, "phone");
        assert_eq!(plan.pushes[0].schedule, PushSchedule::Now);
        a.desktop_active = true;
        let held = e.on_event(&event(), &a);
        assert_eq!(held.pushes[0].schedule, PushSchedule::HoldUntil(1_700_000_060_000));
    }

    #[test]
    fn test_notification_reaches_desktop_and_each_paired_device() {
        let a = audience(
            &["c1"],
            vec![
                device("p1", DevicePreferences { scope: Scope::Off, ..Default::default() }),
                device("p2", DevicePreferences::default()),
            ],
        );
        let e = engine();
        let all = e.test(&TestTarget::All, &a);
        assert_eq!((all.toasts.len(), all.pushes.len()), (1, 2));
        let one = e.test(&TestTarget::Device("p2".into()), &a);
        assert_eq!((one.toasts.len(), one.pushes.len()), (0, 1));
        let desktop = e.test(&TestTarget::Desktop, &a);
        assert_eq!((desktop.toasts.len(), desktop.pushes.len()), (1, 0));
    }

    #[test]
    fn an_approval_push_carries_its_clipped_id_and_allow_flag_and_other_events_none() {
        let a = audience(&[], vec![device("phone", DevicePreferences::default())]);
        let long = format!("{}😀{}", "a".repeat(119), "tail");
        let waiting = ThreadEvent {
            event: Event::Approval,
            approval: Some(PushApproval { id: long, allow_once: true }),
            ..event()
        };
        let plan = engine().on_event(&waiting, &a);
        let approval = plan.pushes[0].approval.clone().expect("approval push");
        // 119 units + the emoji's high surrogate: `slice(0, 120)` cuts the pair.
        assert_eq!(mixdog_js::utf16_len(&approval.id), 120);
        assert!(approval.allow_once);
        let finished = ThreadEvent { approval: Some(PushApproval { id: "x".into(), allow_once: true }), ..event() };
        assert_eq!(engine().on_event(&finished, &a).pushes[0].approval, None);
    }

    #[test]
    fn device_notice_follows_scope() {
        assert!(device_notice(&view(DevicePreferences::default()), "t", "b", 0).is_some());
        assert!(device_notice(&view(DevicePreferences { scope: Scope::Off, ..Default::default() }), "t", "b", 0).is_none());
    }
}
