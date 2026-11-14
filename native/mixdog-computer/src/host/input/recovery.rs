//! Idle and recovery reads, restore and release of held input.

use crate::host::{sleep_ms, Host, Res};
use crate::keys;
use crate::obj;
use crate::observer::now_ms;
use crate::platform::{parse_window_id, window_id, Background, Desktop, Wid};
use crate::protocol::{Obj, Req};
use std::collections::BTreeMap;

/// How long after process start the observer may still be warming up, and how
/// long one idle read waits for it.
const FRESH_HOST_MS: u64 = 5_000;
const OBSERVER_WARMUP_MS: u64 = 300;

impl Host {
    // --- recovery -------------------------------------------------------------

    pub(in crate::host) fn input_idle_state(&self, req: &Req) -> Obj {
        // A capture names its window, so input into other processes during it
        // can be told apart from input into the target (runtime.ps1
        // input_idle_state); an unknown target is reached by all input.
        let target = parse_window_id(&req.text("input_target_window_id"));
        let process = self.desktop.pid_of(target);
        // ReadFor(target): pointer input elsewhere is not input into it.
        let mut state = self.observer.read_for(process, false);
        // A freshly started host has not taken its observer's first sample yet
        // (a few tens of ms); reporting not-ready then would make the first
        // capture of every session refuse foreground input.
        let started = now_ms();
        while !state.ready && started < FRESH_HOST_MS && now_ms() - started < OBSERVER_WARMUP_MS {
            sleep_ms(25);
            state = self.observer.read_for(process, false);
        }
        // Each cause is reported on its own: the input desktop's accessibility
        // does not depend on the observer, and the reason is metadata only.
        let desktop_ready = self.desktop.desktop_ready();
        let idle = now_ms().saturating_sub(state.tick);
        obj! {
            "ready" => state.ready && desktop_ready,
            "observer_ready" => state.ready,
            "observer_reason" => state.reason,
            "desktop_ready" => desktop_ready,
            "monitor" => state.generation,
            "sequence" => state.sequence,
            "target_sequence" => state.relevant_sequence,
            "idleMs" => idle,
            "held" => self.desktop.input_held(),
        }
    }

    pub(in crate::host) fn input_recovery_state(&self, req: &Req) -> Res<Obj> {
        let last_focus = self.session(|session| session.last_focus);
        let target = if req.bool_true("after_input") && req.has("window_id") {
            parse_window_id(&req.text("window_id"))
        } else if let Some(reference) = req.str("ref") {
            parse_window_id(&self.ref_record(&reference)?.1)
        } else if req.has("window_id") || req.has("window") {
            self.resolve_window(req)?.handle
        } else if self.is_window(last_focus) {
            last_focus
        } else {
            0
        };
        let exists = self.is_window(target);
        if target == 0 || (!exists && !req.bool_true("after_input")) {
            return Err("foreground input target is unavailable before dispatch".into());
        }
        let owner = if exists {
            self.desktop
                .info(target)
                .map(|info| info.owner_id())
                .unwrap_or_default()
        } else {
            String::new()
        };
        let foreground = self.desktop.foreground();
        let original = self.session(|session| session.original_focus);
        let restore = if self.is_window(original) {
            original
        } else {
            foreground
        };
        let restore_owner = self
            .desktop
            .info(restore)
            .map(|info| info.owner_id())
            .unwrap_or_default();
        let (cx, cy) = self.desktop.cursor();
        let evidence = self.observer.read();
        let foreground_pid = self
            .desktop
            .info(foreground)
            .map(|info| info.pid)
            .unwrap_or(0);
        let target_pid = self.desktop.info(target).map(|info| info.pid).unwrap_or(-1);
        Ok(obj! {
            "text" => "foreground input recovery state captured",
            "input_observer_ready" => evidence.ready,
            "input_monitor_id" => evidence.generation,
            "input_user_sequence" => evidence.sequence,
            "target_window_id" => window_id(target),
            "target_exists" => exists,
            "target_owner_window_id" => owner,
            "foreground_window_id" => if self.is_window(foreground) { window_id(foreground) } else { String::new() },
            "restore_window_id" => if self.is_window(restore) { window_id(restore) } else { String::new() },
            "restore_owner_window_id" => restore_owner,
            "cursor_x" => cx,
            "cursor_y" => cy,
            "input_tick" => evidence.tick,
            "synthetic_input" => self.physical_idle_ms() == i32::MAX as u64,
            "foreground_within_target" => foreground == target || self.desktop.is_owned_by(foreground, target),
            "foreground_child_process" => exists && foreground != target && foreground_pid != 0 && crate::platform::is_child_process(foreground_pid, target_pid),
        })
    }

