//! `mixdog-relay renderer-releases --action=prepare` (`deploy/renderer-releases.mjs`): the maintenance of the side-by-side
//! renderer registry (see [`crate::web::releases`]) a deploy runs. It works on the STAGED install tree, never the live one, so a
//! failure is a failure before the swap and the release transaction's rollback guarantees apply unchanged.
//!
//! ```text
//! mixdog-relay renderer-releases --action=prepare \
//!   --releases=<NEXT>/renderer-releases   registry dir (pre-populated with hardlinks of the installed one)
//!   --renderer=<NEXT>/renderer            the renderer this deploy installs
//!   --desktop-version=1.2.3               desktop build the renderer belongs to ('' = relay-only deploy)
//!   [--legacy=<installed>/renderer]       adopted as the `legacy` release when no registry exists yet
//!   [--devices=<DATA_DIR>/devices.json]   devices whose reported version pins a release against GC
//! ```
//!
//! It prints one JSON line: `{ releaseId, added, legacy, kept, dropped }`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use mixdog_fsio::Unlaned;
use mixdog_js::JsonSyntaxError;
use serde_json::{Value, json};

use crate::js;
use crate::rate_limit::now_ms;
use crate::web::releases::{
    DeviceReport, DeviceSeen, LEGACY_RELEASE_ID, RELEASE_INDEX_FILE, ReleaseEntry, ReleaseIndex, ReleaseIndexError,
    RetentionOptions, is_desktop_version,
};

/// Why a deploy step failed; the messages are the ones the Node tool prints.
#[derive(Debug, thiserror::Error)]
pub enum ReleasesToolError {
    #[error("{0}")]
    Message(String),
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Index(#[from] ReleaseIndexError),
    #[error("{0}")]
    Json(#[from] JsonSyntaxError),
}

fn message(text: impl Into<String>) -> ReleasesToolError {
    ReleasesToolError::Message(text.into())
}

/// What [`prepare_releases`] works on.
#[derive(Debug, Clone)]
pub struct PrepareOptions {
    pub releases_dir: PathBuf,
    pub renderer_dir: PathBuf,
    /// Empty for a relay-only deploy: nothing is registered, the registry is only collected.
    pub desktop_version: String,
    /// Adopted as the legacy release when there is no registry yet.
    pub legacy_dir: Option<PathBuf>,
    pub devices: Vec<DeviceSeen>,
    /// `Date.now()`, milliseconds since the epoch.
    pub now: f64,
}

/// The one JSON line the tool prints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrepareOutcome {
    pub release_id: String,
    pub added: bool,
    pub legacy: String,
    pub kept: Vec<String>,
    pub dropped: Vec<String>,
}

impl PrepareOutcome {
    pub fn to_json(&self) -> Value {
        json!({
            "releaseId": self.release_id,
            "added": self.added,
            "legacy": self.legacy,
            "kept": self.kept,
            "dropped": self.dropped,
        })
    }
}

/// `rmSync(path, { recursive: true, force: true })`: a link is removed, never entered.
fn remove_all(path: &Path) -> io::Result<()> {
    let metadata = match mixdog_fsio::symlink_metadata(&Unlaned, path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let removed = if metadata.is_dir() {
        mixdog_fsio::remove_dir_all(&Unlaned, path)
    } else {
        // A directory link on Windows is removed as a directory.
        mixdog_fsio::remove_file(&Unlaned, path).or_else(|first| mixdog_fsio::remove_dir(&Unlaned, path).map_err(|_| first))
    };
    match removed {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// `linkTree`: hardlink a whole tree (copy across filesystems), so a retained release costs no extra disk and the installed
/// tree it came from is never touched. An entry that is neither a file nor a directory is refused.
pub fn link_tree(source: &Path, destination: &Path) -> Result<(), ReleasesToolError> {
    mixdog_fsio::create_dir_all(&Unlaned, destination)?;
    for entry in mixdog_fsio::read_dir(&Unlaned, source)? {
        let entry = entry?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let kind = entry.file_type(&Unlaned)?;
        if kind.is_dir() {
            link_tree(&from, &to)?;
        } else if kind.is_file() {
            match mixdog_fsio::hard_link(&Unlaned, &from, &to) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
                    mixdog_fsio::copy(&Unlaned, &from, &to)?;
                }
                Err(error) => return Err(error.into()),
            }
        } else {
            return Err(message(format!("Renderer tree contains an unsupported entry: {}", from.display())));
        }
    }
    Ok(())
}

/// `/<meta name="mixdog-shell-version" content="([a-f0-9]{64})">/`: the first match in `document`.
fn find_shell_version(document: &str) -> Option<&str> {
    const OPEN: &str = "<meta name=\"mixdog-shell-version\" content=\"";
    document.match_indices(OPEN).find_map(|(at, _)| {
        let start = at + OPEN.len();
        let value = document.get(start..start + 64)?;
        let hex = value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        (hex && document[start + 64..].starts_with("\">")).then_some(value)
    })
}

/// The `mixdog-shell-version` a staged renderer's `index.html` declares.
fn renderer_shell_version(renderer_dir: &Path) -> Result<String, ReleasesToolError> {
    let bytes = mixdog_fsio::read(&Unlaned, renderer_dir.join("index.html"))?;
    find_shell_version(&js::decode_utf8(&bytes)).map(str::to_owned).ok_or_else(|| message("renderer release metadata missing"))
}

/// `releaseIdFor`: `<desktop version>-<first 12 hex of the shell version>`, unique per renderer build, yet readable and stable
/// for a redeploy of the same build.
pub fn release_id_for(desktop_version: &str, shell_version: &str) -> String {
    format!("{desktop_version}-{}", &shell_version[..shell_version.len().min(12)])
}

/// `readReportingDevices`: the devices of `devices.json` that reported a build, as retention input. No path, or no such file,
/// is no devices.
pub fn read_reporting_devices(devices_path: Option<&Path>) -> Result<Vec<DeviceSeen>, ReleasesToolError> {
    let Some(path) = devices_path.filter(|path| !path.as_os_str().is_empty()) else { return Ok(Vec::new()) };
    if !mixdog_fsio::exists(&Unlaned, path).unwrap_or(false) {
        return Ok(Vec::new());
    }
    let document = js::parse_bytes(&mixdog_fsio::read(&Unlaned, path)?)?;
    let rows: Vec<&Value> = match &document {
        Value::Object(map) => map.values().collect(),
        Value::Array(list) => list.iter().collect(),
        _ => Vec::new(),
    };
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let app_version = row.get("appVersion")?.as_str()?;
            let seen_at = row.get("versionSeenAt")?.as_f64().filter(|seen| seen.is_finite())?;
            let renderer_release = row.get("rendererRelease").and_then(Value::as_str).unwrap_or_default();
            Some(DeviceSeen {
                report: DeviceReport { app_version: app_version.to_owned(), renderer_release: renderer_release.to_owned() },
                seen_at,
            })
        })
        .collect())
}

