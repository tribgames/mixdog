//! Side-by-side renderer releases (`lib/renderer-releases.mjs`). Each desktop build ships its own web renderer; the relay
//! keeps several and serves a phone or a second PC the one that matches the desktop version of the main PC it is paired
//! with.
//!
//! Layout of the releases directory (`RENDERER_RELEASES_DIR`, by default `renderer-releases` beside `RENDERER_DIR`):
//! `index.json` is the registry below (written atomically by the deploy tool) and `<releaseId>/` is one complete staged
//! renderer tree per release.
//!
//! Selection rule ([`ReleaseIndex::select`]): choose the exact desktop version, preferring its exact shell hash. An
//! adopted shell without version metadata can be identified by its exact hash unless a known version contradicts it.
//! Only a desktop that reports neither identifier gets the legacy/default fallback.
//!
//! Retention rule ([`ReleaseIndex::plan_retention`]): the legacy release is never collected; the newest
//! [`KEEP_LATEST_RELEASES`] releases are kept; any release still selected for a device seen within
//! [`DEVICE_REFERENCE_WINDOW_MS`] is kept too, newest first, until [`MAX_RETAINED_RELEASES`] releases (without legacy) are
//! retained.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_fsio::Unlaned;
use mixdog_js::JsonSyntaxError;
use serde_json::{Value, json};

use crate::js;
use crate::rate_limit::now_ms;

pub const LEGACY_RELEASE_ID: &str = "legacy";
pub const RELEASE_INDEX_FILE: &str = "index.json";
pub const KEEP_LATEST_RELEASES: usize = 3;
pub const MAX_RETAINED_RELEASES: usize = 6;
pub const DEVICE_REFERENCE_WINDOW_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;
/// How long a read of the registry is reused by [`RendererCatalog`].
pub const CATALOG_CACHE_MS: i64 = 1000;

/// `Date.now()` as the code that reads it is handed it: a test moves it by hand.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The clock of the process (the replay's clock when one runs it).
pub fn system_clock() -> Clock {
    Arc::new(now_ms)
}

/// `^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`
pub fn is_release_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

/// `^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$`
pub fn is_desktop_version(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'_' | b'-'))
}

