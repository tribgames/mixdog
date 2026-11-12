//! What a finished turn hands back (`session-runtime/handoff-attachments.mjs`): [`turn_slice`], the
//! messages of one turn, and [`sensitive`], the credential/secret deny list
//! (`runtime/shared/sensitive-path-rules.mjs`) an automatic hand-off never crosses.

use serde_json::Value;

/// `turnSlice(messages, { runId, since })`: from the user message that took submission `run_id`
/// (or, with `since`, the first user message at or after it) to the end; all of `messages` when
/// neither is asked, and none when the one asked for is not found.
pub fn turn_slice(messages: &Value, run_id: &str, since: f64) -> Vec<Value> {
    let list: &[Value] = messages.as_array().map_or(&[], Vec::as_slice);
    let user = |message: &Value| message.get("role").and_then(Value::as_str) == Some("user");
    let transcript_of = |message: &Value| message.get("meta").and_then(|meta| meta.get("transcript")).cloned().unwrap_or(Value::Null);
    let start = if !run_id.is_empty() {
        list.iter().position(|message| {
            if !user(message) {
                return false;
            }
            let transcript = transcript_of(message);
            let ids = |value: Option<&Value>| value.and_then(Value::as_array).cloned().unwrap_or_default();
            let mut named = std::iter::once(transcript.get("checkpointId").cloned().unwrap_or(Value::Null))
                .chain(ids(transcript.get("submissionIds")))
                .chain(ids(message.get("meta").and_then(|meta| meta.get("submissionIds"))));
            named.any(|id| id.as_str() == Some(run_id))
        })
    } else if since > 0.0 {
        list.iter().position(|message| user(message) && mixdog_js::to_number_of(transcript_of(message).get("at")) >= since)
    } else {
        None
    };
    match start {
        Some(start) => list[start..].to_vec(),
        None if !run_id.is_empty() || since > 0.0 => Vec::new(),
        None => list.to_vec(),
    }
}

/// The credential / secret file deny list of the runtime's attachment hand-offs.
pub mod sensitive {
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
    const CREDENTIAL_FILES: [&str; 12] = [".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".vault-token", ".htpasswd", ".dockercfg", ".envrc", ".s3cfg", "kubeconfig"];
    const MIXDOG_SECRET_DIRECTORIES: [&str; 5] = ["secrets", "mcp-oauth", "provider-accounts", "relay-data", "dev-profile"];
    const MIXDOG_SECRET_EXTENSIONS: [&str; 2] = [".dpapi", ".token"];
    const MAX_BACKUP_SUFFIXES: usize = 3;

    static ENV_FILE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:\.env.*|[^.]{1,64}(?:\.[^.]{1,64}){0,3}\.env)$", ""));
    static CREDENTIAL_JSON: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:.*credential.*|service[-_ ]?account.*|client[-_]?secret.*)\.json$", ""));
    static SSH_PRIVATE_KEY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^id_[a-z0-9]{2,16}(?:[_-][^._-]{1,32}){0,3}$", ""));
    static BACKUP_SUFFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:\.(?:bak|backup|old|orig|prev|save|sav|swp|swo|tmp|copy|\d{1,3})|~)$", ""));
    static MIXDOG_SECRET_FILE: LazyLock<JsRegex> =
        LazyLock::new(|| JsRegex::new_static(r"^\.?(mixdog-config|provider-accounts|relay-hook-device|auth\.json|[a-z0-9-]+-oauth(-credentials)?\.json|[a-z0-9-]+-bridge\.json)", ""));
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
        within.iter().any(|root| !root.is_empty() && root.iter().enumerate().all(|(i, segment)| segments.get(i) == Some(segment)) && mixdog_secret(&segments[root.len()..]))
    }

    fn has_run(segments: &[String], run: &[&str]) -> bool {
        segments.windows(run.len()).any(|window| window.iter().zip(run).all(|(a, b)| a == b))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/session-activity/golden.json");

    fn golden() -> Value {
        serde_json::from_str::<Value>(&GOLDEN).unwrap()["handoff"].clone()
    }

    #[test]
    fn every_recorded_turn_slice_equals_node() {
        for case in golden()["turnSlices"].as_array().unwrap() {
            let options = &case["options"];
            let run_id = options.get("runId").and_then(Value::as_str).unwrap_or("");
            let since = options.get("since").and_then(Value::as_f64).unwrap_or(0.0);
            let slice = turn_slice(&case["messages"], run_id, since);
            assert_eq!(Value::Array(slice), case["slice"], "{}", case["name"]);
        }
    }

    #[test]
    fn every_recorded_path_is_denied_or_allowed_as_in_node() {
        let golden = golden();
        let scopes: Vec<Vec<String>> = golden["scopes"].as_array().unwrap().iter().map(|s| s["root"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()).collect();
        for case in golden["sensitive"].as_array().unwrap() {
            let path = case["path"].as_str().unwrap();
            assert_eq!(sensitive::matches_sensitive_path(path, &scopes), case["denied"] == true, "{path} with scopes");
            assert_eq!(sensitive::matches_sensitive_path(path, &[]), case["deniedWithoutScopes"] == true, "{path}");
        }
    }
}