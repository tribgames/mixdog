//! Who is using the mouse and keyboard: low-level hooks on a thread of their
//! own record every input event as this host's (injected with its marker) or
//! someone else's, into the shared ledger, with the processes it went to.
//! Windows can stop calling a hook without telling its owner, and delivers
//! none on the secure desktop, so the thread also compares the system's
//! last-input clock with the last event it saw and treats a difference as a
//! gap: fresh hooks, and no input until the desktop was quiet again
//! (MixInputObservation, InputObservation.cs).

use super::input::{any_held, desktop_ready, note_foreign, unassigned};
use super::native;
use crate::observer::{Monitor, Shared};
use crate::platform::Wid;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{HANDLE, LPARAM, LRESULT, WAIT_OBJECT_0, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentThreadId, SetEvent, WaitForSingleObject,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetGUIThreadInfo, GetMessageW, KillTimer, PeekMessageW, PostThreadMessageW,
    SetTimer, SetWindowsHookExW, UnhookWindowsHookEx, GUITHREADINFO, HHOOK, KBDLLHOOKSTRUCT, MSG,
    MSLLHOOKSTRUCT, PM_NOREMOVE, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_TIMER,
};

const INJECTED_MOUSE: u32 = 0x1;
const INJECTED_KEY: u32 = 0x10;
const KEY_UP: u32 = 0x80;
const WM_MOUSEWHEEL: u32 = 0x20A;
const WM_MOUSEHWHEEL: u32 = 0x20E;
/// A reader asks the hook thread to account for delivered input (DrainMessage).
const DRAIN: u32 = WM_APP + 1;
/// How often a gap's recovery looks for quiet (RecoveryIntervalMs).
const RECOVERY_INTERVAL_MS: u32 = 50;
/// How long a read waits for the hook thread to answer its drain.
const DRAIN_WAIT: Duration = Duration::from_millis(250);

struct Source {
    shared: Arc<Shared>,
    marker: usize,
}

static SOURCE: OnceLock<Source> = OnceLock::new();

/// What attributing an event asks of the desktop at that moment.
trait Lookup {
    fn window_at(&self, x: i32, y: i32) -> Wid;
    fn root(&self, window: Wid) -> Wid;
    fn foreground(&self) -> Wid;
    /// The process and thread owning a window; zeros for none.
    fn pid_thread(&self, window: Wid) -> (u32, u32);
    /// The window holding mouse capture on a thread; None when unreadable.
    fn capture(&self, thread: u32) -> Option<Wid>;
    fn button_held(&self) -> bool;
}

struct Live;

impl Lookup for Live {
    /// The raw hit, a cross-process child included (MouseProcesses' hit
    /// slot); `root` gives its top level.
    fn window_at(&self, x: i32, y: i32) -> Wid {
        native::window_from_point(x, y)
    }
    fn root(&self, window: Wid) -> Wid {
        native::root_of(window)
    }
    fn foreground(&self) -> Wid {
        native::foreground()
    }
    fn pid_thread(&self, window: Wid) -> (u32, u32) {
        if window == 0 {
            return (0, 0);
        }
        native::pid_thread(window)
    }
    fn capture(&self, thread: u32) -> Option<Wid> {
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: info is a valid, sized out pointer.
        unsafe { GetGUIThreadInfo(thread, &mut info) }.ok()?;
        Some(info.hwndCapture.0 as usize as Wid)
    }
    fn button_held(&self) -> bool {
        // SAFETY: plain key-state reads of the five mouse buttons.
        [1, 2, 4, 5, 6]
            .iter()
            .any(|button| (unsafe { GetAsyncKeyState(*button) }) as u16 & 0x8000 != 0)
    }
}

/// MouseProcesses: a mouse event reaches the window under it and, through a
/// cross-process child, that window's top level; a wheel may also go to the
/// foreground. A window holding mouse capture receives moves and releases
/// wherever the pointer is, and while a button is down the foreground may hold
/// it. None (unattributed, so it reaches every target) when neither the
/// capture nor a held button can be read.
fn mouse_processes(kind: u32, x: i32, y: i32, desktop: &impl Lookup) -> Option<[u32; 4]> {
    let hit = desktop.window_at(x, y);
    let root = if hit == 0 { 0 } else { desktop.root(hit) };
    let (foreground_process, thread) = desktop.pid_thread(desktop.foreground());
    let capture = if thread == 0 {
        None
    } else {
        desktop.capture(thread)
    };
    let held = desktop.button_held();
    if capture.is_none() && !held {
        return None;
    }
    let wheel = kind == WM_MOUSEWHEEL || kind == WM_MOUSEHWHEEL;
    Some([
        desktop.pid_thread(hit).0,
        desktop.pid_thread(root).0,
        if wheel || held { foreground_process } else { 0 },
        capture.map_or(0, |window| desktop.pid_thread(window).0),
    ])
}

