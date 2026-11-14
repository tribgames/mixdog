//! Keeps Mixdog's own GNOME Shell extension (`mixdog-windows@mixdog.io`) in place while Computer Use is on: it is what lets the
//! native backend list and control windows on GNOME Wayland (port of `host/gnome-extension.ts`). The .deb ships it system-wide;
//! every other install gets the bundled copy under `~/.local/share/gnome-shell/extensions`. Turning Computer Use off disables it
//! again and leaves the files. Only this uuid is ever touched, nothing prompts, and every step is idempotent.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::process::ProcessManager;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::computer_linux::Env;
use super::computer_linux::GNOME_EXTENSION_UUID;
use super::computer_linux::run_short;

const SYSTEM_EXTENSIONS_DIR: &str = "/usr/share/gnome-shell/extensions";
const COMMAND_LIMIT: Duration = Duration::from_millis(5000);
const ENABLED_SCHEMA: &str = "org.gnome.shell";
const ENABLED_KEY: &str = "enabled-extensions";

/// What is true of the extension after one apply.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct GnomeExtensionState {
    pub installed: bool,
    pub enabled: bool,
    /// Installed and enabled, but the running shell does not answer for it yet (GNOME loads new extensions at login).
    #[serde(rename = "needsRelogin")]
    pub needs_relogin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The machine the extension is kept on; the real one is [`SystemHost`].
#[async_trait]
trait Host: Send + Sync {
    fn is_linux(&self) -> bool;
    fn exists(&self, path: &Path) -> bool;
    fn read_text(&self, path: &Path) -> Option<String>;
    fn replace_dir(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    /// stdout of a command that ended with code 0; `None` when it failed or could not run.
    async fn run(&self, program: &str, args: &[&str]) -> Option<String>;
}

struct SystemHost {
    manager: Arc<dyn ProcessManager>,
    env: Env,
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[async_trait]
impl Host for SystemHost {
    fn is_linux(&self) -> bool {
        cfg!(target_os = "linux")
    }

    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn read_text(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    fn replace_dir(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        match std::fs::remove_dir_all(to) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        copy_dir(from, to)
    }

    async fn run(&self, program: &str, args: &[&str]) -> Option<String> {
        run_short(&*self.manager, &self.env, program, args, COMMAND_LIMIT).await.and_then(|(ok, out)| ok.then_some(out))
    }
}

fn metadata_version(host: &dyn Host, dir: &Path) -> Option<u64> {
    let text = host.read_text(&dir.join("metadata.json"))?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?.get("version")?.as_u64()
}

/// The enabled-extensions list as gsettings prints it: `['a', 'b']` or `@as []`.
fn parse_extension_list(text: &str) -> Vec<String> {
    let mut list = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('\'') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('\'') else { break };
        list.push(after[..end].to_owned());
        rest = &after[end + 1..];
    }
    list
}

fn format_extension_list(list: &[String]) -> String {
    format!("[{}]", list.iter().map(|uuid| format!("'{uuid}'")).collect::<Vec<_>>().join(", "))
}

fn var<'a>(env: &'a Env, key: &str) -> &'a str {
    env.get(key).map_or("", String::as_str)
}

fn user_extension_dir(env: &Env) -> Option<PathBuf> {
    let data = match (var(env, "XDG_DATA_HOME"), var(env, "HOME")) {
        ("", "") => return None,
        ("", home) => PathBuf::from(home).join(".local").join("share"),
        (data, _) => PathBuf::from(data),
    };
    Some(data.join("gnome-shell").join("extensions").join(GNOME_EXTENSION_UUID))
}

fn system_extension_dir() -> PathBuf {
    Path::new(SYSTEM_EXTENSIONS_DIR).join(GNOME_EXTENSION_UUID)
}

