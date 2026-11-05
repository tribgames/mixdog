//! Provider-safe qualified tool names (T §4 target 2): `mcp__<server>__<tool>`, cut with a
//! stable hash suffix only when the provider limit forces it. The catalog records the original
//! pair, so dispatch never parses a name back.

use sha1::Digest;
use sha1::Sha1;

/// Provider limit on tool names (the strictest among supported providers).
pub const PROVIDER_TOOL_NAME_MAX: usize = 64;
const KEPT_SERVER_PART_MAX: usize = 40;
const SHORT_SERVER_PART_MAX: usize = 24;
const HASH_LEN: usize = 8;

fn provider_safe(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn hash8(full: &str) -> String {
    // SHA-1 as Node derives it: the model sees these names, so the digest is part of the name.
    let digest = Sha1::digest(full.as_bytes());
    digest.iter().take(HASH_LEN / 2).map(|b| format!("{b:02x}")).collect()
}

/// A server part that is already `[A-Za-z0-9-]+(_[A-Za-z0-9-]+)*` and short enough is kept.
fn server_part_is_kept(server: &str) -> bool {
    server.len() <= KEPT_SERVER_PART_MAX
        && !server.is_empty()
        && !server.starts_with('_')
        && !server.ends_with('_')
        && !server.contains("__")
        && provider_safe(server)
}

fn sanitize(text: &str, keep_underscore: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || (keep_underscore && c == '_');
        if ok {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push(if keep_underscore { '_' } else { '-' });
            in_run = true;
        }
    }
    out
}

/// `mcp__<server>__<tool>` when it already fits `max_len` and the provider alphabet, else a
/// deterministic short form ending in a hash of the full name so distinct tools never meet.
pub fn qualified_tool_name(server: &str, tool: &str, max_len: usize) -> String {
    let full = format!("mcp__{server}__{tool}");
    if full.len() <= max_len && provider_safe(&full) {
        return full;
    }
    let hash = hash8(&full);
    let server_part = if server_part_is_kept(server) {
        server.to_owned()
    } else {
        let cleaned = sanitize(server, false);
        let trimmed: String = cleaned
            .trim_matches('-')
            .chars()
            .take(SHORT_SERVER_PART_MAX)
            .collect::<String>()
            .trim_end_matches('-')
            .to_owned();
        if trimmed.is_empty() { "server".to_owned() } else { trimmed }
    };
    let prefix = format!("mcp__{server_part}__");
    let room = max_len.saturating_sub(prefix.len() + hash.len() + 1);
    let tool_part: String = sanitize(tool, true).chars().take(room).collect::<String>().trim_end_matches('_').to_owned();
    if tool_part.is_empty() {
        format!("{prefix}{hash}")
    } else {
        format!("{prefix}{tool_part}_{hash}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fitting_names_are_unchanged() {
        assert_eq!(qualified_tool_name("fs", "read_file", 64), "mcp__fs__read_file");
    }

    #[test]
    fn long_names_get_a_stable_hash_and_distinct_tools_stay_distinct() {
        let a = qualified_tool_name("srv", &"a".repeat(80), 64);
        let b = qualified_tool_name("srv", &format!("{}b", "a".repeat(80)), 64);
        assert!(a.len() <= 64 && b.len() <= 64);
        assert_ne!(a, b);
        assert_eq!(a, qualified_tool_name("srv", &"a".repeat(80), 64));
    }

    #[test]
    fn unsafe_characters_are_replaced_and_hashed() {
        let n = qualified_tool_name("my server", "do it!", 64);
        assert!(n.starts_with("mcp__my-server__do_it_"));
        assert!(provider_safe(&n));
    }
}