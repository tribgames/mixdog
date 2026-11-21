use mixdog_term::modes::ModeEnv;

use super::format::terminal_size;

/// Events of one burst closer than this are coalesced.
pub const RESIZE_DEBOUNCE_MS: f64 = 80.0;

/// `resizeState`: the size the layout is computed against and how many times it changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResizeState {
    pub columns: usize,
    pub rows: usize,
    pub epoch: u64,
}

/// The resize debounce, the extended-keys write and the input gate.
#[derive(Clone, Debug)]
pub struct TerminalChrome {
    resize: ResizeState,
    last_run: f64,
    trailing_due: Option<f64>,
    extended_keys_written: bool,
    ready: bool,
}

impl TerminalChrome {
    /// The chrome before the first commit: the size the terminal reports (a zero is 80 by 24), the input gate closed.
    pub fn new(columns: usize, rows: usize) -> Self {
        let (columns, rows) = terminal_size(columns, rows);
        Self { resize: ResizeState { columns, rows, epoch: 0 }, last_run: 0.0, trailing_due: None, extended_keys_written: false, ready: false }
    }

    pub fn resize_state(&self) -> ResizeState {
        self.resize
    }

    /// A resize event at `now_ms`: the first of a burst (at least [`RESIZE_DEBOUNCE_MS`] since the last update) asks for an
    /// update at once, the settle timer restarts either way. Returns whether the caller updates now with the size it reads
    /// ([`TerminalChrome::update`]).
    pub fn on_resize_event(&mut self, now_ms: f64) -> bool {
        let leading = now_ms - self.last_run >= RESIZE_DEBOUNCE_MS;
        if leading {
            self.last_run = now_ms;
        }
        self.trailing_due = Some(now_ms + RESIZE_DEBOUNCE_MS);
        leading
    }

    /// When the settle update fires, if one is pending.
    pub fn next_due(&self) -> Option<f64> {
        self.trailing_due
    }

    /// The settle timer at `now_ms`: returns whether it fired, in which case the caller updates with the size it reads.
    pub fn poll(&mut self, now_ms: f64) -> bool {
        match self.trailing_due {
            Some(due) if now_ms >= due => {
                self.trailing_due = None;
                self.last_run = now_ms;
                true
            }
            _ => false,
        }
    }

    /// `update()`: takes the size the terminal reports now. A size that did not change keeps the state as it was, so the
    /// post-mount update does not force a second full frame right after the first paint. Returns whether it changed.
    pub fn update(&mut self, columns: usize, rows: usize) -> bool {
        let (columns, rows) = terminal_size(columns, rows);
        if columns == self.resize.columns && rows == self.resize.rows {
            return false;
        }
        self.resize = ResizeState { columns, rows, epoch: self.resize.epoch + 1 };
        true
    }

    /// The listener is removed with the view: a pending settle update does not fire.
    pub fn unmount(&mut self) {
        self.trailing_due = None;
    }

    /// The extended-keyboard enable (kitty flags and modifyOtherKeys), written once, at the mount, before the first key is
    /// read: the text to write the first time it is asked on a terminal that supports raw mode and is on the allowlist
    /// ([`ModeEnv::extended_keys_on`] is empty otherwise), nothing on the later asks. The teardown is the terminal restore.
    pub fn extended_keys_once(&mut self, raw_mode_supported: bool, modes: &ModeEnv) -> Option<String> {
        if self.extended_keys_written {
            return None;
        }
        self.extended_keys_written = true;
        if !raw_mode_supported {
            return None;
        }
        let sequence = modes.extended_keys_on();
        (!sequence.is_empty()).then_some(sequence)
    }

    /// `useTuiReady()`: false across the first render and commit, true once one poll of the event loop has passed, so the
    /// keystrokes the OS buffered during the terminal setup are read (and dropped) while the prompt is still disabled.
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// The one tick after the mount.
    pub fn tick_after_mount(&mut self) {
        self.ready = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_resize_of_a_burst_updates_at_once_and_the_rest_settle_once() {
        let mut chrome = TerminalChrome::new(80, 24);
        assert!(chrome.on_resize_event(1000.0));
        assert!(!chrome.on_resize_event(1020.0));
        assert!(!chrome.on_resize_event(1050.0));
        // The settle timer restarted at the last event.
        assert_eq!(chrome.next_due(), Some(1130.0));
        assert!(!chrome.poll(1100.0));
        assert!(chrome.poll(1130.0));
        assert_eq!(chrome.next_due(), None);
        assert!(!chrome.poll(1200.0));
        // The settle counts as an update: an event right after it waits for the window again.
        assert!(!chrome.on_resize_event(1160.0));
        assert!(chrome.on_resize_event(1300.0));
    }

    #[test]
    fn an_unchanged_size_changes_nothing_and_a_changed_one_bumps_the_epoch() {
        let mut chrome = TerminalChrome::new(80, 24);
        assert!(!chrome.update(80, 24));
        assert_eq!(chrome.resize_state().epoch, 0);
        assert!(chrome.update(100, 30));
        assert_eq!(chrome.resize_state(), ResizeState { columns: 100, rows: 30, epoch: 1 });
        assert!(!chrome.update(100, 30));
        // A terminal that reports zero is not a size.
        assert!(chrome.update(0, 0));
        assert_eq!((chrome.resize_state().columns, chrome.resize_state().rows), (80, 24));
    }

    #[test]
    fn an_unmounted_view_fires_no_settle_update() {
        let mut chrome = TerminalChrome::new(80, 24);
        chrome.on_resize_event(10.0);
        chrome.unmount();
        assert!(!chrome.poll(1000.0));
    }

    #[test]
    fn the_extended_keys_are_enabled_once_and_only_where_the_terminal_allows_it() {
        let on = ModeEnv { extended_keys: true, windows_terminal: false, mouse: true };
        let mut chrome = TerminalChrome::new(80, 24);
        let sequence = chrome.extended_keys_once(true, &on).expect("written the first time");
        assert!(!sequence.is_empty());
        assert_eq!(chrome.extended_keys_once(true, &on), None);
        let off = ModeEnv { extended_keys: false, ..on };
        assert_eq!(TerminalChrome::new(80, 24).extended_keys_once(true, &off), None);
        assert_eq!(TerminalChrome::new(80, 24).extended_keys_once(false, &on), None);
    }

    #[test]
    fn the_input_gate_opens_one_tick_after_the_mount() {
        let mut chrome = TerminalChrome::new(80, 24);
        assert!(!chrome.is_ready());
        chrome.tick_after_mount();
        assert!(chrome.is_ready());
    }
}
