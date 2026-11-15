//! The OS helpers of the terminal layer: the platform and environment facts the other helpers decide by, the one way a
//! helper program is run (a [`Runner`]), the browser opener (`runtime/shared/open-url.mjs`) and the native folder
//! picker (`standalone/folder-dialog.mjs`).
//!
//! Every decision is a pure function of a [`Platform`] and an environment lookup, so the chosen program and arguments
//! of each platform are tested without that platform. Running a program goes through a [`Runner`]; the clipboard and
//! paste modules take one too, and the tests of this crate give them one that records the argv and the stdin bytes.
//!
//! The folder picker on Windows is the Common Item Dialog (`IFileOpenDialog` with `FOS_PICKFOLDERS`) called in this
//! process on its own single-threaded-apartment thread: no PowerShell child. The other platforms run `osascript`,
//! `zenity` or `kdialog` as Node did.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the helper programs of this module are short-lived child processes run on the caller's own thread"
)]

use std::io::{self, Read, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use mixdog_fsio::Unlaned;

/// The platform a helper is chosen for. Anything that is not Windows, macOS or Linux is [`Platform::Other`]; Node
/// treated it as Linux for the launchers and writers and as nothing for the readers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Macos,
    Linux,
    Other,
}

impl Platform {
    /// The platform this process runs on (`process.platform`).
    pub fn current() -> Platform {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::Macos
        } else if cfg!(target_os = "linux") {
            Platform::Linux
        } else {
            Platform::Other
        }
    }
}

/// A lookup of environment variables: `None` when unset. A variable that is set to the empty string is as good as unset
/// wherever Node tested it for truthiness; [`env_set`] and [`env_value`] say that.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The environment of this process.
pub fn process_env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
}

/// `Boolean(process.env[name])`.
pub fn env_set(env: Env<'_>, name: &str) -> bool {
    env(name).is_some_and(|value| !value.is_empty())
}

/// `process.env[name]` when it is truthy.
pub fn env_value(env: Env<'_>, name: &str) -> Option<String> {
    env(name).filter(|value| !value.is_empty())
}

/// A helper program to run: its argv, the variables added to the environment, the bytes written to its stdin, whether its
/// stdout is kept, and how long it may take.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HelperCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Written to the child's stdin, which is then closed. `None` gives it no input.
    pub stdin: Option<Vec<u8>>,
    /// Keep what the child writes to stdout (stderr is always discarded).
    pub capture_stdout: bool,
    /// The child is killed after this long. `None` waits for it.
    pub timeout: Option<Duration>,
    /// The child is killed when it has written more than this many bytes to stdout. `None` keeps all.
    pub max_stdout: Option<usize>,
}

impl HelperCommand {
    pub fn new(program: &str, args: &[&str]) -> HelperCommand {
        HelperCommand {
            program: program.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            ..HelperCommand::default()
        }
    }
}

/// How a helper ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// It ran to its end: the exit code (`None` when a signal ended it) and what it wrote to stdout.
    Exited { code: Option<i32>, stdout: Vec<u8> },
    /// The program does not exist (`ENOENT`).
    NotFound,
    /// The program could not be started for another reason.
    SpawnFailed(String),
    /// It was killed after its timeout.
    TimedOut,
    /// It was killed for writing more than its stdout limit.
    Overflow,
}

impl Outcome {
    /// Exited with code 0 (execFile's `!error`).
    pub fn succeeded(&self) -> bool {
        matches!(self, Outcome::Exited { code: Some(0), .. })
    }

    pub fn not_found(&self) -> bool {
        matches!(self, Outcome::NotFound)
    }

    /// What the helper wrote to stdout, when it ran.
    pub fn stdout(&self) -> &[u8] {
        match self {
            Outcome::Exited { stdout, .. } => stdout,
            _ => &[],
        }
    }
}

/// How helper programs are run.
pub trait Runner: Send + Sync {
    /// Run a helper to its end (or its timeout) and say how it ended.
    fn run(&self, command: &HelperCommand) -> Outcome;

    /// Start a program that outlives this call, with no stdio and no window; the error is the failure to start it.
    fn spawn_detached(&self, program: &str, args: &[String]) -> io::Result<()>;
}