/// Where the extension files of this install are: `MIXDOG_GNOME_EXTENSION_DIR`, a `gnome-extension` folder beside the executable, in
/// the packaged app's resources (the core sits in `resources/core` and the package packs the extension to `resources/gnome-extension`,
/// so the folders above the executable are searched too), then the repository's `native/gnome-extension` above the executable (a
/// development tree).
pub fn bundled_dir(env: &Env, exe_dir: &Path) -> Option<PathBuf> {
    let explicit = var(env, "MIXDOG_GNOME_EXTENSION_DIR");
    if !explicit.is_empty() {
        return Some(PathBuf::from(explicit));
    }
    let mut candidates = vec![exe_dir.join("gnome-extension"), exe_dir.join("resources").join("gnome-extension")];
    candidates.extend(exe_dir.ancestors().skip(1).take(2).map(|dir| dir.join("gnome-extension")));
    candidates.extend(exe_dir.ancestors().map(|dir| dir.join("native").join("gnome-extension")));
    candidates.into_iter().map(|dir| dir.join(GNOME_EXTENSION_UUID)).find(|dir| dir.join("metadata.json").exists())
}

/// Puts the bundled copy in the user's extensions dir unless one is already installed system-wide.
fn install_files(host: &dyn Host, env: &Env, bundled: Option<&Path>) -> Result<(), String> {
    if host.exists(&system_extension_dir().join("metadata.json")) {
        return Ok(());
    }
    let Some(target) = user_extension_dir(env) else {
        return Err("no home directory to install the GNOME extension into".into());
    };
    let Some((bundled, version)) = bundled.and_then(|dir| Some((dir, metadata_version(host, dir)?))) else {
        return Err(match bundled {
            Some(dir) => format!("bundled extension not found at {}", dir.display()),
            None => "bundled extension not found beside the executable".into(),
        });
    };
    if metadata_version(host, &target) != Some(version) || !host.exists(&target.join("extension.js")) {
        host.replace_dir(bundled, &target).map_err(|error| format!("copying the extension failed: {error}"))?;
    }
    Ok(())
}

fn files_installed(host: &dyn Host, env: &Env) -> bool {
    host.exists(&system_extension_dir().join("metadata.json")) || user_extension_dir(env).is_some_and(|dir| host.exists(&dir.join("metadata.json")))
}

/// Brings the enabled-extensions list in line; returns whether our uuid is in it afterwards.
async fn set_enabled(host: &dyn Host, enabled: bool) -> Result<bool, String> {
    let Some(text) = host.run("gsettings", &["get", ENABLED_SCHEMA, ENABLED_KEY]).await else {
        return Err("gsettings could not read the enabled extensions".into());
    };
    let current = parse_extension_list(&text);
    if current.iter().any(|uuid| uuid == GNOME_EXTENSION_UUID) == enabled {
        return Ok(enabled);
    }
    let next: Vec<String> = if enabled {
        current.into_iter().chain([GNOME_EXTENSION_UUID.to_owned()]).collect()
    } else {
        current.into_iter().filter(|uuid| uuid != GNOME_EXTENSION_UUID).collect()
    };
    let value = format_extension_list(&next);
    match host.run("gsettings", &["set", ENABLED_SCHEMA, ENABLED_KEY, &value]).await {
        Some(_) => Ok(enabled),
        None => Err("gsettings could not write the enabled extensions".into()),
    }
}

/// Whether the running shell answers for the extension on the session bus.
async fn shell_answers(host: &dyn Host) -> bool {
    host.run(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.gnome.Shell",
            "--object-path",
            "/io/mixdog/Windows",
            "--method",
            "org.freedesktop.DBus.Properties.Get",
            "io.mixdog.Windows",
            "Version",
        ],
    )
    .await
    .is_some()
}

