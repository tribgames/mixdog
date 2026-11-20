//! The phone push of a held request (push-notifier.ts `heldRequestPushText` and `onHeldRequest`,
//! fed by `notifyHeldRequest` of held-request-host.mjs): it names the waiting agent and nothing
//! else, never the tool, its arguments or any text of the request.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use mixdog_js::slice_utf16;

use super::decision::{Conversation, DESKTOP_HOLD_MS, SessionFields};
use super::engine::{NotificationEngine, PushRequest, PushSchedule};
use super::service::{AudienceSource, PushSink};

/// The title of every held-request push (`title: 'Mixdog'`).
pub const HELD_PUSH_TITLE: &str = "Mixdog";
/// `String(agentName || 'Mixy').slice(0, 60)`: the name clip, in UTF-16 units.
const NAME_UNITS: usize = 60;
const DEFAULT_NAME: &str = "Mixy";

/// What `notifyHeldRequest` hands the notifier: ids and the agent's name only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldRequestEvent {
    /// The owning agent's home thread: a tap opens it.
    pub session_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub request_id: String,
}

/// The whole text of a held-request push. The name is not Markdown-processed and takes no
/// particle: `ann` waits as `ann가 승인을 기다립니다`. A name cut inside a surrogate pair ends in
/// U+FFFD, which is what JavaScript's UTF-8 encoders write for the half pair.
pub fn held_request_push_text(agent_name: &str) -> String {
    let name = if agent_name.is_empty() { DEFAULT_NAME } else { agent_name };
    format!("{}가 승인을 기다립니다", slice_utf16(name, NAME_UNITS))
}

/// The desktop service's held-request notifier (`registerHeldRequestNotifier(event =>
/// pushNotifier.onHeldRequest(event))`): asks who is listening, plans the push and hands it to the
/// relay. A device whose PC-in-use preference holds it waits `DESKTOP_HOLD_MS`, then gets it unless
/// the notifier was switched off meanwhile; a request is never "seen on screen" (Node's `due` is
/// always true for it), so nothing else cancels the hold.
pub struct HeldPushNotifier {
    engine: Arc<NotificationEngine>,
    audience: Arc<dyn AudienceSource>,
    sink: Arc<dyn PushSink>,
    /// `isEnabled`: off once the host is closing.
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// `onError`: `[mixdog-remote-push] <detail>` in the daemon log.
    log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl HeldPushNotifier {
    pub fn new(
        engine: Arc<NotificationEngine>,
        audience: Arc<dyn AudienceSource>,
        sink: Arc<dyn PushSink>,
        enabled: Arc<dyn Fn() -> bool + Send + Sync>,
        now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
        log: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self { engine, audience, sink, enabled, now_ms, log })
    }

    /// `onHeldRequest`: the push runs on its own task, so the hold never waits for a phone. Called
    /// from inside the runtime (the hold that asks for it is an async call).
    pub fn notify(self: &Arc<Self>, held: HeldRequestEvent) {
        if !(self.enabled)() {
            return;
        }
        let this = Arc::clone(self);
        tokio::spawn(async move { this.deliver(&held).await });
    }

    async fn send(&self, request: &PushRequest) {
        if let Err(detail) = self.sink.push(request).await {
            (self.log)(&format!("[mixdog-remote-push] {detail}"));
        }
    }

    async fn deliver(&self, held: &HeldRequestEvent) {
        let conversation = Conversation::of(&held.session_id, &SessionFields::default());
        let audience = self.audience.audience(&held.session_id).await;
        let plan = self.engine.on_held_request(held, &conversation, &audience, (self.now_ms)());
        let mut waiting = HashSet::new();
        for request in &plan.pushes {
            match request.schedule {
                PushSchedule::Now => self.send(request).await,
                PushSchedule::HoldUntil(_) => {
                    waiting.insert(request.device_id.clone());
                }
            }
        }
        if waiting.is_empty() {
            return;
        }
        mixdog_rt::time::sleep(Duration::from_millis(DESKTOP_HOLD_MS)).await;
        if !(self.enabled)() {
            return;
        }
        // The second look asks nothing of this PC's activity: the held devices hear it now.
        let mut audience = self.audience.audience(&held.session_id).await;
        audience.desktop_active = false;
        let plan = self.engine.on_held_request(held, &conversation, &audience, (self.now_ms)());
        for request in plan.pushes.iter().filter(|request| waiting.contains(&request.device_id)) {
            self.send(request).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use async_trait::async_trait;

    use super::*;
    use crate::notify::decision::{DESKTOP_HOLD_MS, DevicePreferences, PreferencesView};
    use crate::notify::engine::{
        Audience, NotificationEngine, PairedDevice, PushApproval, ToastStyle,
    };


    fn engine() -> NotificationEngine {
        NotificationEngine::new(Arc::new(|| ToastStyle::for_volume(50)))
    }




    struct Listeners(Mutex<Audience>);

    #[async_trait]
    impl AudienceSource for Listeners {
        async fn audience(&self, _thread_id: &str) -> Audience {
            self.0.lock().unwrap().clone()
        }
        async fn settings(&self) -> serde_json::Value {
            serde_json::Value::Null
        }
    }

    #[derive(Default)]
    struct Relay {
        sent: Mutex<Vec<PushRequest>>,
        fail: AtomicBool,
    }

    #[async_trait]
    impl PushSink for Relay {
        async fn push(&self, request: &PushRequest) -> Result<(), String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("The relay is not connected right now.".to_owned());
            }
            self.sent.lock().unwrap().push(request.clone());
            Ok(())
        }

        fn connected(&self) -> bool {
            true
        }
    }

