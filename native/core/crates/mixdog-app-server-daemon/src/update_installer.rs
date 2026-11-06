//! The [`UpdateInstaller`] of the product: the staged background install of Node's
//! `runtime/shared/staged-update.mjs` (`runStagedInstall`).
//!
//! `npm install mixdog@<version> --prefix <data>/staging/<version>/install` runs in a private
//! per-version directory, the package is relocated into a self-contained
//! `<data>/staging/<version>/mixdog` (its hoisted dependencies nested beneath), its
//! `package.json` version is verified, and only then the completion marker
//! `.staged-complete.json` is written. The live package directory is never touched: the swap
//! into place happens at the next clean launch, in the Node launcher (`cli.mjs`), which reads the
//! same marker. A staging lock (`.staging.lock`, `<pid> <ms>`) keeps two installers of one version
//! apart; it is stolen only from a dead owner or after ten minutes.
//!
//! The whole install is one job of the maintenance lane: it waits for the npm child, which
//! takes minutes, and holds no other lane while it does.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::netproxy::system::SystemProxy;
use mixdog_core_domains::domains::update::UpdateInstaller;
use mixdog_rt::MaintenanceIo;
use tokio_util::sync::CancellationToken;

/// Where the install lives and what runs npm.
#[derive(Debug, Clone)]
pub struct StagedConfig {
    /// `<data>`: the staging directory is `<data_dir>/staging`.
    pub data_dir: PathBuf,
    /// The installed package directory (`<prefix>/node_modules/mixdog`), `JsRuntime::package_root`.
    pub package_root: PathBuf,
    /// The JS interpreter that runs `npm-cli.js` (`JsRuntime::program`).
    pub node: PathBuf,
    /// `node` is the app binary in node mode (`ELECTRON_RUN_AS_NODE`).
    pub electron: bool,
}

pub struct StagedInstaller {
    config: StagedConfig,
    lane: MaintenanceIo,
    proxy: Arc<SystemProxy>,
    dev: bool,
}

impl StagedInstaller {
    /// `dev` is [`Self::probe_dev_install`] of the package root, asked once by the composition
    /// (it probes the file system) and kept for the life of the process, as Node's
    /// `isDevInstall()` is a property of the module location.
    pub fn new(config: StagedConfig, lane: MaintenanceIo, proxy: Arc<SystemProxy>, dev: bool) -> Self {
        Self { config, lane, proxy, dev }
    }

    /// `isDevInstall()`: a `.git` entry at the package root, or a package directory that is not
    /// under any `node_modules`. Probes the file system.
    pub fn probe_dev_install(package_root: &Path) -> bool {
        blocking::is_dev_install(package_root)
    }
}

#[async_trait]
impl UpdateInstaller for StagedInstaller {
    fn is_dev_install(&self) -> bool {
        self.dev
    }