/// `^[a-f0-9]{64}$`
pub fn is_shell_version(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$`: the three numbers of a version, a pre-release or build suffix ignored.
fn parse_version(value: &str) -> Option<[f64; 3]> {
    let mut rest = value;
    let mut numbers = [0.0; 3];
    for (position, number) in numbers.iter_mut().enumerate() {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        *number = rest[..digits].parse::<f64>().ok()?;
        rest = &rest[digits..];
        if position < 2 {
            rest = rest.strip_prefix('.')?;
        }
    }
    let suffix_ok = match rest.chars().next() {
        None => true,
        // `.` stops at every line terminator.
        Some('-' | '+') => !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']),
        Some(_) => false,
    };
    suffix_ok.then_some(numbers)
}

fn compare_versions(left: &[f64; 3], right: &[f64; 3]) -> Ordering {
    for (a, b) in left.iter().zip(right) {
        if a != b {
            return a.partial_cmp(b).unwrap_or(Ordering::Equal);
        }
    }
    Ordering::Equal
}

/// Why a registry cannot be used; the messages are the ones the Node code throws.
#[derive(Debug, thiserror::Error)]
pub enum ReleaseIndexError {
    #[error("{0}")]
    Invalid(&'static str),
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Json(#[from] JsonSyntaxError),
}

/// One release of the registry.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseEntry {
    pub id: String,
    /// Empty only for the legacy release.
    pub desktop_version: String,
    /// The `mixdog-shell-version` of the release's `index.html`; empty when the entry does not say.
    pub shell_version: String,
    /// Milliseconds since the epoch (a JavaScript number).
    pub added_at: f64,
    pub legacy: bool,
}

impl ReleaseEntry {
    /// The entry as `index.json` holds it.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "desktopVersion": self.desktop_version,
            "shellVersion": self.shell_version,
            "addedAt": mixdog_js::json_number(self.added_at),
            "legacy": self.legacy,
        })
    }
}

/// What a device reports about the build it runs: both empty when it reports nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceReport {
    pub app_version: String,
    pub renderer_release: String,
}

/// A device row as retention reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceSeen {
    pub report: DeviceReport,
    /// When the report was last seen, milliseconds since the epoch.
    pub seen_at: f64,
}

/// The knobs of [`ReleaseIndex::plan_retention`].
#[derive(Debug, Clone, Copy)]
pub struct RetentionOptions {
    pub now: f64,
    pub keep_latest: usize,
    pub max_retained: usize,
    pub window_ms: f64,
}

impl RetentionOptions {
    /// The defaults at `now`.
    pub fn at(now: f64) -> Self {
        Self { now, keep_latest: KEEP_LATEST_RELEASES, max_retained: MAX_RETAINED_RELEASES, window_ms: DEVICE_REFERENCE_WINDOW_MS }
    }
}

impl Default for RetentionOptions {
    fn default() -> Self {
        Self::at(now_ms() as f64)
    }
}

/// Which releases survive garbage collection, each list in registry order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetentionPlan {
    pub keep: Vec<String>,
    pub drop: Vec<String>,
}

/// The registry document (`schemaVersion` 1).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReleaseIndex {
    pub releases: Vec<ReleaseEntry>,
}

/// The checks every entry passes, in the order the Node code makes them. `id` and `added_at` are `None` when the document
/// holds something that is not a string or not a number there.
fn check_entry(
    id: Option<&str>,
    desktop_version: &str,
    shell_version: &str,
    added_at: Option<f64>,
    legacy: bool,
    seen: &mut HashSet<String>,
) -> Result<(), ReleaseIndexError> {
    let id = match id {
        Some(id) if is_release_id(id) && !seen.contains(id) => id,
        _ => return Err(ReleaseIndexError::Invalid("renderer release id is invalid")),
    };
    let desktop_ok = if desktop_version.is_empty() { legacy } else { is_desktop_version(desktop_version) };
    if !desktop_ok {
        return Err(ReleaseIndexError::Invalid("renderer release desktop version is invalid"));
    }
    if !shell_version.is_empty() && !is_shell_version(shell_version) {
        return Err(ReleaseIndexError::Invalid("renderer release shell version is invalid"));
    }
    if !added_at.is_some_and(f64::is_finite) {
        return Err(ReleaseIndexError::Invalid("renderer release timestamp is invalid"));
    }
    seen.insert(id.to_owned());
    Ok(())
}

fn one_legacy(releases: Vec<ReleaseEntry>) -> Result<ReleaseIndex, ReleaseIndexError> {
    if releases.iter().filter(|entry| entry.legacy).count() > 1 {
        return Err(ReleaseIndexError::Invalid("renderer release index has more than one legacy release"));
    }
    Ok(ReleaseIndex { releases })
}

/// `String(value ?? '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

impl ReleaseIndex {
    /// The registry of `releases`, checked as a document read from disk is.
    pub fn new(releases: Vec<ReleaseEntry>) -> Result<Self, ReleaseIndexError> {
        let mut seen = HashSet::new();
        for entry in &releases {
            check_entry(Some(&entry.id), &entry.desktop_version, &entry.shell_version, Some(entry.added_at), entry.legacy, &mut seen)?;
        }
        one_legacy(releases)
    }

    /// `parseReleaseIndex`: validates a registry document. An entry id that is not a string is refused: Node accepts a
    /// number there and then fails to build the release path from it.
    pub fn parse(value: &Value) -> Result<Self, ReleaseIndexError> {
        let list = match (value.get("schemaVersion").and_then(Value::as_f64), value.get("releases").and_then(Value::as_array)) {
            (Some(version), Some(list)) if version == 1.0 => list,
            _ => return Err(ReleaseIndexError::Invalid("renderer release index is missing or incompatible")),
        };
        let mut seen = HashSet::new();
        let mut releases = Vec::with_capacity(list.len());
        for entry in list {
            let legacy = entry.get("legacy") == Some(&Value::Bool(true));
            let desktop_version = text_or_empty(entry.get("desktopVersion"));
            let shell_version = text_or_empty(entry.get("shellVersion"));
            let id = entry.get("id").and_then(Value::as_str);
            let added_at = entry.get("addedAt").and_then(Value::as_f64);
            check_entry(id, &desktop_version, &shell_version, added_at, legacy, &mut seen)?;
            releases.push(ReleaseEntry {
                id: id.unwrap_or_default().to_owned(),
                desktop_version,
                shell_version,
                added_at: added_at.unwrap_or_default(),
                legacy,
            });
        }
        one_legacy(releases)
    }

    /// The document `index.json` holds.
    pub fn to_json(&self) -> Value {
        json!({ "schemaVersion": 1, "releases": self.releases.iter().map(ReleaseEntry::to_json).collect::<Vec<_>>() })
    }

    /// `readReleaseIndex`: the registry in `releases_dir`; `None` when there is none, an error when it is invalid.
    pub fn read(releases_dir: impl AsRef<Path>) -> Result<Option<Self>, ReleaseIndexError> {
        let bytes = match mixdog_fsio::read(&Unlaned, releases_dir.as_ref().join(RELEASE_INDEX_FILE)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        Self::parse(&js::parse_bytes(&bytes)?).map(Some)
    }

    /// `withRelease`: the registry with `entry` added; an already registered id is left as it is.
    pub fn with_release(&self, entry: ReleaseEntry) -> Result<Self, ReleaseIndexError> {
        if self.releases.iter().any(|existing| existing.id == entry.id) {
            return Ok(self.clone());
        }
        let mut releases = self.releases.clone();
        releases.push(entry);
        Self::new(releases)
    }

    fn non_legacy(&self) -> impl Iterator<Item = &ReleaseEntry> {
        self.releases.iter().filter(|entry| !entry.legacy)
    }

    fn legacy_release(&self) -> Option<&ReleaseEntry> {
        self.releases.iter().find(|entry| entry.legacy)
    }

    /// `selectRelease`: the registry entry a device should be served; see the rule at the top.
    pub fn select(&self, report: &DeviceReport) -> Option<&ReleaseEntry> {
        let hash_matches = |entry: &ReleaseEntry| !report.renderer_release.is_empty() && entry.shell_version == report.renderer_release;
        let exact = || {
            self.releases.iter().filter(move |entry| !report.app_version.is_empty() && entry.desktop_version == report.app_version)
        };
        if !report.app_version.is_empty() {
            if let Some(hit) = newest_of(exact().filter(|entry| hash_matches(entry))) {
                return Some(hit);
            }
            if let Some(adopted) = self.legacy_release().filter(|entry| entry.desktop_version.is_empty() && hash_matches(entry))
                && !self.releases.iter().any(|entry| !entry.desktop_version.is_empty() && hash_matches(entry))
            {
                return Some(adopted);
            }
            return newest_of(exact());
        }
        if !report.renderer_release.is_empty() {
            return newest_of(self.releases.iter().filter(|entry| hash_matches(entry)));
        }
        self.legacy_release().or_else(|| newest_of(self.non_legacy()))
    }

    /// `oldestSupportedVersion`: the oldest desktop version any retained non-legacy release is built for (what a
    /// legacy-served desktop must update to); empty when there is none.
    pub fn oldest_supported_version(&self) -> String {
        let mut oldest: Option<([f64; 3], &ReleaseEntry)> = None;
        for entry in self.non_legacy() {
            let Some(version) = parse_version(&entry.desktop_version) else { continue };
            if oldest.as_ref().is_none_or(|(held, _)| compare_versions(&version, held) == Ordering::Less) {
                oldest = Some((version, entry));
            }
        }
        oldest.map(|(_, entry)| entry.desktop_version.clone()).unwrap_or_default()
    }

    /// `planRetention`: which releases survive garbage collection.
    pub fn plan_retention(&self, devices: &[DeviceSeen], options: &RetentionOptions) -> RetentionPlan {
        let mut newest_first: Vec<&ReleaseEntry> = self.non_legacy().collect();
        // A stable sort, so releases added at the same time keep the registry order.
        newest_first.sort_by(|a, b| b.added_at.partial_cmp(&a.added_at).unwrap_or(Ordering::Equal));
        let mut keep: HashSet<&str> = newest_first.iter().take(options.keep_latest).map(|entry| entry.id.as_str()).collect();
        let mut referenced: HashSet<&str> = HashSet::new();
        for device in devices {
            // A seen-at that is not a number never counts: the comparison with NaN is false.
            let recent = options.now - device.seen_at <= options.window_ms;
            if recent
                && let Some(selected) = self.select(&device.report)
                && !selected.legacy
            {
                referenced.insert(selected.id.as_str());
            }
        }
        for entry in &newest_first {
            if keep.len() >= options.max_retained {
                break;
            }
            if referenced.contains(entry.id.as_str()) {
                keep.insert(entry.id.as_str());
            }
        }
        if let Some(legacy) = self.legacy_release() {
            keep.insert(legacy.id.as_str());
        }
        let ids = |kept: bool| -> Vec<String> {
            self.releases.iter().filter(|entry| keep.contains(entry.id.as_str()) == kept).map(|entry| entry.id.clone()).collect()
        };
        RetentionPlan { keep: ids(true), drop: ids(false) }
    }
}

/// The newest of `entries`; of two added at the same time the later one in the registry.
fn newest_of<'a>(entries: impl Iterator<Item = &'a ReleaseEntry>) -> Option<&'a ReleaseEntry> {
    let mut best: Option<&ReleaseEntry> = None;
    for entry in entries {
        if best.is_none_or(|held| entry.added_at >= held.added_at) {
            best = Some(entry);
        }
    }
    best
}

/// Answer of [`RendererCatalog::legacy_for`]: the native phone app should show its update-PC page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyNotice {
    pub min_version: String,
}

