//! The system-cursor theme a foreground action holds while the overlay draws
//! the agent's pointer (input-guard.ps1 Acquire-CursorTheme and
//! Release-CursorTheme, runtime.ps1 Release-SessionState and
//! Do-ReleaseCursorTheme). The watchdog behind the desktop does the work; this
//! side decides when a theme is wanted, keeps it across a sequence's steps and
//! says what happened in the reply.

use super::{Host, Req, Res};
use crate::obj;
use crate::protocol::Obj;
use serde_json::json;

/// What one foreground action did with the theme.
#[derive(Default)]
pub(super) struct ThemeRun {
    /// A lease from an earlier action was held when this one began.
    pub(super) held_before: bool,
    /// This action holds a lease: its own, or the held one.
    pub(super) acquired: bool,
    /// Whether the lease blanks the cursors.
    pub(super) applied: bool,
    /// The input body ran to its end.
    pub(super) body_completed: bool,
}

impl Host {
    /// Ends the theme a sequence held across its steps (Do-ReleaseCursorTheme,
    /// runtime.ps1:37-41).
    pub(super) fn release_cursor_theme(&self) -> Res<Obj> {
        let restored = self.desktop.cursor_theme_end()?;
        Ok(obj! { "text" => "cursor theme released", "system_theme_restored" => restored })
    }

    /// Release-SessionState (runtime.ps1:22-35): the held input and then the
    /// theme are let go of, and the first failure is the one reported.
    pub(super) fn release_session_state(&self, req: &Req) -> Res<Obj> {
        let released = self.release_session(req);
        let theme = self.desktop.cursor_theme_end();
        let result = released?;
        theme?;
        Ok(result)
    }

    /// The decoration a foreground action asks for: only while the overlay
    /// draws the arrow (the request asked for pointer feedback), so the
    /// person's pointer is never hidden with nothing to replace it, and for a
    /// pointer action or a sequence that continues into one
    /// (input-guard.ps1:155-157).
    fn theme_decorates(&self, action: &str) -> bool {
        let keyboard = matches!(action, "key" | "type" | "key_down" | "key_up");
        self.feedback_enabled() && (!keyboard || self.current_request().bool_true("input_continues"))
    }

    /// Takes the theme right before input is dispatched.
    pub(super) fn theme_acquire(&self, run: &mut ThemeRun, action: &str) -> Res<()> {
        run.applied = match self.desktop.cursor_theme_begin(self.theme_decorates(action)) {
            Ok(applied) => applied,
            // The person's input, not the theme, stopped the lease: that reason
            // reaches the caller unchanged (MixCursorTheme.Complete).
            Err(error) if error.starts_with("computer_cursor_unavailable:") => {
                self.assert_continue()?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        run.acquired = true;
        Ok(())
    }

    /// Whether the theme outlives this action: input that ran, or a hold an
    /// earlier action began, keeps the blanked cursor for a sequence that
    /// continues or a held pointer; a refusal before any input hands it
    /// straight back.
    fn theme_kept(&self, run: &ThemeRun) -> bool {
        let request = self.current_request();
        let holds = request.bool_true("input_continues") || (request.bool_true("hold_pointer") && run.applied);
        holds && (run.body_completed || run.held_before)
    }

    /// The end of a foreground action (the finally of Invoke-ForegroundInput):
    /// an unused reservation is dropped, and a theme that is not kept is
    /// ended. A restoration the watchdog did not confirm replaces the outcome.
    pub(super) fn theme_finish(&self, run: &ThemeRun, outcome: &mut Res<Obj>) {
        if run.acquired && self.theme_kept(run) {
            return;
        }
        if !run.acquired && run.held_before {
            // The held theme belongs to an earlier action; this one never took it.
            return;
        }
        match self.desktop.cursor_theme_end() {
            Err(error) => *outcome = Err(error),
            Ok(_) if run.acquired && run.applied => {
                let feedback = outcome
                    .as_mut()
                    .ok()
                    .and_then(|result| result.get_mut("cursor_feedback"))
                    .and_then(|feedback| feedback.as_object_mut());
                if let Some(feedback) = feedback {
                    feedback.insert("system_theme_restored".into(), json!(true));
                }
            }
            Ok(_) => {}
        }
    }
}
