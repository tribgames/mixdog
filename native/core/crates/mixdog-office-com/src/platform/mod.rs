//! The Win32 and process layer of the Office hosts, behind a trait so the session code is testable off Windows.
//!
//! The Windows implementation ([`WindowsPlatform`]) is the port of the PowerShell hosts' `MixdogOfficeInterop` class and
//! of their process helpers (`Office-ProcessIds`, `Office-ProcessStartTicks`, `Installed`, `Installed-OfficeFonts`,
//! `File-AppearsOpen`). [`FakePlatform`] answers from a script and has a clock that advances instantly.
//!
//! The layer is used from the host's single STA thread: it holds COM objects and a wait event, so it carries no `Send`
//! bound.

use std::any::Any;
use std::collections::HashSet;
use std::io::Read;
use std::io::Seek;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::Instant;

#[cfg(any(test, feature = "test-support"))]
mod fake;
#[cfg(windows)]
mod fonts;
#[cfg(windows)]
mod win;

#[cfg(any(test, feature = "test-support"))]
pub use fake::FakePlatform;
#[cfg(any(test, feature = "test-support"))]
pub use fake::FakeWindow;
#[cfg(windows)]
pub use win::WindowsPlatform;

/// `FILETIME` (100 ns since 1601-01-01) to .NET ticks (100 ns since 0001-01-01): the difference of the two epochs.
pub const FILETIME_TO_TICKS_OFFSET: i64 = 504_911_232_000_000_000;

/// The window message Excel answers by registering its running workbooks in the ROT (`WM_USER + 18`).
pub const WM_USER_REGISTER_EXCEL: u32 = 0x0400 + 18;

/// A live object found in the running object table. The Windows layer holds a `windows::core::IUnknown`
/// (`downcast::<IUnknown>()`), the fake whatever its script named (a `String` label).
pub struct RunningObject(Box<dyn Any>);

impl RunningObject {
    pub fn new<T: Any>(value: T) -> Self {
        Self(Box::new(value))
    }

    pub fn downcast<T: Any>(self) -> Result<T, Self> {
        self.0.downcast::<T>().map(|value| *value).map_err(Self)
    }

    pub fn downcast_ref<T: Any>(&self) -> Option<&T> {
        self.0.downcast_ref::<T>()
    }
}

/// A file opened for reading and writing with share mode none: nobody else can open it while it is held.
pub trait ExclusiveStream: Read + Write + Seek {}

impl<T: Read + Write + Seek> ExclusiveStream for T {}

/// The installed font families, as `Installed-OfficeFonts` returns them: a PowerShell hashtable, so a name is found
/// whatever its case.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FontSet {
    names: Vec<String>,
    folded: HashSet<String>,
}

impl FontSet {
    /// Adds a family name; the first spelling of a name is the one kept.
    pub fn insert(&mut self, name: &str) {
        if self.folded.insert(name.to_lowercase()) {
            self.names.push(name.to_string());
        }
    }

    pub fn contains(&self, name: &str) -> bool {
        self.folded.contains(&name.to_lowercase())
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.names.iter().map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }
}

impl FromIterator<String> for FontSet {
    fn from_iter<I: IntoIterator<Item = String>>(iter: I) -> Self {
        let mut set = Self::default();
        for name in iter {
            set.insert(&name);
        }
        set
    }
}

/// The image name of the process an Office format runs in (`Office-ProcessName`); empty for another format.
pub fn office_process_name(format: &str) -> &'static str {
    match format {
        "docx" => "WINWORD",
        "xlsx" => "EXCEL",
        "pptx" => "POWERPNT",
        _ => "",
    }
}

/// .NET ticks of a process creation `FILETIME` (`Office-ProcessStartTicks`).
pub fn ticks_from_filetime(filetime: u64) -> i64 {
    (filetime as i64).wrapping_add(FILETIME_TO_TICKS_OFFSET)
}