/// The runner of this process: real child processes with a hidden window on Windows.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemRunner;

/// `CREATE_NO_WINDOW`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hide_window(process: &mut std::process::Command) {
    #[cfg(windows)]
    {
        std::os::windows::process::CommandExt::creation_flags(process, CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = process;
    }
}

/// How often a running helper is looked at.
const POLL: Duration = Duration::from_millis(2);
/// How long the stdout reader may take to finish once the child is gone.
const DRAIN: Duration = Duration::from_millis(500);

impl Runner for SystemRunner {
    fn run(&self, command: &HelperCommand) -> Outcome {
        let mut process = std::process::Command::new(&command.program);
        process.args(&command.args);
        for (name, value) in &command.env {
            process.env(name, value);
        }
        process.stdin(if command.stdin.is_some() { Stdio::piped() } else { Stdio::null() });
        process.stdout(if command.capture_stdout { Stdio::piped() } else { Stdio::null() });
        process.stderr(Stdio::null());
        hide_window(&mut process);
        let mut child = match process.spawn() {
            Ok(child) => child,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Outcome::NotFound,
            Err(error) => return Outcome::SpawnFailed(error.to_string()),
        };
        if let (Some(bytes), Some(mut pipe)) = (command.stdin.clone(), child.stdin.take()) {
            // A helper that closes its stdin early is not an error (EPIPE).
            thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            });
        }
        let overflow = Arc::new(AtomicBool::new(false));
        let reader = child.stdout.take().map(|mut pipe| {
            let (sender, receiver) = mpsc::channel();
            let flag = Arc::clone(&overflow);
            let limit = command.max_stdout;
            thread::spawn(move || {
                let mut data = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(count) => {
                            data.extend_from_slice(&chunk[..count]);
                            if limit.is_some_and(|limit| data.len() > limit) {
                                flag.store(true, Ordering::SeqCst);
                                break;
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
                let _ = sender.send(data);
            });
            receiver
        });
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(error) => return Outcome::SpawnFailed(error.to_string()),
            }
            if overflow.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Outcome::Overflow;
            }
            if command.timeout.is_some_and(|limit| started.elapsed() >= limit) {
                let _ = child.kill();
                let _ = child.wait();
                return Outcome::TimedOut;
            }
            mixdog_fsio::sleep(&Unlaned, POLL);
        };
        let stdout = reader.and_then(|receiver| receiver.recv_timeout(DRAIN).ok()).unwrap_or_default();
        if overflow.load(Ordering::SeqCst) {
            return Outcome::Overflow;
        }
        Outcome::Exited { code: status.code(), stdout }
    }

    fn spawn_detached(&self, program: &str, args: &[String]) -> io::Result<()> {
        let mut process = std::process::Command::new(program);
        process.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut process);
        // POSIX: the child leads its own process group, so it outlives this process's terminal and is not signalled
        // with it. Windows: no detached flag, because DETACHED_PROCESS would make the hidden window visible.
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut process, 0);
        let mut child = process.spawn()?;
        // Reaped on its own thread so a launcher that has finished is not left as a zombie.
        thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

// ---- WSL -----------------------------------------------------------------------------------------------------------------

/// `isWSL()`: Linux with `WSL_DISTRO_NAME` or `WSL_INTEROP` set, or a Microsoft kernel in `/proc/version` (read through
/// `proc_version`, only when the variables say nothing).
pub fn is_wsl(platform: Platform, env: Env<'_>, proc_version: &dyn Fn() -> Option<String>) -> bool {
    if platform != Platform::Linux {
        return false;
    }
    if env_set(env, "WSL_DISTRO_NAME") || env_set(env, "WSL_INTEROP") {
        return true;
    }
    proc_version().is_some_and(|text| {
        let text = text.to_lowercase();
        text.contains("microsoft") || text.contains("wsl")
    })
}

/// [`is_wsl`] of this machine, settled once.
pub fn is_wsl_host() -> bool {
    static WSL: OnceLock<bool> = OnceLock::new();
    *WSL.get_or_init(|| {
        is_wsl(Platform::current(), &process_env, &|| {
            mixdog_fsio::read_to_string(&Unlaned, "/proc/version").ok()
        })
    })
}

// ---- the browser opener --------------------------------------------------------------------------------------------------

