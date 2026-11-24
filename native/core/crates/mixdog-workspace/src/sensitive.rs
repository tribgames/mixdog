//! The credential / secret file deny list (`runtime/shared/sensitive-path-rules.mjs`): what an automatic hand-off never crosses
//! and a paired device never reaches.

use std::path::Path;
use std::path::PathBuf;
use std::sync::LazyLock;

use mixdog_js::JsRegex;

/// A directory with this name anywhere on the path holds credentials.
const SECRET_DIRECTORIES: [&str; 8] = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".mozilla", ".password-store", ".git"];

/// Consecutive segments anywhere on the path that name a credential store.
const SECRET_SEQUENCES: &[&[&str]] = &[
    &[".docker", "config.json"],
    &[".config", "gcloud"],
    &["appdata", "roaming", "gcloud"],
    &[".config", "gh"],
    &["appdata", "roaming", "github cli"],
    &[".config", "git", "credentials"],
    &[".cargo", "credentials"],
    &[".cargo", "credentials.toml"],
    &[".terraform.d", "credentials.tfrc.json"],
    &[".claude", ".credentials.json"],
    &[".codex", "auth.json"],
    &[".gemini", "oauth_creds.json"],
    &["google", "chrome", "user data"],
    &["microsoft", "edge", "user data"],
    &["bravesoftware", "brave-browser"],
    &["chromium", "user data"],
    &["vivaldi", "user data"],
    &["opera software"],
    &["mozilla", "firefox"],
    &["application support", "google", "chrome"],
    &["application support", "microsoft edge"],
    &["application support", "firefox"],
    &["application support", "chromium"],
    &["application support", "bravesoftware"],
    &["application support", "vivaldi"],
    &["library", "safari"],
    &["library", "cookies"],
    &[".config", "google-chrome"],
    &[".config", "chromium"],
    &[".config", "microsoft-edge"],
    &[".config", "bravesoftware"],
    &[".config", "vivaldi"],
    &["snap", "firefox"],
    &["snap", "chromium"],
    &[".var", "app", "org.mozilla.firefox"],
    &[".var", "app", "com.google.chrome"],
    &["microsoft", "credentials"],
    &["microsoft", "protect"],
    &["microsoft", "vault"],
    &["windows", "system32", "config"],
    &["library", "keychains"],
    &[".local", "share", "keyrings"],
    &[".local", "share", "kwalletd"],
    &["etc", "shadow"],
    &["etc", "gshadow"],
    &["etc", "ssh"],
    &["etc", "ssl", "private"],
];

const KEY_EXTENSIONS: [&str; 11] = [".pem", ".key", ".p12", ".pfx", ".p8", ".ppk", ".jks", ".keystore", ".kdbx", ".keychain", ".keychain-db"];
const CREDENTIAL_FILES: [&str; 12] =
    [".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".vault-token", ".htpasswd", ".dockercfg", ".envrc", ".s3cfg", "kubeconfig"];
const MIXDOG_SECRET_DIRECTORIES: [&str; 5] = ["secrets", "mcp-oauth", "provider-accounts", "relay-data", "dev-profile"];
const MIXDOG_SECRET_EXTENSIONS: [&str; 2] = [".dpapi", ".token"];
const MAX_BACKUP_SUFFIXES: usize = 3;

static ENV_FILE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:\.env.*|[^.]{1,64}(?:\.[^.]{1,64}){0,3}\.env)$", ""));
static CREDENTIAL_JSON: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:.*credential.*|service[-_ ]?account.*|client[-_]?secret.*)\.json$", ""));
static SSH_PRIVATE_KEY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^id_[a-z0-9]{2,16}(?:[_-][^._-]{1,32}){0,3}$", ""));
static BACKUP_SUFFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:\.(?:bak|backup|old|orig|prev|save|sav|swp|swo|tmp|copy|\d{1,3})|~)$", ""));
static MIXDOG_SECRET_FILE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^\.?(mixdog-config|provider-accounts|relay-hook-device|auth\.json|[a-z0-9-]+-oauth(-credentials)?\.json|[a-z0-9-]+-bridge\.json)", "")
});
static EXTENDED_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[\\/]{2}[?.][\\/]", ""));

