//! Window reads and window-level operations.

use super::{sleep_ms, Host, Res};
use crate::obj;
use crate::platform::{window_id, WinState, WindowInfo};
use crate::protocol::{Obj, Req};
use serde_json::{json, Value};

fn window_row(info: &WindowInfo, with_app: bool) -> Value {
    json!({
        "id": info.id(),
        "title": info.title,
        "class_name": info.class_name,
        "app": if with_app { info.app.clone() } else { String::new() },
        "pid": info.pid,
        "parent_pid": info.parent_pid,
        "content_pid": info.pid,
        "owner_id": info.owner_id(),
        "focused": info.focused,
        "minimized": info.minimized,
        "maximized": info.maximized,
        "x": info.x,
        "y": info.y,
        "width": info.width,
        "height": info.height,
    })
}

impl Host {
    pub(super) fn list_windows(&self) -> Res<Obj> {
        let windows = self.desktop.windows()?;
        if windows.is_empty() {
            return Ok(obj! { "text" => "No windows found.", "windows" => Vec::<Value>::new() });
        }
        let lines: Vec<String> = windows
            .iter()
            .map(|info| {
                let focus = if info.focused { " focused" } else { "" };
                let state = if info.minimized {
                    " minimized"
                } else if info.maximized {
                    " maximized"
                } else {
                    ""
                };
                let owner = if info.owner != 0 { format!(" owner={}", info.owner_id()) } else { String::new() };
                let title = if info.title.is_empty() { "<untitled>" } else { info.title.as_str() };
                format!(
                    "{} | app={} pid={} class={}{}{}{} | \"{}\" | {}x{} at {},{}",
                    info.id(),
                    info.app,
                    info.pid,
                    info.class_name,
                    owner,
                    focus,
                    state,
                    title,
                    info.width,
                    info.height,
                    info.x,
                    info.y
                )
            })
            .collect();
        let rows: Vec<Value> = windows.iter().map(|info| window_row(info, true)).collect();
        Ok(obj! { "text" => format!("Windows:\n{}", lines.join("\n")), "windows" => rows })
    }

    pub(super) fn window_snapshot(&self) -> Res<Obj> {
        let rows: Vec<Value> = self.desktop.windows()?.iter().map(|info| window_row(info, false)).collect();
        Ok(obj! { "windows" => rows })
    }

    pub(super) fn related_windows(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        let ids: Vec<String> = self.desktop.related_windows(info.handle).into_iter().map(window_id).collect();
        Ok(obj! { "window_ids" => ids })
    }

    pub(super) fn window_bounds(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        if info.width <= 0 || info.height <= 0 {
            return Err(format!("window has no capturable bounds: {}", info.id()));
        }
        let related: Vec<String> = self.desktop.related_windows(info.handle).into_iter().map(window_id).collect();
        let (client_x, client_y, client_width, client_height) = info.client;
        Ok(obj! {
            "text" => format!("window bounds: {}", info.title),
            "title" => info.title,
            "window_id" => info.id(),
            "owner_id" => info.owner_id(),
            "x" => info.x,
            "y" => info.y,
            "width" => info.width,
            "height" => info.height,
            "client_x" => client_x,
            "client_y" => client_y,
            "client_width" => client_width,
            "client_height" => client_height,
            "related_window_ids" => related,
        })
    }

    /// The composited capture already renders exact windows on this platform;
    /// there is no separate window-owned surface to read.
    pub(super) fn window_capture(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        Err(format!(
            "capture_source_unavailable: {} has no native window surface backend; the composited capture covers {}",
            self.desktop.name(),
            info.id()
        ))
    }

    /// Integrity levels are a Windows boundary; these desktops have none, so
    /// no window is ever above this host.
    pub(super) fn window_integrity(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        Ok(obj! {
            "text" => "window integrity: not applicable",
            "window_id" => info.id(),
            "known" => false,
            "higher" => false,
            "own_rid" => 0,
            "target_rid" => 0,
            "own_name" => "",
            "target_name" => "",
        })
    }