/// Whether a browser can plausibly open here: not inside an SSH session, and on Linux outside WSL a `DISPLAY` or
/// `WAYLAND_DISPLAY` exists.
pub fn can_open_browser(env: Env<'_>, platform: Platform, wsl: bool) -> bool {
    if env_set(env, "SSH_TTY") || env_set(env, "SSH_CONNECTION") {
        return false;
    }
    if platform != Platform::Linux || wsl {
        return true;
    }
    env_set(env, "DISPLAY") || env_set(env, "WAYLAND_DISPLAY")
}

/// The launchers tried in order to open `url`, each as program and arguments.
pub fn browser_candidates(platform: Platform, env: Env<'_>, wsl: bool, url: &str) -> Vec<(String, Vec<String>)> {
    match platform {
        Platform::Windows => {
            let system_root = env_value(env, "SystemRoot")
                .or_else(|| env_value(env, "WINDIR"))
                .unwrap_or_else(|| "C:\\Windows".to_owned());
            vec![(
                format!("{system_root}\\System32\\rundll32.exe"),
                vec!["url.dll,FileProtocolHandler".to_owned(), url.to_owned()],
            )]
        }
        Platform::Macos => vec![("open".to_owned(), vec![url.to_owned()])],
        _ if wsl => {
            let quoted = format!("'{}'", url.replace('\'', "''"));
            vec![
                ("wslview".to_owned(), vec![url.to_owned()]),
                (
                    "powershell.exe".to_owned(),
                    vec![
                        "-NoProfile".to_owned(),
                        "-NonInteractive".to_owned(),
                        "-Command".to_owned(),
                        format!("Start-Process -FilePath {quoted}"),
                    ],
                ),
            ]
        }
        _ => vec![("xdg-open".to_owned(), vec![url.to_owned()])],
    }
}

/// Open `url` in the default browser through `runner`: best effort and not waited for. A launcher that cannot be started
/// hands over to the next one; one that starts and then fails is not retried. Callers also print the URL, so a failure
/// never blocks a sign-in.
pub fn open_in_browser_with(runner: &dyn Runner, platform: Platform, env: Env<'_>, wsl: bool, url: &str) {
    for (program, args) in browser_candidates(platform, env, wsl, url) {
        if runner.spawn_detached(&program, &args).is_ok() {
            return;
        }
    }
}

/// [`open_in_browser_with`] on this machine.
pub fn open_in_browser(url: &str) {
    open_in_browser_with(&SystemRunner, Platform::current(), &process_env, is_wsl_host(), url);
}

// ---- the folder picker ---------------------------------------------------------------------------------------------------

/// How long a Unix dialog may stay open before it is given up on.
const DIALOG_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// The dialog title when none is given.
pub const DEFAULT_FOLDER_TITLE: &str = "Select a project folder";

/// What the folder picker is asked.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FolderPickOptions {
    /// The dialog title; `None` is [`DEFAULT_FOLDER_TITLE`].
    pub title: Option<String>,
    /// The folder the dialog opens in (Windows; the current directory when empty).
    pub initial_path: String,
}

/// What the folder picker answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderPick {
    /// `false`: no usable dialog exists; the caller falls back to typing a path (`reason` names what to install when
    /// nothing exists).
    pub available: bool,
    /// The chosen absolute path; `None` with `available` set is a cancel.
    pub path: Option<String>,
    pub reason: Option<String>,
}

impl FolderPick {
    fn unavailable() -> FolderPick {
        FolderPick { available: false, path: None, reason: None }
    }

    fn chosen(path: Option<String>) -> FolderPick {
        FolderPick { available: true, path, reason: None }
    }
}

/// The AppleScript of the macOS picker; backslashes and quotes of the title are escaped.
pub fn macos_choose_script(title: &str) -> String {
    let safe = title.replace('\\', "\\\\").replace('"', "\\\"");
    format!("set f to choose folder with prompt \"{safe}\"\nPOSIX path of f")
}

/// A dialog helper could not run at all (it could not be started, or it timed out), as against a cancel, which is a
/// clean non-zero exit.
fn dialog_failed(outcome: &Outcome) -> bool {
    !matches!(outcome, Outcome::Exited { .. })
}