/// A GUID as .NET's `ToString('N')` writes it: 32 lowercase hex digits, no separators.
pub fn guid_text_n(data1: u32, data2: u16, data3: u16, data4: [u8; 8]) -> String {
    let mut text = format!("{data1:08x}{data2:04x}{data3:04x}");
    for byte in data4 {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

/// The ROT's `NormalizePath`: trim, drop leading `!`, a `file:` URI to its local path, the full path without trailing
/// separators; empty when the text is blank or no full path can be made.
pub fn normalize_path(value: &str) -> String {
    let mut value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    while let Some(rest) = value.strip_prefix('!') {
        value = rest;
    }
    let local = file_uri_local_path(value);
    match full_path(local.as_deref().unwrap_or(value)) {
        Some(full) => full.trim_end_matches(['\\', '/']).to_string(),
        None => String::new(),
    }
}

/// `Uri.LocalPath` of an absolute `file:` URI; `None` when the text is not one.
fn file_uri_local_path(value: &str) -> Option<String> {
    let head = value.get(..5)?;
    if !head.eq_ignore_ascii_case("file:") {
        return None;
    }
    let rest = value[5..].split(['?', '#']).next().unwrap_or("");
    let slashes = rest.bytes().take_while(|byte| *byte == b'/' || *byte == b'\\').count();
    let after = &rest[slashes..];
    let local = if slashes == 2 {
        // `file://host/share/x`: a UNC path.
        let (host, path) = match after.find(['/', '\\']) {
            Some(at) => (&after[..at], &after[at..]),
            None => (after, ""),
        };
        format!("//{host}{}", percent_decode(path))
    } else {
        let path = percent_decode(after);
        let bytes = path.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && (bytes[1] == b':' || bytes[1] == b'|') {
            format!("{}:{}", bytes[0] as char, &path[2..])
        } else {
            format!("/{path}")
        }
    };
    Some(local.replace('/', "\\"))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%'
            && at + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex_value(bytes[at + 1]), hex_value(bytes[at + 2]))
        {
            out.push(high * 16 + low);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `Path.GetFullPath`: a drive or UNC path is resolved by text (`.` and `..` segments, repeated separators, `/` to `\`),
/// anything else is made absolute against the current directory.
fn full_path(value: &str) -> Option<String> {
    if value.contains('\0') {
        return None;
    }
    let bytes = value.as_bytes();
    let separator = |byte: u8| byte == b'\\' || byte == b'/';
    let (root, rest) = if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && separator(bytes[2]) {
        (format!("{}:\\", bytes[0] as char), &value[3..])
    } else if bytes.len() >= 2 && separator(bytes[0]) && separator(bytes[1]) {
        let body = value[2..].trim_start_matches(['\\', '/']);
        let mut parts = body.splitn(3, ['\\', '/']);
        let server = parts.next().filter(|part| !part.is_empty())?;
        let share = parts.next().filter(|part| !part.is_empty())?;
        (format!("\\\\{server}\\{share}\\"), parts.next().unwrap_or(""))
    } else {
        return std::path::absolute(value).ok().map(|path| path.to_string_lossy().into_owned());
    };
    let mut segments: Vec<&str> = Vec::new();
    for segment in rest.split(['\\', '/']) {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    Some(format!("{root}{}", segments.join("\\")))
}

/// What the Office hosts ask of the operating system.
pub trait Platform {
    /// `MixdogOfficeInterop.TryGetRunningFile`: the live object registered in the ROT under a file moniker whose
    /// normalised display name equals the normalised `path` (ordinal, case-insensitive); `None` when nothing matches.
    fn try_get_running_file(&self, path: &str) -> Option<RunningObject>;

    /// Asks every `XLMAIN` window to register its workbooks in the ROT.
    fn register_excel_instances(&self);

    /// The id of the process that owns a window (0 when it has none).
    fn process_id_for_window(&self, hwnd: i64) -> i32;

    fn foreground_window(&self) -> i64;

    /// Hides every visible top-level window of a process; the count of the ones that accepted.
    fn hide_visible_windows_for_process(&self, process_id: i32) -> i32;

    fn visible_window_count_for_process(&self, process_id: i32) -> i32;

    /// `"class|title"` of every visible top-level window of a process (class cut at 127, title at 1023 characters).
    fn visible_window_descriptions_for_process(&self, process_id: i32) -> Vec<String>;

    /// Same as [`Platform::activate_window`].
    fn restore_foreground_window(&self, hwnd: i64) -> bool {
        self.activate_window(hwnd)
    }

    /// The first visible window of a class (ignoring case) whose title contains `title_part` (ignoring case); 0 when none.
    fn find_window_by_class_and_title(&self, class: &str, title_part: &str) -> i64;

    /// Brings a window to the foreground; true when it is the foreground window afterwards.
    fn activate_window(&self, hwnd: i64) -> bool;

    fn hide_window(&self, hwnd: i64) -> bool;

    fn window_visible(&self, hwnd: i64) -> bool;

    /// The ids of every process with this image name (no extension, ignoring case), as `Get-Process -Name` lists them.
    fn process_ids_by_name(&self, name: &str) -> Vec<i32>;

    /// `Office-ProcessIds`: the processes of an Office format; none for another format.
    fn office_process_ids(&self, format: &str) -> Vec<i32> {
        match office_process_name(format) {
            "" => Vec::new(),
            name => self.process_ids_by_name(name),
        }
    }

    /// `Excel-ProcessIds`.
    fn excel_process_ids(&self) -> Vec<i32> {
        self.process_ids_by_name("EXCEL")
    }

    /// `Office-ProcessStartTicks`: the creation time as .NET UTC ticks; 0 when the process cannot be opened.
    fn process_start_ticks(&self, process_id: i32) -> i64;

    fn process_exists(&self, process_id: i32) -> bool;

    /// Waits up to `timeout_ms` for a process to end; true when it has ended (also when it cannot be opened).
    fn wait_for_exit(&self, process_id: i32, timeout_ms: u32) -> bool;

    /// `TerminateProcess`; true when the call succeeded.
    fn kill_process(&self, process_id: i32) -> bool;

    /// `Installed`: the ProgID resolves to a class.
    fn installed(&self, prog_id: &str) -> bool;

    /// `Installed-OfficeFonts`: every installed family (per-user fonts included) by its name in the user's language and
    /// by its name in 1033.
    fn installed_office_fonts(&self) -> FontSet;

    /// Opens an existing file for reading and writing with share mode none; fails when anything else holds it.
    fn open_exclusive(&self, path: &Path) -> std::io::Result<Box<dyn ExclusiveStream>>;

    /// `File-AppearsOpen`: the exclusive open fails (also when the file does not exist, as in PowerShell).
    fn file_appears_open(&self, path: &Path) -> bool {
        self.open_exclusive(path).is_err()
    }

    /// `[System.IO.Path]::GetTempPath()`, with its trailing separator.
    fn temp_dir(&self) -> PathBuf;

    /// `[guid]::NewGuid().ToString('N')`.
    fn new_guid_n(&self) -> String;

    /// A wait that keeps dispatching window messages (an STA thread stays responsive); the fake advances its clock.
    fn sleep(&self, milliseconds: u32);

    /// The clock the render deadline reads.
    fn now(&self) -> Instant;
}
