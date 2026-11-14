//! The ledger of no-activate holds: one line per bit this host added to
//! another application's window or took off again, replayed from a fresh
//! process to clear what a killed host left (MixWin32InactiveLedger.cs;
//! RecoverLedgers, backend/program.ts:40-73).

use super::native::{self, hwnd};
use crate::platform::Wid;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, SetWindowLongW, GWL_EXSTYLE};

pub(super) const WS_EX_NOACTIVATE: i32 = 0x0800_0000;

pub(super) fn ex_style(root: Wid) -> i32 {
    // SAFETY: plain value arguments.
    unsafe { GetWindowLongW(hwnd(root), GWL_EXSTYLE) }
}

pub(super) fn set_ex_style(root: Wid, style: i32) {
    // SAFETY: plain value arguments.
    unsafe { SetWindowLongW(hwnd(root), GWL_EXSTYLE, style) };
}

/// Whether the window accepts input (false for a gone window too).
pub(super) fn is_enabled(root: Wid) -> bool {
    // SAFETY: plain value argument.
    unsafe { IsWindowEnabled(hwnd(root)) }.as_bool()
}

pub(super) fn set_enabled(root: Wid, enabled: bool) {
    // SAFETY: plain value arguments.
    let _ = unsafe { EnableWindow(hwnd(root), enabled) };
}

/// The ledger's event kinds: the no-activate bit added or cleared, the
/// window disabled (shield) or enabled again.
const BIT_ADDED: char = '+';
const BIT_CLEARED: char = '-';
const SHIELD_ADDED: char = 'd';
const SHIELD_CLEARED: char = 'e';

/// The class as a ledger field: one tab-separated line holds it.
fn field(class: &str) -> String {
    class.replace(['\t', '\r', '\n'], " ")
}

/// Appends one event to the ledger at `path`, written through to the disk:
/// "+" or "-", the root (hex), its process id and its class (LedgerAppend).
fn append(path: &Path, added: bool, root: Wid, pid: u32, class: &str) -> std::io::Result<()> {
    append_kind(path, if added { BIT_ADDED } else { BIT_CLEARED }, root, pid, class)
}

fn append_kind(path: &Path, kind: char, root: Wid, pid: u32, class: &str) -> std::io::Result<()> {
    let line = format!("{kind}\t{root:x}\t{pid}\t{}\n", field(class));
    let mut file = std::fs::OpenOptions::new().append(true).create(true).open(path)?;
    file.write_all(line.as_bytes())?;
    file.sync_data()
}

/// Records that `root` gets the bit (before it is written) or lost it (after
/// it is cleared). False when the desktop gave no ledger or it cannot be
/// written: nothing could then clear a killed host's bit.
pub(super) fn record(added: bool, root: Wid) -> bool {
    crate::config::inactive_ledger().is_some_and(|path| {
        append(&path, added, root, native::pid_of(root), &native::class_name(root)).is_ok()
    })
}

/// Records that `root` is about to be disabled (before) or was enabled again
/// (after). False when it cannot be written: the window must then not be
/// disabled, since nothing could re-enable it after a kill.
pub(super) fn record_shield(disabled: bool, root: Wid) -> bool {
    let kind = if disabled { SHIELD_ADDED } else { SHIELD_CLEARED };
    crate::config::inactive_ledger().is_some_and(|path| {
        append_kind(&path, kind, root, native::pid_of(root), &native::class_name(root)).is_ok()
    })
}

/// The roots a ledger still records as held, each with the process id and
/// class written beside it.
fn recorded(text: &str) -> BTreeMap<Wid, (String, String)> {
    recorded_kinds(text, BIT_ADDED, BIT_CLEARED)
}

/// The roots a ledger still records as disabled by a shield.
fn recorded_shields(text: &str) -> BTreeMap<Wid, (String, String)> {
    recorded_kinds(text, SHIELD_ADDED, SHIELD_CLEARED)
}

fn recorded_kinds(text: &str, add: char, clear: char) -> BTreeMap<Wid, (String, String)> {
    let mut held = BTreeMap::new();
    for line in text.split('\n') {
        let fields: Vec<&str> = line.split('\t').collect();
        let [kind, root, pid, class] = fields[..] else {
            continue;
        };
        let Ok(root) = Wid::from_str_radix(root.trim(), 16) else {
            continue;
        };
        let mut chars = kind.chars();
        match (chars.next(), chars.next()) {
            (Some(k), None) if k == add => {
                held.insert(root, (pid.to_string(), class.to_string()));
            }
            (Some(k), None) if k == clear => {
                held.remove(&root);
            }
            _ => {}
        }
    }
    held
}

