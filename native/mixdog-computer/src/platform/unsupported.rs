//! A desktop that cannot be driven: builds for other systems, or a session
//! with no display server. Every call reports why.

#![allow(dead_code)]

use super::{AppEntry, Background, Button, Desktop, Launched, WinState, WindowInfo, Wid};
use crate::a11y::Accessibility;
use crate::keys::Key;
use serde_json::{json, Value};

pub struct Unsupported {
    reason: String,
}

impl Unsupported {
    pub fn new(reason: impl Into<String>) -> Unsupported {
        Unsupported { reason: reason.into() }
    }
}

impl Unsupported {
    fn fail<T>(&self) -> Result<T, String> {
        Err(self.reason.clone())
    }
}

impl Desktop for Unsupported {
    fn name(&self) -> &'static str {
        "unsupported"
    }
    fn windows(&self) -> Result<Vec<WindowInfo>, String> {
        self.fail()
    }
    fn info(&self, _handle: Wid) -> Option<WindowInfo> {
        None
    }
    fn foreground(&self) -> Wid {
        0
    }
    fn focus(&self, _handle: Wid) -> bool {
        false
    }
    fn window_at_point(&self, _x: i32, _y: i32) -> Wid {
        0
    }
    fn related_windows(&self, _handle: Wid) -> Vec<Wid> {
        Vec::new()
    }
    fn is_owned_by(&self, _candidate: Wid, _owner: Wid) -> bool {
        false
    }
    fn move_window(&self, _handle: Wid, _x: i32, _y: i32, _width: i32, _height: i32) -> Result<(), String> {
        self.fail()
    }
    fn set_window_state(&self, _handle: Wid, _state: WinState) -> Result<(), String> {
        self.fail()
    }
    fn close_window(&self, _handle: Wid) -> Result<bool, String> {
        self.fail()
    }
    fn is_responding(&self, _handle: Wid) -> bool {
        true
    }
    fn cursor(&self) -> (i32, i32) {
        (0, 0)
    }
    fn move_pointer(&self, _x: i32, _y: i32) -> Result<(), String> {
        self.fail()
    }
    fn button(&self, _button: Button, _down: bool, _x: i32, _y: i32, _clicks: u32) -> Result<(), String> {
        self.fail()
    }
    fn drag_move(&self, _x: i32, _y: i32) -> Result<(), String> {
        self.fail()
    }
    fn wheel(&self, _x: i32, _y: i32, _clicks: i32, _horizontal: bool) -> Result<(), String> {
        self.fail()
    }
    fn key(&self, _key: Key, _down: bool) -> Result<(), String> {
        self.fail()
    }
    fn text(&self, _text: &str) -> Result<(), String> {
        self.fail()
    }
    fn input_held(&self) -> bool {
        false
    }
    fn background(&self) -> Option<&dyn Background> {
        None
    }
    fn accessibility(&self) -> Option<&dyn Accessibility> {
        None
    }
    fn clipboard_read(&self) -> Result<String, String> {
        self.fail()
    }
    fn clipboard_write(&self, _text: &str) -> Result<bool, String> {
        self.fail()
    }
    fn launch(&self, _target: &str, _app: Option<&AppEntry>) -> Result<Launched, String> {
        self.fail()
    }
    fn installed_apps(&self) -> Result<Vec<AppEntry>, String> {
        self.fail()
    }
    fn ocr(&self, _image: &[u8], _language: &str, _max_words: usize) -> Result<Value, String> {
        self.fail()
    }
    fn ocr_status(&self, _language: &str) -> Value {
        json!({ "text": "OCR readiness", "available": false })
    }
}
