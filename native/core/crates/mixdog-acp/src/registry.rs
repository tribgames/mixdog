//! The builds of an agent of the ACP registry ([`Distribution::Registry`]): which build the registry's index offers this
//! system, the fetcher that downloads and unpacks one, and installing it in `<acp data>/bin/<preset id>/<version>/`, named by
//! that folder's `installed.json`.
//!
//! [`Distribution::Registry`]: crate::preset::Distribution::Registry

use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
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
}

/// Downloads what the registry offers.
#[async_trait]
pub trait RegistryFetcher: Send + Sync {
    /// The registry's index at `url`, within a short time: an `Err` where it cannot be reached.
    async fn index(&self, url: &str) -> Result<Value, String>;
    /// Downloads `build`'s archive to the file `archive`, checks it against `build.sha256` before anything of it is
    /// unpacked, and unpacks it into the folder `into`, which is not there yet: an entry that would land outside it is
    /// refused, and `build.cmd` is left executable. Dropping the future ends the download.
    async fn unpack(&self, build: &Build, archive: &Path, into: &Path) -> Result<(), String>;
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
    let host = https_host(archive).ok_or_else(|| format!("{archive} is not an HTTPS address"))?;
    if !hosts.iter().any(|allowed| allowed.eq_ignore_ascii_case(host)) {
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
    Ok(Build { version, archive: archive.to_owned(), cmd: cmd.to_owned(), args, sha256: sha256.to_ascii_lowercase() })
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
    /// `<version>/` unless it is absolute) with the build's arguments, in the home Mixdog keeps for the agent. `Ok(None)`
    /// where no build is installed.
    pub(crate) async fn installed(&self, preset: &AgentPreset) -> Result<Option<Installed>, String> {
        let Distribution::Registry { home_env, .. } = &preset.distribution else { return Ok(None) };
        let folder = self.builds(preset);
        let file = absolute(folder.join(INSTALLED))?;
        let Ok(text) = self.parts.files.read(file).await else { return Ok(None) };
        let unreadable = |why: &str| format!("the record of {}'s installed build cannot be read: {why}", preset.label);
        let installed: Value = serde_json::from_str(&text).map_err(|error| unreadable(&error.to_string()))?;
        let field = |key: &str| installed.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
        let (Some(version), Some(cmd)) = (field("version"), field("cmd")) else { return Err(unreadable("it names no version or no program")) };
        let args = installed.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        Ok(Some(Installed {
            version: version.to_owned(),
            program: Program {
                path: folder.join(version).join(cmd).to_string_lossy().into_owned(),
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
        let (Some(fetcher), Distribution::Registry { index_url, agent_id, allowed_archive_hosts, kept_current: true, .. }) =
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
            Ok(build)
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
        // What an install that was ended before it was done left.
        for name in files.folders(absolute(folder.clone())?).await.unwrap_or_default() {
            if name.starts_with(STAGING) {
                let _ = files.remove_folder(absolute(folder.join(name))?).await;
            }
        }
        let staging = absolute(folder.join(format!("{STAGING}{}", uuid::Uuid::new_v4().simple())))?;
        files.make_folder(staging.clone()).await?;
        let placed = async {
            let unpacked = staging.as_path().join("build");
            fetcher.unpack(build, &staging.as_path().join("archive"), &unpacked).await?;
            let version = absolute(folder.join(build.version.to_string()))?;
            files.remove_folder(version.clone()).await?;
            files.rename(absolute(unpacked)?, version).await?;
            let record = json!({ "version": build.version.to_string(), "cmd": build.cmd, "args": build.args, "sha256": build.sha256 });
            files.replace(absolute(folder.join(INSTALLED))?, record.to_string()).await
        }
        .await;
        let _ = files.remove_folder(staging).await;
        placed
    }
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
}