/// Keys go to the foreground window's process (OnKey).
fn key_process(desktop: &impl Lookup) -> u32 {
    desktop.pid_thread(desktop.foreground()).0
}

unsafe extern "system" fn on_mouse(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 {
        if let Some(source) = SOURCE.get() {
            let event = &*(data.0 as *const MSLLHOOKSTRUCT);
            let kind = message.0 as u32;
            let own = event.flags & INJECTED_MOUSE != 0 && event.dwExtraInfo == source.marker;
            let processes = if own {
                None
            } else {
                mouse_processes(kind, event.pt.x, event.pt.y, &Live)
            };
            source.shared.record_event(
                own,
                event.time,
                true,
                processes.as_ref().map_or(&[], |found| found.as_slice()),
            );
            if !own {
                // A button's down message holds it, its up message lets go.
                let button = match kind {
                    0x201 => Some((1, true)),
                    0x202 => Some((1, false)),
                    0x204 => Some((2, true)),
                    0x205 => Some((2, false)),
                    0x207 => Some((4, true)),
                    0x208 => Some((4, false)),
                    _ => None,
                };
                if let Some((slot, held)) = button {
                    note_foreign(slot, held);
                }
            }
        }
    }
    CallNextHookEx(None, code, message, data)
}

unsafe extern "system" fn on_key(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 {
        if let Some(source) = SOURCE.get() {
            let event = &*(data.0 as *const KBDLLHOOKSTRUCT);
            let injected = event.flags.0 & INJECTED_KEY != 0;
            if injected && unassigned(event.vkCode) {
                // The system injects a reserved key while a packaged app takes
                // the foreground; counting it as a person's input would block
                // every restore of the person's focus. It still moves the
                // system's input clock, so the ledger keeps pace with it.
                source
                    .shared
                    .with_ledger(|ledger| ledger.record_neutral(event.time));
            } else {
                let own = injected && event.dwExtraInfo == source.marker;
                let process = if own { 0 } else { key_process(&Live) };
                source
                    .shared
                    .record_event(own, event.time, false, &[process]);
                if !own {
                    note_foreign(event.vkCode, event.flags.0 & KEY_UP == 0);
                }
            }
        }
    }
    CallNextHookEx(None, code, message, data)
}

/// InputTick (MixWin32.cs): the system's last-input clock.
fn input_tick() -> Option<u32> {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: info is a valid, sized out pointer.
    unsafe { GetLastInputInfo(&mut info) }
        .as_bool()
        .then_some(info.dwTime)
}

/// What the hook thread and its readers share.
struct Hub {
    /// The hook thread; 0 until it runs.
    thread: AtomicU32,
    /// Signalled after each answered drain and when the thread ends; 0 when
    /// the event could not be created.
    drained: isize,
    /// The newest drain request answered.
    answered: AtomicUsize,
    closed: AtomicBool,
}

impl Hub {
    fn signal(&self) {
        if self.drained != 0 {
            // SAFETY: the event lives as long as the process.
            let _ = unsafe { SetEvent(HANDLE(self.drained as *mut _)) };
        }
    }
}

struct HookMonitor {
    hub: Arc<Hub>,
    requests: AtomicUsize,
}

impl Monitor for HookMonitor {
    /// ReadMonitor's drain: hook callbacks for input the system already took
    /// reach the hook thread's queue first, so a drain posted behind them is
    /// answered with them accounted for. A drain an earlier reader gave up on
    /// may be answered late; its number does not end this wait.
    fn drain(&self) -> bool {
        let hub = &self.hub;
        let thread = hub.thread.load(Ordering::SeqCst);
        if thread == 0 || hub.drained == 0 || hub.closed.load(Ordering::SeqCst) {
            return false;
        }
        let request = self.requests.fetch_add(1, Ordering::SeqCst) + 1;
        // SAFETY: a plain post to a thread of this process.
        if unsafe { PostThreadMessageW(thread, DRAIN, WPARAM(request), LPARAM(0)) }.is_err() {
            return false;
        }
        let started = Instant::now();
        loop {
            let left = DRAIN_WAIT.saturating_sub(started.elapsed());
            // SAFETY: the event lives as long as the process.
            let signalled = !left.is_zero()
                && unsafe { WaitForSingleObject(HANDLE(hub.drained as *mut _), left.as_millis() as u32) }
                    == WAIT_OBJECT_0;
            if !signalled || hub.closed.load(Ordering::SeqCst) {
                return false;
            }
            if hub.answered.load(Ordering::SeqCst) >= request {
                return true;
            }
        }
    }

    fn input_tick(&self) -> Option<u32> {
        input_tick()
    }
}

/// Both hooks, owned by the hook thread.
#[derive(Default)]
struct Hooks {
    mouse: Option<HHOOK>,
    keyboard: Option<HHOOK>,
}

