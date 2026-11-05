//! Sandbox policy and the policy→transform step (T §1.4, SPEC §4.12 D-PATH).
//!
//! Mixdog runs commands and file tools with the user's own rights and has no
//! OS sandbox; the only policy is [`SandboxPolicy::Unrestricted`]. The seams
//! exist so that a later, separately reviewed restriction is one new policy
//! variant plus one new [`SandboxType`], not a change in every tool:
//! * [`SandboxPolicy::resolve_in_workspace`] is the single place a tool turns
//!   a path argument into the path it touches;
//! * [`SandboxManager::transform`] is the single place a command becomes the
//!   request that is spawned.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

/// What a tool may touch. One variant: tools keep today's behaviour, no
/// workspace boundary.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum SandboxPolicy {
    #[default]
    Unrestricted,
}

impl SandboxPolicy {
    /// The path a tool argument names, resolved against the call's working
    /// directory: an absolute `path` stands on its own, a relative one is
    /// joined to `cwd`; `.` and `..` components are removed lexically (no
    /// filesystem access, symlinks are not followed).
    pub fn resolve_in_workspace(&self, cwd: &Path, path: &Path) -> PathBuf {
        match self {
            Self::Unrestricted => normalize(&cwd.join(path)),
        }
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // `..` at a root stays at the root; a relative path keeps its leading `..`.
                match out.components().next_back() {
                    Some(Component::Normal(_)) => {
                        out.pop();
                    }
                    Some(Component::RootDir | Component::Prefix(_)) => {}
                    _ => out.push(".."),
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// How a spawned command is confined by the operating system.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SandboxType {
    None,
}

/// A command as a tool describes it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CommandSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub env: BTreeMap<OsString, OsString>,
}

/// A command ready to spawn, with the confinement chosen for it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ExecRequest {
    pub command: CommandSpec,
    pub sandbox: SandboxType,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SandboxManager;

impl SandboxManager {
    pub fn select_initial(&self, policy: &SandboxPolicy) -> SandboxType {
        match policy {
            SandboxPolicy::Unrestricted => SandboxType::None,
        }
    }

    pub fn transform(&self, command: CommandSpec, policy: &SandboxPolicy) -> ExecRequest {
        ExecRequest {
            sandbox: self.select_initial(policy),
            command,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_join_the_cwd_and_lose_dot_components() {
        let policy = SandboxPolicy::Unrestricted;
        let cwd = Path::new("base").join("work");
        let got = policy.resolve_in_workspace(&cwd, Path::new("./a/../b/c.txt"));
        assert_eq!(got, Path::new("base").join("work").join("b").join("c.txt"));
    }

    #[test]
    fn parent_components_may_leave_the_cwd_because_there_is_no_boundary() {
        let policy = SandboxPolicy::Unrestricted;
        let cwd = Path::new("base").join("work");
        let got = policy.resolve_in_workspace(&cwd, Path::new("../../other/x"));
        assert_eq!(got, Path::new("other").join("x"));
        let above = policy.resolve_in_workspace(&cwd, Path::new("../../../x"));
        assert_eq!(above, Path::new("..").join("x"));
    }

    #[cfg(windows)]
    #[test]
    fn absolute_paths_stand_on_their_own_and_stop_at_the_root() {
        let policy = SandboxPolicy::Unrestricted;
        let cwd = Path::new(r"C:\work");
        assert_eq!(
            policy.resolve_in_workspace(cwd, Path::new(r"D:\x\..\y")),
            PathBuf::from(r"D:\y")
        );
        assert_eq!(
            policy.resolve_in_workspace(cwd, Path::new(r"C:\..\..\y")),
            PathBuf::from(r"C:\y")
        );
    }

    #[cfg(unix)]
    #[test]
    fn absolute_paths_stand_on_their_own_and_stop_at_the_root() {
        let policy = SandboxPolicy::Unrestricted;
        let cwd = Path::new("/work");
        assert_eq!(
            policy.resolve_in_workspace(cwd, Path::new("/x/../y")),
            PathBuf::from("/y")
        );
        assert_eq!(
            policy.resolve_in_workspace(cwd, Path::new("/../../y")),
            PathBuf::from("/y")
        );
    }

    #[test]
    fn unrestricted_policy_leaves_the_command_unconfined() {
        let manager = SandboxManager;
        let spec = CommandSpec {
            program: "tool".into(),
            args: vec!["--flag".into()],
            cwd: PathBuf::from("work"),
            env: BTreeMap::new(),
        };
        let request = manager.transform(spec.clone(), &SandboxPolicy::Unrestricted);
        assert_eq!(request.sandbox, SandboxType::None);
        assert_eq!(request.command, spec);
    }
}