type CatalogIndex = Result<Option<Arc<ReleaseIndex>>, Arc<ReleaseIndexError>>;

struct IndexCache {
    index: CatalogIndex,
    expires_at: i64,
}

/// `createRendererCatalog`: resolves the renderer tree to serve for a device. Without a registry it is the plain renderer
/// directory, so a relay that was never given releases behaves exactly as before. The registry is read again at most once
/// per [`CATALOG_CACHE_MS`]. An invalid or unreadable registry never enables single-renderer mode.
pub struct RendererCatalog {
    renderer_dir: PathBuf,
    releases_dir: PathBuf,
    cache_ms: i64,
    clock: Clock,
    cache: Mutex<IndexCache>,
}

impl RendererCatalog {
    pub fn new(renderer_dir: impl Into<PathBuf>, releases_dir: impl Into<PathBuf>) -> Self {
        Self::with_clock(renderer_dir, releases_dir, CATALOG_CACHE_MS, system_clock())
    }

    pub fn with_clock(renderer_dir: impl Into<PathBuf>, releases_dir: impl Into<PathBuf>, cache_ms: i64, clock: Clock) -> Self {
        Self {
            renderer_dir: renderer_dir.into(),
            releases_dir: releases_dir.into(),
            cache_ms,
            clock,
            cache: Mutex::new(IndexCache { index: Ok(None), expires_at: i64::MIN }),
        }
    }

