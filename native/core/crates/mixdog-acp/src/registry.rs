//! The builds of an agent of the ACP registry ([`Distribution::Registry`]): which build the registry's index offers this
//! system, the fetcher that downloads and unpacks one, and installing it in `<acp data>/bin/<preset id>/<version>/`, named by
//! that folder's `installed.json`.
//!
//! [`Distribution::Registry`]: crate::preset::Distribution::Registry

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;

use crate::agents::Agents;
use crate::preset::AgentPreset;
use crate::preset::Distribution;
use crate::preset::Version;
use crate::session::Program;
use crate::upkeep::Action;
use crate::upkeep::Plan;
use crate::upkeep::Step;

/// The file of a preset's folder of builds that names the one installed.
const INSTALLED: &str = "installed.json";
/// What starts the name of a folder a build is unpacked into before it takes its place.
const STAGING: &str = ".staging-";
/// What a build folder that is not the installed one is called where it is removed.
const OLD_BUILD: &str = "the agent's build folder that is not the installed one";
/// What starts the name, after the preset's id, of a sign-in's staging home beside the agent's home.
pub(crate) const LOGIN_HOME: &str = ".login-";

/// The registry's name of this system; `None` where it names none.
pub fn this_target() -> Option<&'static str> {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return None;
    };
    match (os, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("windows", "aarch64") => Some("windows-aarch64"),
        ("darwin", "x86_64") => Some("darwin-x86_64"),
        ("darwin", "aarch64") => Some("darwin-aarch64"),
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("linux", "aarch64") => Some("linux-aarch64"),
        _ => None,
    }
}

/// One build of an agent the registry offers for a system.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Build {
    pub version: Version,
    /// Its archive's address: HTTPS, on one of the preset's hosts.
    pub archive: String,
    /// The program, relative to the folder the archive is unpacked into.
    pub cmd: String,
    /// What the program starts with on this system, ahead of the preset's own arguments.
    pub args: Vec<String>,
    /// The archive's SHA-256, in lowercase hex.
    pub sha256: String,
    /// The hosts its archive may come from, every redirect of its download included.
    pub hosts: Vec<String>,
    /// The programs beside `cmd` the build starts, as the preset names them.
    pub helpers: Vec<String>,
}

/// Held for as long as anything of an unpack or its staging folder's move and cleanup may still touch disk, past the
/// drop of the future that started it: the next unpack clears away what an ended one left only once it is let go.
#[derive(Clone)]
pub struct Unpacking(pub Arc<tokio::sync::OwnedSemaphorePermit>);

/// Downloads what the registry offers, and asks the HTTPS services an agent's own credential is for.
#[async_trait]
pub trait RegistryFetcher: Send + Sync {
    /// The registry's index at `url`, within a short time: an `Err` where it cannot be reached.
    async fn index(&self, url: &str) -> Result<Value, String>;
    /// Downloads `build`'s archive to the file `archive`, following a redirect only to one of `build.hosts`, checks it
    /// against `build.sha256` before anything of it is unpacked, and unpacks it into the folder `into`, which is not there
    /// yet: an entry that would land outside it is refused, an archive without `build.cmd` or one of `build.helpers` is
    /// no build, and they are left executable. Dropping the future ends the download; `held` is kept until nothing of
    /// the unpack writes any more.
    async fn unpack(&self, build: &Build, archive: &Path, into: &Path, held: Unpacking) -> Result<(), String>;
    /// Posts `body` to the HTTPS address `url` with `headers` and answers the JSON it returns, within a short time, never
    /// following a redirect: an `Err` tells why it did not answer, a status that is no success with its answer's text.
    async fn post(&self, url: &str, headers: &[(String, String)], body: Vec<u8>) -> Result<Value, String>;
}

/// `url`'s host, where it is an HTTPS address that names no user.
fn https_host(url: &str) -> Option<&str> {
    let rest = url.get(.."https://".len()).filter(|scheme| scheme.eq_ignore_ascii_case("https://")).map(|_| &url["https://".len()..])?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None;
    }
    authority.split(':').next().filter(|host| !host.is_empty())
}

