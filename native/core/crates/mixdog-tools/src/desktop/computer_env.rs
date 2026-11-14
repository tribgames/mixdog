//! The environment a helper run starts with (`spawnHostWorker`, `backend/host-worker-process.ts`): the action lists and limits the
//! helper shares with the core (`native/mixdog-computer/src/config.rs`), the input marker, and the recovery inputs (the inactive-window
//! ledger and the desktop's foreground lock).

use std::path::Path;
use std::path::PathBuf;

use mixdog_app_protocol::v2::host::HostComputerDisplay;

/// Helper actions that only read (`computerActionsWith('nativeRead')`). `list_apps` is the helper's own answer to
/// `list kind="apps"`, which reads as `list_installed_apps` did.
const READ_ACTIONS: [&str; 20] = [
    "list_windows",
    "window_snapshot",
    "related_windows",
    "snapshot",
    "find",
    "clipboard_read",
    "wait",
    "window_bounds",
    "window_capture",
    "validate_background_input",
    "window_predicates",
    "accessibility_probe",
    "window_integrity",
    "input_recovery_state",
    "input_idle_state",
    "ocr_image",
    "ocr_status",
    "process_fate",
    "list_installed_apps",
    "list_apps",
];
/// Helper actions that keep the session's element refs (`retainNativeRefs`): the reads plus
/// the ones that hand input back (these, never sent read-only: `computer_policy::decorate`).
pub(super) const RETAIN_REF_ACTIONS: [&str; 5] =
    ["release_session", "release_cursor_theme", "release_held_input", "release_sequence_holds", "restore_input_state"];

/// What one helper run's environment is made from.
pub(super) struct EnvInputs {
    pub(super) sequence_settle_ms: u64,
    pub(super) max_foreground_text: usize,
    /// The backend's input marker, the same for every run of its helper.
    pub(super) marker: u32,
    /// Where the helper records the windows it holds inactive; `None` keeps no ledger.
    pub(super) ledger_path: Option<PathBuf>,
    /// The desktop can own a foreground lease for the helper (`computer_lease::owner_available`).
    pub(super) host_lock_offered: bool,
    /// The `MIXDOG_ABORT_*` variables of an `--abort-cleanup` run (`computer_abort::env`); none for the resident helper.
    pub(super) abort: Vec<(String, String)>,
}

/// The variables a helper run is started with.
pub(super) fn helper_env(inputs: &EnvInputs) -> Vec<(String, String)> {
    let mut set = vec![
        ("MIXDOG_COMPUTER_READ_ACTIONS".to_owned(), READ_ACTIONS.join(",")),
        (
            "MIXDOG_COMPUTER_RETAIN_REF_ACTIONS".to_owned(),
            READ_ACTIONS.iter().chain(RETAIN_REF_ACTIONS.iter()).copied().collect::<Vec<_>>().join(","),
        ),
        ("MIXDOG_COMPUTER_SEQUENCE_SETTLE_MS".to_owned(), inputs.sequence_settle_ms.to_string()),
        ("MIXDOG_COMPUTER_MAX_FOREGROUND_TEXT".to_owned(), inputs.max_foreground_text.to_string()),
        ("MIXDOG_COMPUTER_INPUT_MARKER".to_owned(), inputs.marker.to_string()),
    ];
    if let Some(path) = &inputs.ledger_path {
        set.push(("MIXDOG_COMPUTER_INACTIVE_LEDGER".to_owned(), path.to_string_lossy().into_owned()));
    }
    // `MixForegroundLock.cs:349-353` reads exactly "1".
    if inputs.host_lock_offered {
        set.push(("MIXDOG_COMPUTER_HOST_FOREGROUND_LOCK".to_owned(), "1".to_owned()));
    }
    set.extend(inputs.abort.iter().cloned());
    set
}