fn trimmed_path(outcome: &Outcome) -> Option<String> {
    let text = String::from_utf8_lossy(outcome.stdout());
    let text = mixdog_js::js_trim(&text);
    (!text.is_empty()).then(|| text.to_owned())
}

fn dialog_command(program: &str, args: &[&str]) -> HelperCommand {
    HelperCommand { capture_stdout: true, timeout: Some(DIALOG_TIMEOUT), ..HelperCommand::new(program, args) }
}

/// Whether `name` is an executable file in a directory of `PATH` (`which`), best effort.
pub fn command_exists(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let Ok(metadata) = mixdog_fsio::metadata(&Unlaned, dir.join(name)) else {
            return false;
        };
        if !metadata.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            true
        }
    })
}

/// The picker of macOS and of Linux and the other Unixes: `osascript choose folder`, else `zenity` before `kdialog`. A
/// helper that could not run (started badly, timed out) means no dialog, so the caller types; any other exit without a
/// path is a cancel.
pub fn pick_folder_unix(
    runner: &dyn Runner,
    platform: Platform,
    options: &FolderPickOptions,
    exists: &dyn Fn(&str) -> bool,
) -> FolderPick {
    let title = options.title.as_deref().unwrap_or(DEFAULT_FOLDER_TITLE);
    if platform == Platform::Macos {
        let outcome = runner.run(&dialog_command("osascript", &["-e", &macos_choose_script(title)]));
        if dialog_failed(&outcome) {
            return FolderPick::unavailable();
        }
        return FolderPick::chosen(trimmed_path(&outcome));
    }
    let picker = if exists("zenity") {
        dialog_command("zenity", &["--file-selection", "--directory", &format!("--title={title}")])
    } else if exists("kdialog") {
        dialog_command("kdialog", &["--getexistingdirectory", "."])
    } else {
        return FolderPick {
            available: false,
            path: None,
            reason: Some("No folder dialog is installed; install zenity or kdialog to pick folders.".to_owned()),
        };
    };
    let outcome = runner.run(&picker);
    if dialog_failed(&outcome) {
        return FolderPick::unavailable();
    }
    FolderPick::chosen(trimmed_path(&outcome))
}

/// Open the native folder picker and wait for the answer.
#[cfg(not(windows))]
pub fn pick_folder(options: &FolderPickOptions) -> FolderPick {
    pick_folder_unix(&SystemRunner, Platform::current(), options, &command_exists)
}

/// Open the native folder picker and wait for the answer: the Common Item Dialog on its own apartment thread, owned by
/// an invisible topmost window placed at the centre of the console (or the foreground window, or the work area), so it is
/// modal, centred and not left on another monitor.
#[cfg(windows)]
pub fn pick_folder(options: &FolderPickOptions) -> FolderPick {
    let title = options
        .title
        .clone()
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| DEFAULT_FOLDER_TITLE.to_owned());
    let initial = windows_dialog::initial_folder(&options.initial_path);
    match thread::Builder::new()
        .name("mixdog-folder-dialog".to_owned())
        .spawn(move || windows_dialog::pick(&title, &initial))
        .map(thread::JoinHandle::join)
    {
        Ok(Ok(Ok(selected))) => FolderPick::chosen(selected),
        // The dialog could not be created or shown (the script of Node would have failed without printing a path), or
        // its thread could not be started.
        _ => FolderPick::unavailable(),
    }
}

#[cfg(windows)]
mod windows_dialog {
    use std::ffi::c_void;
    use std::path::PathBuf;

