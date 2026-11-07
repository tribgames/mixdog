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
//! The file work is jobs of the maintenance lane; the npm child, which takes minutes, runs
//! through the one process manager (`mixdog_scm::exec::Exec`) between them, so no lane is held
//! while it runs and spawn admission and tree kill are the manager's.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::netproxy::system::SystemProxy;
use mixdog_core_domains::domains::update::UpdateInstaller;
use mixdog_rt::MaintenanceIo;
use mixdog_scm::exec::Exec;
use mixdog_scm::exec::ExecSpec;
use tokio_util::sync::CancellationToken;

const REGISTRY_TIMEOUT: Duration = Duration::from_secs(10);
/// npm runs at `--loglevel=error`; a child that writes more than this is killed.
const NPM_MAX_OUTPUT: u64 = 64 * 1024 * 1024;

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
    exec: Arc<Exec>,
    dev: bool,
}

impl StagedInstaller {
    /// `dev` is [`Self::probe_dev_install`] of the package root, asked once by the composition
    /// (it probes the file system) and kept for the life of the process, as Node's
    /// `isDevInstall()` is a property of the module location.
    pub fn new(config: StagedConfig, lane: MaintenanceIo, proxy: Arc<SystemProxy>, exec: Arc<Exec>, dev: bool) -> Self {
        Self { config, lane, proxy, exec, dev }
    }

    /// `npm-cli.js` run by the configured interpreter (shell-less: no `cmd`, no PowerShell).
    fn npm_spec(&self, cli: &Path, args: &[String]) -> ExecSpec {
        let mut spec = ExecSpec::new(self.config.node.to_string_lossy(), &self.config.data_dir);
        spec.args = std::iter::once(cli.to_string_lossy().into_owned()).chain(args.iter().cloned()).collect();
        if self.config.electron {
            spec.env_set.push(("ELECTRON_RUN_AS_NODE".into(), "1".into()));
        }
        spec
    }

    /// `npmRegistry`: the registry npm installs from (its `.npmrc` files included); npm's
    /// default when npm cannot say.
    async fn registry(&self, cli: &Path, cancel: &CancellationToken) -> String {
        let mut spec = self.npm_spec(cli, &["config".into(), "get".into(), "registry".into()]);
        spec.time_limit = Some(REGISTRY_TIMEOUT);
        let asked = match self.exec.run(spec, cancel).await {
            Ok(output) if output.success() => blocking::url_href(output.stdout_text().trim()),
            _ => None,
        };
        asked.unwrap_or_else(|| blocking::DEFAULT_NPM_REGISTRY.to_owned())
    }

