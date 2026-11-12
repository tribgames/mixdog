//! Links in mails the core itself read for a session through Mixdog's own Gmail connector: the one way a link carrying a token (a
//! sign-up or sign-in confirmation) becomes navigable in Browser Use, whose desktop host refuses every other agent URL with one
//! (`apps/desktop/src/main/browser/url-policy.ts`). Node's `browser-bridge/mail-links.mjs`: a link is recorded from the
//! `read_email` result the core received, never from anything the model passes, and is offered (as `mail_link` on a `navigate`)
//! only for that exact link, in the same session, for a short time; the desktop checks it again.
//!
//! Only a mail whose one From mailbox Gmail authenticated counts, and only the link targets the connector read from it (its
//! `links`, exactly as written).

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;

use regex::Regex;
use serde_json::Value;
use serde_json::json;
use url::Url;

/// How long after the read a mail's link stays navigable: the lifetime the desktop gives a sign-in flow, a 2-step check
/// included (`MAIL_LINK_WINDOW_MS`, which the desktop's `url-policy.ts` enforces again).
pub const MAIL_LINK_WINDOW_MS: i64 = 30 * 60_000;

/// `{ url, from_domain, read_at }`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MailLink {
    pub url: String,
    pub from_domain: String,
    /// Milliseconds since the epoch.
    pub read_at: i64,
}

impl MailLink {
    /// The `mail_link` member of the `navigate` command.
    pub fn to_json(&self) -> Value {
        json!({ "url": self.url, "from_domain": self.from_domain, "read_at": self.read_at })
    }
}

/// Session id → the links of the mails read for it, oldest first. A process-wide table, as Node's module-level one.
static LINKS: LazyLock<Mutex<HashMap<String, Vec<MailLink>>>> = LazyLock::new(Mutex::default);

/// `domain` as a URL host spells it (IDNs in punycode); `None` when it is none.
fn host_of(domain: &str) -> Option<String> {
    static SHAPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$").expect("a fixed pattern"));
    let text = domain.to_lowercase();
    if !SHAPE.is_match(&text) {
        return None;
    }
    // As Node's `new URL(..).hostname`: an address spelled as digits (`0x7f.1`) is its dotted-quad form, which stays a host.
    Some(Url::parse(&format!("https://{text}/")).ok()?.host_str()?.to_owned())
}

/// tldts's `isValidHostname`: a shallow structural check (at most 255 bytes, a label of at most 63, no label starting or ending
/// with `-`, no empty label) that every host passes before its suffix is looked up.
fn is_valid_hostname(host: &str) -> bool {
    host.len() <= 255
        && host.split('.').all(|label| {
            let bytes = label.as_bytes();
            (1..=63).contains(&bytes.len()) && bytes[0] != b'-' && bytes[bytes.len() - 1] != b'-' && bytes.iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_' || b > 127)
        })
}

/// tldts's `isIp` for a host that passed `is_valid_hostname`: seven to fifteen digits and dots with exactly three dots.
fn is_dotted_quad(host: &str) -> bool {
    (7..=15).contains(&host.len()) && host.bytes().all(|b| b.is_ascii_digit() || b == b'.') && host.bytes().filter(|&b| b == b'.').count() == 3 && !host.starts_with('.') && !host.ends_with('.')
}