async fn sync(host: &dyn Host, enabled: bool, env: &Env, bundled: Option<&Path>, cancel: &CancellationToken) -> Option<GnomeExtensionState> {
    if !host.is_linux() || !var(env, "XDG_CURRENT_DESKTOP").to_lowercase().contains("gnome") {
        return None;
    }
    let mut state = GnomeExtensionState::default();
    let steps = async {
        if enabled {
            install_files(host, env, bundled)?;
        }
        state.installed = files_installed(host, env);
        if cancel.is_cancelled() {
            return Ok(());
        }
        state.enabled = set_enabled(host, enabled && state.installed).await?;
        state.needs_relogin = state.enabled && !shell_answers(host).await;
        Ok::<(), String>(())
    };
    if let Err(message) = steps.await {
        state.installed = files_installed(host, env);
        state.error = Some(message);
    }
    Some(state)
}

static LAST: Mutex<Option<GnomeExtensionState>> = Mutex::new(None);
static QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The state of the last apply in this process; what `diagnose` reports.
pub fn last_state() -> Option<GnomeExtensionState> {
    LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

/// Brings the extension in line with the `desktop.computerControl` value. Serialized, so a quick off/on toggle cannot interleave two
/// applies; a failure is in the returned state's `error` and logged, never thrown. Off GNOME (or off Linux) nothing is touched and the
/// default state comes back. `bundled` is [`bundled_dir`]: without one, turning it on reports the missing files and turning it off still
/// takes our uuid out of the enabled list.
pub async fn apply_gnome_extension(manager: Arc<dyn ProcessManager>, enabled: bool, env: &Env, bundled: Option<&Path>, cancel: &CancellationToken) -> GnomeExtensionState {
    let _turn = QUEUE.lock().await;
    let host = SystemHost { manager, env: env.clone() };
    let Some(state) = sync(&host, enabled, env, bundled, cancel).await else { return GnomeExtensionState::default() };
    if let Some(error) = &state.error {
        tracing::error!("[gnome-extension] {} failed: {error}", if enabled { "setup" } else { "disable" });
    }
    *LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(state.clone());
    state
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const BUNDLED: &str = "/app/resources/gnome-extension/mixdog-windows@mixdog.io";
    const USER_DIR: &str = "/home/u/.local/share/gnome-shell/extensions/mixdog-windows@mixdog.io";
    const SYSTEM_DIR: &str = "/usr/share/gnome-shell/extensions/mixdog-windows@mixdog.io";

    struct Fake {
        files: Mutex<HashMap<String, String>>,
        extensions: Mutex<String>,
        commands: Mutex<Vec<String>>,
        copies: Mutex<u32>,
        fail: bool,
        shell_loaded: bool,
        platform_linux: bool,
    }

    impl Fake {
        fn new(files: &[(&str, String)], extensions: &str) -> Self {
            Self {
                files: Mutex::new(files.iter().map(|(path, text)| ((*path).to_owned(), text.clone())).collect()),
                extensions: Mutex::new(extensions.to_owned()),
                commands: Mutex::new(Vec::new()),
                copies: Mutex::new(0),
                fail: false,
                shell_loaded: true,
                platform_linux: true,
            }
        }
        fn sets(&self) -> usize {
            self.commands.lock().unwrap().iter().filter(|line| line.contains(" set ")).count()
        }
    }

    fn norm(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    #[async_trait]
    impl Host for Fake {
        fn is_linux(&self) -> bool {
            self.platform_linux
        }
        fn exists(&self, path: &Path) -> bool {
            self.files.lock().unwrap().contains_key(&norm(path))
        }
        fn read_text(&self, path: &Path) -> Option<String> {
            self.files.lock().unwrap().get(&norm(path)).cloned()
        }
        fn replace_dir(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            let (from, to) = (norm(from), norm(to));
            *self.copies.lock().unwrap() += 1;
            let mut files = self.files.lock().unwrap();
            files.retain(|key, _| !key.starts_with(&to));
            let meta = files[&format!("{from}/metadata.json")].clone();
            files.insert(format!("{to}/metadata.json"), meta);
            files.insert(format!("{to}/extension.js"), "//".into());
            Ok(())
        }
        async fn run(&self, program: &str, args: &[&str]) -> Option<String> {
            self.commands.lock().unwrap().push(format!("{program} {}", args.join(" ")));
            if program == "gdbus" {
                return self.shell_loaded.then(|| "(<uint32 1>,)".to_owned());
            }
            if self.fail {
                return None;
            }
            if args[0] == "get" {
                return Some(format!("{}\n", self.extensions.lock().unwrap()));
            }
            *self.extensions.lock().unwrap() = args[3].to_owned();
            Some(String::new())
        }
    }

    fn meta(version: u64) -> String {
        format!("{{\"uuid\":\"{GNOME_EXTENSION_UUID}\",\"version\":{version}}}")
    }

    fn env(desktop: &str) -> Env {
        [("XDG_CURRENT_DESKTOP", desktop), ("HOME", "/home/u")].into_iter().map(|(key, value)| (key.to_owned(), value.to_owned())).collect()
    }

    async fn run(fake: &Fake, enabled: bool) -> Option<GnomeExtensionState> {
        sync(fake, enabled, &env("ubuntu:GNOME"), Some(Path::new(BUNDLED)), &CancellationToken::new()).await
    }

    #[tokio::test]
    async fn enabling_copies_the_bundled_extension_per_user_and_appends_only_our_uuid() {
        let fake = Fake::new(&[(&format!("{BUNDLED}/metadata.json"), meta(1))], "['dash-to-dock@x.com']");
        let state = run(&fake, true).await.unwrap();
        assert_eq!(*fake.copies.lock().unwrap(), 1);
        assert!(fake.files.lock().unwrap().contains_key(&format!("{USER_DIR}/extension.js")));
        assert_eq!(*fake.extensions.lock().unwrap(), format!("['dash-to-dock@x.com', '{GNOME_EXTENSION_UUID}']"));
        assert_eq!(state, GnomeExtensionState { installed: true, enabled: true, needs_relogin: false, error: None });
    }

    #[tokio::test]
    async fn a_shell_that_does_not_answer_yet_needs_a_relogin() {
        let mut fake = Fake::new(&[(&format!("{BUNDLED}/metadata.json"), meta(1))], "@as []");
        fake.shell_loaded = false;
        let state = run(&fake, true).await.unwrap();
        assert!(state.enabled && state.needs_relogin);
        assert_eq!(*fake.extensions.lock().unwrap(), format!("['{GNOME_EXTENSION_UUID}']"));
    }

    #[tokio::test]
    async fn setup_is_idempotent() {
        let fake = Fake::new(&[(&format!("{BUNDLED}/metadata.json"), meta(1))], "['dash-to-dock@x.com']");
        run(&fake, true).await;
        let sets = fake.sets();
        run(&fake, true).await;
        assert_eq!(*fake.copies.lock().unwrap(), 1);
        assert_eq!(fake.sets(), sets);
    }

    #[tokio::test]
    async fn a_user_copy_with_a_different_version_is_replaced_and_the_same_version_is_kept() {
        let fake = Fake::new(
            &[(&format!("{BUNDLED}/metadata.json"), meta(2)), (&format!("{USER_DIR}/metadata.json"), meta(1)), (&format!("{USER_DIR}/extension.js"), "//".into())],
            &format!("['{GNOME_EXTENSION_UUID}']"),
        );
        run(&fake, true).await;
        assert_eq!(*fake.copies.lock().unwrap(), 1);
        assert_eq!(metadata_version(&fake, Path::new(USER_DIR)), Some(2));
        run(&fake, true).await;
        assert_eq!(*fake.copies.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn a_system_wide_copy_is_never_copied_over_it_is_only_enabled() {
        let fake = Fake::new(&[(&format!("{SYSTEM_DIR}/metadata.json"), meta(1))], "@as []");
        let state = run(&fake, true).await.unwrap();
        assert_eq!(*fake.copies.lock().unwrap(), 0);
        assert!(state.installed && state.enabled);
    }

    #[tokio::test]
    async fn disabling_removes_only_our_uuid_and_leaves_the_files() {
        let fake = Fake::new(&[(&format!("{USER_DIR}/metadata.json"), meta(1))], &format!("['a@b', '{GNOME_EXTENSION_UUID}']"));
        let state = run(&fake, false).await.unwrap();
        assert_eq!(*fake.extensions.lock().unwrap(), "['a@b']");
        assert!(fake.files.lock().unwrap().contains_key(&format!("{USER_DIR}/metadata.json")));
        assert_eq!(state, GnomeExtensionState { installed: true, enabled: false, needs_relogin: false, error: None });
        let sets = fake.sets();
        run(&fake, false).await;
        assert_eq!(fake.sets(), sets);
    }

    #[tokio::test]
    async fn without_a_bundle_disabling_still_takes_our_uuid_out_and_enabling_reports_it() {
        let fake = Fake::new(&[], &format!("['a@b', '{GNOME_EXTENSION_UUID}']"));
        let state = sync(&fake, false, &env("GNOME"), None, &CancellationToken::new()).await.unwrap();
        assert_eq!(*fake.extensions.lock().unwrap(), "['a@b']");
        assert!(state.error.is_none());
        let state = sync(&fake, true, &env("GNOME"), None, &CancellationToken::new()).await.unwrap();
        assert!(!state.enabled && state.error.as_deref().is_some_and(|error| error.contains("beside the executable")));
        assert_eq!(*fake.extensions.lock().unwrap(), "['a@b']");
    }

    #[tokio::test]
    async fn another_desktop_or_platform_is_left_alone() {
        let fake = Fake::new(&[(&format!("{BUNDLED}/metadata.json"), meta(1))], "@as []");
        assert!(sync(&fake, true, &env("KDE"), Some(Path::new(BUNDLED)), &CancellationToken::new()).await.is_none());
        let mut other = Fake::new(&[(&format!("{BUNDLED}/metadata.json"), meta(1))], "@as []");
        other.platform_linux = false;
        assert!(run(&other, true).await.is_none());
        assert!(fake.commands.lock().unwrap().is_empty() && other.commands.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_missing_bundle_or_a_failing_gsettings_is_reported_not_thrown() {
        let missing = Fake::new(&[], "@as []");
        let state = run(&missing, true).await.unwrap();
        assert!(!state.enabled && state.error.as_deref().is_some_and(|error| error.contains("bundled extension not found")));
        let mut broken = Fake::new(&[(&format!("{BUNDLED}/metadata.json"), meta(1))], "@as []");
        broken.fail = true;
        let state = run(&broken, true).await.unwrap();
        assert!(!state.enabled && state.error.is_some());
    }

    #[test]
    fn the_packaged_extension_is_found_from_the_core_folder_of_the_resources() {
        let resources = tempfile::tempdir().unwrap();
        let bundled = resources.path().join("gnome-extension").join(GNOME_EXTENSION_UUID);
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(bundled.join("metadata.json"), meta(1)).unwrap();
        let core = resources.path().join("core");
        std::fs::create_dir_all(&core).unwrap();
        assert_eq!(bundled_dir(&Env::new(), &core), Some(bundled));
    }

    #[test]
    fn the_extension_list_round_trips_gsettings_text() {
        assert!(parse_extension_list("@as []\n").is_empty());
        assert_eq!(parse_extension_list("['a', 'b@c']"), ["a", "b@c"]);
        assert_eq!(format_extension_list(&["a".into(), "b".into()]), "['a', 'b']");
        assert_eq!(format_extension_list(&[]), "[]");
    }

    #[test]
    fn the_state_serializes_with_the_camel_case_name_and_no_empty_error() {
        let value = serde_json::to_value(GnomeExtensionState { installed: true, enabled: true, needs_relogin: true, error: None }).unwrap();
        assert_eq!(value, serde_json::json!({ "installed": true, "enabled": true, "needsRelogin": true }));
    }
}
