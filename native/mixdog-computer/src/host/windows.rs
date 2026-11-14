//! Window reads and window-level operations.

use super::frame::{capture_size, local_region, map_ocr, Pixels};
use super::frame_quality::{decode_png, png_quality_issue, Issue, Region};
use super::{sleep_ms, Host, Res};
use crate::obj;
use crate::platform::{
    window_id, CaptureFailure, Cleanup, Surface, Wid, WinState, WindowInfo,
    UNKNOWN_CAPTURE_BACKEND,
};
use crate::protocol::{Obj, Req};
use serde_json::{json, Value};
use std::time::Instant;

/// The work one capture attempt may spend: NATIVE_CAPTURE_TIMEOUT_MS less
/// 500 ms to cancel and release (shared/capture-attempts.ts:22-24).
const CAPTURE_WORK_MS: u32 = 1500;

/// The window-owned surfaces, in the order a request that names none tries them.
const CAPTURE_PLAN: [&str; 2] = ["print_window", "wgc"];

/// A window that once needed the compositor capture asks it first, so the
/// PrintWindow attempts that failed before are not paid again.
const REMEMBERED_PLAN: [&str; 2] = ["wgc", "print_window"];

/// Windows remembered at most; a closed window leaves its entry behind.
const REMEMBERED_WINDOWS: usize = 64;