/// The Organizational Domain of `host` (RFC 7489 §3.2: by the public suffix list, its private suffixes included, so `a.github.io` is
/// not `b.github.io`); `None` for an invalid hostname, an IP address, a bare suffix or no host.
fn site_of(host: &str) -> Option<String> {
    if !is_valid_hostname(host) || is_dotted_quad(host) {
        return None;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let suffix = suffix::length(&labels);
    (labels.len() > suffix).then(|| labels[labels.len() - suffix - 1..].join("."))
}

/// The public-suffix lookup of tldts (`suffix-trie.js`) over the trie it ships (`public_suffix.txt`, generated from it).
mod suffix {
    use std::collections::HashMap;
    use std::sync::LazyLock;

    const DATA: &str = include_str!("mail_links/public_suffix.txt");
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

    /// The deepest node with a rule the labels (left to right) spell from the right, as `(index of its first label, ...)`.
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
    pub(super) fn length(labels: &[&str]) -> usize {
        // An exception strips its own left-most label; no rule at all makes the right-most label the suffix.
        if let Some(index) = walk(&TRIE.exceptions, labels) {
            return labels.len() - index - 1;
        }
        walk(&TRIE.rules, labels).map_or(1, |index| labels.len() - index)
    }
}

/// The From domain of read_email header `head` when From names exactly one mailbox (with several, RFC 7489 §6.6.1 checks each
/// author domain, and one verdict cannot vouch for the one a link names) and Gmail authenticated it: DMARC passed for that very
/// domain, or a passing DKIM signature's `d=` is aligned with it in relaxed mode (the same Organizational Domain, RFC 7489 §3.1.1).
fn authenticated_sender(head: &Value) -> Option<String> {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or_default().to_owned();
    let from = head.get("fromAddresses").and_then(Value::as_array).filter(|from| from.len() == 1)?;
    let address = text(from[0].get("address"));
    let host = host_of(address.rsplit_once('@')?.1)?;
    let authentication = head.get("authentication");
    let dmarc = authentication.and_then(|a| a.get("dmarc"));
    if dmarc.and_then(|d| d.get("result")).and_then(Value::as_str) == Some("pass") && host_of(&text(dmarc.and_then(|d| d.get("from")))).as_deref() == Some(host.as_str()) {
        return Some(host);
    }
    let site = site_of(&host)?;
    let signed = authentication.and_then(|a| a.get("dkim")).and_then(Value::as_array).is_some_and(|signatures| {
        signatures.iter().any(|sig| {
            sig.get("result").and_then(Value::as_str) == Some("pass")
                && host_of(&text(sig.get("domain"))).and_then(|domain| site_of(&domain)).as_deref() == Some(site.as_str())
        })
    });
    signed.then_some(host)
}

/// The normalized https URL `raw` is, with no credentials in it.
fn https_href(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    (url.scheme() == "https" && url.username().is_empty() && url.password().is_none()).then(|| url.into())
}

/// Milliseconds since the epoch on the wall clock: the clock the desktop judges `read_at` by.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn table() -> std::sync::MutexGuard<'static, HashMap<String, Vec<MailLink>>> {
    LINKS.lock().unwrap_or_else(PoisonError::into_inner)
}

fn prune_expired(links: &mut HashMap<String, Vec<MailLink>>, now: i64) {
    links.retain(|_, list| {
        list.retain(|link| now - link.read_at <= MAIL_LINK_WINDOW_MS);
        !list.is_empty()
    });
}

/// Records the https link targets of read_email result `result` (its header line, `links` among its fields, a blank line, the
/// body) for `session`, with the authenticated sender's domain. Links leave only by the window.
pub fn record(session: &str, result: &str, now: i64) {
    let mut links = table();
    prune_expired(&mut links, now);
    if session.is_empty() {
        return;
    }
    let Some((head, _)) = result.split_once("\n\n") else { return };
    let Ok(head) = serde_json::from_str::<Value>(head) else { return };
    let Some(from_domain) = authenticated_sender(&head) else { return };
    let Some(listed) = head.get("links").and_then(Value::as_array) else { return };
    let mut seen = HashSet::new();
    let found: Vec<String> = listed.iter().filter_map(|link| https_href(link.as_str()?)).filter(|href| seen.insert(href.clone())).collect();
    if found.is_empty() {
        return;
    }
    let kept = links.entry(session.to_owned()).or_default();
    kept.retain(|link| !seen.contains(&link.url));
    kept.extend(found.into_iter().map(|url| MailLink { url, from_domain: from_domain.clone(), read_at: now }));
}