    struct Rig {
        relay: Arc<Relay>,
        on: Arc<AtomicBool>,
        logs: Arc<Mutex<Vec<String>>>,
        notifier: Arc<HeldPushNotifier>,
    }

    fn rig(devices: Vec<PairedDevice>, desktop_active: bool) -> Rig {
        let audience = Audience {
            pc: PreferencesView { preferences: DevicePreferences::default(), overrides: Vec::new() },
            hosts: Vec::new(),
            devices,
            desktop_active,
        };
        let listeners = Arc::new(Listeners(Mutex::new(audience)));
        let relay = Arc::new(Relay::default());
        let on = Arc::new(AtomicBool::new(true));
        let logs = Arc::new(Mutex::new(Vec::new()));
        let notifier = HeldPushNotifier::new(
            Arc::new(engine()),
            listeners,
            relay.clone(),
            Arc::new({
                let on = on.clone();
                move || on.load(Ordering::SeqCst)
            }),
            Arc::new(|| 1_800_000_000_000),
            Arc::new({
                let logs = logs.clone();
                move |line: &str| logs.lock().unwrap().push(line.to_owned())
            }),
        );
        Rig { relay, on, logs, notifier }
    }

    fn phone(id: &str) -> PairedDevice {
        PairedDevice {
            device_id: id.into(),
            view: PreferencesView { preferences: DevicePreferences::default(), overrides: Vec::new() },
            foreground_thread: None,
        }
    }

    fn held() -> HeldRequestEvent {
        HeldRequestEvent {
            session_id: "sess_home_ann".into(),
            agent_id: "ann".into(),
            agent_name: "ann".into(),
            request_id: "held_1".into(),
        }
    }

    async fn run_tasks() {
        mixdog_rt::time::sleep(Duration::from_millis(1)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_listening_phone_is_pushed_the_wording_at_once() {
        let rig = rig(vec![phone("phone-a")], false);
        rig.notifier.notify(held());
        run_tasks().await;
        let sent = rig.relay.sent.lock().unwrap().clone();
        assert_eq!(sent.len(), 1);
        assert_eq!((sent[0].title.as_str(), sent[0].body.as_str()), ("Mixdog", "ann가 승인을 기다립니다"));
        assert_eq!(sent[0].approval, Some(PushApproval { id: "held_1".into(), allow_once: false }));
    }

    /// A phone that holds pushes while this PC is in use hears it after the hold, past the PC's
    /// activity; a phone that does not, at once.
    #[tokio::test(start_paused = true)]
    async fn a_phone_held_for_the_pc_in_use_is_pushed_after_the_hold() {
        let mut waiting = phone("phone-hold");
        waiting.view.preferences.hold_while_desktop_active = true;
        let mut eager = phone("phone-now");
        eager.view.preferences.hold_while_desktop_active = false;
        let rig = rig(vec![waiting, eager], true);
        rig.notifier.notify(held());
        run_tasks().await;
        let ids = |rig: &Rig| rig.relay.sent.lock().unwrap().iter().map(|push| push.device_id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&rig), ["phone-now"]);
        tokio::time::advance(Duration::from_millis(DESKTOP_HOLD_MS)).await;
        run_tasks().await;
        assert_eq!(ids(&rig), ["phone-now", "phone-hold"], "the held phone only, once");
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_is_pushed_while_the_notifier_is_off_or_if_it_goes_off_during_the_hold() {
        let rig = rig(vec![phone("phone-a")], false);
        rig.on.store(false, Ordering::SeqCst);
        rig.notifier.notify(held());
        run_tasks().await;
        assert!(rig.relay.sent.lock().unwrap().is_empty());

        let rig = rig_held();
        rig.notifier.notify(held());
        run_tasks().await;
        rig.on.store(false, Ordering::SeqCst);
        tokio::time::advance(Duration::from_millis(DESKTOP_HOLD_MS)).await;
        run_tasks().await;
        assert!(rig.relay.sent.lock().unwrap().is_empty(), "the hold ended with the notifier off");
    }

    fn rig_held() -> Rig {
        rig(vec![phone("phone-hold")], true)
    }

    #[tokio::test(start_paused = true)]
    async fn a_relay_that_refuses_is_logged_and_never_fails_the_hold() {
        let rig = rig(vec![phone("phone-a")], false);
        rig.relay.fail.store(true, Ordering::SeqCst);
        rig.notifier.notify(held());
        run_tasks().await;
        assert_eq!(*rig.logs.lock().unwrap(), ["[mixdog-remote-push] The relay is not connected right now."]);
    }


}
