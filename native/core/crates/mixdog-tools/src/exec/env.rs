//! The environment of a model shell (`spawn-env.mjs`, `env-scrub.mjs`, `session-scratch.mjs`,
//! `skill-script-runtime.mjs` `withSkillLauncherPath`): the daemon's environment minus loader,
//! agent-socket, credential and host-identity variables, a UTF-8 locale, the session scratch
//! directory as TEMP, and the skill launcher directory first on PATH.

use std::path::Path;
use std::path::PathBuf;
use std::sync::LazyLock;

use mixdog_core_api::domain::process::EnvSpec;
use regex::Regex;
use sha2::Digest;
use sha2::Sha256;

const LOADER_VARS: [&str; 20] = [
    "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH", "PYTHONPATH", "RUBYLIB", "PERL5LIB", "BASH_ENV", "ENV", "SHELLOPTS",
    "GLOBIGNORE", "CDPATH", "PROMPT_COMMAND", "BASHOPTS", "IFS", "SSH_AUTH_SOCK", "GPG_AGENT_INFO",
    "GNUPGHOME",
];

const SECRET_EXACT: [&str; 17] = [
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "DATABASE_URL",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS", "GITHUB_PAT", "STRIPE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY",
    "NPM_CONFIG__AUTH", "npm_config__auth",
];

/// Host-runtime variables a model shell must not inherit (`scrubRuntimeRootVars`).
const RUNTIME_VARS: [&str; 8] = [
    "MIXDOG_ROOT", "NODE_ENV", "MIXDOG_DAEMON_HOST", "MIXDOG_WORKER_MODE",
    "MIXDOG_DAEMON_SPAWNED_FOR", "MIXDOG_SUPERVISOR_PID", "MIXDOG_SERVER_PID", "ELECTRON_RUN_AS_NODE",
];

static SECRET_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(_SECRET_ACCESS_KEY|_ACCESS_KEY|_SESSION_TOKEN|_AUTH_TOKEN|_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS|_PRIVATE_KEY|_PAT)$")
        .expect("static pattern")
});
static PUBLIC_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:NEXT_PUBLIC_|NUXT_PUBLIC_|VITE_|REACT_APP_|VUE_APP_|EXPO_PUBLIC_|GATSBY_|STORYBOOK_|PUBLIC_)")
        .expect("static pattern")
});

/// Whether `scrubLoaderVars`, `scrubProviderSecrets` or `scrubRuntimeRootVars` removes `name`.
/// Matching is case-sensitive, as it is for the Node object keys.
pub fn is_scrubbed(name: &str) -> bool {
    LOADER_VARS.contains(&name)
        || name.starts_with("DYLD_")
        || name.starts_with("LD_")
        || (!PUBLIC_PREFIX.is_match(name)
            && (SECRET_EXACT.contains(&name) || SECRET_SUFFIX.is_match(name)))
        || RUNTIME_VARS.contains(&name)
}

/// `envFlag`: unset, empty or unrecognised keeps `fallback`; only the documented spellings flip it.
pub fn env_flag(name: &str, fallback: bool) -> bool {
    let Ok(raw) = std::env::var(name) else { return fallback };
    match mixdog_js::js_trim(&raw).to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "off" | "no" => false,
        _ => fallback,
    }
}

/// `<data>/scratch/s.<sha256(id)[..16]>`, or `None` for an id that is not `[A-Za-z0-9_-]+`.
pub fn session_scratch_dir(data_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let usable = !session_id.is_empty()
        && session_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !usable {
        return None;
    }
    let digest = Sha256::digest(session_id.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Some(data_dir.join("scratch").join(format!("s.{hex}")))
}

pub struct ShellEnv<'a> {
    pub cwd: &'a str,
    pub windows: bool,
    pub scratch_dir: Option<&'a Path>,
    pub skill_launcher_dir: Option<&'a Path>,
}

