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

use mixdog_browser_policy::suffix::registrable_domain;
use regex::Regex;
use serde_json::Value;
use serde_json::json;
use url::Url;

/// How long after the read a mail's link stays navigable: the lifetime the desktop gives a sign-in flow, a 2-step check
/// included (`MAIL_LINK_WINDOW_MS`, which the desktop's `url-policy.ts` enforces again).
pub use mixdog_browser_policy::url_policy::MAIL_LINK_WINDOW_MS;

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
    let site = registrable_domain(&host)?;
    let signed = authentication.and_then(|a| a.get("dkim")).and_then(Value::as_array).is_some_and(|signatures| {
        signatures.iter().any(|sig| {
            sig.get("result").and_then(Value::as_str) == Some("pass")
                && host_of(&text(sig.get("domain"))).and_then(|domain| registrable_domain(&domain)).as_deref() == Some(site.as_str())
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
    let href = https_href(mixdog_js::js_trim(url))?;
    links.get(session)?.iter().find(|link| link.url == href).cloned()
}



#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    /// A read_email result: its header line, a blank line, the body.
    fn mail(from: &str, dmarc: Value, dkim: Value, links: &[&str]) -> String {
        let head = json!({
            "fromAddresses": [{ "address": from }],
            "authentication": { "dmarc": dmarc, "dkim": dkim },
            "links": links,
        });
        format!("{head}\n\nbody")
    }

    fn passed(domain: &str) -> Value {
        json!({ "result": "pass", "from": domain })
    }

    #[test]
    fn a_mails_links_are_offered_for_exactly_the_targets_it_writes() {
        let session = "links-exact";
        record(session, &mail("a@news.example.com", passed("news.example.com"), json!([]), &["https://news.example.com/confirm?t=1"]), NOW);
        let link = link_for(session, "https://news.example.com/confirm?t=1", NOW).expect("the written target is offered");
        assert_eq!(link, MailLink { url: "https://news.example.com/confirm?t=1".into(), from_domain: "news.example.com".into(), read_at: NOW });
        assert_eq!(link.to_json(), json!({ "url": "https://news.example.com/confirm?t=1", "from_domain": "news.example.com", "read_at": NOW }));
        assert!(link_for(session, "https://news.example.com/confirm?t=2", NOW).is_none(), "another target of the same host");
        assert!(link_for("another-session", "https://news.example.com/confirm?t=1", NOW).is_none(), "another session");
    }

    #[test]
    fn a_link_is_offered_only_while_recent_and_over_https() {
        let session = "links-window";
        let body = mail(
            "a@example.com",
            passed("example.com"),
            json!([]),
            &["https://example.com/ok", "http://example.com/plain", "https://user:pw@example.com/creds"],
        );
        record(session, &body, NOW);
        assert!(link_for(session, "https://example.com/ok", NOW + MAIL_LINK_WINDOW_MS).is_some(), "the last moment of the window");
        assert!(link_for(session, "http://example.com/plain", NOW).is_none(), "http is never recorded");
        assert!(link_for(session, "https://user:pw@example.com/creds", NOW).is_none(), "credentials in the link are never recorded");
        assert!(link_for(session, "https://example.com/ok", NOW + MAIL_LINK_WINDOW_MS + 1).is_none(), "past the window");
        assert!(link_for(session, "https://example.com/ok", NOW).is_none(), "an expired link is forgotten");
    }

    #[test]
    fn only_a_single_from_mailbox_gmail_authenticated_counts() {
        let record_for = |session: &str, head: Value| record(session, &format!("{head}\n\nbody"), NOW);
        let links = ["https://example.com/go"];
        let authenticated = json!({ "dmarc": passed("example.com"), "dkim": [] });
        // Unauthenticated, failing and misaligned verdicts record nothing.
        record_for("mb-none", json!({ "fromAddresses": [{ "address": "a@example.com" }], "links": links }));
        record_for("mb-fail", json!({ "fromAddresses": [{ "address": "a@example.com" }], "authentication": { "dmarc": { "result": "fail", "from": "example.com" }, "dkim": [] }, "links": links }));
        record_for("mb-misaligned", json!({ "fromAddresses": [{ "address": "a@example.com" }], "authentication": { "dmarc": passed("other.org"), "dkim": [] }, "links": links }));
        // Two mailboxes in From: one verdict cannot vouch for the one a link names.
        record_for("mb-two", json!({ "fromAddresses": [{ "address": "a@example.com" }, { "address": "b@example.com" }], "authentication": authenticated, "links": links }));
        for session in ["mb-none", "mb-fail", "mb-misaligned", "mb-two"] {
            assert!(link_for(session, "https://example.com/go", NOW).is_none(), "{session}");
        }
        // A passing DKIM signature aligned with the sender in relaxed mode (same organizational domain) vouches for it.
        record_for("mb-dkim", json!({ "fromAddresses": [{ "address": "a@mail.example.com" }], "authentication": { "dkim": [{ "result": "pass", "domain": "example.com" }] }, "links": links }));
        assert_eq!(link_for("mb-dkim", "https://example.com/go", NOW).map(|l| l.from_domain), Some("mail.example.com".to_owned()));
    }

    #[test]
    fn the_hostnames_a_mail_spells_are_normalised_before_they_are_judged() {
        // Upper case in the sender's domain and the link's host reads as the lower case host.
        record("host-case", &mail("A@Example.COM", passed("EXAMPLE.com"), json!([]), &["https://EXAMPLE.com/Path"]), NOW);
        let link = link_for("host-case", " https://example.com/Path ", NOW).expect("surrounding white space is trimmed and the host lower-cased");
        assert_eq!((link.url.as_str(), link.from_domain.as_str()), ("https://example.com/Path", "example.com"));
        // A sender that is not a host name (no dot) never authenticates.
        record("host-bare", &mail("a@localhost", passed("localhost"), json!([]), &["https://example.com/x"]), NOW);
        assert!(link_for("host-bare", "https://example.com/x", NOW).is_none());
    }
}