    fn assert_recovery_unchanged(&self, req: &Req) -> Res<()> {
        let evidence = self.observer.read();
        let monitor = req.text("expected_input_monitor_id");
        let Some(sequence) = req.int("expected_input_user_sequence") else {
            return Err(
                "input_observation_unavailable: cannot establish the original input observation"
                    .into(),
            );
        };
        if !evidence.ready || monitor.is_empty() || evidence.generation != monitor {
            return Err(
                "input_observation_unavailable: cannot establish the original input observation"
                    .into(),
            );
        }
        if evidence.sequence != sequence {
            return Err(
                "user_input_active: desktop input changed; recovery must not override the user"
                    .into(),
            );
        }
        Ok(())
    }

    pub(in crate::host) fn restore_input_state(&self, req: &Req) -> Res<Obj> {
        self.assert_recovery_unchanged(req)?;
        {
            let mut scope = self.scope.borrow_mut();
            scope.begin_expected(
                &self.observer,
                &req.text("expected_input_monitor_id"),
                req.int("expected_input_user_sequence").unwrap_or(-1),
            )?;
        }
        let outcome = self.restore_body(req);
        self.scope.borrow_mut().end();
        outcome
    }

    fn restore_body(&self, req: &Req) -> Res<Obj> {
        let mut restore_focus = !req.bool_false("restore_focus");
        let mut restore = parse_window_id(&req.text("restore_window_id"));
        let mut restored = if restore_focus {
            "original"
        } else {
            "preserved"
        };
        if restore_focus && !self.is_window(restore) {
            let owner = parse_window_id(&req.text("restore_owner_window_id"));
            if !self.is_window(owner) {
                return Err("input recovery restore window is stale or invalid".into());
            }
            restore = owner;
            restored = "owner";
        }
        if restore_focus && req.has("held_window_ids") {
            // A restore may only take focus from a window the session held
            // (Restore-InputRecoveryState).
            let held: Vec<Wid> = req
                .strings("held_window_ids")
                .iter()
                .map(|id| parse_window_id(id))
                .collect();
            if !self.foreground_is_held(restore, &held) {
                return Err("foreground_changed: another window holds the foreground; the desktop was not restored".into());
            }
        }
        if restore_focus && !self.desktop.is_visible_focus_home(restore) {
            // The Start menu or search can hold focus when a session begins and
            // be hidden by the time it ends (Test-VisibleFocusHome).
            restore_focus = false;
            restored = "unavailable";
        }
        if restore_focus && self.desktop.foreground() != restore {
            self.mark_own();
            self.desktop.focus(restore);
        }
        self.assert_recovery_unchanged(req)?;
        let x = req.int("cursor_x").unwrap_or(0) as i32;
        let y = req.int("cursor_y").unwrap_or(0) as i32;
        self.mark_own();
        self.desktop.move_pointer(x, y)?;
        sleep_ms(30);
        self.assert_recovery_unchanged(req)?;
        self.mark_own();
        self.desktop.move_pointer(x, y)?;
        let foreground = self.desktop.foreground();
        let (cx, cy) = self.desktop.cursor();
        let evidence = self.observer.read();
        let target = parse_window_id(&req.text("window_id"));
        Ok(obj! {
            "input_observer_ready" => evidence.ready,
            "input_monitor_id" => evidence.generation,
            "input_user_sequence" => evidence.sequence,
            "foreground_window_id" => if self.is_window(foreground) { window_id(foreground) } else { String::new() },
            "restored_target" => restored,
            "cursor_x" => cx,
            "cursor_y" => cy,
            "input_tick" => evidence.tick,
            "synthetic_input" => self.physical_idle_ms() == i32::MAX as u64,
            "foreground_within_target" => foreground == target || self.desktop.is_owned_by(foreground, target),
        })
    }