    /// `npm install mixdog@<version> --prefix <prefix>`; its exit code, `-1` when it did not run
    /// or ended by a signal.
    async fn npm_install(&self, cli: &Path, version: &str, prefix: &Path, proxy_env: &[(&'static str, String)], cancel: &CancellationToken) -> i32 {
        let args: Vec<String> = [
            "install".to_owned(),
            format!("{}@{version}", blocking::PACKAGE_NAME),
            "--prefix".to_owned(),
            prefix.to_string_lossy().into_owned(),
            "--no-save".to_owned(),
            "--no-audit".to_owned(),
            "--no-fund".to_owned(),
            "--loglevel=error".to_owned(),
        ]
        .into();
        let mut spec = self.npm_spec(cli, &args);
        spec.env_set.extend(proxy_env.iter().map(|(key, value)| ((*key).to_owned(), value.clone())));
        spec.max_output = NPM_MAX_OUTPUT;
        match self.exec.run(spec, cancel).await {
            Ok(output) => output.code.unwrap_or(-1),
            Err(_) => -1,
        }
    }

    /// `isDevInstall()`: a `.git` entry at the package root, or a package directory that is not
    /// under any `node_modules`. Probes the file system.
    pub fn probe_dev_install<L: mixdog_statefile::IoLane>(lane: &mixdog_rt::InLane<L>, package_root: &Path) -> bool {
        blocking::is_dev_install(lane, package_root)
    }
}

#[async_trait]
impl UpdateInstaller for StagedInstaller {
    fn is_dev_install(&self) -> bool {
        self.dev
    }

    async fn is_staged(&self, version: &str) -> bool {
        let (config, version) = (self.config.clone(), version.trim().to_owned());
        // A lane that refused the job reads as "not staged"; the next poll asks again.
        mixdog_core_base::support::on_lane(self.lane, &CancellationToken::new(), move |lane| blocking::is_staged(lane, &config, &version))
            .await
            .unwrap_or(false)
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
        let config = self.config.clone();
        // Shell-less only. Without npm-cli.js staging is skipped.
        let cli = mixdog_core_base::support::on_lane(self.lane, &cancel, move |lane| blocking::npm_cli_js(lane, &config))
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "npm-cli.js unresolved — staging skipped".to_owned());
        let outcome = match cli {
            Ok(cli) => self.install(&cli, &version, &verdir, &cancel).await,
            Err(error) => Err(error),
        };
        // The lock is released whatever happened above.
        let lock_dir = verdir;
        mixdog_core_base::support::on_lane(self.lane, &cancel, move |lane| blocking::release(lane, &lock_dir))
            .await
            .map_err(|error| error.to_string())?;
        outcome?;
        Ok(None)
    }
}


impl StagedInstaller {
    /// The install proper, with the lock held: npm into a private prefix, relocate, verify, mark.
    async fn install(&self, cli: &Path, version: &str, ver_dir: &Path, cancel: &CancellationToken) -> Result<(), String> {
        // npm's registry decides the proxy route.
        let registry = self.registry(cli, cancel).await;
        let proxy_env = self.proxy.npm_env(&registry).await;
        let prefix = ver_dir.join("install");
        let prepared = prefix.clone();
        let pkg_dir = ver_dir.join(blocking::PKG_SUBDIR);
        mixdog_core_base::support::on_lane(self.lane, cancel, move |lane| blocking::prepare(lane, &prepared, &pkg_dir))
            .await
            .map_err(|error| error.to_string())??;
        let code = self.npm_install(cli, version, &prefix, &proxy_env, cancel).await;
        if code != 0 {
            return Err(format!("npm install exited with code {code}"));
        }
        let (finish_version, finish_dir) = (version.to_owned(), ver_dir.to_owned());
        mixdog_core_base::support::on_lane(self.lane, cancel, move |lane| blocking::finish(lane, &finish_version, &finish_dir))
            .await
            .map_err(|error| error.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use mixdog_core_base::support::on_lane;
    use mixdog_spawn::LocalProcessManager;
    use mixdog_spawn::ProcessConfig;

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

    /// Writes `text` to `path` (parents created) as a maintenance-lane job.
    async fn put(path: &Path, text: &str) {
        let (path, text) = (path.to_owned(), text.to_owned());
        on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| {
            if let Some(parent) = path.parent() {
                mixdog_statefile::create_private_dir_all(lane, parent).map_err(|error| error.to_string())?;
            }
            let opts = mixdog_statefile::Opts { lock: false, ..mixdog_statefile::Opts::default() };
            mixdog_statefile::write_file(lane, &path, text.as_bytes(), &opts).map(|_| ()).map_err(|error| error.to_string())
        })
        .await
        .unwrap()
        .unwrap();
    }

    async fn present(path: &Path) -> bool {
        let path = path.to_owned();
        on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| mixdog_statefile::metadata(lane, &path).is_ok()).await.unwrap()
    }

    async fn dev(path: &Path) -> bool {
        let path = path.to_owned();
        on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| StagedInstaller::probe_dev_install(lane, &path)).await.unwrap()
    }