    pub fn renderer_dir(&self) -> &Path {
        &self.renderer_dir
    }

    pub fn releases_dir(&self) -> &Path {
        &self.releases_dir
    }

    /// The registry, distinguishing a missing file from a failed read.
    pub fn index(&self) -> Result<Option<Arc<ReleaseIndex>>, Arc<ReleaseIndexError>> {
        if self.releases_dir.as_os_str().is_empty() {
            return Ok(None);
        }
        let time = (self.clock)();
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        if time < cache.expires_at {
            return cache.index.clone();
        }
        cache.index = ReleaseIndex::read(&self.releases_dir).map(|index| index.map(Arc::new)).map_err(Arc::new);
        cache.expires_at = time + self.cache_ms;
        cache.index.clone()
    }

    /// Advise updating only for an unidentified legacy fallback or an older PC without a matching shell.
    pub fn legacy_for(&self, report: &DeviceReport) -> Option<LegacyNotice> {
        let registry = self.index().ok().flatten()?;
        let selected = registry.select(report);
        let min_version = registry.oldest_supported_version();
        let update = if report.app_version.is_empty() {
            report.renderer_release.is_empty() && selected.is_some_and(|entry| entry.legacy)
        } else {
            selected.is_none()
                && parse_version(&report.app_version).zip(parse_version(&min_version))
                    .is_some_and(|(current, min)| compare_versions(&current, &min) == Ordering::Less)
        };
        update.then_some(LegacyNotice { min_version })
    }

    /// The selected tree, or the plain renderer only in single-renderer mode.
    pub fn dir_for(&self, report: &DeviceReport) -> Option<PathBuf> {
        let Some(registry) = self.index().ok()? else {
            return Some(self.renderer_dir.clone());
        };
        let entry = registry.select(report)?;
        let dir = self.releases_dir.join(&entry.id);
        mixdog_fsio::metadata(&Unlaned, dir.join("index.html")).is_ok_and(|info| info.is_file()).then_some(dir)
    }
}