/// Whether `url` is an HTTPS address on one of `hosts` that names no user.
pub fn allowed_archive(url: &str, hosts: &[String]) -> bool {
    https_host(url).is_some_and(|host| hosts.iter().any(|allowed| allowed.eq_ignore_ascii_case(host)))
}

/// The build of `agent_id` that `index`, the registry's index, offers for `target`, its archive on one of `hosts`.
pub fn build_of(index: &Value, agent_id: &str, target: &str, hosts: &[String]) -> Result<Build, String> {
    let mut agents = index.get("agents").and_then(Value::as_array).into_iter().flatten();
    let agent = agents.find(|agent| agent.get("id").and_then(Value::as_str) == Some(agent_id)).ok_or_else(|| format!("the registry lists no {agent_id}"))?;
    let version = agent.get("version").and_then(Value::as_str).and_then(Version::find).ok_or_else(|| format!("the registry names no version of {agent_id}"))?;
    let entry = agent.get("distribution").and_then(|distribution| distribution.get("binary")).and_then(|builds| builds.get(target));
    let entry = entry.ok_or_else(|| format!("the registry has no build of {agent_id} for {target}"))?;
    let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
    let (Some(archive), Some(cmd), Some(sha256)) = (text("archive"), text("cmd"), text("sha256")) else {
        return Err(format!("the registry's build of {agent_id} for {target} names no archive, program or digest"));
    };
    https_host(archive).ok_or_else(|| format!("{archive} is not an HTTPS address"))?;
    if !allowed_archive(archive, hosts) {
        return Err(format!("{archive} is not on a host the build may come from"));
    }
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("the registry's digest of {agent_id} is not a SHA-256"));
    }
    let cmd = cmd.trim_start_matches("./");
    if !Path::new(cmd).components().all(|part| matches!(part, std::path::Component::Normal(_))) {
        return Err(format!("the registry's program of {agent_id} is not inside its archive: {cmd}"));
    }
    let args = entry.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    Ok(Build {
        version,
        archive: archive.to_owned(),
        cmd: cmd.to_owned(),
        args,
        sha256: sha256.to_ascii_lowercase(),
        hosts: hosts.to_vec(),
        helpers: Vec::new(),
    })
}

/// The build of a preset this machine holds, as its `installed.json` names it.
#[derive(Clone, Debug)]
pub(crate) struct Installed {
    pub(crate) version: String,
    /// Its program in the home Mixdog keeps for the agent, with the build's arguments.
    pub(crate) program: Program,
}

fn absolute(path: PathBuf) -> Result<AbsPath, String> {
    AbsPath::new(&path).ok_or_else(|| format!("{} is not an absolute folder to keep the agents in", path.display()))
}

impl Agents {
    /// The folder of `preset`'s builds: `<acp data>/bin/<preset id>`.
    fn builds(&self, preset: &AgentPreset) -> PathBuf {
        self.parts.data_dir.join("bin").join(&preset.id)
    }

    /// The home Mixdog keeps for `preset`'s agent: `<acp data>/homes/<preset id>`.
    pub(crate) fn home(&self, preset: &AgentPreset) -> PathBuf {
        self.parts.data_dir.join("homes").join(&preset.id)
    }

