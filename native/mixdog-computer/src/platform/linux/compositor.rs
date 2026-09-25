//! Window lists and window control on Wayland, where no protocol is shared:
//! each compositor answers through its own interface.

use crate::platform::{WinState, WindowInfo, Wid};
use serde_json::Value;
use std::process::Command;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Compositor {
    Sway,
    Hyprland,
    /// GNOME Shell with the Window Calls extension's D-Bus interface.
    Gnome,
    None,
}

fn json_command(program: &str, args: &[&str]) -> Option<Value> {
    let output = Command::new(program).args(args).output().ok()?;
    output.status.success().then(|| serde_json::from_slice(&output.stdout).ok()).flatten()
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program).args(args).output().map_err(|error| format!("{program}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("{program}: {}", String::from_utf8_lossy(&output.stderr).trim()))
    }
}

const GNOME_PATH: &str = "/org/gnome/Shell/Extensions/Windows";
const GNOME_INTERFACE: &str = "org.gnome.Shell.Extensions.Windows";

fn gnome_call<B>(method: &str, body: &B) -> Result<zbus::Message, String>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    let bus = zbus::blocking::Connection::session().map_err(|error| error.to_string())?;
    bus.call_method(Some("org.gnome.Shell"), GNOME_PATH, Some(GNOME_INTERFACE), method, body).map_err(|error| error.to_string())
}

fn gnome_json(method: &str, body: &(impl serde::Serialize + zbus::zvariant::DynamicType)) -> Option<Value> {
    let reply = gnome_call(method, body).ok()?;
    let text: String = reply.body().deserialize().ok()?;
    serde_json::from_str(&text).ok()
}

fn int(value: &Value, key: &str) -> i32 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0).round() as i32
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn window(handle: Wid, title: String, app: String, pid: i64, focused: bool, minimized: bool, maximized: bool, rect: (i32, i32, i32, i32)) -> WindowInfo {
    WindowInfo {
        handle,
        title,
        class_name: app.clone(),
        app,
        pid,
        parent_pid: crate::platform::parent_pid(pid),
        owner: 0,
        focused,
        minimized,
        maximized,
        x: rect.0,
        y: rect.1,
        width: rect.2,
        height: rect.3,
        client: rect,
    }
}

fn sway_windows(node: &Value, out: &mut Vec<WindowInfo>) {
    let is_window = node.get("pid").and_then(Value::as_i64).is_some() && matches!(node.get("type").and_then(Value::as_str), Some("con") | Some("floating_con"));
    if is_window {
        let rect = node.get("rect").cloned().unwrap_or_default();
        let inner = node.get("window_rect").cloned().unwrap_or_default();
        let app = node.get("app_id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| {
            node.pointer("/window_properties/class").and_then(Value::as_str).unwrap_or_default().to_string()
        });
        out.push(window(
            node.get("id").and_then(Value::as_u64).unwrap_or(0),
            text(node, "name"),
            app,
            node.get("pid").and_then(Value::as_i64).unwrap_or(0),
            node.get("focused").and_then(Value::as_bool).unwrap_or(false),
            !node.get("visible").and_then(Value::as_bool).unwrap_or(true),
            node.get("fullscreen_mode").and_then(Value::as_i64).unwrap_or(0) != 0,
            (int(&rect, "x") + int(&inner, "x"), int(&rect, "y") + int(&inner, "y"), int(&inner, "width"), int(&inner, "height")),
        ));
    }
    for key in ["nodes", "floating_nodes"] {
        for child in node.get(key).and_then(Value::as_array).into_iter().flatten() {
            sway_windows(child, out);
        }
    }
}

fn hypr_address(value: &Value) -> Wid {
    u64::from_str_radix(text(value, "address").trim_start_matches("0x"), 16).unwrap_or(0)
}