/// The `EnvSpec` of one shell run over the daemon's variables `vars`.
pub fn shell_env(vars: &[(String, String)], shell: &ShellEnv<'_>) -> EnvSpec {
    let has = |name: &str| vars.iter().any(|(k, _)| k == name);
    let mut set = vec![
        ("LANG".to_owned(), "C.UTF-8".to_owned()),
        ("LC_ALL".to_owned(), "C.UTF-8".to_owned()),
        ("MIXDOG_SESSION_CWD".to_owned(), shell.cwd.to_owned()),
    ];
    if shell.windows {
        if !has("PYTHONUTF8") {
            set.push(("PYTHONUTF8".into(), "1".into()));
        }
        if !has("PYTHONIOENCODING") {
            set.push(("PYTHONIOENCODING".into(), "utf-8".into()));
        }
    }
    if let Some(dir) = shell.skill_launcher_dir {
        let delimiter = if shell.windows { ';' } else { ':' };
        let key = if shell.windows {
            vars.iter().map(|(k, _)| k.as_str()).find(|k| k.eq_ignore_ascii_case("PATH"))
        } else {
            None
        }
        .unwrap_or("PATH");
        let dir = dir.to_string_lossy().into_owned();
        let current = vars.iter().find(|(k, _)| k == key).map_or("", |(_, v)| v.as_str());
        let entries = current.split(delimiter).filter(|e| !e.is_empty() && *e != dir);
        let path: Vec<&str> = std::iter::once(dir.as_str()).chain(entries).collect();
        set.push((key.to_owned(), path.join(&delimiter.to_string())));
    }
    if let Some(dir) = shell.scratch_dir {
        let dir = dir.to_string_lossy().into_owned();
        for name in ["TEMP", "TMP", "TMPDIR"] {
            set.push((name.to_owned(), dir.clone()));
        }
    }
    let remove = vars
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| is_scrubbed(k))
        .collect();
    EnvSpec { inherit: true, set, remove }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn scrubbing_equals_nodes_lists() {
        for name in [
            "NODE_OPTIONS", "LD_PRELOAD", "LD_AUDIT", "DYLD_FRAMEWORK_PATH", "SSH_AUTH_SOCK", "IFS",
            "OPENAI_API_KEY", "FOO_API_KEY", "DB_PASSWORD", "STRIPE_SECRET_KEY", "MY_SECRET",
            "AWS_SESSION_TOKEN", "GH_TOKEN", "X_PRIVATE_KEY", "MIXDOG_ROOT", "NODE_ENV",
            "ELECTRON_RUN_AS_NODE", "MIXDOG_SERVER_PID", "npm_config__auth", "SERVICE_CREDENTIALS",
        ] {
            assert!(is_scrubbed(name), "{name}");
        }
        for name in [
            "PATH", "HOME", "AWS_REGION", "GITHUB_WORKSPACE", "NPM_CONFIG_CACHE", "GPG_KEY",
            "NEXT_PUBLIC_API_KEY", "VITE_FIREBASE_API_KEY", "PUBLIC_TOKEN", "node_options",
            "MY_KEY", "TOKEN_COUNT",
        ] {
            assert!(!is_scrubbed(name), "{name}");
        }
    }

    #[test]
    fn locale_scratch_and_launcher_path_are_applied() {
        let env = shell_env(
            &vars(&[("Path", "C:\\a;C:\\launch;C:\\b"), ("OPENAI_API_KEY", "k"), ("HOME", "h")]),
            &ShellEnv {
                cwd: "C:\\w",
                windows: true,
                scratch_dir: Some(Path::new("C:\\s")),
                skill_launcher_dir: Some(Path::new("C:\\launch")),
            },
        );
        assert!(env.inherit);
        assert_eq!(env.remove, vec!["OPENAI_API_KEY".to_owned()]);
        let get = |name: &str| env.set.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
        assert_eq!(get("LANG"), Some("C.UTF-8"));
        assert_eq!(get("MIXDOG_SESSION_CWD"), Some("C:\\w"));
        assert_eq!(get("PYTHONUTF8"), Some("1"));
        assert_eq!(get("Path"), Some("C:\\launch;C:\\a;C:\\b"));
        assert_eq!(get("TMPDIR"), Some("C:\\s"));
    }

    #[test]
    fn scratch_dir_is_named_by_a_digest_of_a_usable_id() {
        let dir = session_scratch_dir(Path::new("/d"), "sess_1").unwrap();
        // sha256("sess_1")[..8 bytes]
        assert_eq!(dir.file_name().unwrap().to_str().unwrap().len(), 2 + 16);
        assert!(session_scratch_dir(Path::new("/d"), "bad id").is_none());
        assert!(session_scratch_dir(Path::new("/d"), "").is_none());
    }
}