    /// Whether the foreground is `restore` or a window `held` has, or none of
    /// the held windows is left (a fallback focus is nobody's to protect).
    fn foreground_is_held(&self, restore: Wid, held: &[Wid]) -> bool {
        let foreground = self.desktop.foreground();
        foreground == restore
            || !held.iter().any(|window| self.is_window(*window))
            || in_held(&*self.desktop, foreground, held)
    }

    /// Ends a session: returns focus when nothing else moved it, then
    /// releases every button and key the session still holds
    /// (Release-SessionState; the focus restore is the host's in PowerShell).
    /// `restore_focus: false` leaves the focus to the last session still using
    /// the desktop, and `handed_window_ids` are windows earlier sessions held
    /// that this one may take focus from (handedWindowIds). The reply names the
    /// windows this session held, for the next one to take over.
    pub(in crate::host) fn release_session(&self, req: &Req) -> Res<Obj> {
        let current = self.desktop.foreground();
        let observed = self.observer.read();
        let (original, monitor, sequence, own) = self.session(|session| {
            let own: Vec<Wid> = [
                session.last_focus,
                session.restore_point.map_or(0, |point| point.target),
            ]
            .into_iter()
            .filter(|window| *window != 0)
            .collect();
            (
                session.original_focus,
                session.original_focus_monitor.clone(),
                session.original_focus_sequence,
                own,
            )
        });
        let mut held = own.clone();
        held.extend(req.strings("handed_window_ids").iter().map(|id| parse_window_id(id)));
        let mut restored = false;
        if !req.bool_false("restore_focus")
            && observed.ready
            && monitor == observed.generation
            && sequence == Some(observed.sequence)
            && original != 0
            && in_held(&*self.desktop, current, &held)
            && self.is_window(original)
            && self.desktop.is_visible_focus_home(original)
        {
            self.mark_own();
            restored = self.desktop.focus(original);
        }
        let released = self.release_all_held();
        self.session(|session| {
            session.invalidate_refs();
            session.last_focus = 0;
            session.original_focus = 0;
            session.original_focus_monitor.clear();
            session.original_focus_sequence = None;
            session.restore_point = None;
        });
        released?;
        Ok(obj! {
            "text" => "computer session released",
            "focus_restored" => restored,
            "held_window_ids" => own.iter().map(|window| window_id(*window)).collect::<Vec<_>>(),
        })
    }

    /// The end of a turn: lets go of every button and key the session still
    /// holds while the session stays warm for a follow-up turn.
    pub(in crate::host) fn release_held_input(&self) -> Res<Obj> {
        self.release_all_held()
    }

    /// Release-HeldInput (runtime.ps1:5-20): pointer buttons, keys and sequence
    /// holds are all let go even when one fails, then a release a busy target
    /// never acknowledged is sent again; only its acknowledgement confirms the
    /// cleanup.
    fn release_all_held(&self) -> Res<Obj> {
        let pointer = self.release_held_pointer();
        let keys = self.release_held_keys();
        let holds = self.release_sequence_holds();
        let unconfirmed = self.retry_pending_releases();
        pointer?;
        keys?;
        holds?;
        if let Some(error) = unconfirmed {
            return Err(error);
        }
        Ok(obj! { "text" => "held input released", "background_release_confirmed" => true })
    }

    fn release_held_pointer(&self) -> Res<()> {
        let (held, roots) = self.session(|session| {
            (
                std::mem::take(&mut session.held_pointer),
                std::mem::take(&mut session.held_pointer_roots),
            )
        });
        if held.is_empty() && roots.is_empty() {
            return Ok(());
        }
        let Some(background) = self.desktop.background() else {
            return Err(
                "input_cleanup_unconfirmed: a held pointer button could not be released".into(),
            );
        };
        let mut pending = BTreeMap::new();
        let released = release_buttons(background, held, roots, &mut pending);
        self.session(|session| session.pending_releases.extend(pending));
        if released {
            return Ok(());
        }
        Err("input_cleanup_unconfirmed: a held pointer button could not be released".into())
    }