impl Compositor {
    pub fn detect() -> Compositor {
        if std::env::var_os("SWAYSOCK").is_some() {
            return Compositor::Sway;
        }
        if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
            return Compositor::Hyprland;
        }
        if std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|desktop| desktop.to_uppercase().contains("GNOME")) && gnome_json("List", &()).is_some() {
            return Compositor::Gnome;
        }
        Compositor::None
    }

    /// Windows front to back: the focused one first.
    pub fn windows(&self) -> Option<Vec<WindowInfo>> {
        let mut windows = Vec::new();
        match self {
            Compositor::Sway => sway_windows(&json_command("swaymsg", &["-t", "get_tree", "-r"])?, &mut windows),
            Compositor::Hyprland => {
                let active = json_command("hyprctl", &["-j", "activewindow"]).map(|value| hypr_address(&value)).unwrap_or(0);
                let mut clients = json_command("hyprctl", &["-j", "clients"])?.as_array()?.clone();
                clients.sort_by_key(|client| client.get("focusHistoryID").and_then(Value::as_i64).unwrap_or(i64::MAX));
                for client in clients.iter().filter(|client| client.get("mapped").and_then(Value::as_bool).unwrap_or(true)) {
                    let at = client.get("at").and_then(Value::as_array).cloned().unwrap_or_default();
                    let size = client.get("size").and_then(Value::as_array).cloned().unwrap_or_default();
                    let number = |list: &Vec<Value>, index: usize| list.get(index).and_then(Value::as_f64).unwrap_or(0.0) as i32;
                    let handle = hypr_address(client);
                    windows.push(window(
                        handle,
                        text(client, "title"),
                        text(client, "class"),
                        client.get("pid").and_then(Value::as_i64).unwrap_or(0),
                        handle == active,
                        client.get("hidden").and_then(Value::as_bool).unwrap_or(false),
                        client.get("fullscreen").is_some_and(|value| value.as_bool().unwrap_or(false) || value.as_i64().unwrap_or(0) != 0),
                        (number(&at, 0), number(&at, 1), number(&size, 0), number(&size, 1)),
                    ));
                }
            }
            Compositor::Gnome => {
                for item in gnome_json("List", &())?.as_array()? {
                    let id = item.get("id").and_then(Value::as_u64).unwrap_or(0);
                    let details = gnome_json("Details", &(id as u32,)).unwrap_or_default();
                    let pick = |key: &str| details.get(key).or_else(|| item.get(key)).cloned().unwrap_or_default();
                    windows.push(window(
                        id,
                        pick("title").as_str().unwrap_or_default().to_string(),
                        pick("wm_class").as_str().unwrap_or_default().to_string(),
                        pick("pid").as_i64().unwrap_or(0),
                        pick("focus").as_bool().unwrap_or(false),
                        pick("minimized").as_bool().unwrap_or(false),
                        pick("maximized").as_i64().unwrap_or(0) != 0 || pick("maximized").as_bool().unwrap_or(false),
                        (int(&details, "x"), int(&details, "y"), int(&details, "width"), int(&details, "height")),
                    ));
                }
                windows.sort_by_key(|window| !window.focused);
            }
            Compositor::None => return None,
        }
        if *self == Compositor::Sway {
            windows.sort_by_key(|window| !window.focused);
        }
        Some(windows)
    }

    pub fn desktop_bounds(&self) -> Option<(i32, i32, i32, i32)> {
        let rects: Vec<(i32, i32, i32, i32)> = match self {
            Compositor::Sway => json_command("swaymsg", &["-t", "get_outputs", "-r"])?
                .as_array()?
                .iter()
                .filter(|output| output.get("active").and_then(Value::as_bool).unwrap_or(true))
                .filter_map(|output| output.get("rect").map(|rect| (int(rect, "x"), int(rect, "y"), int(rect, "width"), int(rect, "height"))))
                .collect(),
            Compositor::Hyprland => json_command("hyprctl", &["-j", "monitors"])?
                .as_array()?
                .iter()
                .map(|monitor| {
                    let scale = monitor.get("scale").and_then(Value::as_f64).unwrap_or(1.0).max(0.1);
                    let size = |key: &str| (monitor.get(key).and_then(Value::as_f64).unwrap_or(0.0) / scale).round() as i32;
                    (int(monitor, "x"), int(monitor, "y"), size("width"), size("height"))
                })
                .collect(),
            _ => Vec::new(),
        };
        union(&rects)
    }

    pub fn cursor(&self) -> Option<(i32, i32)> {
        if *self != Compositor::Hyprland {
            return None;
        }
        let value = json_command("hyprctl", &["-j", "cursorpos"])?;
        Some((int(&value, "x"), int(&value, "y")))
    }

    pub fn supported(&self) -> Result<(), String> {
        if *self == Compositor::None {
            return Err("wayland_window_control_unavailable: this compositor offers no window control to other programs; on GNOME install the Window Calls extension".into());
        }
        Ok(())
    }

    pub fn focus(&self, handle: Wid) -> Result<(), String> {
        match self {
            Compositor::Sway => run("swaymsg", &[&format!("[con_id={handle}]"), "focus"]),
            Compositor::Hyprland => run("hyprctl", &["dispatch", "focuswindow", &format!("address:0x{handle:x}")]),
            Compositor::Gnome => gnome_call("Activate", &(handle as u32,)).map(|_| ()),
            Compositor::None => self.supported(),
        }
    }

    pub fn move_window(&self, handle: Wid, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
        match self {
            Compositor::Sway => {
                let target = format!("[con_id={handle}]");
                run("swaymsg", &[&target, "floating", "enable"])?;
                run("swaymsg", &[&target, "resize", "set", &format!("{width}"), &format!("{height}")])?;
                run("swaymsg", &[&target, "move", "absolute", "position", &format!("{x}"), &format!("{y}")])
            }
            Compositor::Hyprland => {
                let address = format!("address:0x{handle:x}");
                run("hyprctl", &["dispatch", "resizewindowpixel", &format!("exact {width} {height},{address}")])?;
                run("hyprctl", &["dispatch", "movewindowpixel", &format!("exact {x} {y},{address}")])
            }
            Compositor::Gnome => gnome_call("MoveResize", &(handle as u32, x, y, width as u32, height as u32)).map(|_| ()),
            Compositor::None => self.supported(),
        }
    }

    pub fn set_state(&self, handle: Wid, state: WinState) -> Result<(), String> {
        match (self, state) {
            (Compositor::Gnome, WinState::Minimize) => gnome_call("Minimize", &(handle as u32,)).map(|_| ()),
            (Compositor::Gnome, WinState::Maximize) => gnome_call("Maximize", &(handle as u32,)).map(|_| ()),
            (Compositor::Gnome, WinState::Restore) => {
                let _ = gnome_call("Unminimize", &(handle as u32,));
                gnome_call("Unmaximize", &(handle as u32,)).map(|_| ())
            }
            (Compositor::Sway, WinState::Minimize) => run("swaymsg", &[&format!("[con_id={handle}]"), "move", "scratchpad"]),
            (Compositor::Sway, WinState::Maximize) => run("swaymsg", &[&format!("[con_id={handle}]"), "fullscreen", "enable"]),
            (Compositor::Sway, WinState::Restore) => {
                let target = format!("[con_id={handle}]");
                let _ = run("swaymsg", &[&target, "scratchpad", "show"]);
                run("swaymsg", &[&target, "fullscreen", "disable"])
            }
            (Compositor::Hyprland, WinState::Minimize) => run("hyprctl", &["dispatch", "movetoworkspacesilent", &format!("special:minimized,address:0x{handle:x}")]),
            (Compositor::Hyprland, WinState::Maximize) => {
                self.focus(handle)?;
                run("hyprctl", &["dispatch", "fullscreen", "1"])
            }
            (Compositor::Hyprland, WinState::Restore) => {
                let _ = run("hyprctl", &["dispatch", "movetoworkspacesilent", &format!("e+0,address:0x{handle:x}")]);
                self.focus(handle)?;
                run("hyprctl", &["dispatch", "fullscreenstate", "0 0"])
            }
            (Compositor::None, _) => self.supported(),
        }
    }

    pub fn close(&self, handle: Wid) -> Result<bool, String> {
        match self {
            Compositor::Sway => run("swaymsg", &[&format!("[con_id={handle}]"), "kill"]).map(|_| true),
            Compositor::Hyprland => run("hyprctl", &["dispatch", "closewindow", &format!("address:0x{handle:x}")]).map(|_| true),
            Compositor::Gnome => gnome_call("Close", &(handle as u32,)).map(|_| true),
            Compositor::None => self.supported().map(|_| false),
        }
    }
}