fn window_row(info: &WindowInfo, with_app: bool) -> Value {
    json!({
        "id": info.id(),
        "title": info.title,
        "class_name": info.class_name,
        "app": if with_app { info.app.clone() } else { String::new() },
        "pid": info.pid,
        "parent_pid": info.parent_pid,
        "content_pid": if info.content_pid != 0 { info.content_pid } else { info.pid },
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
                let owner = if info.owner != 0 {
                    format!(" owner={}", info.owner_id())
                } else {
                    String::new()
                };
                let title = if info.title.is_empty() {
                    "<untitled>"
                } else {
                    info.title.as_str()
                };
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
        let rows: Vec<Value> = self
            .desktop
            .windows()?
            .iter()
            .map(|info| window_row(info, false))
            .collect();
        Ok(obj! { "windows" => rows })
    }

    pub(super) fn related_windows(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        let ids: Vec<String> = self
            .desktop
            .related_windows(info.handle)
            .into_iter()
            .map(window_id)
            .collect();
        Ok(obj! { "window_ids" => ids })
    }

    pub(super) fn window_bounds(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        if info.width <= 0 || info.height <= 0 {
            return Err(format!("window has no capturable bounds: {}", info.id()));
        }
        let related: Vec<String> = self
            .desktop
            .related_windows(info.handle)
            .into_iter()
            .map(window_id)
            .collect();
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

    /// The window's own rendering where the platform keeps one; elsewhere the
    /// composited capture already renders exact windows. Without a named
    /// backend PrintWindow is tried first and Windows Graphics Capture takes
    /// over from a recoverable failure or an unusable frame
    /// (capture-source-plan.ts, capture-native-surface.ts:110-177).
    pub(super) fn window_capture(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        let output = Output::of(req)?;
        let (mut capture, mut delivery) = self.capture_surface(req, &info, &output)?;
        let mut served = info.clone();
        let mut through_owner = false;
        // A child window whose surface could not be read is retried once
        // through its owner, whose composited surface includes the child
        // (captureThroughOwner, capture-pixels.ts); the owner's attempts are
        // appended to the child's, tagged scope owner.
        if capture.surface.is_err() && !capture.terminal && info.owner != 0 && info.owner != info.handle {
            // The owner is a capture of its own: a grant that names the child alone does not reach it.
            let owner = self
                .desktop
                .info(info.owner)
                .filter(|owner| owner.handle != 0 && self.authorize(req, owner.handle).is_ok());
            if let Some(owner) = owner {
                let (owner_capture, owner_delivery) = self.capture_surface(req, &owner, &output)?;
                let mut attempts = std::mem::take(&mut capture.attempts);
                attempts.extend(owner_capture.attempts.into_iter().map(|mut row| {
                    if let Value::Object(fields) = &mut row {
                        fields.insert("scope".into(), json!("owner"));
                    }
                    row
                }));
                let cleanup = worse(capture.cleanup, owner_capture.cleanup);
                if owner_capture.surface.is_ok() {
                    through_owner = true;
                    served = owner;
                    delivery = owner_delivery;
                    capture = Capture { surface: owner_capture.surface, attempts, cleanup, terminal: false };
                } else {
                    capture.attempts = attempts;
                    capture.cleanup = cleanup;
                }
            }
        }
        let mut reply = capture_reply(&served, capture);
        if let (Ok(result), Some(delivery)) = (reply.result.as_mut(), delivery) {
            delivery.apply(result);
        }
        if let (true, Ok(result)) = (through_owner, reply.result.as_mut()) {
            result.insert("requested_window_id".into(), json!(info.id()));
            let text = result.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
            result.insert(
                "text".into(),
                json!(format!(
                    "{text}; requested child window {} was captured through owner {}",
                    info.id(),
                    served.id()
                )),
            );
        }
        if let Some(result) = reply.error_result {
            self.error_result
                .borrow_mut()
                .get_or_insert_with(Obj::new)
                .extend(result);
        }
        if reply.retire {
            self.retire_after_reply.set(true);
        }
        reply.result
    }

    /// One window's capture through the plan its request names, the frame
    /// cut and fitted for delivery.
    fn capture_surface(&self, req: &Req, info: &WindowInfo, output: &Output) -> Res<(Capture, Option<Delivery>)> {
        let remembered = self.wgc_windows.borrow().get(&info.handle) == Some(&info.pid);
        let (plan, judged): (&[&str], bool) = match req.str("capture_backend").as_deref() {
            None if remembered => (&REMEMBERED_PLAN, true),
            None => (&CAPTURE_PLAN, true),
            Some("print_window") => (&CAPTURE_PLAN[..1], false),
            Some("wgc") => (&CAPTURE_PLAN[1..], false),
            Some(_) => return Err(UNKNOWN_CAPTURE_BACKEND.into()),
        };
        let mut capture = run_plan(
            plan,
            |backend| {
                self.desktop
                    .window_surface_backend(info.handle, backend, CAPTURE_WORK_MS)
            },
            |surface| {
                if !judged {
                    return None;
                }
                let (x, y, width, height) = info.client;
                let content = (width > 0 && height > 0).then_some(Region {
                    x: x - surface.x,
                    y: y - surface.y,
                    width,
                    height,
                });
                png_quality_issue(&surface.png, (surface.width, surface.height), content)
            },
        );
        if judged {
            self.remember_backend(info, &capture);
        }
        let mut delivery = None;
        let mut refused = None;
        if let Ok(surface) = &capture.surface {
            match self.deliver(output, surface) {
                Ok(None) if output.region.is_some() => {
                    // A crop that cannot be made is refused, never answered
                    // with the whole surface under the region's geometry.
                    refused = Some(
                        "capture_region_invalid: the frame could not be decoded or encoded for the region".into(),
                    )
                }
                Ok(delivered) => delivery = delivered,
                Err(error) => refused = Some(error),
            }
        }
        if let Some(error) = refused {
            capture.surface = Err(error);
            capture.terminal = true;
        }
        Ok((capture, delivery))
    }

    /// Keeps the window as one that needs the compositor capture when that
    /// backend produced its frame, and forgets it when another one did or
    /// the capture failed.
    fn remember_backend(&self, info: &WindowInfo, capture: &Capture) {
        let mut windows = self.wgc_windows.borrow_mut();
        if captured_by(capture) == Some("wgc") {
            if windows.len() >= REMEMBERED_WINDOWS {
                windows.clear();
            }
            windows.insert(info.handle, info.pid);
        } else {
            windows.remove(&info.handle);
        }
    }

    /// Integrity levels are a Windows boundary; other desktops have none, so
    /// it is known that no window is ever above this host. Answering "unknown"
    /// instead made the desktop refuse every foreground input there.
    pub(super) fn window_integrity(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        if let Some(level) = self.desktop.integrity(info.handle) {
            return Ok(obj! {
                "text" => format!("window integrity: {}", level.target_name),
                "window_id" => info.id(),
                "known" => level.known(),
                "higher" => level.higher(),
                "own_rid" => level.own_rid,
                "target_rid" => level.target_rid,
                "own_name" => level.own_name,
                "target_name" => level.target_name,
            });
        }
        Ok(obj! {
            "text" => "window integrity: not applicable",
            "window_id" => info.id(),
            "known" => true,
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
            let _ = self
                .desktop
                .set_window_state(info.handle, WinState::Restore);
        }
        self.desktop
            .move_window(info.handle, x, y, width, height)
            .map_err(|error| format!("could not move window: {} ({error})", info.id()))?;
        sleep_ms(80);
        let after = self.desktop.info(info.handle);
        let verified = after.is_some_and(|after| {
            after.x == x && after.y == y && after.width == width && after.height == height
        });
        let message = format!("moved {} to {x},{y} size {width}x{height}", info.id());
        Ok(self.action_result(
            "move_window",
            self.desktop.name(),
            effect(verified),
            verified,
            &message,
            None,
            "background",
            Some(info.id()),
        ))
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
            verified = self
                .desktop
                .info(info.handle)
                .is_some_and(|after| match state {
                    WinState::Minimize => after.minimized,
                    WinState::Maximize => after.maximized,
                    WinState::Restore => !after.minimized && !after.maximized,
                });
            if verified {
                break;
            }
        }
        Ok(self.action_result(
            "window_state",
            self.desktop.name(),
            effect(verified),
            verified,
            &format!("{wanted} window {}", info.id()),
            None,
            "background",
            Some(info.id()),
        ))
    }

    pub(super) fn close_window(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        self.authorize(req, info.handle)?;
        if !self.desktop.close_window(info.handle)? {
            return Ok(self.action_result(
                "close_window",
                self.desktop.name(),
                "suspected_noop",
                false,
                &format!("could not request close for {}", info.id()),
                Some("window_close_rejected"),
                "background",
                Some(info.id()),
            ));
        }
        sleep_ms(120);
        let verified = !self.is_window(info.handle);
        let message = if verified {
            format!("closed window {}", info.id())
        } else {
            format!(
                "close requested for {}; the app may be showing a save or confirmation dialog",
                info.id()
            )
        };
        Ok(self.action_result(
            "close_window",
            self.desktop.name(),
            effect(verified),
            verified,
            &message,
            None,
            "background",
            Some(info.id()),
        ))
    }

    /// Killing a process has nothing to undo, so it needs the caller's repeated
    /// intent and a window that no longer answers.
    pub(super) fn terminate_process(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        let id = Some(info.id());
        if req.text("confirm") != "terminate" {
            let message = format!("terminating {} discards unsaved work; confirm=terminate is required and the user has to agree first", info.id());
            return Ok(self.action_result(
                "terminate_process",
                "none",
                "suspected_noop",
                false,
                &message,
                Some("confirmation_required"),
                "background",
                id,
            ));
        }
        if self.desktop.is_responding(info.handle) {
            let message = format!(
                "window {} still answers; close it the ordinary way instead of killing its process",
                info.id()
            );
            return Ok(self.action_result(
                "terminate_process",
                "none",
                "suspected_noop",
                false,
                &message,
                Some("window_still_responding"),
                "background",
                id,
            ));
        }
        self.authorize(req, info.handle)?;
        if let Err(error) = self.desktop.terminate(info.pid) {
            let message = format!("could not terminate pid {}: {error}", info.pid);
            return Ok(self.action_result(
                "terminate_process",
                self.desktop.name(),
                "suspected_noop",
                false,
                &message,
                Some("terminate_failed"),
                "background",
                id,
            ));
        }
        let verified = !self.is_window(info.handle);
        Ok(self.action_result(
            "terminate_process",
            self.desktop.name(),
            effect(verified),
            verified,
            &format!("terminated pid {} behind {}", info.pid, info.id()),
            None,
            "background",
            id,
        ))
    }

    pub(super) fn do_focus(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        if let Some(refusal) = self.foreground_refusal("focus_window", info.handle) {
            return Ok(refusal);
        }
        self.authorize(req, info.handle)?;
        let previous = self.desktop.foreground();
        self.remember_focus_origin(previous, info.handle);
        // Focus moves the desktop first in a session as foreground input does
        // (input-run-prepare.ts:115-118 reads the baseline for focus_window).
        let restore_point = self.record_restore_point(info.handle, previous);
        let mut outcome = self.focus_body(&info, previous);
        self.report_restore_point(restore_point, &mut outcome);
        outcome
    }

    /// Do-Focus (input-window.ps1:1-26) once the target is authorized.
    fn focus_body(&self, info: &WindowInfo, previous: Wid) -> Res<Obj> {
        self.assert_continue()?;
        self.mark_own();
        if !self.desktop.focus(info.handle) {
            return Ok(self.action_result(
                "focus_window",
                "foreground",
                "suspected_noop",
                false,
                &format!("could not bring window to foreground: {}", info.title),
                Some("foreground_unavailable"),
                "foreground",
                Some(info.id()),
            ));
        }
        // Focus moves the desktop like any input: input from the person while
        // it settles stops it, and a target that does not keep the foreground
        // was not focused (Do-Focus, input-window.ps1:15-19).
        if previous != info.handle {
            sleep_ms(120);
        }
        self.assert_continue()?;
        if self.desktop.foreground() != info.handle {
            return Ok(self.action_result(
                "focus_window",
                "foreground",
                "suspected_noop",
                false,
                &format!(
                    "the foreground moved away from {} before focus settled",
                    info.title
                ),
                Some("foreground_changed"),
                "foreground",
                Some(info.id()),
            ));
        }
        self.session(|session| session.last_focus = info.handle);
        Ok(self.action_result(
            "focus_window",
            "foreground",
            "confirmed",
            true,
            &format!("focused: {}", info.title),
            None,
            "foreground",
            Some(info.id()),
        ))
    }
}

pub(super) fn effect(verified: bool) -> &'static str {
    if verified {
        "confirmed"
    } else {
        "unverifiable"
    }
}

/// What the capture plan left: the surface or the last refusal, one row per
/// attempt, and the worst of what became of the resources.
struct Capture {
    surface: Result<Surface, String>,
    attempts: Vec<Value>,
    cleanup: Cleanup,
    /// The plan ended on a failure no other source recovers from (or on a
    /// platform without the backend): the owner is not asked.
    terminal: bool,
}

/// The code a refusal text opens with (`code|message` or `code: message`),
/// `capture_source_unavailable` when it has none (computerErrorCode,
/// computer-bridge/error-code.mjs; capture-source-attempt.ts): a row never
/// carries an error message.
fn code_of(text: &str) -> &str {
    let text = text.trim();
    let end = text.find(['|', ':']).unwrap_or(0);
    let code = &text[..end];
    let coded = code.len() <= 80
        && code.starts_with(|c: char| c.is_ascii_alphabetic())
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if coded {
        code
    } else {
        "capture_source_unavailable"
    }
}

/// Whether the next backend may still succeed after a refusal
/// (RECOVERABLE_CAPTURE_CODES, capture-source-attempt.ts): a capture code other
/// than a minimized or cloaked window, or an unusable frame. Resources that
/// are not confirmed released end the plan.
fn falls_through(failure: &CaptureFailure) -> bool {
    let code = code_of(&failure.text);
    let capture_code = code.starts_with("capture_") && !matches!(code, "capture_minimized" | "capture_cloaked");
    let frame_code = matches!(
        code,
        "empty_frame" | "blank_black_frame" | "blank_white_frame" | "coordinate_mismatch"
    );
    failure.cleanup.status == "confirmed" && (capture_code || frame_code)
}

/// The more severe of two cleanups (`failed`, then `unconfirmed`); the first on a tie.
fn worse(first: Cleanup, second: Cleanup) -> Cleanup {
    let rank = |cleanup: &Cleanup| match cleanup.status {
        "failed" => 2,
        "unconfirmed" => 1,
        _ => 0,
    };
    if rank(&second) > rank(&first) {
        second
    } else {
        first
    }
}

fn cleanup_json(cleanup: &Cleanup) -> Value {
    match cleanup.cancellation {
        Some(cancellation) => json!({ "status": cleanup.status, "cancellation": cancellation }),
        None => json!({ "status": cleanup.status }),
    }
}

/// Tries `backends` in order, each surface judged by `judge`; one
/// capture_attempts row per attempt (shared/capture-attempts.ts:9-60).
fn run_plan(
    backends: &[&str],
    mut acquire: impl FnMut(&str) -> Result<Surface, CaptureFailure>,
    judge: impl Fn(&Surface) -> Option<Issue>,
) -> Capture {
    let mut attempts = Vec::new();
    let mut cleanup = Cleanup::CONFIRMED;
    let mut flags = None;
    let mut previous = String::new();
    let mut terminal = false;
    for (index, backend) in backends.iter().enumerate() {
        let started = Instant::now();
        let outcome = match acquire(backend) {
            Ok(surface) => {
                flags = surface.print_window_flags.or(flags);
                match judge(&surface) {
                    None => Ok(surface),
                    Some(issue) => Err((CaptureFailure::from(issue.text()), "unavailable")),
                }
            }
            Err(failure) => Err((failure, "failed")),
        };
        let mut row = obj! {
            "backend" => *backend,
            "scope" => "target",
            "status" => "captured",
            "elapsed_ms" => started.elapsed().as_millis() as u64,
        };
        match outcome {
            Ok(mut surface) => {
                attempts.push(Value::Object(row));
                surface.print_window_flags = flags;
                return Capture {
                    surface: Ok(surface),
                    attempts,
                    cleanup,
                    terminal: false,
                };
            }
            Err((failure, status)) => {
                // A backend this desktop lacks was never an attempt.
                if failure.text == UNKNOWN_CAPTURE_BACKEND && index > 0 {
                    return Capture {
                        surface: Err(previous),
                        attempts,
                        cleanup,
                        terminal: true,
                    };
                }
                row.insert("status".into(), json!(status));
                row.insert("code".into(), json!(code_of(&failure.text)));
                row.insert("cleanup".into(), cleanup_json(&failure.cleanup));
                attempts.push(Value::Object(row));
                cleanup = worse(cleanup, failure.cleanup);
                let recoverable = falls_through(&failure);
                previous = failure.text;
                if !recoverable {
                    terminal = true;
                    break;
                }
            }
        }
    }
    Capture {
        surface: Err(previous),
        attempts,
        cleanup,
        terminal,
    }
}

/// The backend that produced the frame of a successful capture.
fn captured_by(capture: &Capture) -> Option<&str> {
    capture.surface.as_ref().ok()?;
    capture.attempts.last()?["backend"].as_str()
}

/// What a capture answers: the request's result, what a failure still reports
/// under `result`, and whether the host must exit once the reply is out
/// (runtime.ps1:255-264: a host whose resource release is unconfirmed is
/// never reused).
struct CaptureReply {
    result: Res<Obj>,
    error_result: Option<Obj>,
    retire: bool,
}

fn capture_reply(info: &WindowInfo, capture: Capture) -> CaptureReply {
    use base64::Engine;
    let retire = capture.cleanup.status != "confirmed";
    let cleanup = cleanup_json(&capture.cleanup);
    match capture.surface {
        Ok(surface) => {
            let mut result = obj! {
                "text" => format!("native window capture: {}", info.title),
                "title" => info.title.as_str(),
                "window_id" => info.id(),
                "x" => surface.x,
                "y" => surface.y,
                "width" => surface.width,
                "height" => surface.height,
                "capture_source" => "window_surface",
                "capture_cleanup" => cleanup,
                "capture_attempts" => capture.attempts,
                "image_base64" => base64::engine::general_purpose::STANDARD.encode(&surface.png),
            };
            if let Some(flags) = surface.print_window_flags {
                result.insert("print_window_flags".into(), json!(flags));
            }
            CaptureReply {
                result: Ok(result),
                error_result: None,
                retire,
            }
        }
        Err(text) => CaptureReply {
            result: Err(text),
            error_result: Some(obj! {
                "capture_cleanup" => cleanup,
                "capture_attempts" => capture.attempts,
            }),
            retire,
        },
    }
}

/// The image half of a window capture request (screenshotEncoding,
/// screenshot-target.ts; zoomRegionOf, zoom-region.ts; max_ocr_words,
/// capture-ocr.ts).
#[derive(Debug, PartialEq)]
struct Output {
    max_width: u32,
    quality: u8,
    /// A physical screen rectangle to cut out of the surface (zoom).
    region: Option<Region>,
    /// Keep the pixels of the region as they are instead of fitting them.
    preserve_resolution: bool,
    /// Read the unfitted frame: its language and word limit.
    ocr: Option<(String, usize)>,
}

const DEFAULT_MAX_WIDTH: i64 = 1280;
const DEFAULT_QUALITY: i64 = 55;
const DEFAULT_OCR_WORDS: i64 = 300;

/// The integer in `key` within `low..=high`, `default` when absent
/// (screenshotInteger, observation/analysis.ts).
fn bounded(req: &Req, key: &str, default: i64, low: i64, high: i64) -> Res<i64> {
    match req.f64(key) {
        None => Ok(default),
        Some(value) if value.fract() == 0.0 && (low as f64..=high as f64).contains(&value) => Ok(value as i64),
        Some(_) => Err(format!("{key} must be an integer from {low} to {high}")),
    }
}

impl Output {
    fn of(req: &Req) -> Res<Output> {
        let region = match req.child("region") {
            None => None,
            Some(region) => {
                let edge = |key: &str| {
                    region
                        .f64(key)
                        .filter(|value| value.fract() == 0.0 && value.abs() < f64::from(i32::MAX))
                        .map(|value| value as i32)
                };
                match (edge("x"), edge("y"), edge("width"), edge("height")) {
                    (Some(x), Some(y), Some(width), Some(height)) => Some(Region { x, y, width, height }),
                    _ => return Err("region requires integer x, y, width and height".into()),
                }
            }
        };
        let ocr = match req.truthy("include_ocr") {
            true => {
                let words = bounded(req, "max_ocr_words", DEFAULT_OCR_WORDS, 1, 1000)?;
                Some((req.text("ocr_language").trim().to_string(), words as usize))
            }
            false => None,
        };
        Ok(Output {
            max_width: bounded(req, "max_width", DEFAULT_MAX_WIDTH, 256, 3840)? as u32,
            quality: bounded(req, "quality", DEFAULT_QUALITY, 0, 100)? as u8,
            region,
            preserve_resolution: req.truthy("preserve_resolution"),
            ocr,
        })
    }
}

/// The frame as it is delivered: the unfitted pixels (what OCR reads), the
/// fitted ones, and where the unfitted ones sit on the screen.
struct Fitted {
    unfitted: Pixels,
    fitted: Pixels,
    origin: (i32, i32),
}

/// Cuts the region out of the surface at `surface` and fits it to the
/// budget, unless the caller keeps the resolution (cropZoom).
fn fit(pixels: Pixels, surface: (i32, i32), output: &Output) -> Res<Fitted> {
    let (mut origin, mut unfitted) = (surface, pixels);
    if let Some(wanted) = output.region {
        let local = local_region(
            (surface.0, surface.1, unfitted.width as i32, unfitted.height as i32),
            wanted,
        )?;
        origin = (surface.0 + local.x, surface.1 + local.y);
        unfitted = unfitted.crop(local);
    }
    let fitted = if output.preserve_resolution {
        unfitted.clone()
    } else {
        let (width, height) = capture_size(unfitted.width as u32, unfitted.height as u32, output.max_width)?;
        unfitted.resize(width as usize, height as usize)
    };
    Ok(Fitted { unfitted, fitted, origin })
}

/// What a window capture answers in place of the surface's PNG.
struct Delivery {
    mime: &'static str,
    bytes: Vec<u8>,
    frame: Fitted,
    ocr: Option<Value>,
}

impl Delivery {
    /// Replaces the full-resolution PNG with the fitted image, its size and
    /// scale, the physical rectangle it shows, and the words read from it.
    fn apply(self, result: &mut Obj) {
        use base64::Engine;
        let (fitted, unfitted) = (&self.frame.fitted, &self.frame.unfitted);
        result.remove("image_base64");
        result.insert(
            "image".into(),
            json!({ "mimeType": self.mime, "data": base64::engine::general_purpose::STANDARD.encode(&self.bytes) }),
        );
        result.insert("image_width".into(), json!(fitted.width));
        result.insert("image_height".into(), json!(fitted.height));
        result.insert("scale".into(), json!(fitted.width as f64 / unfitted.width as f64));
        // The whole surface the image was cut from, so a zoom can tell a
        // moved or resized window from the region it asked for (zoom-shot.ts).
        let edge = |key: &str| result.get(key).cloned().unwrap_or(Value::Null);
        let surface = json!({ "x": edge("x"), "y": edge("y"), "width": edge("width"), "height": edge("height") });
        result.insert("surface".into(), surface);
        result.insert("x".into(), json!(self.frame.origin.0));
        result.insert("y".into(), json!(self.frame.origin.1));
        result.insert("width".into(), json!(unfitted.width));
        result.insert("height".into(), json!(unfitted.height));
        if let Some(ocr) = self.ocr {
            result.insert("ocr".into(), ocr);
        }
    }
}

impl Host {
    /// The surface fitted, encoded and read as `output` asks. None where the
    /// frame cannot be decoded or encoded here: the PNG stays as captured.
    fn deliver(&self, output: &Output, surface: &Surface) -> Res<Option<Delivery>> {
        let Some((data, (width, height))) = decode_png(&surface.png) else {
            return Ok(None);
        };
        let frame = fit(Pixels { width, height, data }, (surface.x, surface.y), output)?;
        let (fitted, unfitted) = (&frame.fitted, &frame.unfitted);
        let Some((mime, bytes)) = self.desktop.encode_image(
            &fitted.data,
            fitted.width as u32,
            fitted.height as u32,
            Some(output.quality),
        ) else {
            return Ok(None);
        };
        let ocr = output.ocr.as_ref().map(|(language, words)| {
            let png = match output.region {
                None => Some(surface.png.clone()),
                Some(_) => self
                    .desktop
                    .encode_image(&unfitted.data, unfitted.width as u32, unfitted.height as u32, None)
                    .map(|(_, bytes)| bytes),
            };
            let read = png
                .ok_or_else(|| "ocr_failed: the frame could not be encoded".to_string())
                .and_then(|png| self.desktop.ocr(&png, language, *words));
            match read {
                Ok(mut ocr) => {
                    let from = |key: &str, fallback: usize| {
                        ocr.get(key)
                            .and_then(Value::as_f64)
                            .filter(|size| *size > 0.0)
                            .unwrap_or(fallback as f64)
                    };
                    let size = (from("image_width", unfitted.width), from("image_height", unfitted.height));
                    map_ocr(&mut ocr, size, (fitted.width, fitted.height));
                    ocr
                }
                // Unreadable text is a reason to keep the pixels, never to fail the capture.
                Err(error) => json!({ "available": false, "error": error }),
            }
        });
        Ok(Some(Delivery { mime, bytes, frame, ocr }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn request(value: Value) -> Req {
        Req(value)
    }

    #[test]
    fn the_image_request_has_the_screenshot_defaults() {
        assert_eq!(
            Output::of(&request(json!({}))),
            Ok(Output { max_width: 1280, quality: 55, region: None, preserve_resolution: false, ocr: None })
        );
    }

    #[test]
    fn the_image_request_is_read_and_bounded() {
        let output = Output::of(&request(json!({
            "max_width": 800, "quality": 0, "include_ocr": true, "max_ocr_words": 20, "ocr_language": " ko ",
            "preserve_resolution": true, "region": { "x": -5, "y": 6, "width": 70, "height": 80 },
        })))
        .expect("read");
        assert_eq!(output.max_width, 800);
        assert_eq!(output.quality, 0);
        assert_eq!(output.ocr, Some(("ko".to_string(), 20)));
        assert_eq!(output.region, Some(Region { x: -5, y: 6, width: 70, height: 80 }));
        assert!(output.preserve_resolution);
        for (field, value, message) in [
            ("max_width", json!(255), "max_width must be an integer from 256 to 3840"),
            ("max_width", json!(1280.5), "max_width must be an integer from 256 to 3840"),
            ("quality", json!(101), "quality must be an integer from 0 to 100"),
            ("max_ocr_words", json!(0), "max_ocr_words must be an integer from 1 to 1000"),
        ] {
            let mut body = json!({ "include_ocr": true });
            body[field] = value;
            assert_eq!(Output::of(&request(body)), Err(message.to_string()));
        }
        assert!(Output::of(&request(json!({ "region": { "x": 1 } }))).is_err());
    }

    fn flat(width: usize, height: usize) -> Pixels {
        Pixels { width, height, data: [9, 8, 7, 255].repeat(width * height) }
    }

    fn output(region: Option<Region>, preserve: bool) -> Output {
        Output { max_width: 256, quality: 55, region, preserve_resolution: preserve, ocr: None }
    }

    #[test]
    fn a_wide_frame_is_fitted_and_keeps_its_screen_position() {
        let frame = fit(flat(1024, 512), (30, 40), &output(None, false)).expect("fit");
        assert_eq!((frame.fitted.width, frame.fitted.height), (256, 128));
        assert_eq!((frame.unfitted.width, frame.origin), (1024, (30, 40)));
    }

    #[test]
    fn a_region_is_cut_in_physical_pixels_and_kept_sharp_on_request() {
        let wanted = Region { x: 130, y: 90, width: 600, height: 300 };
        let sharp = fit(flat(1024, 512), (30, 40), &output(Some(wanted), true)).expect("fit");
        assert_eq!(sharp.origin, (130, 90));
        assert_eq!((sharp.fitted.width, sharp.fitted.height), (600, 300));
        let fitted = fit(flat(1024, 512), (30, 40), &output(Some(wanted), false)).expect("fit");
        assert_eq!((fitted.unfitted.width, fitted.fitted.width), (600, 256));
    }

    #[test]
    fn a_region_off_the_surface_is_a_capture_refusal() {
        let away = Region { x: 5000, y: 0, width: 10, height: 10 };
        let error = fit(flat(100, 100), (0, 0), &output(Some(away), false)).err().expect("refused");
        assert!(error.starts_with("capture_region_invalid"), "{error}");
    }

    #[test]
    fn the_delivery_replaces_the_png_with_the_fitted_image() {
        let frame = fit(flat(1024, 512), (30, 40), &output(None, false)).expect("fit");
        let ocr = json!({ "words": [], "image_width": 256, "image_height": 128 });
        let mut result = obj! { "image_base64" => "AAAA", "width" => 1024 };
        Delivery { mime: "image/jpeg", bytes: vec![0xff, 0xd8], frame, ocr: Some(ocr) }.apply(&mut result);
        assert!(!result.contains_key("image_base64"));
        assert_eq!(result["image"], json!({ "mimeType": "image/jpeg", "data": "/9g=" }));
        assert_eq!((result["image_width"].clone(), result["image_height"].clone()), (json!(256), json!(128)));
        assert_eq!(result["scale"], json!(0.25));
        assert_eq!((result["x"].clone(), result["y"].clone()), (json!(30), json!(40)));
        assert_eq!((result["width"].clone(), result["height"].clone()), (json!(1024), json!(512)));
        assert_eq!(result["ocr"]["image_width"], 256);
    }

    #[test]
    fn a_cropped_delivery_keeps_the_whole_surface_beside_the_region() {
        let wanted = Region { x: 130, y: 90, width: 600, height: 300 };
        let frame = fit(flat(1024, 512), (30, 40), &output(Some(wanted), true)).expect("fit");
        let mut result = obj! { "x" => 30, "y" => 40, "width" => 1024, "height" => 512 };
        Delivery { mime: "image/jpeg", bytes: vec![0xff, 0xd8], frame, ocr: None }.apply(&mut result);
        assert_eq!(result["surface"], json!({ "x": 30, "y": 40, "width": 1024, "height": 512 }));
        assert_eq!((result["x"].clone(), result["y"].clone()), (json!(130), json!(90)));
        assert_eq!((result["width"].clone(), result["height"].clone()), (json!(600), json!(300)));
    }

    fn surface(flags: Option<&'static str>) -> Surface {
        Surface {
            png: vec![1, 2, 3],
            x: 10,
            y: 20,
            width: 300,
            height: 200,
            print_window_flags: flags,
        }
    }

    fn refusal(text: &str) -> CaptureFailure {
        CaptureFailure::from(text.to_string())
    }

    fn info() -> WindowInfo {
        WindowInfo {
            handle: 0x2a,
            title: "Fixture".into(),
            class_name: String::new(),
            app: String::new(),
            pid: 1,
            parent_pid: 0,
            owner: 0,
            focused: false,
            minimized: false,
            maximized: false,
            x: 10,
            y: 20,
            width: 300,
            height: 200,
            client: (10, 20, 300, 200),
            content_pid: 0,
        }
    }

    /// Runs the plan with scripted answers per backend; returns what it asked.
    fn run(
        backends: &[&str],
        mut answers: Vec<Result<Surface, CaptureFailure>>,
        issue: impl Fn(&Surface) -> Option<Issue>,
    ) -> (Capture, Vec<String>) {
        answers.reverse();
        let asked = RefCell::new(Vec::new());
        let capture = run_plan(
            backends,
            |backend| {
                asked.borrow_mut().push(backend.to_string());
                answers.pop().expect("an answer per attempt")
            },
            issue,
        );
        (capture, asked.into_inner())
    }

    fn black(_: &Surface) -> Option<Issue> {
        Some(Issue {
            reason: "blank_black_frame",
            message: "capture is effectively all black; no coordinate frame was issued",
        })
    }

    fn usable(_: &Surface) -> Option<Issue> {
        None
    }

    fn rows(capture: &Capture) -> Vec<(String, String, Option<String>)> {
        capture
            .attempts
            .iter()
            .map(|row| {
                (
                    row["backend"].as_str().unwrap_or_default().to_string(),
                    row["status"].as_str().unwrap_or_default().to_string(),
                    row["code"].as_str().map(str::to_string),
                )
            })
            .collect()
    }

    #[test]
    fn the_backend_of_a_captured_frame_is_the_last_attempt() {
        let (fell, _) = run(
            &CAPTURE_PLAN,
            vec![Err(refusal("capture_timeout|window is not responding")), Ok(surface(None))],
            usable,
        );
        assert_eq!(captured_by(&fell), Some("wgc"));
        let (direct, _) = run(&CAPTURE_PLAN, vec![Ok(surface(Some("2")))], usable);
        assert_eq!(captured_by(&direct), Some("print_window"));
        let (failed, _) = run(
            &CAPTURE_PLAN,
            vec![Err(refusal("capture_minimized|minimized"))],
            usable,
        );
        assert_eq!(captured_by(&failed), None);
    }

    #[test]
    fn a_remembered_window_asks_the_compositor_first() {
        let (capture, asked) = run(&REMEMBERED_PLAN, vec![Ok(surface(None))], usable);
        assert_eq!(asked, ["wgc"]);
        assert_eq!(captured_by(&capture), Some("wgc"));
    }

    #[test]
    fn a_usable_print_window_frame_ends_the_plan() {
        let (capture, asked) = run(&CAPTURE_PLAN, vec![Ok(surface(Some("2")))], usable);
        assert_eq!(asked, ["print_window"]);
        assert_eq!(rows(&capture), [("print_window".into(), "captured".into(), None)]);
        assert_eq!(capture.surface.map(|s| s.print_window_flags), Ok(Some("2")));
        assert_eq!(capture.cleanup, Cleanup::CONFIRMED);
    }

    #[test]
    fn a_black_print_window_frame_falls_to_wgc() {
        let (capture, asked) = run(
            &CAPTURE_PLAN,
            vec![Ok(surface(Some("2,0"))), Ok(surface(None))],
            |surface| if surface.print_window_flags.is_some() { black(surface) } else { None },
        );
        assert_eq!(asked, ["print_window", "wgc"]);
        assert_eq!(
            rows(&capture),
            [
                ("print_window".into(), "unavailable".into(), Some("blank_black_frame".into())),
                ("wgc".into(), "captured".into(), None),
            ]
        );
        // The flags of the PrintWindow attempt are kept on the wgc frame.
        assert_eq!(capture.surface.map(|s| s.print_window_flags), Ok(Some("2,0")));
    }

    #[test]
    fn a_hung_window_and_a_failed_print_window_fall_to_wgc() {
        for text in [
            "capture_timeout|window is not responding",
            "capture_source_unavailable|window-owned rendering is unavailable",
            "capture_geometry_changed|native window changed during capture",
        ] {
            let (capture, asked) = run(
                &CAPTURE_PLAN,
                vec![Err(refusal(text)), Ok(surface(None))],
                usable,
            );
            assert_eq!(asked, ["print_window", "wgc"], "{text}");
            assert!(capture.surface.is_ok(), "{text}");
        }
    }

    #[test]
    fn a_minimized_or_cloaked_window_never_reaches_wgc() {
        for text in [
            "capture_minimized|minimized native window has no rendered surface",
            "capture_cloaked|native window is cloaked and has no available surface",
        ] {
            let (capture, asked) = run(&CAPTURE_PLAN, vec![Err(refusal(text))], usable);
            assert_eq!(asked, ["print_window"], "{text}");
            assert_eq!(capture.attempts.len(), 1);
            assert_eq!(capture.surface.err().as_deref(), Some(text));
        }
    }

    #[test]
    fn a_failure_with_unconfirmed_resources_ends_the_plan() {
        let unconfirmed = CaptureFailure {
            text: "capture_timeout|GPU copy exceeded the remaining capture budget".into(),
            cleanup: Cleanup { status: "unconfirmed", cancellation: Some("unconfirmed") },
        };
        let (capture, asked) = run(&CAPTURE_PLAN, vec![Err(unconfirmed)], usable);
        assert_eq!(asked, ["print_window"]);
        assert_eq!(capture.cleanup.status, "unconfirmed");
    }

    #[test]
    fn both_backends_failing_reports_the_last_refusal_and_each_attempt() {
        let (capture, _) = run(
            &CAPTURE_PLAN,
            vec![
                Err(refusal("capture_timeout|window is not responding")),
                Err(refusal("capture_denied|Windows denied capture of the selected window")),
            ],
            usable,
        );
        assert_eq!(
            rows(&capture),
            [
                ("print_window".into(), "failed".into(), Some("capture_timeout".into())),
                ("wgc".into(), "failed".into(), Some("capture_denied".into())),
            ]
        );
        assert_eq!(
            capture.surface.err().as_deref(),
            Some("capture_denied|Windows denied capture of the selected window")
        );
    }

    #[test]
    fn only_a_plan_that_ran_out_of_recoverable_sources_may_ask_the_owner() {
        let (exhausted, _) = run(
            &CAPTURE_PLAN,
            vec![
                Err(refusal("capture_timeout|window is not responding")),
                Err(refusal("capture_source_unavailable|no frame")),
            ],
            usable,
        );
        assert!(!exhausted.terminal);
        let (cloaked, _) = run(&CAPTURE_PLAN, vec![Err(refusal("capture_cloaked|cloaked"))], usable);
        assert!(cloaked.terminal);
        let (captured, _) = run(&CAPTURE_PLAN, vec![Ok(surface(None))], usable);
        assert!(!captured.terminal);
    }

    #[test]
    fn a_backend_the_desktop_lacks_is_not_an_attempt() {
        let (capture, _) = run(
            &CAPTURE_PLAN,
            vec![
                Err(refusal("capture_source_unavailable: linux has no native window surface backend")),
                Err(refusal(UNKNOWN_CAPTURE_BACKEND)),
            ],
            usable,
        );
        assert_eq!(rows(&capture).len(), 1);
        assert!(capture
            .surface
            .err()
            .is_some_and(|text| text.starts_with("capture_source_unavailable: linux")));
    }

    #[test]
    fn the_worst_cleanup_wins_in_order() {
        let confirmed = Cleanup::CONFIRMED;
        let unconfirmed = Cleanup { status: "unconfirmed", cancellation: Some("unconfirmed") };
        let failed = Cleanup { status: "failed", cancellation: None };
        assert_eq!(worse(confirmed, unconfirmed), unconfirmed);
        assert_eq!(worse(unconfirmed, failed), failed);
        assert_eq!(worse(failed, unconfirmed), failed);
        assert_eq!(worse(unconfirmed, confirmed), unconfirmed);
        assert_eq!(worse(confirmed, confirmed), confirmed);
    }

    #[test]
    fn a_captured_window_replies_with_its_attempts_and_flags() {
        let (capture, _) = run(&CAPTURE_PLAN, vec![Ok(surface(Some("2")))], usable);
        let reply = capture_reply(&info(), capture);
        assert!(!reply.retire);
        assert!(reply.error_result.is_none());
        let result = reply.result.expect("captured");
        assert_eq!(result["capture_source"], "window_surface");
        assert_eq!(result["window_id"], "hwnd:0x2A");
        assert_eq!(result["print_window_flags"], "2");
        assert_eq!(result["capture_cleanup"], json!({ "status": "confirmed" }));
        assert_eq!(result["capture_attempts"][0]["backend"], "print_window");
        assert_eq!(result["capture_attempts"][0]["scope"], "target");
        assert_eq!(result["image_base64"], "AQID");
    }

    #[test]
    fn an_unconfirmed_release_reports_under_result_and_retires_the_host() {
        let unconfirmed = CaptureFailure {
            text: "capture_timeout|GPU copy exceeded the remaining capture budget".into(),
            cleanup: Cleanup { status: "unconfirmed", cancellation: Some("unconfirmed") },
        };
        let (capture, _) = run(&["wgc"], vec![Err(unconfirmed)], usable);
        let reply = capture_reply(&info(), capture);
        assert!(reply.retire);
        assert_eq!(
            reply.result.err().as_deref(),
            Some("capture_timeout|GPU copy exceeded the remaining capture budget")
        );
        let reported = reply.error_result.expect("the cleanup is reported");
        assert_eq!(
            reported["capture_cleanup"],
            json!({ "status": "unconfirmed", "cancellation": "unconfirmed" })
        );
        assert_eq!(reported["capture_attempts"][0]["cleanup"]["status"], "unconfirmed");
    }

    #[test]
    fn a_confirmed_refusal_keeps_the_host() {
        let (capture, _) = run(
            &CAPTURE_PLAN[..1],
            vec![Err(refusal("capture_minimized|minimized native window has no rendered surface"))],
            usable,
        );
        assert!(!capture_reply(&info(), capture).retire);
    }

    #[test]
    fn the_code_is_what_precedes_the_first_separator() {
        assert_eq!(code_of("capture_timeout|window is not responding"), "capture_timeout");
        assert_eq!(code_of("blank_black_frame: capture is all black"), "blank_black_frame");
        assert_eq!(code_of("plain"), "capture_source_unavailable");
        assert_eq!(code_of("could not read: a detail"), "capture_source_unavailable");
    }
}
