//! The [`UpdateInstaller`] of the product: the staged background install of Node's
//! `runtime/shared/staged-update.mjs` (`runStagedInstall`).
//!
//! `npm install mixdog@<version> --prefix <data>/staging/<version>/install` runs in a private
//! per-version directory, the package is relocated into a self-contained
//! `<data>/staging/<version>/mixdog` (its hoisted dependencies nested beneath), its
//! `package.json` version is verified, its native runtime is fetched and verified into the user's runtime cache
//! (`bin/mixdog-runtime.mjs prefetch` of the staged package; the package carries no program), and only once that runtime
//! is ready the completion marker `.staged-complete.json` is written. The live package directory is never touched: the swap
//! into place happens at the next clean launch, in the npm package's launcher (`bin/mixdog.mjs`, `bin/staged-swap.mjs`),
//! which reads the same marker. A staging lock (`.staging.lock`, `<pid> <ms>`) keeps two installers of one version
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
/// Where the runtime archives are downloaded from (the GitHub release of the version): the route of its proxy.
const RUNTIME_ORIGIN: &str = "https://github.com/";
/// `updater` tells the package's postinstall (`bin/mixdog-runtime.mjs`) that this installer fetches the runtime itself.
const RUNTIME_PROVISION_VAR: &str = "MIXDOG_RUNTIME_PROVISION";

/// Where the install lives.
#[derive(Debug, Clone)]
pub struct StagedConfig {
    /// `<data>`: the staging directory is `<data_dir>/staging`.
    pub data_dir: PathBuf,
    /// The installed package directory (`<prefix>/node_modules/mixdog`), `JsRuntime::package_root`.
    pub package_root: PathBuf,
}

pub struct StagedInstaller {
    config: StagedConfig,
    lane: MaintenanceIo,
    proxy: Arc<SystemProxy>,
    exec: Arc<Exec>,
    dev: bool,
    /// The facts npm is looked for by: the process's (`PATH`, `npm_execpath`); a test names its own.
    npm_env: blocking::NpmEnv,
    packaged_desktop: bool,
}

/// What the user reads when this install has no npm to stage an update with (`stage` ends with it, so `/update` shows it).
fn no_npm_message(version: &str) -> String {
    format!(
        "npm was not found on PATH, and Mixdog stages its updates with npm. Install Node.js (it brings npm) and try again, or run `npm install -g mixdog@{version}` in a terminal that has it."
    )
}

impl StagedInstaller {
    /// `dev` is [`Self::probe_dev_install`] of the package root, asked once by the composition
    /// (it probes the file system) and kept for the life of the process, as Node's
    /// `isDevInstall()` is a property of the module location.
    pub fn new(config: StagedConfig, lane: MaintenanceIo, proxy: Arc<SystemProxy>, exec: Arc<Exec>, dev: bool) -> Self {
        Self { config, lane, proxy, exec, dev, npm_env: blocking::NpmEnv::process(), packaged_desktop: false }
    }

    /// The packaged desktop's core: `electron-updater` owns the update there (the core is in the app's `resources`), so this
    /// installer neither stages nor announces. The composition knows it from the install's `js-runtime.json` (`electron`).
    pub fn for_packaged_desktop(mut self, packaged_desktop: bool) -> Self {
        self.packaged_desktop = packaged_desktop;
        self
    }

    /// Looks for npm by `env` instead of the process's facts.
    #[cfg(test)]
    pub(crate) fn with_npm_env(mut self, env: blocking::NpmEnv) -> Self {
        self.npm_env = env;
        self
    }

    /// The user's Node runs npm-cli.js directly; the production resolver never returns a shell shim.
    fn npm_spec(&self, npm: &blocking::NpmCommand, args: &[String]) -> ExecSpec {
        let mut spec = ExecSpec::new(npm.program.to_string_lossy(), &self.config.data_dir);
        spec.args = npm.lead.iter().cloned().chain(args.iter().cloned()).collect();
        spec
    }

    /// `npmRegistry`: the registry npm installs from (its `.npmrc` files included); npm's
    /// default when npm cannot say.
    async fn registry(&self, npm: &blocking::NpmCommand, cancel: &CancellationToken) -> String {
        let mut spec = self.npm_spec(npm, &["config".into(), "get".into(), "registry".into()]);
        spec.time_limit = Some(REGISTRY_TIMEOUT);
        let asked = match self.exec.run(spec, cancel).await {
            Ok(output) if output.success() => blocking::url_href(output.stdout_text().trim()),
            _ => None,
        };
        asked.unwrap_or_else(|| blocking::DEFAULT_NPM_REGISTRY.to_owned())
    }