impl Hooks {
    fn installed(&self) -> bool {
        self.mouse.is_some() && self.keyboard.is_some()
    }

    /// RemoveHooks.
    unsafe fn remove(&mut self, shared: &Shared) {
        shared.set_ready(false);
        for hook in [self.mouse.take(), self.keyboard.take()].into_iter().flatten() {
            let _ = UnhookWindowsHookEx(hook);
        }
    }

    /// InstallHooks: input between removal and installation is unaccounted,
    /// so every reinstall opens a gap that only a confirmed quiet closes.
    unsafe fn install(&mut self, shared: &Shared, initial: bool) {
        self.remove(shared);
        let module = GetModuleHandleW(None).ok().map(|module| module.into());
        self.mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), module, 0).ok();
        self.keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), module, 0).ok();
        if !initial {
            shared.with_ledger(|ledger| ledger.latch());
        }
        if self.installed() {
            shared.set_ready(true);
        } else {
            self.remove(shared);
        }
    }
}

/// PublishSnapshot's judgement: the system clock against the last accounted
/// event, after hook callbacks still pending as sent messages were delivered.
unsafe fn account(shared: &Shared) {
    let mut tick = input_tick();
    let matches = shared.with_ledger(|ledger| ledger.gap() || tick == Some(ledger.latest_tick()));
    if !matches {
        let mut pending = MSG::default();
        let _ = PeekMessageW(&mut pending, None, 0, 0, PM_NOREMOVE);
        tick = input_tick();
    }
    shared.with_ledger(|ledger| match tick {
        Some(tick) => {
            ledger.observe(tick);
        }
        None => ledger.latch(),
    });
}

/// ConfirmQuiet: one recovery observation. A key state reads as up while the
/// input desktop is inaccessible, so held state only counts on a ready
/// desktop; both are rechecked around the resync and once more after it.
fn confirm_quiet(shared: &Shared, clock: &Instant) {
    let facts = || (desktop_ready(), any_held(), input_tick());
    let (desktop, held, tick) = facts();
    let elapsed = clock.elapsed().as_millis() as u64;
    let quiet = shared.with_ledger(|ledger| {
        ledger.observe_quiet(desktop && tick.is_some(), held, tick.unwrap_or(0), elapsed)
    });
    if !quiet {
        return;
    }
    let (desktop, held, _) = facts();
    let resynced = shared.with_ledger(|ledger| {
        let now = input_tick();
        ledger.resynchronize(desktop && now.is_some(), held, now.unwrap_or(0))
    });
    if !resynced {
        return;
    }
    let (desktop, held, _) = facts();
    shared.with_ledger(|ledger| {
        if !desktop || held || input_tick() != Some(ledger.latest_tick()) {
            ledger.latch();
        }
    });
}

/// Run: the hook thread. It serves the hooks, answers drains, and while a gap
/// is open or a hook is missing, works on a timer to get the observation back.
unsafe fn run(shared: &Shared, hub: &Hub, started: std::sync::mpsc::Sender<()>) {
    let mut message = MSG::default();
    // The thread needs its queue before a reader may post to it.
    let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
    let initial = input_tick();
    shared.with_ledger(|ledger| match initial {
        Some(tick) => ledger.record_neutral(tick),
        None => ledger.latch(),
    });
    let mut hooks = Hooks::default();
    hooks.install(shared, true);
    hub.thread.store(GetCurrentThreadId(), Ordering::SeqCst);
    let clock = Instant::now();
    let _ = started.send(());
    let mut timer = 0usize;
    let mut reinstalled_for_gap = false;
    while GetMessageW(&mut message, None, 0, 0).0 > 0 {
        let timer_tick = timer != 0
            && message.message == WM_TIMER
            && message.hwnd.0.is_null()
            && message.wParam.0 == timer;
        if message.message == DRAIN {
            account(shared);
            hub.answered.fetch_max(message.wParam.0, Ordering::SeqCst);
            hub.signal();
        }
        let gap = shared.with_ledger(|ledger| ledger.gap());
        if !gap {
            reinstalled_for_gap = false;
        }
        if !hooks.installed() || (gap && !reinstalled_for_gap) {
            // Windows may stop calling a hook without telling its owner, so
            // an unaccounted gap always gets fresh hooks.
            hooks.install(shared, false);
            reinstalled_for_gap = true;
        } else if gap && timer_tick {
            confirm_quiet(shared, &clock);
        }
        let recovering = !hooks.installed() || shared.with_ledger(|ledger| ledger.gap());
        if recovering && timer == 0 {
            timer = SetTimer(None, 0, RECOVERY_INTERVAL_MS, None);
        } else if !recovering && timer != 0 {
            let _ = KillTimer(None, timer);
            timer = 0;
        }
    }
    if timer != 0 {
        let _ = KillTimer(None, timer);
    }
    hooks.remove(shared);
}