    async fn mkdir(path: &Path) {
        let path = path.to_owned();
        on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| mixdog_statefile::create_private_dir_all(lane, &path))
            .await
            .unwrap()
            .unwrap();
    }

    fn config(dir: &Path) -> StagedConfig {
        StagedConfig { data_dir: dir.join("data"), package_root: dir.join("pkg"), node: PathBuf::from("node"), electron: false }
    }

    fn installer(config: StagedConfig) -> StagedInstaller {
        let tokens = mixdog_rt::testing::tokens();
        let processes = Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default()));
        StagedInstaller::new(config, tokens.maintenance_io, Arc::new(SystemProxy::default()), Arc::new(Exec::new(processes)), false)
    }

    async fn fake_npm(dir: &Path) -> PathBuf {
        let cli = dir.join("npm-cli.js");
        put(&cli, FAKE_NPM).await;
        cli
    }

    /// The claim, install and release of one stage, with `cli` as the npm that runs.
    async fn staged(config: &StagedConfig, cli: &Path, version: &str) -> Result<(), String> {
        let installer = installer(config.clone());
        let cancel = CancellationToken::new();
        let (claim_config, claim_version) = (config.clone(), version.to_owned());
        let claimed = on_lane(installer.lane, &cancel, move |lane| blocking::claim(lane, &claim_config, &claim_version)).await.unwrap()?;
        let dir = match claimed {
            blocking::Claim::AlreadyStaged => return Ok(()),
            blocking::Claim::Held(dir) => dir,
        };
        let result = installer.install(cli, version, &dir, &cancel).await;
        on_lane(installer.lane, &cancel, move |lane| blocking::release(lane, &dir)).await.unwrap();
        result
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_staged_install_is_self_contained_and_marked_last() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        staged(&config, &fake_npm(dir.path()).await, "9.9.9").await.unwrap();
        let ver_dir = config.data_dir.join("staging").join("9.9.9");
        let pkg = ver_dir.join("mixdog");
        assert!(present(&pkg.join("src").join("cli.mjs")).await);
        // The hoisted dependencies travel with the package, and the install prefix is gone.
        assert!(present(&pkg.join("node_modules").join("dep")).await);
        assert!(!present(&ver_dir.join("install")).await);
        assert!(!present(&ver_dir.join(".staging.lock")).await);
        let bytes = mixdog_statefile::read_content(&ver_dir.join(".staged-complete.json")).unwrap().unwrap();
        let marker: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
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
        put(&cli, &FAKE_NPM.replace("process.env.FAKE_NPM_VERSION ||", "'1.0.0' ||")).await;
        let error = staged(&config, &cli, "9.9.9").await.unwrap_err();
        assert_eq!(error, "staged version 1.0.0 != 9.9.9");
        let ver_dir = config.data_dir.join("staging").join("9.9.9");
        assert!(!present(&ver_dir.join(".staged-complete.json")).await);
        assert!(!present(&ver_dir.join(".staging.lock")).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_npm_reports_its_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let cli = dir.path().join("npm-cli.js");
        put(&cli, "process.exit(3)").await;
        assert_eq!(staged(&config, &cli, "9.9.9").await.unwrap_err(), "npm install exited with code 3");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_live_lock_refuses_a_second_installer_and_a_dead_one_is_stolen() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let ver_dir = config.data_dir.join("staging").join("9.9.9");
        let lock = ver_dir.join(".staging.lock");
        put(&lock, &format!("{} 0", std::process::id())).await;
        let cli = fake_npm(dir.path()).await;
        assert_eq!(staged(&config, &cli, "9.9.9").await.unwrap_err(), "staging in progress");
        // pid 0 names no process.
        put(&lock, "0 0").await;
        staged(&config, &cli, "9.9.9").await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_dev_install_is_a_checkout_or_a_package_outside_node_modules() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = dir.path().join("node_modules").join("mixdog");
        mkdir(&checkout.join(".git")).await;
        assert!(dev(&checkout).await);
        let installed = dir.path().join("node_modules").join("other");
        mkdir(&installed).await;
        assert!(!dev(&installed).await);
        assert!(dev(&dir.path().join("src").join("mixdog")).await);
    }
}

pub(crate) mod blocking {
    use std::io::Write;
    use std::path::Path;
    use std::path::PathBuf;
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

    pub const PACKAGE_NAME: &str = "mixdog";
    const MARKER_NAME: &str = ".staged-complete.json";
    /// The self-contained package directory inside a staging version folder.
    pub const PKG_SUBDIR: &str = "mixdog";
    const STALE_INPROGRESS: Duration = Duration::from_secs(10 * 60);
    pub const DEFAULT_NPM_REGISTRY: &str = "https://registry.npmjs.org/";

    pub enum Claim {
        AlreadyStaged,
        /// The staging lock of this version directory is held by this install.
        Held(PathBuf),
    }

    fn staging_root(config: &StagedConfig) -> PathBuf {
        config.data_dir.join("staging")
    }

    fn present<L: mixdog_statefile::IoLane>(lane: &InLane<L>, path: &Path) -> bool {
        mixdog_statefile::metadata(lane, path).is_ok()
    }

    pub fn is_dev_install<L: mixdog_statefile::IoLane>(lane: &InLane<L>, package_root: &Path) -> bool {
        if present(lane, &package_root.join(".git")) {
            return true;
        }
        let normalized = package_root.to_string_lossy().replace('\\', "/").to_lowercase();
        !format!("/{normalized}/").contains("/node_modules/")
    }

    fn marker(ver_dir: &Path) -> Option<serde_json::Value> {
        let bytes = mixdog_statefile::read_content(&ver_dir.join(MARKER_NAME)).ok()??;
        serde_json::from_slice(&bytes).ok()
    }

    fn package_complete(lane: &InLane<MaintenanceIo>, pkg_dir: &Path) -> bool {
        present(lane, &pkg_dir.join("package.json")) && present(lane, &pkg_dir.join("src").join("cli.mjs"))
    }