    /// RetryPendingReleases: the failure text while a release stays
    /// unacknowledged, None when every one landed.
    fn retry_pending_releases(&self) -> Option<String> {
        let pending = self.session(|session| std::mem::take(&mut session.pending_releases));
        if pending.is_empty() {
            return None;
        }
        let Some(background) = self.desktop.background() else {
            self.session(|session| session.pending_releases = pending);
            return Some(UNACKNOWLEDGED.into());
        };
        let (remaining, gone) = retry_pending(background, pending, |window| self.is_window(window));
        let unconfirmed = !remaining.is_empty() || gone > 0;
        self.session(|session| session.pending_releases.extend(remaining));
        unconfirmed.then(|| {
            if gone > 0 {
                "input_cleanup_unconfirmed: background_target_gone|the target window closed before it acknowledged a background input release".to_string()
            } else {
                UNACKNOWLEDGED.to_string()
            }
        })
    }

    fn release_held_keys(&self) -> Res<()> {
        let held = self.session(|session| std::mem::take(&mut session.held_keys));
        let mut failed = false;
        // Each key as it was pressed; every release is attempted.
        for (_, modifiers, key) in held.iter().rev() {
            let sink = &mut super::keyboard::ForegroundKeys { host: self };
            if keys::lift(modifiers, *key, sink).is_err() {
                failed = true;
            }
        }
        if failed {
            return Err("input_cleanup_unconfirmed: a held key could not be released".into());
        }
        Ok(())
    }
}

/// What a background release that a busy target never answered reports
/// (MixWin32Message.WithBackgroundRelease).
const UNACKNOWLEDGED: &str =
    "input_cleanup_unconfirmed: background input release was not acknowledged";

/// Whether `window` is one of the held windows or drawn over one of them.
fn in_held(desktop: &dyn Desktop, window: Wid, held: &[Wid]) -> bool {
    window != 0
        && held
            .iter()
            .any(|held| *held != 0 && (window == *held || desktop.is_owned_by(window, *held)))
}

/// Release-HeldPointerButtons (input-pointer.ps1:167-204): every held button is
/// released and the no-activate hold of its press ended, each one even when
/// another fails. A release the target never acknowledged is kept in `pending`
/// to be sent again. True when everything was let go.
fn release_buttons(
    background: &dyn Background,
    held: BTreeMap<String, (i32, i32)>,
    mut roots: BTreeMap<String, Wid>,
    pending: &mut BTreeMap<String, (i32, i32)>,
) -> bool {
    let mut released = true;
    for (id, (x, y)) in held {
        if let Err(error) = background.pointer(parse_window_id(&id), x, y, "release", &[]) {
            released = false;
            // A timed-out release may or may not have landed; sending it again
            // is harmless (ConfirmBackgroundRelease's background_target_hung).
            if error.contains(UNACKNOWLEDGED) || error.contains("background_target_hung|") {
                pending.insert(id.clone(), (x, y));
            }
        }
        if let Some(root) = roots.remove(&id) {
            released &= background.release_hold(root).is_ok();
        }
    }
    for root in roots.into_values() {
        released &= background.release_hold(root).is_ok();
    }
    released
}