/// What a replay reads and writes of a recorded root; tests answer for it.
trait Roots {
    /// The process that owns the window, 0 when the window is gone.
    fn pid(&self, root: Wid) -> u32;
    fn class(&self, root: Wid) -> String;
    fn ex_style(&self, root: Wid) -> i32;
    fn set_ex_style(&self, root: Wid, style: i32);
    fn is_enabled(&self, root: Wid) -> bool;
    fn set_enabled(&self, root: Wid, enabled: bool);
}

struct Live;

impl Roots for Live {
    fn pid(&self, root: Wid) -> u32 {
        match native::pid_thread(root) {
            (_, 0) => 0,
            (pid, _) => pid,
        }
    }
    fn class(&self, root: Wid) -> String {
        native::class_name(root)
    }
    fn ex_style(&self, root: Wid) -> i32 {
        ex_style(root)
    }
    fn set_ex_style(&self, root: Wid, style: i32) {
        set_ex_style(root, style);
    }
    fn is_enabled(&self, root: Wid) -> bool {
        is_enabled(root)
    }
    fn set_enabled(&self, root: Wid, enabled: bool) {
        set_enabled(root, enabled);
    }
}

/// Clears the bit on every root `text` still records whose handle, process
/// id and class still match; a handle that went to another window is not
/// ours. False when a bit stayed set.
fn clear_recorded(text: &str, roots: &dyn Roots) -> bool {
    let mut clean = true;
    // A shielded window the killed host left disabled is enabled again.
    for (root, (pid, class)) in recorded_shields(text) {
        let owner = roots.pid(root);
        if owner == 0 || owner.to_string() != pid || field(&roots.class(root)) != class {
            continue;
        }
        if !roots.is_enabled(root) {
            roots.set_enabled(root, true);
            if !roots.is_enabled(root) {
                clean = false;
            }
        }
    }
    for (root, (pid, class)) in recorded(text) {
        let owner = roots.pid(root);
        if owner == 0 || owner.to_string() != pid || field(&roots.class(root)) != class {
            continue;
        }
        let style = roots.ex_style(root);
        if style & WS_EX_NOACTIVATE == 0 {
            continue;
        }
        roots.set_ex_style(root, style & !WS_EX_NOACTIVATE);
        if roots.ex_style(root) & WS_EX_NOACTIVATE != 0 {
            clean = false;
        }
    }
    clean
}

/// Replays one ledger and deletes it once nothing it records is still held;
/// a failed clear keeps it for the next replay. False when it was kept.
fn replay_file(path: &Path, roots: &dyn Roots) -> bool {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        // Never written, or a concurrent replay deleted it first.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    if !clear_recorded(&String::from_utf8_lossy(&bytes), roots) {
        return false;
    }
    let _ = std::fs::remove_file(path);
    true
}

/// After an elevated worker exited: replays the ledger it wrote of its own
/// holds and deletes it. What a replay could not clear is appended to this
/// host's ledger (`parent`), so this host's own abort cleanup replays it
/// again. False when the worker's records could be neither cleared nor
/// handed on: its ledger is then kept.
pub(super) fn adopt(worker: &Path) -> bool {
    adopt_with(worker, crate::config::inactive_ledger().as_deref(), &Live)
}

fn adopt_with(worker: &Path, parent: Option<&Path>, roots: &dyn Roots) -> bool {
    if replay_file(worker, roots) {
        return true;
    }
    let Ok(text) = std::fs::read(worker) else { return false };
    let handed = parent.is_some_and(|parent| {
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(parent)
            .and_then(|mut file| file.write_all(&text).and_then(|()| file.sync_data()))
            .is_ok()
    });
    if handed {
        let _ = std::fs::remove_file(worker);
    }
    handed
}

/// The ledgers an abort run is given: those of exited hosts
/// (MIXDOG_ABORT_LEDGERS, separated by '|', host/lifecycle-abort.ts:48) and
/// the stopped host's own.
fn paths() -> Vec<PathBuf> {
    let listed = std::env::var_os("MIXDOG_ABORT_LEDGERS").unwrap_or_default();
    listed
        .to_string_lossy()
        .split('|')
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .chain(crate::config::inactive_ledger())
        .collect()
}