    use mixdog_fsio::Unlaned;
    use windows::Win32::Foundation::{COLORREF, HWND, RECT};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
        IBindCtx,
    };
    use windows::Win32::System::Console::GetConsoleWindow;
    use windows::Win32::UI::Shell::{
        FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, FileOpenDialog,
        IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, SIGDN_FILESYSPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetForegroundWindow, GetWindowRect, LWA_ALPHA, SPI_GETWORKAREA, SW_SHOW,
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SetForegroundWindow, SetLayeredWindowAttributes, ShowWindow,
        SystemParametersInfoW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };
    use windows::core::{HRESULT, PCWSTR, w};

    /// `HRESULT_FROM_WIN32(ERROR_CANCELLED)`: the user closed the dialog.
    const CANCELLED: HRESULT = HRESULT(0x8007_04C7_u32 as i32);

    /// The absolute folder the dialog opens in: the given path, else the current directory, made absolute (best effort).
    pub fn initial_folder(initial_path: &str) -> String {
        let trimmed = mixdog_js::js_trim(initial_path);
        let base = if trimmed.is_empty() {
            std::env::current_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            trimmed.to_owned()
        };
        std::path::absolute(&base).map(|path| path.to_string_lossy().into_owned()).unwrap_or(base)
    }

    /// The centre of the console window, else of the foreground window, else of the primary work area.
    fn owner_center() -> (i32, i32) {
        let mut hwnd = unsafe { GetConsoleWindow() };
        if hwnd.is_invalid() {
            hwnd = unsafe { GetForegroundWindow() };
        }
        let mut rect = RECT::default();
        if !hwnd.is_invalid() && unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
            return ((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        }
        let mut area = RECT::default();
        let _ = unsafe {
            SystemParametersInfoW(
                SPI_GETWORKAREA,
                0,
                Some((&mut area as *mut RECT).cast::<c_void>()),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        };
        (area.left + (area.right - area.left) / 2, area.top + (area.bottom - area.top) / 2)
    }

    /// The invisible 1x1 topmost window the dialog is owned by (no taskbar button, fully transparent).
    fn owner_window() -> Option<HWND> {
        let (left, top) = owner_center();
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
                w!("STATIC"),
                PCWSTR::null(),
                WS_POPUP,
                left,
                top,
                1,
                1,
                None,
                None,
                None,
                None,
            )
        }
        .ok()?;
        unsafe {
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA);
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = SetForegroundWindow(hwnd);
        }
        Some(hwnd)
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Runs the dialog on this (fresh) thread: `Ok(None)` is a cancel, `Err` a dialog that could not be shown.
    pub fn pick(title: &str, initial: &str) -> Result<Option<String>, windows::core::Error> {
        let initialised = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
        let owner = owner_window();
        // The dialog objects are dropped inside `show`, before the apartment is left.
        let result = show(title, initial, owner);
        if let Some(hwnd) = owner {
            let _ = unsafe { DestroyWindow(hwnd) };
        }
        if initialised {
            unsafe { CoUninitialize() };
        }
        result
    }

    fn show(title: &str, initial: &str, owner: Option<HWND>) -> Result<Option<String>, windows::core::Error> {
        let dialog: IFileOpenDialog = unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) }?;
        unsafe {
            let options = dialog.GetOptions()?;
            dialog.SetOptions(
                options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_FILEMUSTEXIST | FOS_NOCHANGEDIR,
            )?;
            if !title.is_empty() {
                dialog.SetTitle(PCWSTR(wide(title).as_ptr()))?;
            }
        }
        // The initial folder is a convenience only: the picker is shown without it when it does not exist or cannot be
        // set.
        if !initial.is_empty() && mixdog_fsio::is_dir(&Unlaned, PathBuf::from(initial)) {
            let wide_initial = wide(initial);
            let item = unsafe {
                SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(wide_initial.as_ptr()), None::<&IBindCtx>)
            };
            if let Ok(item) = item {
                let _ = unsafe { dialog.SetDefaultFolder(&item) };
                let _ = unsafe { dialog.SetFolder(&item) };
            }
        }
        match unsafe { dialog.Show(owner) } {
            Ok(()) => {}
            Err(error) if error.code() == CANCELLED => return Ok(None),
            Err(error) => return Err(error),
        }
        let item = unsafe { dialog.GetResult() }?;
        let name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }?;
        let path = unsafe { name.to_string() }.unwrap_or_default();
        unsafe { CoTaskMemFree(Some(name.0 as *const c_void)) };
        let path = mixdog_js::js_trim(&path);
        Ok((!path.is_empty()).then(|| path.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: Vec<(String, String)> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        move |name| map.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }

    #[test]
    fn a_browser_does_not_open_over_ssh_or_without_a_display() {
        let none = env_of(&[]);
        assert!(can_open_browser(&none, Platform::Windows, false));
        assert!(can_open_browser(&none, Platform::Macos, false));
        assert!(can_open_browser(&none, Platform::Linux, true));
        assert!(!can_open_browser(&none, Platform::Linux, false));
        assert!(can_open_browser(&env_of(&[("DISPLAY", ":0")]), Platform::Linux, false));
        assert!(can_open_browser(&env_of(&[("WAYLAND_DISPLAY", "wayland-0")]), Platform::Linux, false));
        assert!(!can_open_browser(&env_of(&[("DISPLAY", "")]), Platform::Linux, false));
        assert!(!can_open_browser(&env_of(&[("SSH_TTY", "/dev/pts/1"), ("DISPLAY", ":0")]), Platform::Linux, false));
        assert!(!can_open_browser(&env_of(&[("SSH_CONNECTION", "1 2 3 4")]), Platform::Macos, false));
    }

    #[test]
    fn the_launcher_of_each_platform() {
        let url = "https://example.com/a?b=1&c='x'";
        let none = env_of(&[]);
        assert_eq!(
            browser_candidates(Platform::Windows, &none, false, url),
            vec![(
                "C:\\Windows\\System32\\rundll32.exe".to_owned(),
                vec!["url.dll,FileProtocolHandler".to_owned(), url.to_owned()]
            )]
        );
        let windir = env_of(&[("SystemRoot", ""), ("WINDIR", "D:\\Win")]);
        assert_eq!(browser_candidates(Platform::Windows, &windir, false, url)[0].0, "D:\\Win\\System32\\rundll32.exe");
        assert_eq!(browser_candidates(Platform::Macos, &none, false, url), vec![("open".to_owned(), vec![url.to_owned()])]);
        assert_eq!(
            browser_candidates(Platform::Linux, &none, false, url),
            vec![("xdg-open".to_owned(), vec![url.to_owned()])]
        );
        let wsl = browser_candidates(Platform::Linux, &none, true, url);
        assert_eq!(wsl[0], ("wslview".to_owned(), vec![url.to_owned()]));
        assert_eq!(wsl[1].0, "powershell.exe");
        assert_eq!(wsl[1].1[3], "Start-Process -FilePath 'https://example.com/a?b=1&c=''x'''");
    }

    #[test]
    fn wsl_is_told_from_the_environment_then_the_kernel() {
        let none = env_of(&[]);
        let microsoft = || Some("Linux version 5.15 (Microsoft)".to_owned());
        let plain = || Some("Linux version 6.1".to_owned());
        assert!(is_wsl(Platform::Linux, &env_of(&[("WSL_INTEROP", "/run/WSL/1")]), &plain));
        assert!(is_wsl(Platform::Linux, &none, &microsoft));
        assert!(!is_wsl(Platform::Linux, &none, &plain));
        assert!(!is_wsl(Platform::Linux, &none, &|| None));
        assert!(!is_wsl(Platform::Macos, &env_of(&[("WSL_DISTRO_NAME", "Ubuntu")]), &microsoft));
    }

    struct Scripted {
        outcomes: Mutex<Vec<Outcome>>,
        commands: Mutex<Vec<HelperCommand>>,
        launched: Mutex<Vec<String>>,
        launch_fails: Vec<&'static str>,
    }

    impl Scripted {
        fn new(outcomes: Vec<Outcome>, launch_fails: Vec<&'static str>) -> Scripted {
            Scripted {
                outcomes: Mutex::new(outcomes),
                commands: Mutex::new(Vec::new()),
                launched: Mutex::new(Vec::new()),
                launch_fails,
            }
        }
    }

    impl Runner for Scripted {
        fn run(&self, command: &HelperCommand) -> Outcome {
            self.commands.lock().unwrap().push(command.clone());
            self.outcomes.lock().unwrap().remove(0)
        }

        fn spawn_detached(&self, program: &str, _args: &[String]) -> io::Result<()> {
            self.launched.lock().unwrap().push(program.to_owned());
            if self.launch_fails.contains(&program) {
                Err(io::Error::from(io::ErrorKind::NotFound))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn a_launcher_that_cannot_start_hands_over_to_the_next() {
        let runner = Scripted::new(Vec::new(), vec!["wslview"]);
        open_in_browser_with(&runner, Platform::Linux, &env_of(&[]), true, "https://x");
        assert_eq!(*runner.launched.lock().unwrap(), vec!["wslview", "powershell.exe"]);
        let runner = Scripted::new(Vec::new(), vec![]);
        open_in_browser_with(&runner, Platform::Linux, &env_of(&[]), true, "https://x");
        assert_eq!(*runner.launched.lock().unwrap(), vec!["wslview"]);
    }

    #[test]
    fn the_macos_script_escapes_the_title() {
        assert_eq!(
            macos_choose_script("Pick \"a\" \\ folder"),
            "set f to choose folder with prompt \"Pick \\\"a\\\" \\\\ folder\"\nPOSIX path of f"
        );
    }

    fn exited(code: i32, text: &str) -> Outcome {
        Outcome::Exited { code: Some(code), stdout: text.as_bytes().to_vec() }
    }

    #[test]
    fn the_linux_picker_prefers_zenity_then_kdialog_and_tells_a_cancel_from_a_failure() {
        let options = FolderPickOptions { title: Some("Choose".to_owned()), initial_path: String::new() };
        let runner = Scripted::new(vec![exited(0, "/home/u/work\n")], vec![]);
        let pick = pick_folder_unix(&runner, Platform::Linux, &options, &|name| name == "zenity" || name == "kdialog");
        assert_eq!(pick, FolderPick::chosen(Some("/home/u/work".to_owned())));
        let command = runner.commands.lock().unwrap()[0].clone();
        assert_eq!(command.program, "zenity");
        assert_eq!(command.args, vec!["--file-selection", "--directory", "--title=Choose"]);
        assert_eq!(command.timeout, Some(Duration::from_secs(300)));
        assert!(command.capture_stdout);

        let runner = Scripted::new(vec![exited(1, "")], vec![]);
        let pick = pick_folder_unix(&runner, Platform::Linux, &options, &|name| name == "kdialog");
        assert_eq!(pick, FolderPick::chosen(None));
        let command = runner.commands.lock().unwrap()[0].clone();
        assert_eq!(command.program, "kdialog");
        assert_eq!(command.args, vec!["--getexistingdirectory", "."]);

        let runner = Scripted::new(vec![Outcome::TimedOut], vec![]);
        assert_eq!(pick_folder_unix(&runner, Platform::Linux, &options, &|_| true), FolderPick::unavailable());
        let runner = Scripted::new(vec![Outcome::NotFound], vec![]);
        assert_eq!(pick_folder_unix(&runner, Platform::Linux, &options, &|_| true), FolderPick::unavailable());

        let runner = Scripted::new(vec![], vec![]);
        let pick = pick_folder_unix(&runner, Platform::Linux, &options, &|_| false);
        assert!(!pick.available);
        assert_eq!(
            pick.reason.as_deref(),
            Some("No folder dialog is installed; install zenity or kdialog to pick folders.")
        );
        assert!(runner.commands.lock().unwrap().is_empty());
    }

    #[test]
    fn the_macos_picker_runs_osascript() {
        let runner = Scripted::new(vec![exited(0, "/Users/u/work/\n")], vec![]);
        let pick = pick_folder_unix(&runner, Platform::Macos, &FolderPickOptions::default(), &|_| false);
        assert_eq!(pick, FolderPick::chosen(Some("/Users/u/work/".to_owned())));
        let command = runner.commands.lock().unwrap()[0].clone();
        assert_eq!(command.program, "osascript");
        assert_eq!(command.args[0], "-e");
        assert_eq!(command.args[1], macos_choose_script(DEFAULT_FOLDER_TITLE));
        let runner = Scripted::new(vec![exited(1, "")], vec![]);
        assert_eq!(
            pick_folder_unix(&runner, Platform::Macos, &FolderPickOptions::default(), &|_| false),
            FolderPick::chosen(None)
        );
    }

    #[test]
    fn outcomes_say_what_ran() {
        assert!(exited(0, "x").succeeded());
        assert!(!exited(2, "x").succeeded());
        assert!(!Outcome::TimedOut.succeeded());
        assert!(Outcome::NotFound.not_found());
        assert_eq!(exited(0, "ab").stdout(), b"ab");
        assert_eq!(Outcome::Overflow.stdout(), b"");
    }
}
