//! Background input on X11 through a second master pointer and keyboard
//! (XInput2 multi-pointer). The server generates its events like any
//! device's, so toolkits accept them, while the user's own pointer, keyboard
//! focus and window stacking stay where they are. The master is private to
//! this process and removed when it ends; masters left behind by a host that
//! was killed are removed by the next host or the abort cleanup.

use super::keysym;
use super::x11::X11;
use crate::keys::{self, Key, KeySink, Mod};
use crate::platform::{Background, Wid};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xinput::{
    self, ChangeMode, ConnectionExt as _, DeviceType, HierarchyChange, HierarchyChangeData, HierarchyChangeDataAddMaster,
    HierarchyChangeDataRemoveMaster,
};
use x11rb::protocol::xproto::{ConnectionExt as _, Window};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::CURRENT_TIME;

// XInput 1 device event offsets from the extension's first event.
const DEVICE_KEY_PRESS: u8 = 1;
const DEVICE_KEY_RELEASE: u8 = 2;
const DEVICE_BUTTON_PRESS: u8 = 3;
const DEVICE_BUTTON_RELEASE: u8 = 4;

#[derive(Clone, Copy)]
struct Devices {
    pointer: u16,
    keyboard: u16,
    xtest_pointer: u16,
    xtest_keyboard: u16,
}

fn master_name(pid: u32) -> String {
    format!("mixdog-{pid}")
}

fn e<T: std::fmt::Display>(error: T) -> String {
    error.to_string()
}

fn device_infos(conn: &impl Connection) -> Vec<xinput::XIDeviceInfo> {
    conn.xinput_xi_query_device(xinput::Device::ALL)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| reply.infos)
        .unwrap_or_default()
}

fn devices_named(conn: &impl Connection, name: &str) -> Option<Devices> {
    let infos = device_infos(conn);
    let find = |suffix: &str| {
        let wanted = format!("{name} {suffix}");
        infos.iter().find(|info| info.name == wanted.as_bytes()).map(|info| info.deviceid)
    };
    Some(Devices {
        pointer: find("pointer")?,
        keyboard: find("keyboard")?,
        xtest_pointer: find("XTEST pointer")?,
        xtest_keyboard: find("XTEST keyboard")?,
    })
}

fn remove_master(conn: &impl Connection, pointer: u16) {
    let change = HierarchyChange {
        len: 3,
        data: HierarchyChangeData::RemoveMaster(HierarchyChangeDataRemoveMaster {
            deviceid: pointer,
            return_mode: ChangeMode::FLOAT,
            return_pointer: 0,
            return_keyboard: 0,
        }),
    };
    let _ = conn.xinput_xi_change_hierarchy(&[change]);
    let _ = conn.sync();
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only probes whether the process exists.
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

/// Removes masters whose host process no longer runs.
pub fn remove_stale(conn: &impl Connection) {
    for info in device_infos(conn) {
        if info.type_ != DeviceType::MASTER_POINTER {
            continue;
        }
        let name = String::from_utf8_lossy(&info.name).into_owned();
        let pid = name.strip_prefix("mixdog-").and_then(|rest| rest.strip_suffix(" pointer")).and_then(|pid| pid.parse::<i32>().ok());
        if let Some(pid) = pid {
            if !alive(pid) {
                remove_master(conn, info.deviceid);
            }
        }
    }
}

pub struct Mpx;

impl Mpx {
    fn devices(&self, x11: &X11) -> Result<Devices, String> {
        let name = master_name(std::process::id());
        if let Some(devices) = devices_named(&x11.conn, &name) {
            return Ok(devices);
        }
        let bytes = name.into_bytes();
        let len = ((8 + bytes.len().div_ceil(4) * 4) / 4) as u16;
        let change = HierarchyChange {
            len,
            data: HierarchyChangeData::AddMaster(HierarchyChangeDataAddMaster { send_core: false, enable: true, name: bytes }),
        };
        x11.conn.xinput_xi_change_hierarchy(&[change]).map_err(e)?;
        x11.conn.sync().map_err(e)?;
        devices_named(&x11.conn, &master_name(std::process::id()))
            .ok_or_else(|| "background_unsupported|the X server offers no second input master; no input sent".to_string())
    }

    /// Removes this process's master, returning its cursor to nobody.
    pub fn release(&self, x11: &X11) {
        if let Some(devices) = devices_named(&x11.conn, &master_name(std::process::id())) {
            remove_master(&x11.conn, devices.pointer);
        }
    }
}

pub struct MpxRoute<'a> {
    pub mpx: &'a Mpx,
    pub x11: &'a X11,
}