/// The link when `url` is exactly a link of a mail read for `session` within the window.
pub fn link_for(session: &str, url: &str, now: i64) -> Option<MailLink> {
    let mut links = table();
    prune_expired(&mut links, now);
    let href = https_href(&mixdog_js::js_trim(url))?;
    links.get(session)?.iter().find(|link| link.url == href).cloned()
}

/// Node's recording of the same operations (`fixtures/mail-link-navigation`), for the replays here and in `browser.rs`.
#[cfg(test)]
pub(crate) mod replay {
    use std::sync::Mutex;
    use std::sync::MutexGuard;
    use std::sync::PoisonError;

    use serde_json::Value;

    use super::MailLink;
    use super::now_ms;

    const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/mail-link-navigation/golden.json");

    /// The table is process-wide and the window is judged by the clock: replays that use it take turns.
    pub(crate) fn exclusive() -> MutexGuard<'static, ()> {
        static TURN: Mutex<()> = Mutex::new(());
        TURN.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The recorded operations of the case whose title starts with `title`, and the clock that maps Node's held time onto this one:
    /// Node ran with `Date.now` held at `clock`; the replay runs at `base` and keeps every recorded distance from it.
    pub(crate) struct Case {
        pub(crate) ops: Vec<Value>,
        clock: i64,
        base: i64,
    }

    impl Case {
        pub(crate) fn of(title: &str) -> Self {
            let golden: Value = serde_json::from_str(&GOLDEN).expect("golden.json");
            let case = golden["cases"].as_array().expect("cases").iter().find(|case| case["case"].as_str().is_some_and(|name| name.starts_with(title))).unwrap_or_else(|| panic!("no recorded case {title}"));
            assert!(case["observed"].get("threw").is_none(), "{title} threw in Node");
            Self { ops: case["observed"]["ops"].as_array().expect("ops").clone(), clock: golden["clock"]["dateNow"].as_i64().expect("clock"), base: now_ms() }
        }

        /// A recorded time on this clock.
        pub(crate) fn at(&self, node: &Value) -> i64 {
            self.base + node.as_i64().expect("a time") - self.clock
        }

        /// The link Node answered (`null`: none), with its time on this clock.
        pub(crate) fn link(&self, node: &Value) -> Option<MailLink> {
            (!node.is_null()).then(|| MailLink {
                url: node["url"].as_str().expect("url").to_owned(),
                from_domain: node["from_domain"].as_str().expect("from_domain").to_owned(),
                read_at: self.at(&node["read_at"]),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::replay::Case;
    use super::replay::exclusive;
    use super::*;

    /// Every `record` and `probe` of the recorded case, in order, answered as Node answered.
    fn replays(title: &str) {
        let _turn = exclusive();
        let case = Case::of(title);
        let mut probes = 0;
        for op in &case.ops {
            let session = op["session"].as_str().expect("session");
            match op["op"].as_str().expect("op") {
                "record" => record(session, op["mail"].as_str().expect("mail"), case.at(&op["at"])),
                "probe" => {
                    probes += 1;
                    assert_eq!(link_for(session, op["url"].as_str().expect("url"), case.at(&op["at"])), case.link(&op["link"]), "{}: {}", session, op["why"]);
                }
                other => panic!("unexpected recorded operation {other}"),
            }
        }
        assert!(probes > 0, "{title}: nothing was probed");
    }

    #[test]
    fn a_mails_links_are_offered_for_exactly_the_targets_it_writes() {
        replays("the links are the exact targets the mail writes");
    }

    #[test]
    fn a_link_is_offered_only_while_recent_and_over_https() {
        replays("a link is offered only while recent and over https");
    }

    #[test]
    fn only_a_single_from_mailbox_gmail_authenticated_counts() {
        replays("only a single From mailbox that Gmail authenticated counts");
    }

    #[test]
    fn the_hostnames_a_mail_spells_are_judged_as_tldts_judges_them() {
        replays("the hostnames the sender, the signing domain and the link may spell");
    }
}