/// `MIXDOG_COMPUTER_DESKTOP_BOUNDS` (`desktopBoundsEnvironment`, `host/powershell-host.ts`): the union of every display in native
/// coordinates, `left,top,width,height`, which the Wayland input device spans when the compositor cannot report its outputs
/// (`platform/linux/wayland.rs`). Each display's rectangle is its origin and its size in physical pixels (the size the host reports
/// times the scale, as `nativeDisplayGeometry`). `None` without a display: the helper then has no bounds to be told.
pub(super) fn desktop_bounds_env(displays: &[HostComputerDisplay]) -> Option<(String, String)> {
    let area = |display: &HostComputerDisplay| {
        let physical = |edge: u32| (f64::from(edge) * display.scale_factor).round() as i64;
        let (x, y) = (i64::from(display.x), i64::from(display.y));
        (x, y, x + physical(display.width), y + physical(display.height))
    };
    let areas: Vec<(i64, i64, i64, i64)> = displays.iter().map(area).collect();
    let left = areas.iter().map(|area| area.0).min()?;
    let top = areas.iter().map(|area| area.1).min()?;
    let right = areas.iter().map(|area| area.2).max()?;
    let bottom = areas.iter().map(|area| area.3).max()?;
    Some(("MIXDOG_COMPUTER_DESKTOP_BOUNDS".to_owned(), format!("{left},{top},{},{}", right - left, bottom - top)))
}

/// A fresh input marker in `1..=i32::MAX`, the helper's range (`config.rs` `input_marker`), from the OS random source behind
/// `uuid` v4 (its last 32 bits are all random).
pub(super) fn new_marker() -> u32 {
    loop {
        let marker = (uuid::Uuid::new_v4().as_u128() as u32) & 0x7fff_ffff;
        if marker != 0 {
            return marker;
        }
    }
}

/// `<data>/computer/ledgers`, the folder that holds every helper run's ledger.
pub(super) fn ledger_folder(data_dir: &Path) -> PathBuf {
    data_dir.join("computer").join("ledgers")
}

/// `<data>/computer/ledgers/<session>-<marker>.ledger`. The session id keeps only `[A-Za-z0-9_-]`, so it never leaves the folder.
pub(super) fn ledger_path(data_dir: &Path, session: &str, marker: u32) -> PathBuf {
    let name: String = session.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    ledger_folder(data_dir).join(format!("{name}-{marker}.ledger"))
}

