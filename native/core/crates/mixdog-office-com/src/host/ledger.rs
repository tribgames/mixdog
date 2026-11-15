//! The host's record of the Office application it drives, kept on disk for as long as the host has something to clean up.
//!
//! A host that ends in the normal way closes its document and quits the application it owns (its EOF cleanup), so the
//! record is only for the hosts that cannot: one ended by `TerminateProcess`, a crash, a power cut. The application is
//! started by DCOM outside every job, so such a host leaves a hidden WINWORD, EXCEL or POWERPNT with the user's file open;
//! [`crate::sweep`] reads the records of dead hosts and ends what is still safe to end.
//!
//! One file per host, `<dataDir>/office/com-hosts/<hostPid>-<hostStartTicks>.json` (the data directory is the host's
//! `--data-dir` argument, see [`data_dir_from_args`]): the host's own identity is its name, so a reused pid is told from the
//! host. The file is rewritten whenever the identity it holds changes and deleted after a cleanup that succeeded.

use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use mixdog_fsio::WriteProof;
use serde_json::Value;
use serde_json::json;

use crate::identity::Ownership;
use crate::platform::Platform;

/// The argument that carries the data directory to a host: `--data-dir <path>`.
pub const DATA_DIR_FLAG: &str = "--data-dir";

/// The `mode` of a session whose application is hidden.
pub const BACKGROUND: &str = "background";

/// Where the records of every host live.
pub fn directory(data_dir: &Path) -> PathBuf {
    data_dir.join("office").join("com-hosts")
}

/// The data directory a host was started with: the argument after [`DATA_DIR_FLAG`].
pub fn data_dir_from_args(args: &[OsString]) -> Option<PathBuf> {
    let at = args.iter().position(|arg| arg == DATA_DIR_FLAG)?;
    args.get(at + 1).map(PathBuf::from)
}

/// `<hostPid>-<hostStartTicks>.json`.
pub fn file_name(host_pid: u32, host_start_ticks: i64) -> String {
    format!("{host_pid}-{host_start_ticks}.json")
}

/// The host a record name belongs to; `None` for a name this module did not write (a staging file included).
pub fn parse_file_name(name: &str) -> Option<(u32, i64)> {
    let stem = name.strip_suffix(".json")?;
    let (pid, ticks) = stem.split_once('-')?;
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(pid) || !digits(ticks) {
        return None;
    }
    Some((pid.parse().ok()?, ticks.parse().ok()?))
}

/// A process the host tracks besides its application (the Excel a PowerPoint chart starts), with the start time that
/// tells it from a process that took its pid later.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tracked {
    pub pid: i32,
    pub start_ticks: i64,
}

/// What a host knows of the application it drives.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Entry {
    /// `docx`, `xlsx` or `pptx`.
    pub format: String,
    /// `attach`, `visible` or `background`.
    pub mode: String,
    /// Whether the host started the application or found the user's.
    pub ownership: Option<Ownership>,
    pub owns_application: bool,
    /// The application's process id; 0 when there is none (never started, or already gone).
    pub app_pid: i32,
    pub app_start_ticks: i64,
    /// The Excel processes PowerPoint started for chart data and the host tracks.
    pub chart_excel: Vec<Tracked>,
}

impl Entry {
    /// Whether there is no process a sweep could have to end: nothing is worth keeping on disk.
    pub fn holds_no_process(&self) -> bool {
        self.app_pid <= 0 && self.chart_excel.is_empty()
    }

    fn to_json(&self) -> Value {
        let ownership = self.ownership.map(|ownership| match ownership {
            Ownership::Owned => "owned",
            Ownership::Attached => "attached",
        });
        let chart_excel: Vec<Value> =
            self.chart_excel.iter().map(|tracked| json!({"pid": tracked.pid, "startTicks": tracked.start_ticks})).collect();
        json!({
            "format": self.format,
            "mode": self.mode,
            "ownership": ownership,
            "ownsApplication": self.owns_application,
            "appPid": self.app_pid,
            "appStartTicks": self.app_start_ticks,
            "chartExcel": chart_excel,
        })
    }

    /// Reads a record; `None` when the bytes are not a JSON object. A field that is missing or of the wrong type reads as
    /// the value that protects most: not owned, no process.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        let object = value.as_object()?;
        let text = |key: &str| object.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let pid = |value: Option<&Value>| value.and_then(Value::as_i64).and_then(|pid| i32::try_from(pid).ok()).unwrap_or(0);
        let ticks = |value: Option<&Value>| value.and_then(Value::as_i64).unwrap_or(0);
        let ownership = match object.get("ownership").and_then(Value::as_str) {
            Some("owned") => Some(Ownership::Owned),
            Some("attached") => Some(Ownership::Attached),
            _ => None,
        };
        let chart_excel = object
            .get("chartExcel")
            .and_then(Value::as_array)
            .map(|tracked| {
                tracked
                    .iter()
                    .map(|item| Tracked { pid: pid(item.get("pid")), start_ticks: ticks(item.get("startTicks")) })
                    .filter(|tracked| tracked.pid > 0)
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            format: text("format"),
            mode: text("mode"),
            ownership,
            owns_application: object.get("ownsApplication").and_then(Value::as_bool).unwrap_or(false),
            app_pid: pid(object.get("appPid")),
            app_start_ticks: ticks(object.get("appStartTicks")),
            chart_excel,
        })
    }
}

