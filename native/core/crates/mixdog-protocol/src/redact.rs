//! The removal of a call's own secrets from a text that leaves the core: the words of a failure told to a paired phone
//! (`mixdog-app-server` `relay_answer.rs`) and of a request a window made about a server's logins (`mixdog-connections`
//! `server_logins.rs`) lose the keys the call carried.

/// What stands where a secret was.
pub const REDACTED: &str = "[redacted]";

/// `text` with each of `secrets` (plain, and as the inside of a JSON string when that is spelled differently) replaced by
/// [`REDACTED`]. An empty secret removes nothing.
pub fn redact_secrets<S: AsRef<str>>(text: &str, secrets: &[S]) -> String {
    let mut safe = text.to_owned();
    for secret in secrets.iter().map(AsRef::as_ref).filter(|secret| !secret.is_empty()) {
        let json = serde_json::to_string(secret).expect("a string serializes");
        let escaped = &json[1..json.len() - 1];
        safe = safe.replace(secret, REDACTED);
        if escaped != secret {
            safe = safe.replace(escaped, REDACTED);
        }
    }
    safe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_goes_plain_and_as_the_inside_of_a_json_string() {
        let secret = "ab\"cd\\ef";
        let text = format!("failed with {secret} and {}", serde_json::to_string(secret).unwrap());
        let safe = redact_secrets(&text, &[secret]);
        assert!(!safe.contains("cd"), "{safe}");
        assert_eq!(safe, format!("failed with {REDACTED} and \"{REDACTED}\""));
    }

    #[test]
    fn an_empty_secret_removes_nothing_and_owned_secrets_work_too() {
        assert_eq!(redact_secrets("keep", &[""]), "keep");
        assert_eq!(redact_secrets("a key-123 b", &["key-123".to_owned()]), format!("a {REDACTED} b"));
    }
}