    pub(super) fn move_window(&self, req: &Req) -> Res<Obj> {
        if !req.has("x") && !req.has("y") && !req.has("width") && !req.has("height") {
            return Err("move_window requires x, y, width, or height".into());
        }
        let info = self.resolve_window(req)?;
        let x = req.int("x").map_or(info.x, |value| value as i32);
        let y = req.int("y").map_or(info.y, |value| value as i32);
        let width = req.int("width").map_or(info.width, |value| value as i32);
        let height = req.int("height").map_or(info.height, |value| value as i32);
        if width < 1 || height < 1 {
            return Err("window width and height must be positive".into());
        }
        self.authorize(req, info.handle)?;
        if info.minimized {
            let _ = self.desktop.set_window_state(info.handle, WinState::Restore);
        }
        self.desktop
            .move_window(info.handle, x, y, width, height)
            .map_err(|error| format!("could not move window: {} ({error})", info.id()))?;
        sleep_ms(80);
        let after = self.desktop.info(info.handle);
        let verified = after.is_some_and(|after| after.x == x && after.y == y && after.width == width && after.height == height);
        let message = format!("moved {} to {x},{y} size {width}x{height}", info.id());
        Ok(self.action_result("move_window", self.desktop.name(), effect(verified), verified, &message, None, "background", Some(info.id())))
    }

    pub(super) fn window_state(&self, req: &Req) -> Res<Obj> {
        let wanted = req.text("state").to_lowercase();
        let state = match wanted.as_str() {
            "minimize" => WinState::Minimize,
            "maximize" => WinState::Maximize,
            "restore" => WinState::Restore,
            _ => return Err("window state must be minimize, maximize, or restore".into()),
        };
        let info = self.resolve_window(req)?;
        self.authorize(req, info.handle)?;
        self.desktop.set_window_state(info.handle, state)?;
        let mut verified = false;
        for _ in 0..10 {
            sleep_ms(80);
            verified = self.desktop.info(info.handle).is_some_and(|after| match state {
                WinState::Minimize => after.minimized,
                WinState::Maximize => after.maximized,
                WinState::Restore => !after.minimized && !after.maximized,
            });
            if verified {
                break;
            }
        }
        Ok(self.action_result("window_state", self.desktop.name(), effect(verified), verified, &format!("{wanted} window {}", info.id()), None, "background", Some(info.id())))
    }

    pub(super) fn close_window(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        self.authorize(req, info.handle)?;
        if !self.desktop.close_window(info.handle)? {
            return Ok(self.action_result("close_window", self.desktop.name(), "suspected_noop", false, &format!("could not request close for {}", info.id()), Some("window_close_rejected"), "background", Some(info.id())));
        }
        sleep_ms(120);
        let verified = !self.is_window(info.handle);
        let message = if verified {
            format!("closed window {}", info.id())
        } else {
            format!("close requested for {}; the app may be showing a save or confirmation dialog", info.id())
        };
        Ok(self.action_result("close_window", self.desktop.name(), effect(verified), verified, &message, None, "background", Some(info.id())))
    }

    /// Killing a process has nothing to undo, so it needs the caller's repeated
    /// intent and a window that no longer answers.
    pub(super) fn terminate_process(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        let id = Some(info.id());
        if req.text("confirm") != "terminate" {
            let message = format!("terminating {} discards unsaved work; confirm=terminate is required and the user has to agree first", info.id());
            return Ok(self.action_result("terminate_process", "none", "suspected_noop", false, &message, Some("confirmation_required"), "background", id));
        }
        if self.desktop.is_responding(info.handle) {
            let message = format!("window {} still answers; close it the ordinary way instead of killing its process", info.id());
            return Ok(self.action_result("terminate_process", "none", "suspected_noop", false, &message, Some("window_still_responding"), "background", id));
        }
        self.authorize(req, info.handle)?;
        if let Err(error) = self.desktop.terminate(info.pid) {
            let message = format!("could not terminate pid {}: {error}", info.pid);
            return Ok(self.action_result("terminate_process", self.desktop.name(), "suspected_noop", false, &message, Some("terminate_failed"), "background", id));
        }
        let verified = !self.is_window(info.handle);
        Ok(self.action_result("terminate_process", self.desktop.name(), effect(verified), verified, &format!("terminated pid {} behind {}", info.pid, info.id()), None, "background", id))
    }

    pub(super) fn do_focus(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        if self.wait_user_input_idle().is_none() {
            return Ok(self.user_input_active_result("focus_window", Some(info.id())));
        }
        self.authorize(req, info.handle)?;
        let previous = self.desktop.foreground();
        self.remember_focus_origin(previous, info.handle);
        self.mark_own();
        if !self.desktop.focus(info.handle) {
            return Ok(self.action_result("focus_window", "foreground", "suspected_noop", false, &format!("could not bring window to foreground: {}", info.title), Some("foreground_unavailable"), "foreground", Some(info.id())));
        }
        self.session(|session| session.last_focus = info.handle);
        Ok(self.action_result("focus_window", "foreground", "confirmed", true, &format!("focused: {}", info.title), None, "foreground", Some(info.id())))
    }
}

pub(super) fn effect(verified: bool) -> &'static str {
    if verified {
        "confirmed"
    } else {
        "unverifiable"
    }
}