impl MpxRoute<'_> {
    fn first_event(&self) -> Result<u8, String> {
        let reply = self.x11.conn.query_extension(b"XInputExtension").map_err(e)?.reply().map_err(e)?;
        if !reply.present {
            return Err("background_unsupported|the X server has no XInput extension; no input sent".into());
        }
        Ok(reply.first_event)
    }

    fn device_event(&self, offset: u8, detail: u8, device: u16) -> Result<(), String> {
        let kind = self.first_event()? + offset;
        self.x11
            .conn
            .xtest_fake_input(kind, detail, CURRENT_TIME, self.x11.root, 0, 0, device as u8)
            .map_err(|error| format!("background_message_rejected|{error}"))?;
        self.x11.conn.sync().map_err(e)
    }

    fn warp(&self, devices: Devices, x: i32, y: i32) -> Result<(), String> {
        self.x11
            .conn
            .xinput_xi_warp_pointer(x11rb::NONE, self.x11.root, 0, 0, 0, 0, x << 16, y << 16, devices.pointer)
            .map_err(|error| format!("background_message_rejected|{error}"))?;
        self.x11.conn.sync().map_err(e)
    }

    fn button(&self, devices: Devices, button: u8, press: bool) -> Result<(), String> {
        let offset = if press { DEVICE_BUTTON_PRESS } else { DEVICE_BUTTON_RELEASE };
        self.device_event(offset, button, devices.xtest_pointer)
    }

    fn key_code(&self, devices: Devices, code: u8, press: bool) -> Result<(), String> {
        let offset = if press { DEVICE_KEY_PRESS } else { DEVICE_KEY_RELEASE };
        self.device_event(offset, code, devices.xtest_keyboard)
    }

    fn key(&self, devices: Devices, key: Key, press: bool) -> Result<(), String> {
        let (code, _) = self.x11.code_for(keysym::of_key(key)?)?;
        self.key_code(devices, code, press)
    }

    /// Runs `body` with the modifiers held on the private keyboard.
    fn with_modifiers(&self, devices: Devices, modifiers: &[Mod], body: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let mut pressed = Vec::new();
        let mut outcome = Ok(());
        for modifier in modifiers {
            match self.key(devices, Key::Mod(*modifier), true) {
                Ok(()) => pressed.push(*modifier),
                Err(error) => {
                    outcome = Err(error);
                    break;
                }
            }
        }
        if outcome.is_ok() {
            outcome = body();
        }
        let released = pressed.iter().rev().try_for_each(|modifier| self.key(devices, Key::Mod(*modifier), false));
        if let Err(error) = released {
            return Err(format!("input_cleanup_unconfirmed: background modifier release failed: {error}"));
        }
        outcome
    }

    fn target(&self, window: Wid) -> Result<(Window, Devices), String> {
        let window = window as Window;
        if !self.x11.clients().contains(&window) {
            return Err("stale_target|the target window no longer exists; no input sent".into());
        }
        Ok((window, self.mpx.devices(self.x11)?))
    }
}

struct PrivateKeys<'a, 'b> {
    route: &'a MpxRoute<'b>,
    devices: Devices,
}

impl KeySink for PrivateKeys<'_, '_> {
    fn down(&mut self, key: Key) -> Result<(), String> {
        self.route.key(self.devices, key, true)
    }
    fn up(&mut self, key: Key) -> Result<(), String> {
        self.route.key(self.devices, key, false)
    }
    fn text(&mut self, text: &str) -> Result<(), String> {
        for c in text.chars() {
            let sym = match c {
                '\n' | '\r' => keysym::RETURN,
                '\t' => keysym::TAB,
                _ => keysym::of_char(c),
            };
            let (code, shift) = self.route.x11.code_for(sym)?;
            let shift_code = if shift { Some(self.route.x11.code_for(keysym::SHIFT_L)?.0) } else { None };
            if let Some(shift_code) = shift_code {
                self.route.key_code(self.devices, shift_code, true)?;
            }
            let typed = self.route.key_code(self.devices, code, true).and_then(|_| self.route.key_code(self.devices, code, false));
            if let Some(shift_code) = shift_code {
                self.route.key_code(self.devices, shift_code, false)?;
            }
            typed?;
        }
        Ok(())
    }
}