/// RetryPendingReleases (MixWin32Message.cs:147-168): every unacknowledged
/// release is sent once more. Returns those still unacknowledged and how many
/// targets closed first; a closed target holds nothing, so it is reported once
/// and not retried again.
fn retry_pending(
    background: &dyn Background,
    pending: BTreeMap<String, (i32, i32)>,
    is_window: impl Fn(Wid) -> bool,
) -> (BTreeMap<String, (i32, i32)>, usize) {
    let mut remaining = BTreeMap::new();
    let mut gone = 0;
    for (id, (x, y)) in pending {
        let window = parse_window_id(&id);
        if !is_window(window) {
            gone += 1;
        } else if background.pointer(window, x, y, "release", &[]).is_err() {
            remaining.insert(id, (x, y));
        }
    }
    (remaining, gone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Mod;
    use std::cell::RefCell;

    /// Records the pointer and hold calls in order; releases of the windows in
    /// `unreachable` fail, those in `unanswered` time out.
    #[derive(Default)]
    struct Recorder {
        log: RefCell<Vec<String>>,
        unreachable: Vec<Wid>,
        unanswered: RefCell<Vec<Wid>>,
        hold_fails: Vec<Wid>,
    }

    impl Background for Recorder {
        fn validate(&self, _: Wid, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn pointer(&self, window: Wid, _: i32, _: i32, kind: &str, _: &[Mod]) -> Result<String, String> {
            self.log.borrow_mut().push(format!("{kind}:{window}"));
            if self.unreachable.contains(&window) {
                return Err("background_message_rejected|no".into());
            }
            if self.unanswered.borrow().contains(&window) {
                return Err("background_target_hung|native window message timed out".into());
            }
            Ok(window_id(window))
        }
        fn wheel(&self, _: Wid, _: i32, _: i32, _: i32, _: bool, _: &[Mod]) -> Result<String, String> {
            unreachable!()
        }
        fn drag(&self, _: Wid, _: &[(i32, i32)], _: &[Mod]) -> Result<String, String> {
            unreachable!()
        }
        fn keys(&self, _: Wid, _: &str) -> Result<String, String> {
            unreachable!()
        }
        fn text(&self, _: Wid, _: &str) -> Result<String, String> {
            unreachable!()
        }
        fn release_hold(&self, root: Wid) -> Result<(), String> {
            self.log.borrow_mut().push(format!("unhold:{root}"));
            if self.hold_fails.contains(&root) {
                Err("input_cleanup_unconfirmed: bit".into())
            } else {
                Ok(())
            }
        }
    }

    fn held(windows: &[Wid]) -> BTreeMap<String, (i32, i32)> {
        windows.iter().map(|w| (window_id(*w), (5, 6))).collect()
    }

    fn roots(windows: &[Wid]) -> BTreeMap<String, Wid> {
        windows.iter().map(|w| (window_id(*w), *w + 100)).collect()
    }

    #[test]
    fn every_button_and_hold_is_released_even_when_one_fails() {
        let recorder = Recorder {
            unreachable: vec![1],
            hold_fails: vec![102],
            ..Default::default()
        };
        let mut pending = BTreeMap::new();
        let released = release_buttons(&recorder, held(&[1, 2]), roots(&[1, 2]), &mut pending);
        assert!(!released);
        assert_eq!(
            *recorder.log.borrow(),
            ["release:1", "unhold:101", "release:2", "unhold:102"]
        );
        assert!(pending.is_empty(), "a refused release is not a pending one");
    }

    #[test]
    fn a_hold_with_no_button_left_is_still_ended() {
        let recorder = Recorder::default();
        let mut pending = BTreeMap::new();
        assert!(release_buttons(&recorder, BTreeMap::new(), roots(&[3]), &mut pending));
        assert_eq!(*recorder.log.borrow(), ["unhold:103"]);
    }

    #[test]
    fn an_unacknowledged_release_is_kept_then_confirmed_on_retry() {
        let recorder = Recorder {
            unanswered: RefCell::new(vec![4]),
            ..Default::default()
        };
        let mut pending = BTreeMap::new();
        assert!(!release_buttons(&recorder, held(&[4]), roots(&[4]), &mut pending));
        assert_eq!(pending.get(&window_id(4)), Some(&(5, 6)));
        let (remaining, gone) = retry_pending(&recorder, pending.clone(), |_| true);
        assert_eq!((remaining.len(), gone), (1, 0), "still unanswered");
        recorder.unanswered.borrow_mut().clear();
        let (remaining, gone) = retry_pending(&recorder, pending, |_| true);
        assert_eq!((remaining.len(), gone), (0, 0), "acknowledged");
    }

    #[test]
    fn a_closed_target_is_reported_gone_without_a_send() {
        let recorder = Recorder::default();
        let (remaining, gone) = retry_pending(&recorder, held(&[7]), |_| false);
        assert_eq!((remaining.len(), gone), (0, 1));
        assert!(recorder.log.borrow().is_empty());
    }
}
