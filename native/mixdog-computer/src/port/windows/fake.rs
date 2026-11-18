//! A fake Windows below the port: the log is what reached the system, in order, and a test scripts what the system answers
//! and where a submission is held.

use super::{A11y, Broker, Message, Posted, Refusal, Reply, Staged, WinDriver, WinPort};
use crate::platform::windows_input::Event;
use crate::platform::{Wid, WinState};
use crate::port::fake::Pause;
use crate::port::{Boundary, Scope};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
pub(crate) struct FakeWin {
    pub(crate) log: Mutex<Vec<String>>,
    /// The next submission of this name waits here before its admission.
    pub(crate) before: Mutex<Option<(&'static str, Pause)>>,
    /// The next `SendInput` waits here once admitted, before the system takes it (the submission already won).
    pub(crate) inside: Mutex<Option<Pause>>,
    /// The next `SendInput` waits here for the receipt's cross-process lock (another process holds it).
    pub(crate) receipt_lock: Mutex<Option<Pause>>,
    /// The next `SendInput` takes only this many events.
    pub(crate) accept: Mutex<Option<u32>>,
    /// Queued messages are never answered (a lost reply).
    pub(crate) silent: Mutex<bool>,
    /// The next message is refused with this.
    pub(crate) refuse: Mutex<Option<Refusal>>,
    pub(crate) hung: Mutex<Vec<Wid>>,
    /// Windows whose owner changed (a reused handle).
    pub(crate) reused: Mutex<Vec<Wid>>,
    /// Whether a foreground change lands.
    pub(crate) focus_lands: Mutex<bool>,
    pub(crate) foreground: Mutex<Wid>,
    pub(crate) iconic: Mutex<Vec<Wid>>,
    staged: Mutex<Vec<String>>,
    /// An accessibility action waits here once admitted (a provider that has not answered yet).
    pub(crate) provider: Mutex<Option<Pause>>,
    /// Runs before each admission with the submission's name and how many of that name came before it: a test revokes
    /// between two steps here, on the operation's own thread.
    pub(crate) between: Mutex<Option<Box<dyn FnMut(&str, usize) + Send>>>,
    inside_call: Mutex<Option<(&'static str, Pause)>>,
    seen: Mutex<Vec<String>>,
}

impl FakeWin {
    pub(crate) fn port(scope: &Scope) -> (Arc<WinPort>, Arc<FakeWin>) {
        let fake = Arc::new(FakeWin::default());
        (WinPort::with_driver(scope, Box::new(fake.clone())), fake)
    }

    pub(crate) fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn push(&self, entry: String) {
        self.log.lock().unwrap().push(entry);
    }

    /// The next handed-over call named `what` (clipboard, no_activate) waits here inside the call, once handed over.
    pub(crate) fn pause_inside(&self, what: &'static str) -> Pause {
        let pause = Pause::new();
        *self.inside_call.lock().unwrap() = Some((what, pause.clone()));
        pause
    }

    fn hold_inside(&self, what: &str) {
        let pause = {
            let mut inside = self.inside_call.lock().unwrap();
            match inside.take() {
                Some((name, pause)) if name == what => Some(pause),
                other => {
                    *inside = other;
                    None
                }
            }
        };
        if let Some(pause) = pause {
            pause.reached.wait();
            pause.resume.wait();
        }
    }

    /// The order a test holds: the next submission named `what` stops before its admission.
    pub(crate) fn pause_before(&self, what: &'static str) -> Pause {
        let pause = Pause::new();
        *self.before.lock().unwrap() = Some((what, pause.clone()));
        pause
    }
}

/// How the log names one `SendInput` event.
pub(crate) fn event_text(event: &Event) -> String {
    match *event {
        Event::Key { scan, flags, .. } if flags & 0x4 != 0 => {
            format!("unicode {} {}", char::from_u32(scan as u32).unwrap_or('?'), if flags & 0x2 != 0 { "up" } else { "down" })
        }
        Event::Key { vk, flags, .. } => format!("key {vk:#x} {}", if flags & 0x2 != 0 { "up" } else { "down" }),
        Event::Mouse { flags, dx, dy, data } => format!("mouse {flags:#x} {dx} {dy} {data}"),
    }
}

impl WinDriver for Arc<FakeWin> {
    fn preflight(&self, what: &str) {
        let pause = {
            let mut before = self.before.lock().unwrap();
            match before.take() {
                Some((name, pause)) if name == what => Some(pause),
                other => {
                    *before = other;
                    None
                }
            }
        };
        if let Some(pause) = pause {
            pause.reached.wait();
            pause.resume.wait();
        }
        let count = {
            let mut seen = self.seen.lock().unwrap();
            let count = seen.iter().filter(|name| *name == what).count();
            seen.push(what.to_string());
            count
        };
        if let Some(between) = self.between.lock().unwrap().as_mut() {
            between(what, count);
        }
    }
    fn send_input(&self, events: &[Event], admission: Option<&Scope>) -> Result<u32, String> {
        // The receipt's cross-process lock, as the real driver takes it: before admission.
        let pause = self.receipt_lock.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.reached.wait();
            pause.resume.wait();
        }
        let _admitted = admission.map(|scope| scope.admit(Boundary::Local)).transpose()?;
        let pause = self.inside.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.reached.wait();
            pause.resume.wait();
        }
        let accepted = self.accept.lock().unwrap().take().map_or(events.len(), |count| count as usize).min(events.len());
        for event in &events[..accepted] {
            self.push(format!("input {}", event_text(event)));
        }
        Ok(accepted as u32)
    }
    fn hung(&self, window: Wid) -> bool {
        self.hung.lock().unwrap().contains(&window)
    }
    fn owner(&self, window: Wid) -> (u32, u32) {
        if self.reused.lock().unwrap().contains(&window) { (window as u32, 2) } else { (window as u32, 1) }
    }
    fn enqueue(&self, window: Wid, message: Message) -> Result<Reply, Refusal> {
        if let Some(refusal) = self.refuse.lock().unwrap().take() {
            return Err(refusal);
        }
        self.push(format!("queue {window} {message:?}"));
        Ok(if *self.silent.lock().unwrap() { Reply::default() } else { Reply::answered(1) })
    }
    fn wait(&self, reply: &Reply, _: Duration) -> Option<usize> {
        reply.get()
    }
    fn post(&self, window: Wid, message: Posted) -> Result<(), Refusal> {
        self.push(format!("post {window} {message:?}"));
        Ok(())
    }
    fn foreground(&self) -> Wid {
        *self.foreground.lock().unwrap()
    }
    fn iconic(&self, window: Wid) -> bool {
        self.iconic.lock().unwrap().contains(&window)
    }
    fn current_thread(&self) -> u32 {
        99
    }
    fn attach_input(&self, from: u32, to: u32, attach: bool) -> bool {
        self.hold_inside("attach");
        self.push(format!("{} {from} {to}", if attach { "attach" } else { "detach" }));
        true
    }
    fn bring_to_top(&self, window: Wid) {
        self.push(format!("bring_to_top {window}"));
    }
    fn set_foreground(&self, window: Wid) {
        self.push(format!("foreground {window}"));
        if *self.focus_lands.lock().unwrap() {
            *self.foreground.lock().unwrap() = window;
        }
    }
    fn set_active(&self, window: Wid) {
        self.push(format!("active {window}"));
    }
    fn set_focus(&self, window: Wid) {
        self.push(format!("focus {window}"));
    }
    fn no_name_key(&self) {
        self.push("grant".into());
    }
    fn show_async(&self, window: Wid, state: WinState) {
        self.hold_inside("show");
        self.push(format!("show {window} {state:?}"));
    }
    fn place_async(&self, window: Wid, x: i32, y: i32, width: i32, height: i32) -> bool {
        self.push(format!("move {window} {x} {y} {width} {height}"));
        true
    }
    fn terminate(&self, pid: u32) -> Result<(), String> {
        self.push(format!("terminate {pid}"));
        Ok(())
    }
    fn set_no_activate(&self, root: Wid, on: bool) -> bool {
        self.hold_inside("no_activate");
        self.push(format!("no_activate {root} {on}"));
        on
    }
    fn set_enabled(&self, window: Wid, enabled: bool) {
        self.hold_inside("shield");
        self.push(format!("enabled {window} {enabled}"));
    }
    fn accessibility(&self, action: &A11y<'_>) -> Result<(), String> {
        let pause = self.provider.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.reached.wait();
            pause.resume.wait();
        }
        self.push(format!("a11y {}", action.name()));
        Ok(())
    }
    fn stage_text(&self, text: &str) -> Result<Staged, String> {
        self.staged.lock().unwrap().push(text.to_string());
        Ok(Staged(None))
    }
    fn clipboard_empty(&self) -> Result<(), String> {
        self.hold_inside("clipboard_empty");
        self.push("clipboard_empty".into());
        Ok(())
    }
    fn clipboard_set(&self, _staged: Staged) -> Result<(), String> {
        let text = self.staged.lock().unwrap().pop().unwrap_or_default();
        self.push(format!("clipboard_set {text}"));
        Ok(())
    }
    fn shell_execute(&self, target: &str) -> windows::core::Result<u32> {
        self.push(format!("shell_execute {target}"));
        Ok(0)
    }
    fn create_broker(&self) -> windows::core::Result<Broker> {
        self.hold_inside("create_broker");
        self.push("create_broker".into());
        Ok(Broker(None))
    }
    fn activate_application(&self, _broker: &Broker, app_id: &str) -> windows::core::Result<u32> {
        self.push(format!("activate_application {app_id}"));
        Ok(0)
    }
}
