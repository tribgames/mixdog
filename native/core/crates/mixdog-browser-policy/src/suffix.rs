//! The registrable domain of a host by tldts 7.4.19 (`getDomain(host, { allowPrivateDomains: true })`): the public suffix list
//! with its private suffixes (`a.github.io` is not `b.github.io`), looked up in the trie tldts ships (`suffix-trie.js`), which
//! `public_suffix.txt` is generated from (benchmarks/rust-core/recorders/gen-public-suffix.mjs).

use std::collections::HashMap;
use std::sync::LazyLock;

const DATA: &str = include_str!("public_suffix.txt");
/// ICANN and private rules both count.
const MASK: u8 = 3;

struct Trie {
    rules: HashMap<String, u8>,
    exceptions: HashMap<String, u8>,
}

static TRIE: LazyLock<Trie> = LazyLock::new(|| {
    let mut trie = Trie { rules: HashMap::new(), exceptions: HashMap::new() };
    for line in DATA.lines().filter(|line| !line.starts_with('#')) {
        let mut fields = line.splitn(3, ' ');
        let (Some(root), Some(flags), Some(path)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let table = if root == "r" { &mut trie.rules } else { &mut trie.exceptions };
        table.insert(path.to_owned(), flags.parse().unwrap_or(0));
    }
    trie
});

/// The deepest node with a rule that the labels (left to right) spell from the right: the index of its first label.
fn walk(nodes: &HashMap<String, u8>, labels: &[&str]) -> Option<usize> {
    let mut path = String::new();
    let mut found = None;
    for (index, label) in labels.iter().enumerate().rev() {
        let child = |name: &str| if path.is_empty() { name.to_owned() } else { format!("{path}/{name}") };
        let exact = child(label);
        let next = if nodes.contains_key(&exact) { exact } else { child("*") };
        let Some(flags) = nodes.get(&next) else { return found };
        if flags & MASK != 0 {
            found = Some(index);
        }
        path = next;
    }
    found
}

/// How many right-most labels of `labels` are the public suffix.
pub fn suffix_length(labels: &[&str]) -> usize {
    // An exception strips its own left-most label; no rule at all makes the right-most label the suffix.
    if let Some(index) = walk(&TRIE.exceptions, labels) {
        return labels.len() - index - 1;
    }
    walk(&TRIE.rules, labels).map_or(1, |index| labels.len() - index)
}

/// tldts's `isValidHostname`: a shallow structural check (at most 255 bytes, a label of at most 63, no label starting or ending
/// with `-`, no empty label) that every host passes before its suffix is looked up.
fn is_valid_hostname(host: &str) -> bool {
    host.len() <= 255
        && host.split('.').all(|label| {
            let bytes = label.as_bytes();
            (1..=63).contains(&bytes.len())
                && bytes[0] != b'-'
                && bytes[bytes.len() - 1] != b'-'
                && bytes.iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_' || b > 127)
        })
}

/// tldts's `isIp` for a host that passed `is_valid_hostname`: seven to fifteen digits and dots with exactly three dots.
fn is_dotted_quad(host: &str) -> bool {
    (7..=15).contains(&host.len())
        && host.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && host.bytes().filter(|&b| b == b'.').count() == 3
        && !host.starts_with('.')
        && !host.ends_with('.')
}

/// The registrable domain of `hostname` (the suffix and the label before it); `None` for an invalid hostname, an IP address or a bare
/// suffix. Trailing dots are dropped and ASCII letters lowercased first, as tldts does.
pub fn registrable_domain(hostname: &str) -> Option<String> {
    let lowered = hostname.to_lowercase();
    let host = lowered.trim_end_matches('.');
    if !is_valid_hostname(host) || is_dotted_quad(host) {
        return None;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let suffix = suffix_length(&labels);
    (labels.len() > suffix).then(|| labels[labels.len() - suffix - 1..].join("."))
}

#[cfg(test)]
mod tests {
    use super::registrable_domain;

    #[test]
    fn follows_tldts() {
        let site = |host: &str| registrable_domain(host);
        assert_eq!(site("example.com."), Some("example.com".into()));
        assert_eq!(site("example.com.."), Some("example.com".into()));
        assert_eq!(site("EXAMPLE.com"), Some("example.com".into()));
        assert_eq!(site("a.github.io"), Some("a.github.io".into()));
        assert_eq!(site("github.io"), None);
        assert_eq!(site("co.uk"), None);
        assert_eq!(site("foo.bar.co.uk"), Some("bar.co.uk".into()));
        assert_eq!(site("a.www.ck"), Some("www.ck".into()));
        assert_eq!(site("b.a.ck"), Some("b.a.ck".into()));
        assert_eq!(site("[::1]"), None);
        assert_eq!(site("127.0.0.1"), None);
        assert_eq!(site("localhost"), None);
        assert_eq!(site("-a.com"), None);
        assert_eq!(site("a..com"), None);
        assert_eq!(site("a_b.example.com"), Some("example.com".into()));
    }
}