/// One host's record file.
#[derive(Debug)]
pub struct Ledger {
    path: PathBuf,
    /// What the file holds now, `None` when it is not on disk (as far as this host knows).
    written: Option<Entry>,
}

impl Ledger {
    /// The record of host `host_pid`, which started at `host_start_ticks`.
    pub fn new(data_dir: &Path, host_pid: u32, host_start_ticks: i64) -> Self {
        Self { path: directory(data_dir).join(file_name(host_pid, host_start_ticks)), written: None }
    }

    /// The record of the calling process. A start time that cannot be read is 0, and the sweep then tells the host only
    /// by its pid: it never reaps for a pid that is alive.
    pub fn for_this_process(data_dir: &Path, platform: &dyn Platform) -> Self {
        let pid = std::process::id();
        let ticks = i32::try_from(pid).map_or(0, |pid| platform.process_start_ticks(pid));
        Self::new(data_dir, pid, ticks)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Makes the file say `entry`: written when it differs from what the file holds, removed when `entry` holds no process.
    /// The file is replaced whole (written aside, then renamed), so a reader never sees half of one.
    pub fn record<P: WriteProof>(&mut self, proof: &P, entry: &Entry) -> io::Result<()> {
        if entry.holds_no_process() {
            return self.remove(proof);
        }
        if self.written.as_ref() == Some(entry) {
            return Ok(());
        }
        if let Some(parent) = self.path.parent() {
            mixdog_fsio::create_dir_all(proof, parent)?;
        }
        let staging = self.path.with_extension("tmp");
        mixdog_fsio::write(proof, &staging, entry.to_json().to_string())?;
        if let Err(error) = mixdog_fsio::rename(proof, &staging, &self.path) {
            let _ = mixdog_fsio::remove_file(proof, &staging);
            return Err(error);
        }
        self.written = Some(entry.clone());
        Ok(())
    }

    /// The end of the host's cleanup: the file goes when the cleanup succeeded (`cleanup_ok`), and stays for the sweep when
    /// it did not.
    pub fn settle<P: WriteProof>(&mut self, proof: &P, cleanup_ok: bool) -> io::Result<()> {
        if cleanup_ok { self.remove(proof) } else { Ok(()) }
    }

    fn remove<P: WriteProof>(&mut self, proof: &P) -> io::Result<()> {
        self.written = None;
        match mixdog_fsio::remove_file(proof, &self.path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_is_named_for_its_host_and_only_such_a_name_is_read_back() {
        assert_eq!(file_name(4242, 638_000_000_000_000_000), "4242-638000000000000000.json");
        assert_eq!(parse_file_name("4242-638000000000000000.json"), Some((4242, 638_000_000_000_000_000)));
        for name in ["4242.json", "4242-5.tmp", "a-5.json", "4242-.json", "-5.json", "4242-5.json.bak", "4242--5.json", "4242-9999999999999999999999.json"] {
            assert_eq!(parse_file_name(name), None, "{name}");
        }
    }

    #[test]
    fn the_data_dir_is_the_argument_after_its_flag() {
        let args: Vec<OsString> = ["office-com-host", "--session", "--data-dir", "D:\\data"].iter().map(OsString::from).collect();
        assert_eq!(data_dir_from_args(&args), Some(PathBuf::from("D:\\data")));
        assert_eq!(data_dir_from_args(&args[..3]), None);
        assert_eq!(data_dir_from_args(&args[..2]), None);
    }

    #[test]
    fn an_entry_survives_its_own_json_and_a_damaged_one_reads_as_protectively_as_possible() {
        let entry = Entry {
            format: "pptx".into(),
            mode: BACKGROUND.into(),
            ownership: Some(Ownership::Owned),
            owns_application: true,
            app_pid: 77,
            app_start_ticks: 123,
            chart_excel: vec![Tracked { pid: 88, start_ticks: 456 }],
        };
        assert_eq!(Entry::parse(entry.to_json().to_string().as_bytes()), Some(entry));
        assert_eq!(Entry::parse(b"[1]"), None);
        assert_eq!(Entry::parse(b"{"), None);
        let bare = Entry::parse(b"{\"appPid\":\"x\",\"ownership\":7,\"chartExcel\":[{\"pid\":0}]}").expect("an object");
        assert_eq!(bare, Entry::default());
    }
}