/// `backupOriginal`: the name a backup copy was made of (`.npmrc.bak.1` is `.npmrc`).
fn backup_original(name: &str) -> String {
    let mut original = name.to_owned();
    for _ in 0..MAX_BACKUP_SUFFIXES {
        let next = BACKUP_SUFFIX.find(&original).map_or_else(|| original.clone(), |hit| format!("{}{}", &original[..hit.start], &original[hit.end..]));
        if next == original || next.is_empty() {
            break;
        }
        original = next;
    }
    original
}

/// `secretFileName`: a file whose own name says it holds a secret.
fn secret_file_name(name: &str) -> bool {
    let original = backup_original(name);
    if CREDENTIAL_FILES.contains(&original.as_str()) || CREDENTIAL_JSON.is_match(&original) || ENV_FILE.is_match(&original) {
        return true;
    }
    if original.rfind('.').is_some_and(|dot| KEY_EXTENSIONS.iter().any(|key| *key == &original[dot..])) {
        return true;
    }
    SSH_PRIVATE_KEY.is_match(&original)
}

fn mixdog_secret(rest: &[String]) -> bool {
    if rest.iter().any(|segment| MIXDOG_SECRET_DIRECTORIES.contains(&segment.as_str())) {
        return true;
    }
    let name = rest.last().map_or("", String::as_str);
    let extension = name.rfind('.').map_or("", |dot| &name[dot..]);
    MIXDOG_SECRET_FILE.is_match(name) || MIXDOG_SECRET_EXTENSIONS.contains(&extension)
}

/// `sensitivePathSegments`: no extended-path prefix, no NTFS stream suffix, no trailing dots or
/// spaces, lower case.
pub fn segments_of(path: &str) -> Vec<String> {
    let stripped = EXTENDED_PREFIX.find(path).map_or(path, |hit| &path[hit.end..]);
    stripped
        .split(['\\', '/'])
        .map(|segment| segment.split(':').next().unwrap_or("").trim_end_matches(['.', ' ']).to_lowercase())
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// `matchesSensitivePath(path, within)`: `path` is already absolute and normalized (Node
/// resolves it first); `within` holds the segments of Mixdog's home and data folders, where
/// only their secret subset is denied.
pub fn matches_sensitive_path(path: &str, within: &[Vec<String>]) -> bool {
    let segments = segments_of(path);
    let name = segments.last().map_or("", String::as_str);
    if segments.iter().any(|segment| SECRET_DIRECTORIES.contains(&segment.as_str())) {
        return true;
    }
    if secret_file_name(name) || SECRET_SEQUENCES.iter().any(|run| has_run(&segments, run)) {
        return true;
    }
    within
        .iter()
        .any(|root| !root.is_empty() && root.iter().enumerate().all(|(i, segment)| segments.get(i) == Some(segment)) && mixdog_secret(&segments[root.len()..]))
}

fn has_run(segments: &[String], run: &[&str]) -> bool {
    segments.windows(run.len()).any(|window| window.iter().zip(run).all(|(a, b)| a == b))
}

/// `realOrSelf`: the canonical path, or the canonical parent with the missing tail put back.
fn real_or_self(path: &Path) -> PathBuf {
    if let Ok(real) = crate::pathguard::canonical(path) {
        return real;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if parent != path => real_or_self(parent).join(name),
        _ => path.to_path_buf(),
    }
}

/// `mixdogSensitiveScopes`: the `within` of [`matches_sensitive_path`] for these folders (home, data, extra), each as written and
/// as its links resolve.
pub fn scopes(folders: &[PathBuf]) -> Vec<Vec<String>> {
    let mut scopes = Vec::new();
    for folder in folders.iter().filter(|folder| !folder.as_os_str().is_empty()) {
        let written = crate::pathguard::resolve(folder);
        let real = real_or_self(&written);
        scopes.push(segments_of(&written.to_string_lossy()));
        if real != written {
            scopes.push(segments_of(&real.to_string_lossy()));
        }
    }
    scopes
}

/// `isSensitiveLocalPath(path)`: the path as written, or what its links lead to, is a secret file.
pub fn is_sensitive(path: &Path, scopes: &[Vec<String>]) -> bool {
    let written = crate::pathguard::resolve(path);
    matches_sensitive_path(&written.to_string_lossy(), scopes) || matches_sensitive_path(&real_or_self(&written).to_string_lossy(), scopes)
}