impl Background for MpxRoute<'_> {
    fn validate(&self, window: Wid, _action: &str) -> Result<(), String> {
        self.target(window).map(|_| ())
    }

    fn pointer(&self, window: Wid, x: i32, y: i32, kind: &str, modifiers: &[Mod]) -> Result<String, String> {
        let (window, devices) = self.target(window)?;
        let clicks = |button: u8, count: u32| -> Result<(), String> {
            for press in 0..count {
                if press > 0 {
                    std::thread::sleep(Duration::from_millis(40));
                }
                self.button(devices, button, true)?;
                self.button(devices, button, false)?;
            }
            Ok(())
        };
        self.warp(devices, x, y)?;
        self.with_modifiers(devices, modifiers, || match kind {
            "click" => clicks(1, 1),
            "double" => clicks(1, 2),
            "triple" => clicks(1, 3),
            "right" => clicks(3, 1),
            "middle" => clicks(2, 1),
            "move" => Ok(()),
            "press" => self.button(devices, 1, true),
            "release" => self.button(devices, 1, false),
            other => Err(format!("background_unsupported|pointer kind {other} has no background route; no input sent")),
        })?;
        Ok(format!("X window 0x{window:X} through a private pointer"))
    }

    fn wheel(&self, window: Wid, x: i32, y: i32, clicks: i32, horizontal: bool, modifiers: &[Mod]) -> Result<String, String> {
        let (window, devices) = self.target(window)?;
        let button = match (horizontal, clicks > 0) {
            (false, true) => 5,
            (false, false) => 4,
            (true, true) => 7,
            (true, false) => 6,
        };
        self.warp(devices, x, y)?;
        self.with_modifiers(devices, modifiers, || {
            (0..clicks.unsigned_abs()).try_for_each(|_| {
                self.button(devices, button, true)?;
                self.button(devices, button, false)
            })
        })?;
        Ok(format!("X window 0x{window:X} through a private pointer"))
    }

    fn drag(&self, window: Wid, points: &[(i32, i32)], modifiers: &[Mod]) -> Result<String, String> {
        let (window, devices) = self.target(window)?;
        let (x0, y0) = points[0];
        self.warp(devices, x0, y0)?;
        self.with_modifiers(devices, modifiers, || {
            self.button(devices, 1, true)?;
            let travel = points.windows(2).try_for_each(|pair| {
                let ((fx, fy), (tx, ty)) = (pair[0], pair[1]);
                (1..=12).try_for_each(|step| {
                    self.warp(devices, fx + (tx - fx) * step / 12, fy + (ty - fy) * step / 12)?;
                    std::thread::sleep(Duration::from_millis(12));
                    Ok::<(), String>(())
                })
            });
            let released = self.button(devices, 1, false);
            travel?;
            released.map_err(|error| format!("input_cleanup_unconfirmed: background drag release failed: {error}"))
        })?;
        Ok(format!("X window 0x{window:X} through a private pointer"))
    }

    fn keys(&self, window: Wid, keys_text: &str) -> Result<String, String> {
        let (window, devices) = self.target(window)?;
        self.x11.conn.xinput_xi_set_focus(window, CURRENT_TIME, devices.keyboard).map_err(e)?;
        self.x11.conn.sync().map_err(e)?;
        let mut sink = PrivateKeys { route: self, devices };
        let result = if keys::is_plain_text(keys_text) { sink.text(keys_text) } else { keys::send(keys_text, &mut sink) };
        self.x11.restore_borrowed();
        result?;
        Ok(format!("X window 0x{window:X} through a private keyboard"))
    }

    fn text(&self, window: Wid, text: &str) -> Result<String, String> {
        let (window, devices) = self.target(window)?;
        self.x11.conn.xinput_xi_set_focus(window, CURRENT_TIME, devices.keyboard).map_err(e)?;
        self.x11.conn.sync().map_err(e)?;
        let result = PrivateKeys { route: self, devices }.text(text);
        self.x11.restore_borrowed();
        result?;
        Ok(format!("X window 0x{window:X} through a private keyboard"))
    }
}