    async fn stage(&self, version: &str) -> Result<Option<String>, String> {
        let version = version.trim().to_owned();
        if version.is_empty() {
            return Err("no version".into());
        }
        let cancel = CancellationToken::new();
        let config = self.config.clone();
        let claim_version = version.clone();
        let claimed = mixdog_core_base::support::on_lane(self.lane, &cancel, move |lane| blocking::claim(lane, &config, &claim_version))
            .await
            .map_err(|error| error.to_string())??;
        let verdir = match claimed {
            blocking::Claim::AlreadyStaged => return Ok(None),
            blocking::Claim::Held(dir) => dir,
        };
        // npm's registry decides the proxy route; asked between the two jobs because the route
        // lookup is async.
        let registry_config = self.config.clone();
        let registry = mixdog_core_base::support::on_lane(self.lane, &cancel, move |_lane| blocking::npm_registry(&registry_config))
            .await
            .map_err(|error| error.to_string())?;
        let proxy_env = match &registry {
            Some((_, registry)) => self.proxy.npm_env(registry).await,
            None => Vec::new(),
        };
        let config = self.config.clone();
        let install_version = version.clone();
        let install_dir = verdir.clone();
        let outcome = mixdog_core_base::support::on_lane(self.lane, &cancel, move |lane| {
            blocking::install(lane, &config, &install_version, &install_dir, registry.as_ref().map(|(cli, _)| cli.as_path()), &proxy_env)
        })
        .await
        .map_err(|error| error.to_string());
        // The lock is released whatever happened above.
        let lock_dir = verdir;
        mixdog_core_base::support::on_lane(self.lane, &cancel, move |lane| blocking::release(lane, &lock_dir))
            .await
            .map_err(|error| error.to_string())?;
        outcome??;
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods, reason = "tests write their staging tree on the test thread")]

    use std::path::Path;

    use mixdog_core_base::support::on_lane;

    use super::*;

    /// An `npm-cli.js` that installs what `npm install mixdog@<v> --prefix <p>` installs.
    const FAKE_NPM: &str = r#"
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'config') { process.stdout.write('https://registry.example.test/\n'); process.exit(0); }
const spec = args[1];
const prefix = args[args.indexOf('--prefix') + 1];
const version = process.env.FAKE_NPM_VERSION || spec.split('@')[1];
const pkg = path.join(prefix, 'node_modules', 'mixdog');
fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'mixdog', version }));
fs.writeFileSync(path.join(pkg, 'src', 'cli.mjs'), '');
fs.mkdirSync(path.join(prefix, 'node_modules', 'dep'), { recursive: true });
"#;

    fn config(dir: &Path) -> StagedConfig {
        StagedConfig { data_dir: dir.join("data"), package_root: dir.join("pkg"), node: PathBuf::from("node"), electron: false }
    }

    fn fake_npm(dir: &Path) -> PathBuf {
        let cli = dir.join("npm-cli.js");
        std::fs::write(&cli, FAKE_NPM).unwrap();
        cli
    }

    async fn staged(config: &StagedConfig, cli: &Path, version: &str) -> Result<(), String> {
        let lane = mixdog_rt::testing::tokens().maintenance_io;
        let (config, cli, version) = (config.clone(), cli.to_owned(), version.to_owned());
        on_lane(lane, &CancellationToken::new(), move |lane| {
            let dir = match blocking::claim(lane, &config, &version)? {
                blocking::Claim::AlreadyStaged => return Ok(()),
                blocking::Claim::Held(dir) => dir,
            };
            let result = blocking::install(lane, &config, &version, &dir, Some(&cli), &[]);
            blocking::release(lane, &dir);
            result
        })
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_staged_install_is_self_contained_and_marked_last() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        staged(&config, &fake_npm(dir.path()), "9.9.9").await.unwrap();
        let ver_dir = config.data_dir.join("staging").join("9.9.9");
        let pkg = ver_dir.join("mixdog");
        assert!(pkg.join("src").join("cli.mjs").exists());
        // The hoisted dependencies travel with the package, and the install prefix is gone.
        assert!(pkg.join("node_modules").join("dep").exists());
        assert!(!ver_dir.join("install").exists());
        assert!(!ver_dir.join(".staging.lock").exists());
        let marker: serde_json::Value = serde_json::from_slice(&std::fs::read(ver_dir.join(".staged-complete.json")).unwrap()).unwrap();
        assert_eq!(marker["version"], "9.9.9");
        assert_eq!(marker["pkgDir"], pkg.to_string_lossy().as_ref());
        // A second call finds it complete and installs nothing.
        staged(&config, Path::new("does-not-exist.js"), "9.9.9").await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_version_mismatch_leaves_no_marker_and_frees_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let cli = dir.path().join("npm-cli.js");
        std::fs::write(&cli, FAKE_NPM.replace("process.env.FAKE_NPM_VERSION ||", "'1.0.0' ||")).unwrap();
        let error = staged(&config, &cli, "9.9.9").await.unwrap_err();
        assert_eq!(error, "staged version 1.0.0 != 9.9.9");
        let ver_dir = config.data_dir.join("staging").join("9.9.9");
        assert!(!ver_dir.join(".staged-complete.json").exists());
        assert!(!ver_dir.join(".staging.lock").exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_npm_reports_its_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let cli = dir.path().join("npm-cli.js");
        std::fs::write(&cli, "process.exit(3)").unwrap();
        assert_eq!(staged(&config, &cli, "9.9.9").await.unwrap_err(), "npm install exited with code 3");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_live_lock_refuses_a_second_installer_and_a_dead_one_is_stolen() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let ver_dir = config.data_dir.join("staging").join("9.9.9");
        std::fs::create_dir_all(&ver_dir).unwrap();
        let lock = ver_dir.join(".staging.lock");
        std::fs::write(&lock, format!("{} 0", std::process::id())).unwrap();
        let cli = fake_npm(dir.path());
        assert_eq!(staged(&config, &cli, "9.9.9").await.unwrap_err(), "staging in progress");
        // pid 0 names no process.
        std::fs::write(&lock, "0 0").unwrap();
        staged(&config, &cli, "9.9.9").await.unwrap();
    }

    #[test]
    fn a_dev_install_is_a_checkout_or_a_package_outside_node_modules() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = dir.path().join("node_modules").join("mixdog");
        std::fs::create_dir_all(checkout.join(".git")).unwrap();
        assert!(StagedInstaller::probe_dev_install(&checkout));
        let installed = dir.path().join("node_modules").join("other");
        std::fs::create_dir_all(&installed).unwrap();
        assert!(!StagedInstaller::probe_dev_install(&installed));
        assert!(StagedInstaller::probe_dev_install(&dir.path().join("src").join("mixdog")));
    }
}