/// The ledgers in `folder`, with the input marker their name carries (`<session>-<marker>.ledger`), in name order.
pub(super) fn leftover_ledgers(folder: &Path) -> Vec<(PathBuf, Option<u32>)> {
    let Ok(entries) = std::fs::read_dir(folder) else { return Vec::new() };
    let mut found: Vec<(PathBuf, Option<u32>)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_name()?.to_str()?.strip_suffix(".ledger")?.to_owned();
            let marker = stem.rsplit_once('-').and_then(|(_, tail)| tail.parse::<u32>().ok()).filter(|marker| (1..=i32::MAX as u32).contains(marker));
            path.is_file().then_some((path, marker))
        })
        .collect();
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> EnvInputs {
        EnvInputs {
            sequence_settle_ms: 350,
            max_foreground_text: 4_000,
            marker: 77,
            ledger_path: Some(PathBuf::from("/data/computer/ledgers/s1-77.ledger")),
            host_lock_offered: true,
            abort: Vec::new(),
        }
    }

    fn value<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
        env.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// The marker, the ledger and (when the desktop offers its lock) the foreground lock go on every run; without them neither is sent.
    #[test]
    fn the_marker_the_ledger_and_the_offered_lock_are_sent() {
        let env = helper_env(&inputs());
        assert_eq!(value(&env, "MIXDOG_COMPUTER_INPUT_MARKER"), Some("77"));
        assert_eq!(value(&env, "MIXDOG_COMPUTER_SEQUENCE_SETTLE_MS"), Some("350"));
        assert_eq!(value(&env, "MIXDOG_COMPUTER_MAX_FOREGROUND_TEXT"), Some("4000"));
        assert!(value(&env, "MIXDOG_COMPUTER_READ_ACTIONS").is_some_and(|reads| reads.split(',').any(|action| action == "list_apps")));
        assert_eq!(value(&env, "MIXDOG_COMPUTER_INACTIVE_LEDGER"), Some("/data/computer/ledgers/s1-77.ledger"));
        assert_eq!(value(&env, "MIXDOG_COMPUTER_HOST_FOREGROUND_LOCK"), Some("1"));
        let bare = helper_env(&EnvInputs { ledger_path: None, host_lock_offered: false, ..inputs() });
        assert!(value(&bare, "MIXDOG_COMPUTER_INACTIVE_LEDGER").is_none() && value(&bare, "MIXDOG_COMPUTER_HOST_FOREGROUND_LOCK").is_none());
    }

    /// An `--abort-cleanup` run carries its recovery variables after the shared ones.
    #[test]
    fn an_abort_run_carries_its_recovery_variables() {
        let abort = vec![("MIXDOG_ABORT_TARGET".to_owned(), "hwnd:0x10".to_owned())];
        let env = helper_env(&EnvInputs { abort: abort.clone(), ..inputs() });
        assert_eq!(env.last(), abort.last());
        assert_eq!(value(&env, "MIXDOG_COMPUTER_INPUT_MARKER"), Some("77"));
        assert_eq!(value(&env, "MIXDOG_COMPUTER_INACTIVE_LEDGER"), Some("/data/computer/ledgers/s1-77.ledger"));
    }

    #[test]
    fn leftover_ledgers_are_the_ledger_files_with_their_markers() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a-5.ledger", "b_c-x.ledger", "notes.txt", "z-0.ledger"] {
            std::fs::write(dir.path().join(name), b"").unwrap();
        }
        std::fs::create_dir(dir.path().join("d-3.ledger")).unwrap();
        let found: Vec<(String, Option<u32>)> =
            leftover_ledgers(dir.path()).into_iter().map(|(path, marker)| (path.file_name().unwrap().to_string_lossy().into_owned(), marker)).collect();
        assert_eq!(found, [("a-5.ledger".to_owned(), Some(5)), ("b_c-x.ledger".to_owned(), None), ("z-0.ledger".to_owned(), None)]);
        assert!(leftover_ledgers(&dir.path().join("missing")).is_empty());
    }

    fn display(index: u32, x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> HostComputerDisplay {
        HostComputerDisplay { index, id: index.to_string(), primary: index == 0, scale_factor, width, height, x, y, label: None }
    }

    /// The union of the displays' native rectangles: a second display to the left and above widens it both ways, and a scaled display
    /// counts in physical pixels.
    #[test]
    fn the_bounds_are_the_union_of_the_displays_in_native_pixels() {
        let one = [display(0, 0, 0, 1920, 1080, 1.0)];
        assert_eq!(desktop_bounds_env(&one), Some(("MIXDOG_COMPUTER_DESKTOP_BOUNDS".to_owned(), "0,0,1920,1080".to_owned())));
        let two = [display(0, 0, 0, 1280, 720, 1.5), display(1, -1920, -200, 1920, 1080, 1.0)];
        assert_eq!(desktop_bounds_env(&two).map(|(_, bounds)| bounds), Some("-1920,-200,3840,1280".to_owned()));
        assert_eq!(desktop_bounds_env(&[]), None);
    }

    #[test]
    fn markers_are_in_the_helpers_range() {
        for _ in 0..1_000 {
            let marker = new_marker();
            assert!((1..=i32::MAX as u32).contains(&marker), "{marker}");
        }
    }

    #[test]
    fn a_ledger_is_named_by_session_and_marker_inside_the_data_folder() {
        let data = Path::new("/data");
        assert_eq!(ledger_path(data, "thr_1-a", 9), data.join("computer").join("ledgers").join("thr_1-a-9.ledger"));
        assert_eq!(ledger_path(data, "../x/y", 9), data.join("computer").join("ledgers").join("___x_y-9.ledger"));
    }
}