    /// The build of `preset`'s registry agent this machine holds: its program (`cmd`, under the build's own folder
    /// `<version>/` unless it is absolute) and any required helper programs beside it, with the build's arguments, in
    /// the home Mixdog keeps for the agent. `Ok(None)` where no build is installed, a record whose program or a helper
    /// is gone (removed, or quarantined) included: the install step installs it again.
    pub(crate) async fn installed(&self, preset: &AgentPreset) -> Result<Option<Installed>, String> {
        let Distribution::Registry { home_env, helpers, .. } = &preset.distribution else { return Ok(None) };
        let folder = self.builds(preset);
        let file = absolute(folder.join(INSTALLED))?;
        let Ok(text) = self.parts.files.read(file).await else { return Ok(None) };
        let unreadable = |why: &str| format!("the record of {}'s installed build cannot be read: {why}", preset.label);
        let installed: Value = serde_json::from_str(&text).map_err(|error| unreadable(&error.to_string()))?;
        let field = |key: &str| installed.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
        let (Some(version), Some(cmd)) = (field("version"), field("cmd")) else { return Err(unreadable("it names no version or no program")) };
        let build = folder.join(version);
        let path = build.join(cmd);
        if self.parts.files.resolved(absolute(path.clone())?).await.is_err() {
            return Ok(None);
        }
        for helper in helpers {
            if self.parts.files.resolved(absolute(build.join(helper))?).await.is_err() {
                return Ok(None);
            }
        }
        let args = installed.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        Ok(Some(Installed {
            version: version.to_owned(),
            program: Program {
                path: path.to_string_lossy().into_owned(),
                args,
                env: vec![(home_env.clone(), self.home(preset).to_string_lossy().into_owned())],
            },
        }))
    }

    /// `preset`'s registry build installed or brought to the registry's newest as `plan` allows, and the build this machine
    /// holds after it. A build that is not there is installed by the feature's install step alone, never by a check; one
    /// that is there is replaced only while no session of it runs and none starts. A registry that cannot be reached
    /// leaves the installed build as it is.
    pub(crate) async fn keep_current(&self, preset: &AgentPreset, plan: Plan, check: u64, installed: Option<Installed>) -> Option<Installed> {
        let (Some(fetcher), Distribution::Registry { index_url, agent_id, allowed_archive_hosts, helpers, kept_current: true, .. }) =
            (self.parts.registry.clone(), &preset.distribution)
        else {
            return installed;
        };
        if plan == Plan::Look || (installed.is_none() && plan != Plan::Install) {
            return installed;
        }
        let action = if installed.is_some() { Action::Update } else { Action::Install };
        let offered = async {
            let target = this_target().ok_or_else(|| format!("the registry has no build of {} for this system", preset.label))?;
            let index = fetcher.index(index_url).await?;
            let build = build_of(&index, agent_id, target, allowed_archive_hosts)?;
            if build.version < preset.minimum_version {
                return Err(format!("the registry offers {} {}, and {} or later is needed", preset.label, build.version, preset.minimum_version));
            }
            Ok(Build { helpers: helpers.clone(), ..build })
        }
        .await;
        let build = match offered {
            Ok(build) => build,
            Err(message) => {
                if installed.is_none() {
                    self.set_fault(preset, Some((action, message)));
                }
                return installed;
            }
        };
        if installed.as_ref().is_some_and(|installed| Version::find(&installed.version).is_some_and(|version| version >= build.version)) {
            return installed;
        }
        if installed.is_none() {
            self.set_step(preset, check, Step::Installing);
        } else if self.begin_update(preset, check) {
            (self.parts.changed)();
        } else {
            return installed;
        }
        let placed = self.place(preset, fetcher.as_ref(), &build).await;
        self.set_step(preset, check, Step::Checking);
        if let Err(message) = placed {
            self.set_fault(preset, Some((action, message)));
            return installed;
        }
        self.set_fault(preset, None);
        // What the agent told of itself was of the build replaced.
        self.forget_told(preset).await;
        // No process runs from it (`begin_update`); one that cannot be removed now goes with the next start's sweep.
        if let Some(old) = installed.filter(|old| old.version != build.version.to_string())
            && let Ok(folder) = absolute(self.builds(preset).join(&old.version))
        {
            crate::connection::remove_folder(self.parts.files.as_ref(), folder, OLD_BUILD).await;
        }
        self.installed(preset).await.ok().flatten()
    }