    /// `npm install mixdog@<version> --prefix <prefix>`; its exit code, `-1` when it did not run
    /// or ended by a signal.
    async fn npm_install(
        &self,
        npm: &blocking::NpmCommand,
        version: &str,
        prefix: &Path,
        proxy_env: &[(&'static str, String)],
        cancel: &CancellationToken,
    ) -> i32 {
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
        let mut spec = self.npm_spec(npm, &args);
        spec.env_set.extend(proxy_env.iter().map(|(key, value)| ((*key).to_owned(), value.clone())));
        // npm is routed as its registry is, which need not reach GitHub: the package's postinstall leaves the runtime to
        // `provision_runtime`, which is routed as GitHub is.
        spec.env_set.push((RUNTIME_PROVISION_VAR.to_owned(), "updater".to_owned()));
        spec.max_output = NPM_MAX_OUTPUT;
        match self.exec.run(spec, cancel).await {
            Ok(output) => output.code.unwrap_or(-1),
            Err(_) => -1,
        }
    }

    /// The verified native runtime of the staged package in the user's cache: `bin/mixdog-runtime.mjs prefetch` of that package,
    /// run by the node that runs npm (`resolve_npm`: `program` is that node), routed as GitHub is. The postinstall left it to
    /// this; a runtime that is ready is not fetched again.
    async fn provision_runtime(&self, npm: &blocking::NpmCommand, pkg_dir: &Path, cancel: &CancellationToken) -> Result<(), String> {
        let mut spec = ExecSpec::new(npm.program.to_string_lossy(), &self.config.data_dir);
        spec.args = vec![pkg_dir.join("bin").join("mixdog-runtime.mjs").to_string_lossy().into_owned(), "prefetch".to_owned()];
        spec.env_set.extend(self.proxy.npm_env(RUNTIME_ORIGIN).await.into_iter().map(|(key, value)| (key.to_owned(), value)));
        spec.env_set.push(("MIXDOG_DATA_DIR".to_owned(), self.config.data_dir.to_string_lossy().into_owned()));
        spec.max_output = NPM_MAX_OUTPUT;
        let failed = |reason: String| format!("the native runtime of the staged version could not be fetched: {reason}");
        match self.exec.run(spec, cancel).await {
            Ok(output) if output.success() => Ok(()),
            Ok(output) => {
                let stderr = output.stderr_text();
                let said = stderr.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default().to_owned();
                Err(failed(if said.is_empty() { format!("exit code {}", output.code.unwrap_or(-1)) } else { said }))
            }
            Err(error) => Err(failed(error.to_string())),
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

    fn managed_by_desktop(&self) -> bool {
        self.packaged_desktop
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
        if self.packaged_desktop {
            return Err(mixdog_core_domains::domains::update::MANAGED_BY_DESKTOP.to_owned());
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
        // Shell-less only. Without an npm to run, staging is skipped.
        let npm_env = self.npm_env.clone();
        let npm = mixdog_core_base::support::on_lane(self.lane, &cancel, move |lane| blocking::resolve_npm(lane, &npm_env))
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| no_npm_message(&version));
        let outcome = match npm {
            Ok(npm) => self.install(&npm, &version, &verdir, &cancel).await,
            Err(error) => Err(error),
        };
        // The lock is released whatever happened above.
        let lock_dir = verdir;
        mixdog_core_base::support::on_lane(self.lane, &cancel, move |lane| blocking::release(lane, &lock_dir)).await.map_err(|error| error.to_string())?;
        outcome?;
        Ok(None)
    }
}

impl StagedInstaller {
    /// The install proper, with the lock held: npm into a private prefix, relocate, verify, fetch the runtime, mark.
    async fn install(&self, npm: &blocking::NpmCommand, version: &str, ver_dir: &Path, cancel: &CancellationToken) -> Result<(), String> {
        // npm's registry decides the proxy route.
        let registry = self.registry(npm, cancel).await;
        let proxy_env = self.proxy.npm_env(&registry).await;
        let prefix = ver_dir.join("install");
        let prepared = prefix.clone();
        let pkg_dir = ver_dir.join(blocking::PKG_SUBDIR);
        mixdog_core_base::support::on_lane(self.lane, cancel, move |lane| blocking::prepare(lane, &prepared, &pkg_dir))
            .await
            .map_err(|error| error.to_string())??;
        let code = self.npm_install(npm, version, &prefix, &proxy_env, cancel).await;
        if code != 0 {
            return Err(format!("npm install exited with code {code}"));
        }
        let (relocate_version, relocate_dir) = (version.to_owned(), ver_dir.to_owned());
        let pkg_dir = mixdog_core_base::support::on_lane(self.lane, cancel, move |lane| blocking::relocate(lane, &relocate_version, &relocate_dir))
            .await
            .map_err(|error| error.to_string())??;
        self.provision_runtime(npm, &pkg_dir, cancel).await?;
        let (mark_version, mark_dir, data_dir) = (version.to_owned(), ver_dir.to_owned(), self.config.data_dir.clone());
        mixdog_core_base::support::on_lane(self.lane, cancel, move |lane| blocking::mark(lane, &mark_version, &mark_dir, &data_dir))
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

    /// What the staged package's runtime command does when the installer runs it (`<node> <pkg>/bin/mixdog-runtime.mjs prefetch`).
    #[derive(Clone, Copy)]
    enum Runtime {
        /// Fetches: the cache folder of the manifest's entry, with its files and its marker.
        Fetches,
        /// Fails, and says why.
        Fails,
        /// Ends well and leaves nothing.
        Nothing,
    }

    /// The version every fake runtime is for, and its archive's digest.
    const STAGED: &str = "9.9.9";
    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn program_suffix() -> &'static str {
        if cfg!(windows) { ".exe" } else { "" }
    }

    /// The runtime manifest the fake package carries, its `version` written by the fake script.
    fn manifest_json(key: &str, version: &str) -> String {
        let s = program_suffix();
        format!(
            r#"{{"schema":1,"repository":"o/r","tag":"v{STAGED}","targets":{{"{key}":{{"asset":"mixdog-runtime-{key}.tar.gz","length":1,"sha256":"{DIGEST}","version":"{version}","buildId":"b","files":{{"mixdog{s}":0,"mixdogd{s}":0,"mixdog-askpass{s}":0}}}}}}}}"#
        )
    }

    /// The marker of the fake runtime of `key`, as `bin/runtime.mjs` writes it.
    fn marker_json(key: &str, digest: &str) -> String {
        let s = program_suffix();
        format!(
            r#"{{"key":"{key}","asset":"mixdog-runtime-{key}.tar.gz","length":1,"sha256":"{digest}","version":"{STAGED}","buildId":"b","files":{{"mixdog{s}":0,"mixdogd{s}":0,"mixdog-askpass{s}":0}}}}"#
        )
    }

    /// The runtime folder of the fake package of this host under `data`.
    fn runtime_folder(data: &Path) -> PathBuf {
        data.join("runtime").join(STAGED).join(format!("{}-{DIGEST}", blocking::host_keys().remove(0)))
    }

    /// The shim script of an `npm` that installs what `npm install mixdog@<v> --prefix <p>`
    /// installs; `version` pins what the package claims to be, else it is the requested one. Its postinstall fails the install
    /// when it fetches the runtime itself, as it does behind a proxy npm's registry route does not use.
    fn fake_npm_script(version: Option<&str>) -> String {
        fake_npm_script_with(version, Runtime::Fetches)
    }

    /// The script also stands for the node that runs the staged package's runtime command, which does what `runtime` says.
    fn fake_npm_script_with(version: Option<&str>, runtime: Runtime) -> String {
        let key = blocking::host_keys().remove(0);
        if cfg!(windows) { fake_npm_cmd(version, runtime, &key) } else { fake_npm_sh(version, runtime, &key) }
    }

    fn fake_npm_cmd(version: Option<&str>, runtime: Runtime, key: &str) -> String {
        let fetched = match runtime {
            Runtime::Fetches => vec![
                format!("set \"D=%MIXDOG_DATA_DIR%\\runtime\\{STAGED}\\{key}-{DIGEST}\""),
                "mkdir \"%D%\"".to_owned(),
                "type nul > \"%D%\\mixdog.exe\"".to_owned(),
                "type nul > \"%D%\\mixdogd.exe\"".to_owned(),
                "type nul > \"%D%\\mixdog-askpass.exe\"".to_owned(),
                format!("> \"%D%\\.ready.json\" echo {}", marker_json(key, DIGEST)),
                "exit /b 0".to_owned(),
            ],
            Runtime::Fails => vec![">&2 echo mixdog: the native runtime could not be fetched: offline".to_owned(), "exit /b 3".to_owned()],
            Runtime::Nothing => vec!["exit /b 0".to_owned()],
        };
        let version =
            version.map_or_else(|| "for /f \"tokens=2 delims=@\" %%v in (\"%SPEC%\") do set \"V=%%v\"".to_owned(), |version| format!("set \"V={version}\""));
        let manifest = format!("> \"%PKG%\\bin\\runtime-manifest.json\" echo {}", manifest_json(key, "%V%"));
        let mut lines: Vec<String> = [
            "@echo off",
            "if \"%~1\"==\"config\" (echo https://registry.example.test/& exit /b 0)",
            "if \"%~nx1\"==\"mixdog-runtime.mjs\" goto runtime",
            "set \"SPEC=%~2\"",
            "set \"PREFIX=%~4\"",
            &version,
            "set \"PKG=%PREFIX%\\node_modules\\mixdog\"",
            "mkdir \"%PKG%\\bin\"",
            "mkdir \"%PKG%\\src\"",
            "> \"%PKG%\\package.json\" echo {\"name\":\"mixdog\",\"version\":\"%V%\"}",
            "type nul > \"%PKG%\\bin\\mixdog.mjs\"",
            "type nul > \"%PKG%\\bin\\runtime.mjs\"",
            "type nul > \"%PKG%\\src\\cli.mjs\"",
            &manifest,
            "if not \"%MIXDOG_RUNTIME_PROVISION%\"==\"updater\" (>&2 echo mixdog: fetching the runtime failed: connect ETIMEDOUT& exit /b 1)",
            "mkdir \"%PREFIX%\\node_modules\\dep\"",
            "exit /b 0",
            ":runtime",
        ]
        .map(str::to_owned)
        .into();
        lines.extend(fetched);
        lines.push(String::new());
        lines.join("\r\n")
    }

    fn fake_npm_sh(version: Option<&str>, runtime: Runtime, key: &str) -> String {
        let fetched = match runtime {
            Runtime::Fetches => vec![
                format!("D=\"$MIXDOG_DATA_DIR/runtime/{STAGED}/{key}-{DIGEST}\""),
                "mkdir -p \"$D\"".to_owned(),
                ": > \"$D/mixdog\" && : > \"$D/mixdogd\" && : > \"$D/mixdog-askpass\"".to_owned(),
                format!("printf '%s' '{}' > \"$D/.ready.json\"", marker_json(key, DIGEST)),
                "exit 0".to_owned(),
            ],
            Runtime::Fails => vec!["echo 'mixdog: the native runtime could not be fetched: offline' >&2".to_owned(), "exit 3".to_owned()],
            Runtime::Nothing => vec!["exit 0".to_owned()],
        };
        let version = version.map_or_else(|| "V=${2#*@}".to_owned(), |version| format!("V={version}"));
        let mut lines: Vec<String> =
            ["#!/bin/sh", "if [ \"$1\" = config ]; then echo https://registry.example.test/; exit 0; fi", "case \"$1\" in *mixdog-runtime.mjs)"]
                .map(str::to_owned)
                .into();
        lines.extend(fetched);
        lines.extend(
            [
                ";; esac",
                &version,
                "PKG=\"$4/node_modules/mixdog\"",
                "mkdir -p \"$PKG/bin\" \"$PKG/src\" \"$4/node_modules/dep\"",
                "printf '{\"name\":\"mixdog\",\"version\":\"%s\"}' \"$V\" > \"$PKG/package.json\"",
                ": > \"$PKG/bin/mixdog.mjs\" && : > \"$PKG/bin/runtime.mjs\" && : > \"$PKG/src/cli.mjs\"",
                &format!("printf '{}' \"$V\" > \"$PKG/bin/runtime-manifest.json\"", manifest_json(key, "%s")),
                "[ \"$MIXDOG_RUNTIME_PROVISION\" = updater ] || { echo 'mixdog: fetching the runtime failed: connect ETIMEDOUT' >&2; exit 1; }",
            ]
            .map(str::to_owned),
        );
        lines.push(String::new());
        lines.join("\n")
    }

    /// The name of an `npm` shim file on this platform.
    fn shim_name() -> &'static str {
        if cfg!(windows) { "npm.cmd" } else { "npm" }
    }

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
        on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| mixdog_statefile::metadata(lane, &path).is_ok())
            .await
            .unwrap()
    }

    async fn dev(path: &Path) -> bool {
        let path = path.to_owned();
        on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| StagedInstaller::probe_dev_install(lane, &path))
            .await
            .unwrap()
    }