/// Clears the no-activate bit on every root the ledgers still hold; every
/// ledger is replayed even when another fails.
pub fn replay() -> Result<(), String> {
    let kept = paths()
        .iter()
        .filter(|path| !replay_file(path, &Live))
        .count();
    if kept > 0 {
        return Err("inactive_ledger_unrecovered".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// Windows by handle: (pid, class, style); `stuck` roots keep their bit.
    #[derive(Default)]
    struct Fake {
        windows: RefCell<HashMap<Wid, (u32, String, i32)>>,
        stuck: Vec<Wid>,
        disabled: RefCell<Vec<Wid>>,
    }

    impl Fake {
        fn with(windows: &[(Wid, u32, &str, i32)]) -> Fake {
            Fake {
                windows: RefCell::new(
                    windows
                        .iter()
                        .map(|(root, pid, class, style)| (*root, (*pid, class.to_string(), *style)))
                        .collect(),
                ),
                stuck: Vec::new(),
                disabled: RefCell::new(Vec::new()),
            }
        }
        fn held(&self, root: Wid) -> bool {
            self.ex_style(root) & WS_EX_NOACTIVATE != 0
        }
    }

    impl Roots for Fake {
        fn pid(&self, root: Wid) -> u32 {
            self.windows.borrow().get(&root).map_or(0, |window| window.0)
        }
        fn class(&self, root: Wid) -> String {
            self.windows.borrow().get(&root).map(|window| window.1.clone()).unwrap_or_default()
        }
        fn ex_style(&self, root: Wid) -> i32 {
            self.windows.borrow().get(&root).map_or(0, |window| window.2)
        }
        fn set_ex_style(&self, root: Wid, style: i32) {
            if self.stuck.contains(&root) {
                return;
            }
            if let Some(window) = self.windows.borrow_mut().get_mut(&root) {
                window.2 = style;
            }
        }
        fn is_enabled(&self, root: Wid) -> bool {
            !self.disabled.borrow().contains(&root)
        }
        fn set_enabled(&self, root: Wid, enabled: bool) {
            if enabled && !self.stuck.contains(&root) {
                self.disabled.borrow_mut().retain(|r| *r != root);
            }
        }
    }

    fn ledger(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("mixdog-ledger-{}-{name}.txt", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn a_ledger_records_the_roots_still_held() {
        let text = "+\t1a2b\t10\tNotepad\n+\tff\t11\tEdit\n-\t1a2b\t10\tNotepad\n\
                    +\tzz\t1\tBad handle\n+\t5\t12\n?\t6\t13\tOther\n+\t7\t14\tMy  class\n";
        let held = recorded(text);
        assert_eq!(
            held.into_iter().collect::<Vec<_>>(),
            [
                (0x7, ("14".to_string(), "My  class".to_string())),
                (0xff, ("11".to_string(), "Edit".to_string())),
            ]
        );
        assert!(recorded("").is_empty());
    }

    #[test]
    fn appended_events_read_back_and_a_class_stays_one_field() {
        let path = ledger("append");
        append(&path, true, 0x2a, 77, "Odd\tclass\r\nname").unwrap();
        append(&path, true, 0x2b, 78, "Edit").unwrap();
        append(&path, false, 0x2b, 78, "Edit").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "+\t2a\t77\tOdd class  name\n+\t2b\t78\tEdit\n-\t2b\t78\tEdit\n");
        assert_eq!(
            recorded(&text).into_iter().collect::<Vec<_>>(),
            [(0x2a, ("77".to_string(), "Odd class  name".to_string()))]
        );
        std::fs::remove_file(&path).unwrap();
        // A ledger whose folder is missing cannot be written.
        assert!(append(&path.join("missing").join("ledger.txt"), true, 1, 1, "x").is_err());
    }

    #[test]
    fn a_replay_clears_only_roots_whose_process_and_class_still_match() {
        let bit = WS_EX_NOACTIVATE;
        let roots = Fake::with(&[
            (1, 10, "Notepad", bit | 0x100),
            // The handle went to another process, or to another class.
            (2, 99, "Notepad", bit),
            (3, 10, "Other", bit),
            // Released before the host died.
            (4, 10, "Notepad", bit),
            // Recorded, but the bit was never written.
            (5, 10, "Notepad", 0x100),
            (7, 10, "Odd\tclass", bit),
        ]);
        let text = "+\t1\t10\tNotepad\n+\t2\t10\tNotepad\n+\t3\t10\tNotepad\n+\t4\t10\tNotepad\n\
                    -\t4\t10\tNotepad\n+\t5\t10\tNotepad\n+\t6\t10\tGone\n+\t7\t10\tOdd class\n";
        assert!(clear_recorded(text, &roots));
        assert_eq!(roots.ex_style(1), 0x100, "only the bit is cleared");
        assert!(roots.held(2) && roots.held(3) && roots.held(4));
        assert_eq!(roots.ex_style(5), 0x100);
        assert!(!roots.held(7), "the class is compared as it was written");
    }

    #[test]
    fn a_replayed_ledger_is_deleted_unless_a_bit_stayed_set() {
        let path = ledger("replay");
        assert!(replay_file(&path, &Fake::default()), "a ledger never written is clean");
        append(&path, true, 1, 10, "Notepad").unwrap();
        let mut roots = Fake::with(&[(1, 10, "Notepad", WS_EX_NOACTIVATE)]);
        roots.stuck.push(1);
        assert!(!replay_file(&path, &roots));
        assert!(path.exists(), "a failed clear keeps the ledger");
        roots.stuck.clear();
        assert!(replay_file(&path, &roots));
        assert!(!roots.held(1));
        assert!(!path.exists());
    }

    #[test]
    fn a_replay_enables_shielded_windows_that_still_match() {
        let roots = Fake::with(&[
            (1, 10, "Settings", 0),
            (2, 99, "Settings", 0),
            (3, 10, "Settings", 0),
            (4, 10, "Settings", 0),
        ]);
        roots.disabled.borrow_mut().extend([1, 2, 3, 4]);
        let text = "d\t1\t10\tSettings\nd\t2\t10\tSettings\nd\t3\t10\tSettings\n\
                    e\t3\t10\tSettings\nd\t4\t10\tSettings\n+\t4\t10\tSettings\n";
        assert!(clear_recorded(text, &roots));
        assert!(roots.is_enabled(1), "a recorded shield is lifted");
        assert!(!roots.is_enabled(2), "a handle of another process is not ours");
        assert!(!roots.is_enabled(3), "a lifted shield is not touched again");
        assert!(roots.is_enabled(4));
        let mut stuck = Fake::with(&[(1, 10, "Settings", 0)]);
        stuck.stuck.push(1);
        stuck.disabled.borrow_mut().push(1);
        assert!(!clear_recorded("d\t1\t10\tSettings\n", &stuck));
    }

    #[test]
    fn a_worker_ledger_is_replayed_and_what_stays_held_is_handed_to_the_parent() {
        let (worker, parent) = (ledger("worker"), ledger("parent"));
        assert!(adopt_with(&worker, Some(&parent), &Fake::default()), "no worker ledger is clean");
        append(&worker, true, 1, 10, "Notepad").unwrap();
        let roots = Fake::with(&[(1, 10, "Notepad", WS_EX_NOACTIVATE)]);
        assert!(adopt_with(&worker, Some(&parent), &roots));
        assert!(!roots.held(1) && !worker.exists() && !parent.exists());
        append(&worker, true, 1, 10, "Notepad").unwrap();
        let mut stuck = Fake::with(&[(1, 10, "Notepad", WS_EX_NOACTIVATE)]);
        stuck.stuck.push(1);
        assert!(!adopt_with(&worker, None, &stuck), "with no parent ledger the worker's is kept");
        assert!(worker.exists());
        assert!(adopt_with(&worker, Some(&parent), &stuck));
        assert!(!worker.exists());
        assert_eq!(recorded(&std::fs::read_to_string(&parent).unwrap()).keys().copied().collect::<Vec<_>>(), [1]);
        std::fs::remove_file(&parent).unwrap();
    }

    #[test]
    fn shield_events_do_not_read_as_no_activate_holds() {
        let text = "d\t1\t10\tA\n+\t2\t10\tB\n";
        assert_eq!(recorded(text).keys().copied().collect::<Vec<_>>(), [2]);
        assert_eq!(recorded_shields(text).keys().copied().collect::<Vec<_>>(), [1]);
    }
}