    /// Clears away what the builds of the registry agents Mixdog keeps current left behind: every folder of a preset's
    /// builds but the installed one (a build an update could not remove, an unpack that was ended), and the staging
    /// homes of sign-ins that did not end. Run at the daemon's start, before any of their processes runs.
    pub(crate) async fn sweep_builds(&self) {
        for preset in &self.parts.presets {
            if !matches!(preset.distribution, Distribution::Registry { kept_current: true, .. }) {
                continue;
            }
            let installed = match self.installed(preset).await {
                Ok(installed) => installed.map(|installed| installed.version),
                // A record that cannot be read names no build to keep: what is there is left as it is.
                Err(_) => continue,
            };
            let folder = self.builds(preset);
            let Ok(root) = absolute(folder.clone()) else { continue };
            for name in self.parts.files.folders(root).await.unwrap_or_default() {
                if Some(&name) != installed.as_ref()
                    && let Ok(old) = absolute(folder.join(&name))
                {
                    crate::connection::remove_folder(self.parts.files.as_ref(), old, OLD_BUILD).await;
                }
            }
            let home = self.home(preset);
            let (Some(homes), Some(own)) = (home.parent(), home.file_name().map(|name| format!("{}{LOGIN_HOME}", name.to_string_lossy()))) else { continue };
            let Ok(root) = absolute(homes.to_path_buf()) else { continue };
            for name in self.parts.files.folders(root).await.unwrap_or_default() {
                if name.starts_with(&own)
                    && let Ok(staging) = absolute(homes.join(&name))
                {
                    crate::connection::remove_folder(self.parts.files.as_ref(), staging, "the staging home of a sign-in that did not end").await;
                }
            }
        }
    }

    /// Unpacks `build` beside the installed one and names it in `installed.json`, which is replaced whole.
    async fn place(&self, preset: &AgentPreset, fetcher: &dyn RegistryFetcher, build: &Build) -> Result<(), String> {
        let files = &self.parts.files;
        let folder = self.builds(preset);
        let held = Unpacking(Arc::new(self.unpacking.clone().acquire_owned().await.expect("the unpack gate is never closed")));
        // What an install that was ended before it was done left, once nothing of it writes any more.
        for name in files.folders(absolute(folder.clone())?).await.unwrap_or_default() {
            if name.starts_with(STAGING) {
                let files = files.clone();
                let target = absolute(folder.join(name))?;
                let _ = finish_holding(held.clone(), async move { files.remove_folder(target).await }).await;
            }
        }
        let staging = absolute(folder.join(format!("{STAGING}{}", uuid::Uuid::new_v4().simple())))?;
        {
            let files = files.clone();
            let target = staging.clone();
            finish_holding(held.clone(), async move { files.make_folder(target).await }).await?;
        }
        let placed = async {
            let unpacked = staging.as_path().join("build");
            fetcher.unpack(build, &staging.as_path().join("archive"), &unpacked, held.clone()).await?;
            let version = absolute(folder.join(build.version.to_string()))?;
            {
                let files = files.clone();
                let target = version.clone();
                finish_holding(held.clone(), async move { files.remove_folder(target).await }).await?;
            }
            {
                let files = files.clone();
                let from = absolute(unpacked)?;
                finish_holding(held.clone(), async move { files.rename(from, version).await }).await?;
            }
            let record = json!({ "version": build.version.to_string(), "cmd": build.cmd, "args": build.args, "sha256": build.sha256 });
            let files = files.clone();
            let target = absolute(folder.join(INSTALLED))?;
            finish_holding(held.clone(), async move { files.replace(target, record.to_string()).await }).await
        }
        .await;
        let files = files.clone();
        let _ = finish_holding(held, async move { files.remove_folder(staging).await }).await;
        placed
    }
}