pub(crate) mod blocking {
    #![allow(clippy::disallowed_methods, reason = "bodies of maintenance-lane jobs: probing and spawning that the lane contract is for")]

    use std::io::Write;
    use std::path::Path;
    use std::path::PathBuf;
    use std::process::Command;
    use std::process::Stdio;
    use std::time::Duration;
    use std::time::SystemTime;
    use std::time::UNIX_EPOCH;

    use mixdog_rt::InLane;
    use mixdog_rt::MaintenanceIo;
    use mixdog_statefile::Access;
    use serde_json::json;

    use super::StagedConfig;
    use crate::verdict::OsProcessTable;
    use crate::verdict::ProcessTable;

    const PACKAGE_NAME: &str = "mixdog";
    const MARKER_NAME: &str = ".staged-complete.json";
    /// The self-contained package directory inside a staging version folder.
    const PKG_SUBDIR: &str = "mixdog";
    const STALE_INPROGRESS: Duration = Duration::from_secs(10 * 60);
    const REGISTRY_TIMEOUT: Duration = Duration::from_secs(10);
    const DEFAULT_NPM_REGISTRY: &str = "https://registry.npmjs.org/";

    pub enum Claim {
        AlreadyStaged,
        /// The staging lock of this version directory is held by this install.
        Held(PathBuf),
    }

    fn staging_root(config: &StagedConfig) -> PathBuf {
        config.data_dir.join("staging")
    }

    pub fn is_dev_install(package_root: &Path) -> bool {
        if package_root.join(".git").exists() {
            return true;
        }
        let normalized = package_root.to_string_lossy().replace('\\', "/").to_lowercase();
        !format!("/{normalized}/").contains("/node_modules/")
    }

    fn marker(ver_dir: &Path) -> Option<serde_json::Value> {
        let bytes = mixdog_statefile::read_content(&ver_dir.join(MARKER_NAME)).ok()??;
        serde_json::from_slice(&bytes).ok()
    }

    fn package_complete(pkg_dir: &Path) -> bool {
        pkg_dir.join("package.json").exists() && pkg_dir.join("src").join("cli.mjs").exists()
    }

    /// `isStagedComplete`.
    fn is_staged_complete(root: &Path, version: &str) -> bool {
        let ver_dir = root.join(version);
        let Some(marker) = marker(&ver_dir) else { return false };
        if marker["version"].as_str() != Some(version) {
            return false;
        }
        let pkg_dir = marker["pkgDir"].as_str().map_or_else(|| ver_dir.join(PKG_SUBDIR), PathBuf::from);
        package_complete(&pkg_dir)
    }

