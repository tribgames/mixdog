//! Idle and recovery reads, restore and release of held input.

use crate::host::{sleep_ms, Host, Res};
use crate::keys::{self, Key};
use crate::obj;
use crate::observer::now_ms;
use crate::platform::{parse_window_id, window_id};
use crate::protocol::{Obj, Req};

impl Host {
    // --- recovery -------------------------------------------------------------

    pub(in crate::host) fn input_idle_state(&self) -> Obj {
        let state = self.observer.read();
        let idle = now_ms().saturating_sub(state.tick);
        obj! {
            "ready" => state.ready && self.desktop.desktop_ready(),
            "observer_ready" => state.ready,
            "monitor" => state.generation,
            "sequence" => state.sequence,
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
        let restore_focus = !req.bool_false("restore_focus");
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

    /// Ends a session: returns focus when nothing else moved it, then
    /// releases every button and key the session still holds.
    pub(in crate::host) fn release_session(&self) -> Res<Obj> {
        let current = self.desktop.foreground();
        let observed = self.observer.read();
        let (original, monitor, sequence, last_focus) = self.session(|session| {
            (
                session.original_focus,
                session.original_focus_monitor.clone(),
                session.original_focus_sequence,
                session.last_focus,
            )
        });
        let mut restored = false;
        if observed.ready
            && monitor == observed.generation
            && sequence == Some(observed.sequence)
            && original != 0
            && current == last_focus
            && self.is_window(original)
        {
            self.mark_own();
            restored = self.desktop.focus(original);
        }
        let pointer = self.release_held_pointer();
        let keys = self.release_held_keys();
        self.session(|session| {
            session.invalidate_refs();
            session.last_focus = 0;
            session.original_focus = 0;
            session.original_focus_monitor.clear();
            session.original_focus_sequence = None;
        });
        pointer?;
        keys?;
        Ok(obj! { "text" => "computer session released", "focus_restored" => restored })
    }

    /// The end of a turn: lets go of every button and key the session still
    /// holds while the session stays warm for a follow-up turn.
    pub(in crate::host) fn release_held_input(&self) -> Res<Obj> {
        let pointer = self.release_held_pointer();
        let keys = self.release_held_keys();
        pointer?;
        keys?;
        Ok(obj! { "text" => "held input released" })
    }

    fn release_held_pointer(&self) -> Res<()> {
        let held: Vec<(String, (i32, i32))> = self.session(|session| {
            std::mem::take(&mut session.held_pointer)
                .into_iter()
                .collect()
        });
        if held.is_empty() {
            return Ok(());
        }
        let Some(background) = self.desktop.background() else {
            return Err(
                "input_cleanup_unconfirmed: a held pointer button could not be released".into(),
            );
        };
        let mut failed = false;
        for (id, (x, y)) in held {
            if background
                .pointer(parse_window_id(&id), x, y, "release", &[])
                .is_err()
            {
                failed = true;
            }
        }
        if failed {
            return Err(
                "input_cleanup_unconfirmed: a held pointer button could not be released".into(),
            );
        }
        Ok(())
    }

    fn release_held_keys(&self) -> Res<()> {
        let held: Vec<String> = self.session(|session| std::mem::take(&mut session.held_keys));
        let mut failed = false;
        for keys_text in held.iter().rev() {
            let released = keys::held_key(keys_text).and_then(|(modifiers, key)| {
                self.mark_own();
                self.desktop.key(key, false)?;
                for modifier in modifiers.iter().rev() {
                    self.desktop.key(Key::Mod(*modifier), false)?;
                }
                Ok(())
            });
            if released.is_err() {
                failed = true;
            }
        }
        if failed {
            return Err("input_cleanup_unconfirmed: a held key could not be released".into());
        }
        Ok(())
    }
}