    /// `isStagedComplete`.
    fn is_staged_complete(lane: &InLane<MaintenanceIo>, root: &Path, version: &str) -> bool {
        let ver_dir = root.join(version);
        let Some(marker) = marker(&ver_dir) else { return false };
        if marker["version"].as_str() != Some(version) {
            return false;
        }
        let pkg_dir = marker["pkgDir"].as_str().map_or_else(|| ver_dir.join(PKG_SUBDIR), PathBuf::from);
        package_complete(lane, &pkg_dir)
    }

    /// `isStagedComplete(version)` over the staging area of `config`.
    pub fn is_staged(lane: &InLane<MaintenanceIo>, config: &StagedConfig, version: &str) -> bool {
        is_staged_complete(lane, &staging_root(config), version)
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
        if is_staged_complete(lane, &root, version) {
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

    /// `npmCliJsPath`: npm's `npm-cli.js` beside the interpreter (Windows, Unix and Homebrew
    /// layouts), else through an `npm` shim on `PATH` whose real path is npm's package.
    pub fn npm_cli_js(lane: &InLane<MaintenanceIo>, config: &StagedConfig) -> Option<PathBuf> {
        let mut candidates = Vec::new();
        if let Some(path) = std::env::var_os("npm_execpath").map(PathBuf::from)
            && path.to_string_lossy().to_lowercase().ends_with("npm-cli.js")
        {
            candidates.push(path);
        }
        let mut exec_dirs = Vec::new();
        if let Some(dir) = config.node.parent() {
            exec_dirs.push(dir.to_path_buf());
        }
        if let Some(dir) = mixdog_workspace::pathguard::canonical(&config.node).ok().and_then(|real| real.parent().map(Path::to_path_buf))
            && !exec_dirs.contains(&dir)
        {
            exec_dirs.push(dir);
        }
        for dir in &exec_dirs {
            candidates.push(dir.join("node_modules").join("npm").join("bin").join("npm-cli.js"));
            candidates.push(dir.join("..").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"));
            candidates.push(dir.join("..").join("libexec").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"));
        }
        if let Some(found) = candidates.into_iter().find(|candidate| present(lane, candidate)) {
            return Some(found);
        }
        let path = std::env::var_os("PATH").or_else(|| std::env::var_os("Path")).unwrap_or_default();
        for dir in std::env::split_paths(&path).filter(|dir| !dir.as_os_str().is_empty()) {
            let shims: &[&str] = if cfg!(windows) { &["npm", "npm.cmd"] } else { &["npm"] };
            for shim in shims {
                let Ok(real) = mixdog_workspace::pathguard::canonical(&dir.join(shim)) else { continue };
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
                if present(lane, &cli) {
                    return Some(cli);
                }
            }
        }
        None
    }

    /// `new URL(text).href` for the registry URLs npm answers with.
    pub fn url_href(text: &str) -> Option<String> {
        reqwest::Url::parse(text).ok().map(|url| url.to_string())
    }

    /// Clears a failed earlier attempt and makes the private install prefix.
    pub fn prepare(lane: &InLane<MaintenanceIo>, prefix: &Path, pkg_dir: &Path) -> Result<(), String> {
        let _ = mixdog_statefile::remove_dir_all(lane, prefix);
        let _ = mixdog_statefile::remove_dir_all(lane, pkg_dir);
        mixdog_statefile::create_private_dir_all(lane, prefix).map_err(|error| error.to_string())
    }

    /// After npm: verify the version, relocate the package, mark it complete.
    pub fn finish(lane: &InLane<MaintenanceIo>, version: &str, ver_dir: &Path) -> Result<(), String> {
        let rm = |dir: &Path| {
            let _ = mixdog_statefile::remove_dir_all(lane, dir);
        };
        let prefix = ver_dir.join("install");
        let pkg_dir = ver_dir.join(PKG_SUBDIR);
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
        if !present(lane, &pkg_dir.join("src").join("cli.mjs")) {
            return Err("staged cli.mjs missing".into());
        }
        // Written last: its presence is the completion signal for the swap.
        let value = json!({ "version": version, "pkgDir": pkg_dir.to_string_lossy(), "stagedAt": u64::try_from(now_ms()).unwrap_or(0) });
        let opts = mixdog_statefile::Opts { compact: true, ..mixdog_statefile::Opts::default() };
        mixdog_statefile::write_json(lane, &ver_dir.join(MARKER_NAME), &value, &opts).map_err(|error| error.to_string())?;
        Ok(())
    }
}