    fn now_ms() -> u128 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
    }

    /// `claimPidLockFile`: exclusive `<pid> <ms>`; an existing lock is stolen only when its owner
    /// is dead or it is older than ten minutes.
    fn claim_pid_lock(lane: &InLane<MaintenanceIo>, lock: &Path) -> bool {
        let write = || -> std::io::Result<()> {
            let mut file = mixdog_statefile::create_new(lane, lock, Access::Inherit, 0o644)?;
            file.write_all(format!("{} {}", std::process::id(), now_ms()).as_bytes())
        };
        match write() {
            Ok(()) => return true,
            Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => return false,
            Err(_) => {}
        }
        let owner = mixdog_statefile::read_content(lock)
            .ok()
            .flatten()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|text| text.split_whitespace().next().and_then(|pid| pid.parse::<u64>().ok()))
            .unwrap_or(0);
        let age = mixdog_statefile::metadata(lane, lock)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .unwrap_or(Duration::MAX);
        let alive = owner > 0 && OsProcessTable.query(owner).is_ok_and(|info| info.is_some());
        if alive && age < STALE_INPROGRESS {
            return false;
        }
        let _ = mixdog_statefile::remove_file(lane, lock);
        write().is_ok()
    }

    pub fn claim(lane: &InLane<MaintenanceIo>, config: &StagedConfig, version: &str) -> Result<Claim, String> {
        let root = staging_root(config);
        if is_staged_complete(&root, version) {
            return Ok(Claim::AlreadyStaged);
        }
        let ver_dir = root.join(version);
        mixdog_statefile::create_private_dir_all(lane, &ver_dir).map_err(|error| error.to_string())?;
        if !claim_pid_lock(lane, &ver_dir.join(".staging.lock")) {
            return Err("staging in progress".into());
        }
        Ok(Claim::Held(ver_dir))
    }

    pub fn release(lane: &InLane<MaintenanceIo>, ver_dir: &Path) {
        let _ = mixdog_statefile::remove_file(lane, &ver_dir.join(".staging.lock"));
    }

    fn hidden(command: &mut Command) -> &mut Command {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: no console appears for the shell-less npm child.
            command.creation_flags(0x0800_0000);
        }
        command
    }

    fn node_command(config: &StagedConfig, cli: &Path) -> Command {
        let mut command = Command::new(&config.node);
        command.arg(cli);
        hidden(&mut command);
        if config.electron {
            command.env("ELECTRON_RUN_AS_NODE", "1");
        }
        command
    }

    /// `npmCliJsPath`: npm's `npm-cli.js` beside the interpreter (Windows, Unix and Homebrew
    /// layouts), else through an `npm` shim on `PATH` whose real path is npm's package.
    pub fn npm_cli_js(config: &StagedConfig) -> Option<PathBuf> {
        let mut candidates = Vec::new();
        if let Some(path) = std::env::var_os("npm_execpath").map(PathBuf::from) {
            if path.to_string_lossy().to_lowercase().ends_with("npm-cli.js") {
                candidates.push(path);
            }
        }
        let mut exec_dirs = Vec::new();
        if let Some(dir) = config.node.parent() {
            exec_dirs.push(dir.to_path_buf());
        }
        if let Some(dir) = std::fs::canonicalize(&config.node).ok().and_then(|real| real.parent().map(Path::to_path_buf)) {
            if !exec_dirs.contains(&dir) {
                exec_dirs.push(dir);
            }
        }
        for dir in &exec_dirs {
            candidates.push(dir.join("node_modules").join("npm").join("bin").join("npm-cli.js"));
            candidates.push(dir.join("..").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"));
            candidates.push(dir.join("..").join("libexec").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"));
        }
        if let Some(found) = candidates.into_iter().find(|candidate| candidate.exists()) {
            return Some(found);
        }
        let path = std::env::var_os("PATH").or_else(|| std::env::var_os("Path")).unwrap_or_default();
        for dir in std::env::split_paths(&path).filter(|dir| !dir.as_os_str().is_empty()) {
            let shims: &[&str] = if cfg!(windows) { &["npm", "npm.cmd"] } else { &["npm"] };
            for shim in shims {
                let Ok(real) = std::fs::canonicalize(dir.join(shim)) else { continue };
                let Some(bin) = real.parent() else { continue };
                let names = |path: &Path| path.file_name().map(|n| n.to_string_lossy().into_owned());
                let npm = bin.parent();
                let modules = npm.and_then(Path::parent);
                if names(bin).as_deref() != Some("bin")
                    || npm.and_then(names).as_deref() != Some("npm")
                    || modules.and_then(names).as_deref() != Some("node_modules")
                {
                    continue;
                }
                let cli = bin.join("npm-cli.js");
                if cli.exists() {
                    return Some(cli);
                }
            }
        }
        None
    }

    /// `npmRegistry`: the registry npm installs from (its `.npmrc` files included), as
    /// `(npm-cli.js, registry)`; npm's default when npm cannot say. `None` when npm is not found.
    pub fn npm_registry(config: &StagedConfig) -> Option<(PathBuf, String)> {
        let cli = npm_cli_js(config)?;
        let asked = (|| {
            let mut command = node_command(config, &cli);
            command.args(["config", "get", "registry"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
            let mut child = command.spawn().ok()?;
            let deadline = std::time::Instant::now() + REGISTRY_TIMEOUT;
            let status = loop {
                match child.try_wait().ok()? {
                    Some(status) => break status,
                    None if std::time::Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                    None => std::thread::sleep(Duration::from_millis(20)),
                }
            };
            if !status.success() {
                return None;
            }
            let mut text = String::new();
            std::io::Read::read_to_string(&mut child.stdout.take()?, &mut text).ok()?;
            url_href(text.trim())
        })();
        Some((cli, asked.unwrap_or_else(|| DEFAULT_NPM_REGISTRY.to_owned())))
    }

    /// `new URL(text).href` for the registry URLs npm answers with.
    fn url_href(text: &str) -> Option<String> {
        reqwest::Url::parse(text).ok().map(|url| url.to_string())
    }

    /// The install proper, with the lock held: npm into a private prefix, relocate, verify, mark.
    pub fn install(
        lane: &InLane<MaintenanceIo>,
        config: &StagedConfig,
        version: &str,
        ver_dir: &Path,
        cli: Option<&Path>,
        proxy_env: &[(&'static str, String)],
    ) -> Result<(), String> {
        let rm = |dir: &Path| {
            let _ = mixdog_statefile::remove_dir_all(lane, dir);
        };
        let prefix = ver_dir.join("install");
        let pkg_dir = ver_dir.join(PKG_SUBDIR);
        rm(&prefix);
        rm(&pkg_dir);
        mixdog_statefile::create_private_dir_all(lane, &prefix).map_err(|error| error.to_string())?;
        // Shell-less only: no `cmd`, no PowerShell. Without npm-cli.js staging is skipped.
        let cli = cli.ok_or_else(|| "npm-cli.js unresolved — staging skipped".to_owned())?;
        let mut command = node_command(config, cli);
        command
            .args(["install", &format!("{PACKAGE_NAME}@{version}"), "--prefix"])
            .arg(&prefix)
            .args(["--no-save", "--no-audit", "--no-fund", "--loglevel=error"])
            .envs(proxy_env.iter().map(|(key, value)| (*key, value.as_str())))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let code = match command.spawn().and_then(|mut child| child.wait()) {
            Ok(status) => status.code().unwrap_or(-1),
            Err(_) => -1,
        };
        if code != 0 {
            return Err(format!("npm install exited with code {code}"));
        }
        let installed_modules = prefix.join("node_modules");
        let installed_pkg = installed_modules.join(PACKAGE_NAME);
        let package_json = installed_pkg.join("package.json");
        let bytes = mixdog_statefile::read_content(&package_json).ok().flatten().ok_or_else(|| "staged package.json missing".to_owned())?;
        let staged_version = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| value["version"].as_str().map(str::to_owned))
            .unwrap_or_default();
        if staged_version != version {
            let shown = if staged_version.is_empty() { "?" } else { staged_version.as_str() };
            return Err(format!("staged version {shown} != {version}"));
        }
        // Self-contained: mixdog moves out of the install's node_modules and the remaining
        // (hoisted) dependencies nest under it, so the swapped-in package resolves its own.
        mixdog_statefile::rename_with_retry(lane, &installed_pkg, &pkg_dir).map_err(|error| error.to_string())?;
        mixdog_statefile::rename_with_retry(lane, &installed_modules, &pkg_dir.join("node_modules")).map_err(|error| error.to_string())?;
        rm(&prefix);
        if !pkg_dir.join("src").join("cli.mjs").exists() {
            return Err("staged cli.mjs missing".into());
        }
        // Written last: its presence is the completion signal for the swap.
        let value = json!({ "version": version, "pkgDir": pkg_dir.to_string_lossy(), "stagedAt": u64::try_from(now_ms()).unwrap_or(0) });
        let opts = mixdog_statefile::Opts { compact: true, ..mixdog_statefile::Opts::default() };
        mixdog_statefile::write_json(lane, &ver_dir.join(MARKER_NAME), &value, &opts).map_err(|error| error.to_string())?;
        Ok(())
    }
}
