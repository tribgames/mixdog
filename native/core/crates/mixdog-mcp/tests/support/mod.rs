//! Shared by the suites that replay a recorded golden whose paths were recorded under a fixed
//! scratch directory.

use sha1::Digest;
use sha1::Sha1;

fn short_hash(text: &str) -> String {
    let digest = Sha1::digest(text.as_bytes());
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

fn json_escaped(text: &str) -> String {
    let quoted = serde_json::to_string(text).unwrap();
    quoted[1..quoted.len() - 1].to_owned()
}

/// Maps a golden recorded under its own scratch directory onto `new_base` (a directory the
/// replay allocated): the recorded base becomes `new_base`, and the plugin ids that Node derived
/// from the hash of each recorded local source path (`<base>\src\<name>`) become the ids of the
/// relocated path. Nothing on disk at the recorded base is touched.
pub fn relocate(golden: &str, new_base: &str) -> String {
    let parsed: serde_json::Value = serde_json::from_str(golden).unwrap();
    let old_base = parsed["base"].as_str().unwrap().to_owned();
    let mut text = golden.to_owned();
    for name in parsed["fixtures"].as_object().unwrap().keys() {
        let old = short_hash(&format!("{old_base}\\src\\{name}"));
        let new = short_hash(&format!("{new_base}\\src\\{name}"));
        text = text.replace(&old, &new);
    }
    text.replace(&json_escaped(&old_base), &json_escaped(new_base))
}