    async fn mkdir(path: &Path) {
        let path = path.to_owned();
        on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| mixdog_statefile::create_private_dir_all(lane, &path))
            .await
            .unwrap()
            .unwrap();
    }

    fn config(dir: &Path) -> StagedConfig {
        StagedConfig { data_dir: dir.join("data"), package_root: dir.join("pkg") }
    }

    fn installer(config: StagedConfig) -> StagedInstaller {
        let tokens = mixdog_rt::testing::tokens();
        let processes = Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default()));
        StagedInstaller::new(config, tokens.maintenance_io, Arc::new(SystemProxy::default()), Arc::new(Exec::new(processes)), false)
    }

    /// Writes an npm shim with `script` into `dir` and returns the command that runs it.
    #[allow(clippy::disallowed_methods, reason = "the test marks its own shim file executable")]
    async fn shim(dir: &Path, script: &str) -> blocking::NpmCommand {
        let path = dir.join(shim_name());
        put(&path, script).await;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        blocking::NpmCommand { program: path, lead: Vec::new() }
    }

    async fn fake_npm(dir: &Path) -> blocking::NpmCommand {
        shim(dir, &fake_npm_script(None)).await
    }

    async fn resolved(env: blocking::NpmEnv) -> Option<blocking::NpmCommand> {
        on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| blocking::resolve_npm(lane, &env)).await.unwrap()
    }

    /// The claim, install and release of one stage, with `npm` as the npm that runs.
    async fn staged(config: &StagedConfig, npm: &blocking::NpmCommand, version: &str) -> Result<(), String> {
        let installer = installer(config.clone());
        let cancel = CancellationToken::new();
        let (claim_config, claim_version) = (config.clone(), version.to_owned());
        let claimed = on_lane(installer.lane, &cancel, move |lane| blocking::claim(lane, &claim_config, &claim_version)).await.unwrap()?;
        let dir = match claimed {
            blocking::Claim::AlreadyStaged => return Ok(()),
            blocking::Claim::Held(dir) => dir,
        };
        let result = installer.install(npm, version, &dir, &cancel).await;
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
        assert!(present(&pkg.join("bin").join("mixdog.mjs")).await);
        // The hoisted dependencies travel with the package, and the install prefix is gone.
        assert!(present(&pkg.join("node_modules").join("dep")).await);
        assert!(!present(&ver_dir.join("install")).await);
        assert!(!present(&ver_dir.join(".staging.lock")).await);
        let bytes = mixdog_statefile::read_content(&ver_dir.join(".staged-complete.json")).unwrap().unwrap();
        let marker: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(marker["version"], "9.9.9");
        assert_eq!(marker["pkgDir"], pkg.to_string_lossy().as_ref());
        // The installer fetched the runtime into this data folder's cache; npm's postinstall left it to it.
        assert!(present(&runtime_folder(&config.data_dir).join(".ready.json")).await);
        // A second call finds it complete and installs nothing.
        staged(&config, &blocking::NpmCommand { program: PathBuf::from("does-not-exist"), lead: Vec::new() }, "9.9.9").await.unwrap();
    }

    /// `package_complete_for` of `pkg` with the cache of `data`, for `keys`.
    async fn complete(pkg: &Path, data: &Path, keys: Vec<String>) -> bool {
        let (pkg, data) = (pkg.to_owned(), data.to_owned());
        on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| blocking::package_complete_for(lane, &pkg, &data, &keys))
            .await
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_version_mismatch_leaves_no_marker_and_frees_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let npm = shim(dir.path(), &fake_npm_script(Some("1.0.0"))).await;
        let error = staged(&config, &npm, "9.9.9").await.unwrap_err();
        assert_eq!(error, "staged version 1.0.0 != 9.9.9");
        let ver_dir = config.data_dir.join("staging").join("9.9.9");
        assert!(!present(&ver_dir.join(".staged-complete.json")).await);
        assert!(!present(&ver_dir.join(".staging.lock")).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_staged_package_whose_runtime_is_not_ready_is_never_marked_complete() {
        for (runtime, expected) in [
            (Runtime::Fails, "the native runtime of the staged version could not be fetched: mixdog: the native runtime could not be fetched: offline"),
            (Runtime::Nothing, "staged package is incomplete"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let config = config(dir.path());
            let npm = shim(dir.path(), &fake_npm_script_with(None, runtime)).await;
            let error = staged(&config, &npm, "9.9.9").await.unwrap_err();
            assert!(error.starts_with(expected), "{error}");
            let ver_dir = config.data_dir.join("staging").join("9.9.9");
            assert!(!present(&ver_dir.join(".staged-complete.json")).await, "no marker: the swap would replace a working install");
            assert!(!present(&ver_dir.join(".staging.lock")).await);
            assert!(!installer(config.clone()).is_staged("9.9.9").await);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_staged_package_is_complete_only_with_the_verified_runtime_of_this_host_for_its_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        staged(&config, &fake_npm(dir.path()).await, "9.9.9").await.unwrap();
        let pkg = config.data_dir.join("staging").join("9.9.9").join("mixdog");
        let data = config.data_dir.clone();
        assert!(complete(&pkg, &data, blocking::host_keys()).await);
        // The manifest names no runtime for another host.
        assert!(!complete(&pkg, &data, vec!["other-arch".to_owned()]).await);
        // Another data folder holds no runtime.
        assert!(!complete(&pkg, &dir.path().join("elsewhere"), blocking::host_keys()).await);
        let folder = runtime_folder(&data);
        let key = blocking::host_keys().remove(0);
        // A marker of another archive (a runtime of other bytes) does not count.
        put(&folder.join(".ready.json"), &marker_json(&key, &"f".repeat(64))).await;
        assert!(!complete(&pkg, &data, blocking::host_keys()).await);
        put(&folder.join(".ready.json"), &marker_json(&key, DIGEST)).await;
        assert!(complete(&pkg, &data, blocking::host_keys()).await);
        // A file of the runtime that is gone, or of another size, does not count.
        let core = folder.join(format!("mixdogd{}", program_suffix()));
        put(&core, "x").await;
        assert!(!complete(&pkg, &data, blocking::host_keys()).await);
        put(&core, "").await;
        assert!(complete(&pkg, &data, blocking::host_keys()).await);
        // Without the command an install made by 1.4.5 links to, the swap would leave that install without one.
        let legacy = pkg.join("src").join("cli.mjs");
        let removed = legacy.clone();
        on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| mixdog_statefile::remove_file(lane, &removed))
            .await
            .unwrap()
            .unwrap();
        assert!(!complete(&pkg, &data, blocking::host_keys()).await);
        put(&legacy, "").await;
        assert!(complete(&pkg, &data, blocking::host_keys()).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_npm_reports_its_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let npm = shim(dir.path(), if cfg!(windows) { "@echo off\r\nexit /b 3\r\n" } else { "#!/bin/sh\nexit 3\n" }).await;
        assert_eq!(staged(&config, &npm, "9.9.9").await.unwrap_err(), "npm install exited with code 3");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_live_lock_refuses_a_second_installer_and_a_dead_one_is_stolen() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let ver_dir = config.data_dir.join("staging").join("9.9.9");
        let lock = ver_dir.join(".staging.lock");
        put(&lock, &format!("{} 0", std::process::id())).await;
        let npm = fake_npm(dir.path()).await;
        assert_eq!(staged(&config, &npm, "9.9.9").await.unwrap_err(), "staging in progress");
        // pid 0 names no process.
        put(&lock, "0 0").await;
        staged(&config, &npm, "9.9.9").await.unwrap();
    }

    /// An install with no npm on PATH says so plainly, with what to do, and leaves no lock behind.
    #[tokio::test(flavor = "multi_thread")]
    async fn staging_without_npm_on_path_says_so_plainly() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let empty = tempfile::tempdir().unwrap();
        let installer = installer(config.clone()).with_npm_env(blocking::NpmEnv { exec_path: None, path: empty.path().as_os_str().to_owned() });
        let error = installer.stage("9.9.9").await.unwrap_err();
        assert!(error.starts_with("npm was not found on PATH"), "{error}");
        assert!(error.contains("npm install -g mixdog@9.9.9"), "{error}");
        assert!(!error.contains("npm-cli.js"), "{error}");
        assert!(!present(&config.data_dir.join("staging").join("9.9.9").join(".staging.lock")).await);
        assert!(!installer.is_staged("9.9.9").await);
    }

    /// The packaged desktop's core stages nothing, even with an npm at hand: electron-updater is the only path there.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_packaged_desktop_installer_stages_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let _npm = fake_npm(dir.path()).await;
        let installer =
            installer(config.clone()).for_packaged_desktop(true).with_npm_env(blocking::NpmEnv { exec_path: None, path: dir.path().as_os_str().to_owned() });
        assert!(installer.managed_by_desktop());
        assert_eq!(installer.stage("9.9.9").await.unwrap_err(), mixdog_core_domains::domains::update::MANAGED_BY_DESKTOP);
        assert!(!present(&config.data_dir.join("staging")).await, "no staging folder is made");
    }

    /// A shell shim alone must not turn the original shell-less staging into a shell spawn.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_npm_shim_without_node_is_not_executed() {
        let dir = tempfile::tempdir().unwrap();
        let _npm = fake_npm(dir.path()).await;
        let found = resolved(blocking::NpmEnv { exec_path: None, path: dir.path().as_os_str().to_owned() }).await;
        assert_eq!(found, None);
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(resolved(blocking::NpmEnv { exec_path: None, path: empty.path().as_os_str().to_owned() }).await, None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn npm_execpath_precedes_adjacent_cli_and_no_shell_fallback_exists() {
        let dir = tempfile::tempdir().unwrap();
        let node = dir.path().join(if cfg!(windows) { "node.exe" } else { "node" });
        put(&node, "").await;
        let _shim = fake_npm(dir.path()).await;
        let env = || blocking::NpmEnv { exec_path: None, path: dir.path().as_os_str().to_owned() };
        assert_eq!(resolved(env()).await, None);
        let adjacent = dir.path().join("node_modules").join("npm").join("bin").join("npm-cli.js");
        let explicit = dir.path().join("explicit/npm-cli.js");
        put(&adjacent, "").await;
        put(&explicit, "").await;
        let mut supplied = env();
        supplied.exec_path = Some(explicit.clone());
        assert_eq!(resolved(supplied).await, Some(blocking::NpmCommand { program: node.clone(), lead: vec![explicit.to_string_lossy().into_owned()] }));
        let mut missing = env();
        missing.exec_path = Some(dir.path().join("missing/npm-cli.js"));
        assert_eq!(resolved(missing).await, Some(blocking::NpmCommand { program: node, lead: vec![adjacent.to_string_lossy().into_owned()] }));
    }

    /// With only a `node` on `PATH`, npm's `npm-cli.js` beside it is run by that node.
    #[tokio::test(flavor = "multi_thread")]
    async fn only_a_node_on_path_runs_the_npm_cli_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let node = dir.path().join(if cfg!(windows) { "node.exe" } else { "node" });
        put(&node, "").await;
        assert_eq!(resolved(blocking::NpmEnv { exec_path: None, path: dir.path().as_os_str().to_owned() }).await, None);
        let cli = dir.path().join("node_modules").join("npm").join("bin").join("npm-cli.js");
        put(&cli, "").await;
        let found = resolved(blocking::NpmEnv { exec_path: None, path: dir.path().as_os_str().to_owned() }).await.unwrap();
        assert_eq!(found, blocking::NpmCommand { program: node, lead: vec![cli.to_string_lossy().into_owned()] });
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

    /// The runtime manifest the package carries (`bin/runtime.mjs` RUNTIME_MANIFEST), beside its launcher.
    const RUNTIME_MANIFEST: &str = "runtime-manifest.json";
    /// The marker a runtime folder of the cache holds once it is complete (`bin/runtime.mjs` READY_FILE).
    const READY_FILE: &str = ".ready.json";
    /// The command an install made by 1.4.5 links to; a swap never rewrites that link.
    const LEGACY_ENTRY: &str = "src/cli.mjs";

    /// The `<os>-<arch>` keys of the runtimes this host can run, in the launcher's order
    /// (`nativeCandidates` of `bin/native-layout.mjs`: Windows on Arm also runs the x64 program).
    pub fn host_keys() -> Vec<String> {
        let os = match std::env::consts::OS {
            "windows" => "win32",
            "macos" => "darwin",
            other => other,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        let mut keys = vec![format!("{os}-{arch}")];
        if os == "win32" && arch == "arm64" {
            keys.push("win32-x64".to_owned());
        }
        keys
    }

    /// A staged package is complete only when it can run here: the launcher, the runtime module and the 1.4.5 command, and the
    /// verified runtime of the first of `keys` its manifest names ready in the cache under `data_dir`. Mirrors `packageComplete`
    /// of `bin/staged-swap.mjs`, which asks again before the installed package is replaced.
    pub(super) fn package_complete_for(lane: &InLane<MaintenanceIo>, pkg_dir: &Path, data_dir: &Path, keys: &[String]) -> bool {
        let has = |path: PathBuf| present(lane, &path);
        has(pkg_dir.join("package.json"))
            && has(pkg_dir.join("bin").join("mixdog.mjs"))
            && has(pkg_dir.join("bin").join("runtime.mjs"))
            && has(pkg_dir.join(LEGACY_ENTRY))
            && runtime_ready(lane, pkg_dir, data_dir, keys)
    }

    fn read_json(path: &Path) -> Option<serde_json::Value> {
        serde_json::from_slice(&mixdog_statefile::read_content(path).ok()??).ok()
    }

    /// `readyRuntime` of `bin/runtime.mjs` for the package's manifest: the runtime folder `<data>/runtime/<version>/<key>-<sha256>`
    /// holds the marker of exactly this manifest entry, and every file the entry lists at its size.
    fn runtime_ready(lane: &InLane<MaintenanceIo>, pkg_dir: &Path, data_dir: &Path, keys: &[String]) -> bool {
        let Some(version) = read_json(&pkg_dir.join("package.json")).and_then(|package| package["version"].as_str().map(str::to_owned)) else { return false };
        let Some(manifest) = read_json(&pkg_dir.join("bin").join(RUNTIME_MANIFEST)) else { return false };
        let Some((key, entry)) = keys.iter().find_map(|key| manifest["targets"].get(key).map(|entry| (key, entry))) else { return false };
        let Some(sha256) =
            entry["sha256"].as_str().filter(|sha| sha.len() == 64 && sha.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        else {
            return false;
        };
        let plain = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte));
        if entry["version"].as_str() != Some(version.as_str()) || !plain(&version) {
            return false;
        }
        let folder = data_dir.join("runtime").join(&version).join(format!("{key}-{sha256}"));
        let expected = json!({
            "key": key,
            "asset": entry["asset"].clone(),
            "length": entry["length"].clone(),
            "sha256": sha256,
            "version": version,
            "buildId": entry["buildId"].clone(),
            "files": entry["files"].clone(),
        });
        if read_json(&folder.join(READY_FILE)).as_ref() != Some(&expected) {
            return false;
        }
        let Some(files) = entry["files"].as_object().filter(|files| !files.is_empty()) else { return false };
        files.iter().all(|(path, size)| {
            let relative = Path::new(path);
            relative.components().all(|component| matches!(component, std::path::Component::Normal(_)))
                && size
                    .as_u64()
                    .is_some_and(|size| mixdog_statefile::metadata(lane, &folder.join(relative)).is_ok_and(|meta| meta.is_file() && meta.len() == size))
        })
    }

    fn package_complete(lane: &InLane<MaintenanceIo>, pkg_dir: &Path, data_dir: &Path) -> bool {
        package_complete_for(lane, pkg_dir, data_dir, &host_keys())
    }

    /// `isStagedComplete`.
    fn is_staged_complete(lane: &InLane<MaintenanceIo>, config: &StagedConfig, version: &str) -> bool {
        let ver_dir = staging_root(config).join(version);
        let Some(marker) = marker(&ver_dir) else { return false };
        if marker["version"].as_str() != Some(version) {
            return false;
        }
        let pkg_dir = marker["pkgDir"].as_str().map_or_else(|| ver_dir.join(PKG_SUBDIR), PathBuf::from);
        package_complete(lane, &pkg_dir, &config.data_dir)
    }

    /// `isStagedComplete(version)` over the staging area of `config`.
    pub fn is_staged(lane: &InLane<MaintenanceIo>, config: &StagedConfig, version: &str) -> bool {
        is_staged_complete(lane, config, version)
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
        if is_staged_complete(lane, config, version) {
            return Ok(Claim::AlreadyStaged);
        }
        let ver_dir = staging_root(config).join(version);
        mixdog_statefile::create_private_dir_all(lane, &ver_dir).map_err(|error| error.to_string())?;
        if !claim_pid_lock(lane, &ver_dir.join(".staging.lock")) {
            return Err("staging in progress".into());
        }
        Ok(Claim::Held(ver_dir))
    }

    pub fn release(lane: &InLane<MaintenanceIo>, ver_dir: &Path) {
        let _ = mixdog_statefile::remove_file(lane, &ver_dir.join(".staging.lock"));
    }

    /// What the updater runs as npm: a program and the arguments that come before npm's own.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct NpmCommand {
        pub program: PathBuf,
        pub lead: Vec<String>,
    }

    /// The process facts npm is looked for by (`npm_execpath` and `PATH`).
    #[derive(Clone)]
    pub struct NpmEnv {
        pub exec_path: Option<PathBuf>,
        pub path: std::ffi::OsString,
    }

    impl NpmEnv {
        pub fn process() -> Self {
            Self {
                exec_path: std::env::var_os("npm_execpath").map(PathBuf::from),
                path: std::env::var_os("PATH").or_else(|| std::env::var_os("Path")).unwrap_or_default(),
            }
        }
    }

    fn path_dirs(env: &NpmEnv) -> Vec<PathBuf> {
        std::env::split_paths(&env.path).filter(|dir| !dir.as_os_str().is_empty()).collect()
    }

    fn names(path: &Path) -> Option<String> {
        path.file_name().map(|n| n.to_string_lossy().into_owned())
    }

    /// The first `node` on `PATH`: the interpreter of the user's own install.
    fn node_on_path(lane: &InLane<MaintenanceIo>, env: &NpmEnv) -> Option<PathBuf> {
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        path_dirs(env).into_iter().map(|dir| dir.join(name)).find(|candidate| present(lane, candidate))
    }

    /// `npm-cli.js` of npm's own package behind an `npm` shim on `PATH` (the shim's real path is
    /// `<node_modules>/npm/bin/...`).
    fn shim_cli(lane: &InLane<MaintenanceIo>, env: &NpmEnv) -> Option<PathBuf> {
        let shims: &[&str] = if cfg!(windows) { &["npm", "npm.cmd"] } else { &["npm"] };
        for dir in path_dirs(env) {
            for shim in shims {
                let Ok(real) = mixdog_workspace::pathguard::canonical(&dir.join(shim)) else { continue };
                let Some(bin) = real.parent() else { continue };
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

    /// `npmCliJsPath` beside a `node` (Windows, Unix and Homebrew layouts).
    fn cli_beside(lane: &InLane<MaintenanceIo>, node: &Path) -> Option<PathBuf> {
        let mut exec_dirs = Vec::new();
        if let Some(dir) = node.parent() {
            exec_dirs.push(dir.to_path_buf());
        }
        if let Some(dir) = mixdog_workspace::pathguard::canonical(node).ok().and_then(|real| real.parent().map(Path::to_path_buf))
            && !exec_dirs.contains(&dir)
        {
            exec_dirs.push(dir);
        }
        let mut candidates = Vec::new();
        for dir in &exec_dirs {
            candidates.push(dir.join("node_modules").join("npm").join("bin").join("npm-cli.js"));
            candidates.push(dir.join("..").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"));
            candidates.push(dir.join("..").join("libexec").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"));
        }
        candidates.into_iter().find(|candidate| present(lane, candidate))
    }

    /// The user's npm. With a `node` on `PATH`, `npmCliJsPath`'s order, run by that node: the
    /// `npm-cli.js` named by `npm_execpath`, the one beside the node (Windows, Unix and Homebrew
    /// layouts), the one behind the `npm` shim. A shim is only a lookup hint: never execute it.
    /// Without both a system Node and npm-cli.js, staging is skipped.
    pub fn resolve_npm(lane: &InLane<MaintenanceIo>, env: &NpmEnv) -> Option<NpmCommand> {
        if let Some(node) = node_on_path(lane, env) {
            let exec = env.exec_path.clone().filter(|path| path.to_string_lossy().to_lowercase().ends_with("npm-cli.js") && present(lane, path));
            if let Some(cli) = exec.or_else(|| cli_beside(lane, &node)).or_else(|| shim_cli(lane, env)) {
                return Some(NpmCommand { program: node, lead: vec![cli.to_string_lossy().into_owned()] });
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

    /// After npm: verify the version and relocate the package into `<ver_dir>/mixdog`, which is returned.
    pub fn relocate(lane: &InLane<MaintenanceIo>, version: &str, ver_dir: &Path) -> Result<PathBuf, String> {
        let rm = |dir: &Path| {
            let _ = mixdog_statefile::remove_dir_all(lane, dir);
        };
        let prefix = ver_dir.join("install");
        let pkg_dir = ver_dir.join(PKG_SUBDIR);
        let installed_modules = prefix.join("node_modules");
        let installed_pkg = installed_modules.join(PACKAGE_NAME);
        let package_json = installed_pkg.join("package.json");
        let bytes = mixdog_statefile::read_content(&package_json).ok().flatten().ok_or_else(|| "staged package.json missing".to_owned())?;
        let staged_version =
            serde_json::from_slice::<serde_json::Value>(&bytes).ok().and_then(|value| value["version"].as_str().map(str::to_owned)).unwrap_or_default();
        if staged_version != version {
            let shown = if staged_version.is_empty() { "?" } else { staged_version.as_str() };
            return Err(format!("staged version {shown} != {version}"));
        }
        // Self-contained: mixdog moves out of the install's node_modules and the remaining
        // (hoisted) dependencies nest under it, so the swapped-in package resolves its own.
        mixdog_statefile::rename_with_retry(lane, &installed_pkg, &pkg_dir).map_err(|error| error.to_string())?;
        mixdog_statefile::rename_with_retry(lane, &installed_modules, &pkg_dir.join("node_modules")).map_err(|error| error.to_string())?;
        rm(&prefix);
        Ok(pkg_dir)
    }

    /// Marks the relocated package complete. The marker is the swap's permission to replace a working install: never for a
    /// package that cannot run on this host.
    pub fn mark(lane: &InLane<MaintenanceIo>, version: &str, ver_dir: &Path, data_dir: &Path) -> Result<(), String> {
        let pkg_dir = ver_dir.join(PKG_SUBDIR);
        if !package_complete(lane, &pkg_dir, data_dir) {
            return Err(format!("staged package is incomplete: no launcher, or no verified native runtime for {} ready", host_keys().join(" or ")));
        }
        // Written last: its presence is the completion signal for the swap.
        let value = json!({ "version": version, "pkgDir": pkg_dir.to_string_lossy(), "stagedAt": u64::try_from(now_ms()).unwrap_or(0) });
        let opts = mixdog_statefile::Opts { compact: true, ..mixdog_statefile::Opts::default() };
        mixdog_statefile::write_json(lane, &ver_dir.join(MARKER_NAME), &value, &opts).map_err(|error| error.to_string())?;
        Ok(())
    }
}