/// Runs a file-lane step to its end while keeping `held`, even if the caller's future is dropped mid-flight.
async fn finish_holding<T: Send + 'static>(held: Unpacking, work: impl std::future::Future<Output = T> + Send + 'static) -> T {
    let (tx, rx) = tokio::sync::oneshot::channel();
    drop(mixdog_rt::spawn("acp.registry.place", TaskClass::Work, async move {
        let _held = held;
        let _ = tx.send(work.await);
    }));
    rx.await.expect("the place task never panics")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(archive: &str, sha256: &str, cmd: &str) -> Value {
        json!({ "agents": [{ "id": "antigravity-acp", "version": "1.5.2", "distribution": { "binary": {
            "linux-x86_64": { "archive": archive, "cmd": cmd, "args": ["--uid="], "sha256": sha256 },
            "windows-x86_64": { "archive": archive, "cmd": cmd, "sha256": sha256 },
        } } }] })
    }

    const DIGEST: &str = "5CBADD4F4DF698572473D8890FC26EC2DC1724501F06E3A963941DAEC2BD21D6";

    /// A build is taken for this system with its own arguments, only from an HTTPS address on an allowed host, with a
    /// SHA-256, and with its program inside the archive.
    #[test]
    fn a_build_is_taken_only_from_an_allowed_https_host_with_its_digest_and_its_targets_arguments() {
        let hosts = vec!["dl.google.com".to_owned()];
        let good = "https://dl.google.com/agy-extensions/releases/x.zip";
        let linux = build_of(&index(good, DIGEST, "./agy_acp_server.par"), "antigravity-acp", "linux-x86_64", &hosts).expect("the build");
        assert_eq!(
            linux,
            Build {
                version: Version::new(1, 5, 2),
                archive: good.into(),
                cmd: "agy_acp_server.par".into(),
                args: vec!["--uid=".into()],
                sha256: DIGEST.to_ascii_lowercase(),
                hosts: hosts.clone(),
                helpers: Vec::new(),
            }
        );
        let windows = build_of(&index(good, DIGEST, "./agy_acp_server.exe"), "antigravity-acp", "windows-x86_64", &hosts).expect("the build");
        assert!(windows.args.is_empty());
        for (archive, sha256, cmd) in [
            ("http://dl.google.com/x.zip", DIGEST, "a"),
            ("https://dl.google.com.evil.example/x.zip", DIGEST, "a"),
            ("https://dl.google.com@evil.example/x.zip", DIGEST, "a"),
            (good, "abc", "a"),
            (good, DIGEST, "../a"),
            (good, DIGEST, "/a"),
        ] {
            assert!(build_of(&index(archive, sha256, cmd), "antigravity-acp", "linux-x86_64", &hosts).is_err(), "{archive} {sha256} {cmd}");
        }
        assert!(build_of(&index(good, DIGEST, "a"), "antigravity-acp", "darwin-x86_64", &hosts).is_err(), "no build for the target");
        assert!(build_of(&index(good, DIGEST, "a"), "other", "linux-x86_64", &hosts).is_err());
    }

    /// Cancelling `place` while a post-unpack file-lane rename is still in flight keeps `Unpacking` held until the
    /// rename finishes, so the next install cannot acquire the gate and remove `.staging-*` underneath it.
    #[tokio::test]
    async fn cancelling_place_mid_rename_keeps_unpacking_held_until_rename_ends() {
        use tokio::sync::Notify;

        use crate::agents::AgentsParts;
        use crate::agents::Refusals;
        use crate::files::TextFiles;
        use mixdog_core_api::domain::common::EventSource;
        use mixdog_core_api::domain::process::ProcessError;
        use mixdog_core_api::domain::process::ProcessEvent;
        use mixdog_core_api::domain::process::ProcessInfo;
        use mixdog_core_api::domain::process::ProcessManager;
        use mixdog_core_api::domain::process::PtySize;
        use mixdog_core_api::domain::process::SpawnRequest;
        use mixdog_core_api::domain::process::SpawnedProcess;
        use mixdog_protocol::ProcessHandle;

        struct NoRefusals;
        #[async_trait]
        impl Refusals for NoRefusals {
            async fn read(&self) -> Result<std::collections::HashMap<String, String>, String> {
                Ok(std::collections::HashMap::new())
            }
            async fn write(&self, _: &std::collections::HashMap<String, String>) -> Result<(), String> {
                Ok(())
            }
        }

        struct NoProcesses;
        #[async_trait]
        impl ProcessManager for NoProcesses {
            async fn spawn(&self, _: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
                Err(ProcessError::UnknownHandle)
            }
            fn subscribe(&self, _: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
                Err(ProcessError::UnknownHandle)
            }
            fn subscribe_holding(&self, _: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
                Err(ProcessError::UnknownHandle)
            }
            async fn write_stdin(&self, _: &ProcessHandle, _: Vec<u8>) -> Result<(), ProcessError> {
                Err(ProcessError::UnknownHandle)
            }
            fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
                Err(ProcessError::UnknownHandle)
            }
            fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
                Err(ProcessError::UnknownHandle)
            }
            fn kill(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
                Err(ProcessError::UnknownHandle)
            }
            fn list(&self) -> Vec<ProcessInfo> {
                Vec::new()
            }
        }

        struct BlockingRename {
            entered: Arc<Notify>,
            release: Arc<Notify>,
            done: Arc<Notify>,
        }
        #[async_trait]
        impl TextFiles for BlockingRename {
            async fn read(&self, _: AbsPath) -> Result<String, String> {
                Err("none".into())
            }
            async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
                Ok(path)
            }
            async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
                Ok(())
            }
            async fn make_folder(&self, _: AbsPath) -> Result<(), String> {
                Ok(())
            }
            async fn remove_folder(&self, _: AbsPath) -> Result<(), String> {
                Ok(())
            }
            async fn folders(&self, _: AbsPath) -> Result<Vec<String>, String> {
                Ok(Vec::new())
            }
            async fn replace(&self, _: AbsPath, _: String) -> Result<(), String> {
                Ok(())
            }
            async fn rename(&self, _: AbsPath, _: AbsPath) -> Result<(), String> {
                self.entered.notify_one();
                self.release.notified().await;
                self.done.notify_one();
                Ok(())
            }
        }

        struct InstantFetcher;
        #[async_trait]
        impl RegistryFetcher for InstantFetcher {
            async fn index(&self, _: &str) -> Result<Value, String> {
                Err("unused".into())
            }
            async fn unpack(&self, _: &Build, _: &Path, _: &Path, _held: Unpacking) -> Result<(), String> {
                Ok(())
            }
            async fn post(&self, _: &str, _: &[(String, String)], _: Vec<u8>) -> Result<Value, String> {
                Err("unused".into())
            }
        }

        let dir = tempfile::tempdir().expect("temp dir");
        let preset = crate::preset::builtin().into_iter().find(|preset| preset.id == "antigravity").expect("official preset");
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let done = Arc::new(Notify::new());
        let agents = Agents::new(AgentsParts {
            refusals: Arc::new(NoRefusals),
            presets: vec![preset.clone()],
            processes: Arc::new(NoProcesses),
            files: Arc::new(BlockingRename { entered: entered.clone(), release: release.clone(), done: done.clone() }),
            enabled: Arc::new(|| true),
            changed: Arc::new(|| {}),
            probe_cwd: dir.path().to_path_buf(),
            definitions: dir.path().join("acp-agents"),
            data_dir: dir.path().join("acp-agents"),
            env: Arc::new(|_: &str| None),
            mcp_bridge: None,
            registry: None,
        });
        let build = Build {
            version: Version::new(1, 5, 2),
            archive: "https://dl.google.com/agy-extensions/releases/x.zip".into(),
            cmd: "agy_acp_server.exe".into(),
            args: Vec::new(),
            sha256: DIGEST.to_ascii_lowercase(),
            hosts: vec!["dl.google.com".into()],
            helpers: Vec::new(),
        };
        let rename_entered = entered.notified();
        tokio::pin!(rename_entered);
        rename_entered.as_mut().enable();
        let rename_done = done.notified();
        tokio::pin!(rename_done);
        rename_done.as_mut().enable();

        let task = tokio::spawn({
            let agents = agents.clone();
            let preset = preset.clone();
            async move { agents.place(&preset, &InstantFetcher, &build).await }
        });
        rename_entered.await;
        task.abort();
        let _ = task.await;

        assert!(agents.unpacking.try_acquire().is_err(), "Unpacking must stay held while post-unpack rename is still running");
        release.notify_one();
        rename_done.await;
        let _permit = agents.unpacking.clone().acquire_owned().await.expect("Unpacking releases once rename completes");
    }
}