/// `writeIndexAtomic`: a temporary file of the same directory, then renamed over `index.json`, mode 0644.
fn write_index_atomic(releases_dir: &Path, index: &ReleaseIndex) -> Result<(), ReleasesToolError> {
    let path = releases_dir.join(RELEASE_INDEX_FILE);
    let temporary = releases_dir.join(format!("{RELEASE_INDEX_FILE}.{}.tmp", std::process::id()));
    let mut options = mixdog_fsio::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o644);
    let mut file = options.open(&Unlaned, &temporary)?;
    file.write_all(format!("{}\n", js::pretty(&index.to_json())).as_bytes())?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        mixdog_fsio::set_permissions(&Unlaned, &temporary, std::fs::Permissions::from_mode(0o644))?;
    }
    mixdog_fsio::rename(&Unlaned, &temporary, &path)?;
    Ok(())
}

/// `prepareReleases`: register, adopt and collect inside the releases directory.
pub fn prepare_releases(options: &PrepareOptions) -> Result<PrepareOutcome, ReleasesToolError> {
    let releases_dir = std::path::absolute(&options.releases_dir)?;
    mixdog_fsio::create_dir_all(&Unlaned, &releases_dir)?;
    let mut index = ReleaseIndex::read(&releases_dir)?.unwrap_or_default();
    // First run on a relay that predates side-by-side releases: the renderer it is serving right now becomes the fallback for
    // every desktop that never reports a version.
    if index.releases.is_empty()
        && let Some(legacy_dir) = &options.legacy_dir
        && mixdog_fsio::exists(&Unlaned, legacy_dir.join("index.html")).unwrap_or(false)
    {
        link_tree(legacy_dir, &releases_dir.join(LEGACY_RELEASE_ID))?;
        index = index.with_release(ReleaseEntry {
            id: LEGACY_RELEASE_ID.to_owned(),
            desktop_version: String::new(),
            shell_version: renderer_shell_version(legacy_dir)?,
            added_at: options.now,
            legacy: true,
        })?;
    }
    let mut release_id = String::new();
    let mut added = false;
    if !options.desktop_version.is_empty() {
        if !is_desktop_version(&options.desktop_version) {
            return Err(message("desktop version is invalid"));
        }
        let shell_version = renderer_shell_version(&options.renderer_dir)?;
        release_id = release_id_for(&options.desktop_version, &shell_version);
        let target = releases_dir.join(&release_id);
        if !index.releases.iter().any(|entry| entry.id == release_id) {
            remove_all(&target)?;
            link_tree(&options.renderer_dir, &target)?;
            index = index.with_release(ReleaseEntry {
                id: release_id.clone(),
                desktop_version: options.desktop_version.clone(),
                shell_version,
                added_at: options.now,
                legacy: false,
            })?;
            added = true;
        }
    }
    let plan = index.plan_retention(&options.devices, &RetentionOptions::at(options.now));
    for id in &plan.drop {
        remove_all(&releases_dir.join(id))?;
    }
    index = ReleaseIndex::new(index.releases.into_iter().filter(|entry| plan.keep.contains(&entry.id)).collect())?;
    // Anything on disk the registry does not name (an interrupted earlier run) is not servable and not verifiable: collect it
    // with the rest.
    for entry in mixdog_fsio::read_dir(&Unlaned, &releases_dir)? {
        let entry = entry?;
        let named = index.releases.iter().any(|release| OsStr::new(&release.id) == entry.file_name());
        if !named && entry.file_type(&Unlaned)?.is_dir() {
            remove_all(&entry.path())?;
        }
    }
    write_index_atomic(&releases_dir, &index)?;
    Ok(PrepareOutcome {
        release_id,
        added,
        legacy: index.releases.iter().find(|entry| entry.legacy).map(|entry| entry.id.clone()).unwrap_or_default(),
        kept: plan.keep,
        dropped: plan.drop,
    })
}