/// Installs both hooks and serves them from their own thread for the life of
/// the process. Every read of the ledger drains that thread first.
pub fn start(shared: Arc<Shared>, marker: i64) {
    let _ = SOURCE.set(Source {
        shared: shared.clone(),
        marker: marker as usize,
    });
    let hub = Arc::new(Hub {
        thread: AtomicU32::new(0),
        // SAFETY: an unnamed auto-reset event, kept for the life of the process.
        drained: unsafe { CreateEventW(None, false, false, None) }
            .map_or(0, |event| event.0 as isize),
        answered: AtomicUsize::new(0),
        closed: AtomicBool::new(false),
    });
    shared.set_monitor(Box::new(HookMonitor {
        hub: hub.clone(),
        requests: AtomicUsize::new(0),
    }));
    let (started, wait) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("input-observer".into())
        .spawn(move || {
            // SAFETY: hooks are installed, pumped and removed on this one thread.
            unsafe { run(&shared, &hub, started) };
            // A waiting reader learns at once that nobody will answer.
            hub.closed.store(true, Ordering::SeqCst);
            hub.signal();
        });
    // The first request must find the ledger already answering.
    if spawned.is_ok() {
        let _ = wait.recv_timeout(Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Window 10 (process 100) with a cross-process child 11 (process 110);
    /// window 20 (process 200); the foreground is `foreground`.
    struct Fake {
        foreground: Wid,
        capture: Option<Wid>,
        held: bool,
    }

    impl Lookup for Fake {
        fn window_at(&self, x: i32, _y: i32) -> Wid {
            match x {
                0..=9 => 11,
                10..=19 => 20,
                _ => 0,
            }
        }
        fn root(&self, window: Wid) -> Wid {
            if window == 11 {
                10
            } else {
                window
            }
        }
        fn foreground(&self) -> Wid {
            self.foreground
        }
        fn pid_thread(&self, window: Wid) -> (u32, u32) {
            match window {
                0 => (0, 0),
                // A window whose owner cannot be read.
                30 => (0, 0),
                window => (window as u32 * 10, window as u32),
            }
        }
        fn capture(&self, _thread: u32) -> Option<Wid> {
            self.capture
        }
        fn button_held(&self) -> bool {
            self.held
        }
    }

    const MOVE: u32 = 0x200;

    #[test]
    fn a_mouse_event_reaches_the_window_under_it_and_its_top_level() {
        let desktop = Fake { foreground: 20, capture: Some(0), held: false };
        // Over the child: its process and its top level's, not the foreground's.
        assert_eq!(mouse_processes(MOVE, 5, 0, &desktop), Some([110, 100, 0, 0]));
        // A wheel may also go to the foreground.
        assert_eq!(mouse_processes(WM_MOUSEWHEEL, 5, 0, &desktop), Some([110, 100, 200, 0]));
        assert_eq!(mouse_processes(WM_MOUSEHWHEEL, 5, 0, &desktop), Some([110, 100, 200, 0]));
        // Over no window at all: nobody known, so the ledger counts it for all.
        assert_eq!(mouse_processes(MOVE, 50, 0, &desktop), Some([0, 0, 0, 0]));
    }

    #[test]
    fn capture_and_a_held_button_reach_past_the_window_under_the_pointer() {
        // A drag out of window 10 keeps going to it wherever the pointer is.
        let dragging = Fake { foreground: 10, capture: Some(10), held: true };
        assert_eq!(mouse_processes(MOVE, 15, 0, &dragging), Some([200, 200, 100, 100]));
        // A button down with the capture unreadable still reaches the foreground.
        let held = Fake { foreground: 10, capture: None, held: true };
        assert_eq!(mouse_processes(MOVE, 15, 0, &held), Some([200, 200, 100, 0]));
    }

    #[test]
    fn a_mouse_event_nobody_can_place_is_unattributed() {
        let unreadable = Fake { foreground: 10, capture: None, held: false };
        assert_eq!(mouse_processes(MOVE, 5, 0, &unreadable), None);
        // No foreground window: no thread to ask about capture.
        let none = Fake { foreground: 0, capture: Some(0), held: false };
        assert_eq!(mouse_processes(MOVE, 5, 0, &none), None);
        let unknown = Fake { foreground: 30, capture: Some(0), held: false };
        assert_eq!(mouse_processes(MOVE, 5, 0, &unknown), None);
    }

    #[test]
    fn keys_go_to_the_foreground_process() {
        let desktop = Fake { foreground: 20, capture: None, held: false };
        assert_eq!(key_process(&desktop), 200);
        let none = Fake { foreground: 0, capture: None, held: false };
        assert_eq!(key_process(&none), 0);
    }
}