pub fn union(rects: &[(i32, i32, i32, i32)]) -> Option<(i32, i32, i32, i32)> {
    let first = rects.first()?;
    let (mut left, mut top, mut right, mut bottom) = (first.0, first.1, first.0 + first.2, first.1 + first.3);
    for (x, y, width, height) in rects {
        left = left.min(*x);
        top = top.min(*y);
        right = right.max(x + width);
        bottom = bottom.max(y + height);
    }
    Some((left, top, right - left, bottom - top))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sway_tree_yields_content_rects() {
        let tree = json!({
            "type": "root", "nodes": [{ "type": "workspace", "nodes": [{
                "type": "con", "id": 7, "pid": 42, "name": "Editor", "app_id": "gedit", "focused": true, "visible": true,
                "rect": { "x": 100, "y": 50, "width": 800, "height": 600 },
                "window_rect": { "x": 2, "y": 20, "width": 796, "height": 578 }
            }]}]
        });
        let mut windows = Vec::new();
        sway_windows(&tree, &mut windows);
        assert_eq!(windows.len(), 1);
        assert_eq!((windows[0].x, windows[0].y, windows[0].width), (102, 70, 796));
        assert!(windows[0].focused);
    }

    #[test]
    fn union_spans_every_output() {
        assert_eq!(union(&[(0, 0, 1920, 1080), (1920, -200, 1280, 1024)]), Some((0, -200, 3200, 1280)));
    }
}