/// `parseArgs`: every argument is `--name=value`; a later one of the same name wins.
fn parse_args(args: &[String]) -> Result<HashMap<&str, &str>, ReleasesToolError> {
    args.iter()
        .map(|arg| {
            arg.strip_prefix("--")
                .and_then(|rest| rest.split_once('='))
                .filter(|(name, _)| !name.is_empty())
                .ok_or_else(|| message(format!("Invalid argument: {arg}")))
        })
        .collect()
}

fn required<'a>(args: &HashMap<&str, &'a str>, name: &str) -> Result<&'a str, ReleasesToolError> {
    args.get(name).copied().ok_or_else(|| message(format!("The --{name} argument is required")))
}

/// The tool's work for `args`: the line it prints.
pub fn run(args: &[String]) -> Result<String, ReleasesToolError> {
    let args = parse_args(args)?;
    let action = args.get("action").copied().filter(|action| !action.is_empty()).unwrap_or("(missing)");
    if action != "prepare" {
        return Err(message(format!("Unknown renderer-releases action: {action}")));
    }
    let devices = read_reporting_devices(args.get("devices").copied().map(Path::new))?;
    let renderer_dir = std::path::absolute(required(&args, "renderer")?)?;
    let releases_dir = PathBuf::from(required(&args, "releases")?);
    let legacy_dir = match args.get("legacy").copied().filter(|legacy| !legacy.is_empty()) {
        Some(legacy) => Some(std::path::absolute(legacy)?),
        None => None,
    };
    let outcome = prepare_releases(&PrepareOptions {
        releases_dir,
        renderer_dir,
        desktop_version: args.get("desktop-version").copied().unwrap_or_default().to_owned(),
        legacy_dir,
        devices,
        now: now_ms() as f64,
    })?;
    Ok(js::wire(&outcome.to_json()))
}

/// The `renderer-releases` subcommand.
pub fn main(args: &[String]) -> ExitCode {
    match run(args) {
        Ok(line) => {
            let mut stdout = io::stdout().lock();
            if writeln!(stdout, "{line}").and_then(|()| stdout.flush()).is_err() {
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("[deploy] renderer releases failed: {error}");
            ExitCode::FAILURE
        }
    }
}
