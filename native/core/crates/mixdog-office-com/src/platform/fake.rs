//! A scripted [`Platform`]: windows, processes, running files, fonts and file locks are what the test put in, and the
//! clock advances by exactly what is slept, instantly.

use std::collections::BTreeMap;
use std::collections::HashSet;
use std::io;
use std::io::Cursor;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;
use std::time::Instant;

use super::ExclusiveStream;
use super::FontSet;
use super::Platform;
use super::RunningObject;
use super::guid_text_n;
use super::normalize_path;

/// A top-level window of the script.
#[derive(Debug, Clone)]
pub struct FakeWindow {
    pub hwnd: i64,
    pub process_id: i32,
    pub class: String,
    pub title: String,
    pub visible: bool,
    pub iconic: bool,
}

impl FakeWindow {
    pub fn new(hwnd: i64, process_id: i32, class: &str, title: &str) -> Self {
        Self { hwnd, process_id, class: class.to_string(), title: title.to_string(), visible: true, iconic: false }
    }
}

struct FakeProcess {
    process_id: i32,
    name: String,
    start_ticks: i64,
    alive: bool,
}

struct State {
    running_files: Vec<(String, String)>,
    excel_registrations: u32,
    windows: Vec<FakeWindow>,
    foreground: i64,
    refuse_foreground: bool,
    processes: Vec<FakeProcess>,
    installed: HashSet<String>,
    fonts: FontSet,
    files: BTreeMap<String, Vec<u8>>,
    locked: HashSet<String>,
    temp_dir: PathBuf,
    guids: u64,
    slept_ms: u64,
}

/// See the module text. Every method is callable from a shared reference, as the trait wants.
pub struct FakePlatform {
    state: Mutex<State>,
    base: Instant,
}

