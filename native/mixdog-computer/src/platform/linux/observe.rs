//! Input observation. On X11, XInput2 raw events name the device each event
//! came from; events from the XTEST devices are this host's injected input.
//! Without X11, the session's idle clock is watched and attributed by time.

use super::x11::connect;
use crate::observer::{now_ms, Shared};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xinput::{self, ConnectionExt as _, XIEventMask};
use x11rb::protocol::Event;

fn xtest_devices(conn: &impl Connection) -> HashSet<u16> {
    conn.xinput_xi_query_device(xinput::Device::ALL)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| {
            reply
                .infos
                .iter()
                .filter(|info| String::from_utf8_lossy(&info.name).contains("XTEST"))
                .map(|info| info.deviceid)
                .collect()
        })
        .unwrap_or_default()
}

pub fn start_x11(shared: Arc<Shared>) {
    std::thread::Builder::new()
        .name("mixdog input observation".into())
        .spawn(move || {
            if let Err(error) = watch_raw(&shared) {
                eprintln!("mixdog-computer: raw input observation unavailable ({error}); watching the idle clock");
                watch_screensaver(&shared);
            }
            shared.set_ready(false);
        })
        .ok();
}

fn watch_raw(shared: &Shared) -> Result<(), String> {
    let (conn, root) = connect()?;
    let version = conn.xinput_xi_query_version(2, 2).map_err(|error| error.to_string())?.reply().map_err(|error| error.to_string())?;
    if version.major_version < 2 {
        return Err("XInput2 is not available".into());
    }
    let raw = XIEventMask::RAW_KEY_PRESS | XIEventMask::RAW_KEY_RELEASE | XIEventMask::RAW_BUTTON_PRESS | XIEventMask::RAW_BUTTON_RELEASE | XIEventMask::RAW_MOTION;
    let masks = [
        xinput::EventMask { deviceid: xinput::Device::ALL_MASTER.into(), mask: vec![raw] },
        xinput::EventMask { deviceid: xinput::Device::ALL.into(), mask: vec![XIEventMask::HIERARCHY] },
    ];
    conn.xinput_xi_select_events(root, &masks).map_err(|error| error.to_string())?;
    conn.flush().map_err(|error| error.to_string())?;
    let mut xtest = xtest_devices(&conn);
    shared.set_ready(true);
    loop {
        let event = conn.wait_for_event().map_err(|error| error.to_string())?;
        let source = match &event {
            Event::XinputRawKeyPress(raw) | Event::XinputRawKeyRelease(raw) => Some(raw.sourceid),
            Event::XinputRawButtonPress(raw) | Event::XinputRawButtonRelease(raw) | Event::XinputRawMotion(raw) => Some(raw.sourceid),
            Event::XinputHierarchy(_) => {
                xtest = xtest_devices(&conn);
                None
            }
            _ => None,
        };
        if let Some(source) = source {
            shared.record(xtest.contains(&source));
        }
    }
}

/// Every advance of the last-input clock is an input event, attributed to
/// this host when it falls inside the window the host marked as its own.
fn watch_idle(shared: &Shared, idle_ms: impl Fn() -> Option<u64>) {
    let mut last_seen = 0u64;
    let mut ready = false;
    loop {
        match idle_ms() {
            Some(idle) => {
                if !ready {
                    shared.set_ready(true);
                    ready = true;
                }
                let at = now_ms().saturating_sub(idle);
                if at > last_seen + 5 {
                    if last_seen != 0 {
                        shared.record_untagged(at);
                    }
                    last_seen = at;
                }
            }
            None => {
                shared.set_ready(false);
                ready = false;
            }
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn watch_screensaver(shared: &Shared) {
    use x11rb::protocol::screensaver::ConnectionExt as _;
    let Ok((conn, root)) = connect() else { return };
    watch_idle(shared, || {
        conn.screensaver_query_info(root).ok().and_then(|cookie| cookie.reply().ok()).map(|info| info.ms_since_user_input as u64)
    });
}

/// A Wayland session exposes its idle clock through the compositor: Mutter's
/// idle monitor on GNOME, the freedesktop screensaver service elsewhere.
pub fn start_session_idle(shared: Arc<Shared>) {
    std::thread::Builder::new()
        .name("mixdog input observation".into())
        .spawn(move || {
            let Ok(bus) = zbus::blocking::Connection::session() else { return };
            let mutter = |bus: &zbus::blocking::Connection| -> Option<u64> {
                let reply = bus
                    .call_method(Some("org.gnome.Mutter.IdleMonitor"), "/org/gnome/Mutter/IdleMonitor/Core", Some("org.gnome.Mutter.IdleMonitor"), "GetIdletime", &())
                    .ok()?;
                reply.body().deserialize::<u64>().ok()
            };
            let freedesktop = |bus: &zbus::blocking::Connection| -> Option<u64> {
                let reply = bus
                    .call_method(Some("org.freedesktop.ScreenSaver"), "/org/freedesktop/ScreenSaver", Some("org.freedesktop.ScreenSaver"), "GetSessionIdleTime", &())
                    .ok()?;
                reply.body().deserialize::<u32>().ok().map(|seconds| seconds as u64 * 1000)
            };
            let use_mutter = mutter(&bus).is_some();
            watch_idle(&shared, || if use_mutter { mutter(&bus) } else { freedesktop(&bus) });
        })
        .ok();
}