impl Default for FakePlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl FakePlatform {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                running_files: Vec::new(),
                excel_registrations: 0,
                windows: Vec::new(),
                foreground: 0,
                refuse_foreground: false,
                processes: Vec::new(),
                installed: HashSet::new(),
                fonts: FontSet::default(),
                files: BTreeMap::new(),
                locked: HashSet::new(),
                temp_dir: PathBuf::from("C:\\Temp\\"),
                guids: 0,
                slept_ms: 0,
            }),
            base: Instant::now(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A file moniker in the ROT: its display name and the label of the object behind it (what
    /// [`Platform::try_get_running_file`] returns, as a `String`).
    pub fn add_running_file(&self, display_name: &str, label: &str) {
        self.state().running_files.push((display_name.to_string(), label.to_string()));
    }

    /// How many times [`Platform::register_excel_instances`] ran.
    pub fn excel_registrations(&self) -> u32 {
        self.state().excel_registrations
    }

    pub fn add_window(&self, window: FakeWindow) {
        self.state().windows.push(window);
    }

    pub fn set_foreground(&self, hwnd: i64) {
        self.state().foreground = hwnd;
    }

    /// When set, `activate_window` leaves the foreground where it is and reports false.
    pub fn set_refuse_foreground(&self, refuse: bool) {
        self.state().refuse_foreground = refuse;
    }

    pub fn add_process(&self, process_id: i32, name: &str, start_ticks: i64) {
        self.state().processes.push(FakeProcess { process_id, name: name.to_string(), start_ticks, alive: true });
    }

    pub fn install(&self, prog_id: &str) {
        self.state().installed.insert(prog_id.to_lowercase());
    }

    pub fn set_fonts(&self, fonts: FontSet) {
        self.state().fonts = fonts;
    }

    /// A file the exclusive open can read and write.
    pub fn put_file(&self, path: &str, bytes: &[u8]) {
        self.state().files.insert(normalize_path(path).to_uppercase(), bytes.to_vec());
    }

    /// Makes (or ends) another holder of a file: the exclusive open of it fails while it is locked.
    pub fn set_locked(&self, path: &str, locked: bool) {
        let key = normalize_path(path).to_uppercase();
        let mut state = self.state();
        if locked {
            state.locked.insert(key);
        } else {
            state.locked.remove(&key);
        }
    }

    pub fn set_temp_dir(&self, path: &str) {
        self.state().temp_dir = PathBuf::from(path);
    }

    /// The sum of every `sleep`, in milliseconds.
    pub fn slept_ms(&self) -> u64 {
        self.state().slept_ms
    }

    /// The windows as they are now.
    pub fn windows(&self) -> Vec<FakeWindow> {
        self.state().windows.clone()
    }
}

fn pid_matches(window: &FakeWindow, process_id: i32) -> bool {
    process_id > 0 && window.process_id == process_id
}

impl Platform for FakePlatform {
    fn try_get_running_file(&self, path: &str) -> Option<RunningObject> {
        let expected = normalize_path(path).to_uppercase();
        let state = self.state();
        state
            .running_files
            .iter()
            .find(|(display, _)| normalize_path(display).to_uppercase() == expected)
            .map(|(_, label)| RunningObject::new(label.clone()))
    }

    fn register_excel_instances(&self) {
        self.state().excel_registrations += 1;
    }

    fn process_id_for_window(&self, hwnd: i64) -> i32 {
        self.state().windows.iter().find(|window| window.hwnd == hwnd).map_or(0, |window| window.process_id)
    }

    fn foreground_window(&self) -> i64 {
        self.state().foreground
    }

    fn hide_visible_windows_for_process(&self, process_id: i32) -> i32 {
        let mut hidden = 0;
        for window in self.state().windows.iter_mut() {
            if pid_matches(window, process_id) && window.visible {
                window.visible = false;
                hidden += 1;
            }
        }
        hidden
    }

    fn visible_window_count_for_process(&self, process_id: i32) -> i32 {
        self.state().windows.iter().filter(|window| pid_matches(window, process_id) && window.visible).count() as i32
    }

    fn visible_window_descriptions_for_process(&self, process_id: i32) -> Vec<String> {
        self.state()
            .windows
            .iter()
            .filter(|window| pid_matches(window, process_id) && window.visible)
            .map(|window| {
                let class: String = window.class.chars().take(127).collect();
                let title: String = window.title.chars().take(1023).collect();
                format!("{class}|{title}")
            })
            .collect()
    }

    fn find_window_by_class_and_title(&self, class: &str, title_part: &str) -> i64 {
        let part = title_part.to_uppercase();
        self.state()
            .windows
            .iter()
            .find(|window| {
                window.visible && window.class.eq_ignore_ascii_case(class) && window.title.to_uppercase().contains(&part)
            })
            .map_or(0, |window| window.hwnd)
    }

    fn activate_window(&self, hwnd: i64) -> bool {
        let mut state = self.state();
        if hwnd == 0 {
            return false;
        }
        let refuse = state.refuse_foreground;
        let Some(window) = state.windows.iter_mut().find(|window| window.hwnd == hwnd) else { return false };
        // SW_RESTORE or SW_SHOW: the window is shown and no longer minimised.
        window.visible = true;
        window.iconic = false;
        if refuse {
            return false;
        }
        state.foreground = hwnd;
        true
    }

    fn hide_window(&self, hwnd: i64) -> bool {
        if hwnd == 0 {
            return false;
        }
        match self.state().windows.iter_mut().find(|window| window.hwnd == hwnd) {
            Some(window) => {
                window.visible = false;
                true
            }
            None => false,
        }
    }

    fn window_visible(&self, hwnd: i64) -> bool {
        hwnd != 0 && self.state().windows.iter().any(|window| window.hwnd == hwnd && window.visible)
    }

    fn process_ids_by_name(&self, name: &str) -> Vec<i32> {
        self.state()
            .processes
            .iter()
            .filter(|process| process.alive && process.name.eq_ignore_ascii_case(name))
            .map(|process| process.process_id)
            .collect()
    }

    fn process_start_ticks(&self, process_id: i32) -> i64 {
        self.state()
            .processes
            .iter()
            .find(|process| process.alive && process.process_id == process_id)
            .map_or(0, |process| process.start_ticks)
    }

    fn process_exists(&self, process_id: i32) -> bool {
        self.state().processes.iter().any(|process| process.alive && process.process_id == process_id)
    }

    fn wait_for_exit(&self, process_id: i32, timeout_ms: u32) -> bool {
        if !self.process_exists(process_id) {
            return true;
        }
        self.sleep(timeout_ms);
        false
    }

    fn kill_process(&self, process_id: i32) -> bool {
        match self.state().processes.iter_mut().find(|process| process.alive && process.process_id == process_id) {
            Some(process) => {
                process.alive = false;
                true
            }
            None => false,
        }
    }

    fn installed(&self, prog_id: &str) -> bool {
        !prog_id.is_empty() && self.state().installed.contains(&prog_id.to_lowercase())
    }

    fn installed_office_fonts(&self) -> FontSet {
        self.state().fonts.clone()
    }

    fn open_exclusive(&self, path: &Path) -> io::Result<Box<dyn ExclusiveStream>> {
        let key = normalize_path(&path.to_string_lossy()).to_uppercase();
        let state = self.state();
        if state.locked.contains(&key) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the file is in use by another process"));
        }
        match state.files.get(&key) {
            Some(bytes) => Ok(Box::new(Cursor::new(bytes.clone()))),
            None => Err(io::Error::new(io::ErrorKind::NotFound, "the file does not exist")),
        }
    }

    fn temp_dir(&self) -> PathBuf {
        self.state().temp_dir.clone()
    }

    fn new_guid_n(&self) -> String {
        let mut state = self.state();
        state.guids += 1;
        let count = state.guids;
        guid_text_n(0xF4C3_0000 + (count >> 32) as u32, 0x4A1B, 0x4C2D, count.to_be_bytes())
    }

    fn sleep(&self, milliseconds: u32) {
        self.state().slept_ms += u64::from(milliseconds);
    }

    fn now(&self) -> Instant {
        self.base + Duration::from_millis(self.state().slept_ms)
    }
}
