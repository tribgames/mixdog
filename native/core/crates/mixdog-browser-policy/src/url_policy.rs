//! Pure URL admission rules (`url-policy.ts`): scheme, embedded credentials, agent-input secret tokens (but in a link the runtime
//! read in a mail for the session), cloud metadata endpoints, private networks, and the optional domain allow-list.
//! [`crate::url_admission`] wraps these with DNS resolution; navigation and request filtering both call through here.
//! A refusal's `reason` is the message the TypeScript rules threw, word for word.

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use url::Url;

use crate::redaction::{redact_browser_text, url_contains_secret};
use crate::suffix::registrable_domain;

/// How long after the runtime read a mail its link may still be opened: the lifetime of a sign-in flow, a 2-step check included
/// (`FLOW_TTL_MS` of `linked-sign-in.ts`).
pub const MAIL_LINK_WINDOW_MS: i64 = 30 * 60_000;

/// The allow-list and private-network stance a host runs under.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UrlPolicy {
    pub allow_private_network: bool,
    pub allowed_domains: Vec<String>,
}

/// Runtime-set on a navigate, never a tool argument: `url` appeared in a mail from `from_domain` that the runtime read through
/// its mailbox connector for this session at `read_at` (milliseconds since the epoch; `None` when the command carried none).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MailLink {
    pub url: String,
    pub from_domain: String,
    pub read_at: Option<i64>,
}

/// Which rule set applies to a URL: one an agent typed, or one a page asked for (which may carry the OAuth and tracking tokens
/// the site needs, so only the agent-input secret refusal is skipped).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmitKind {
    Agent,
    Page,
}

/// What a decision depends on besides the URL and the policy.
#[derive(Clone, Debug)]
pub struct AdmitCtx {
    pub kind: AdmitKind,
    /// The provenance of a navigate; lifts only the secret-token refusal, only for the exact link it names.
    pub mail_link: Option<MailLink>,
    /// The clock the mail-link window is read against, milliseconds since the epoch.
    pub now_ms: i64,
}

impl AdmitCtx {
    pub fn agent(now_ms: i64) -> Self {
        Self { kind: AdmitKind::Agent, mail_link: None, now_ms }
    }

    pub fn page(now_ms: i64) -> Self {
        Self { kind: AdmitKind::Page, mail_link: None, now_ms }
    }
}

/// A URL the rules do not admit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub reason: String,
}

impl Refusal {
    pub(crate) fn new(reason: impl Into<String>) -> Self {
        Self { reason: reason.into() }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.reason)
    }
}

impl std::error::Error for Refusal {}

static SCHEME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[a-z][a-z0-9+.-]*:", "i"));
static LOOPBACK_V4: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^127(?:\.\d{1,3}){0,3}$", ""));
static UNIQUE_LOCAL_V6: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:fc|fd)[0-9a-f]{2}:", "i"));
static LINK_LOCAL_V6: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^fe[89ab][0-9a-f]:", "i"));
static MAPPED_V4: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$", "i"));
static SENDER_DOMAIN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[\p{L}\p{N}.-]+$", "u"));

/// Whether agent URL `raw` is exactly the https link `link` names, read within the window, on the registrable domain of the
/// mail's sender: the one agent URL that may carry a token. Where the page redirects afterwards is its own.
fn mail_link_admits(raw: &str, link: Option<&MailLink>, now_ms: i64) -> bool {
    let Some(link) = link else { return false };
    if !SENDER_DOMAIN.is_match(&link.from_domain) {
        return false;
    }
    let Ok(parsed) = Url::parse(js_trim(raw)) else { return false };
    let Ok(named) = Url::parse(&link.url) else { return false };
    if parsed.as_str() != named.as_str() {
        return false;
    }
    let Some(sender) = Url::parse(&format!("https://{}/", link.from_domain)).ok().and_then(|url| url.host_str().map(str::to_owned)) else {
        return false;
    };
    let Some(read_at) = link.read_at else { return false };
    let age = now_ms - read_at;
    if parsed.scheme() != "https" || !(0..=MAIL_LINK_WINDOW_MS).contains(&age) {
        return false;
    }
    // The registrable domain on the public suffix list, private suffixes included (`a.github.io` is not `b.github.io`).
    let site = registrable_domain(parsed.host_str().unwrap_or_default());
    site.is_some() && site == registrable_domain(&sender)
}

fn normalized_hostname(value: &str) -> String {
    let lowered = js_to_lowercase(js_trim(value));
    let without_open = lowered.strip_prefix('[').unwrap_or(&lowered);
    let without_close = without_open.strip_suffix(']').unwrap_or(without_open);
    without_close.strip_suffix('.').unwrap_or(without_close).to_owned()
}

/// Whether `hostname` is loopback (`localhost`, `*.localhost`, `::1`, `127.*`).
pub fn is_loopback_hostname(hostname: &str) -> bool {
    let host = normalized_hostname(hostname);
    host == "localhost" || host.ends_with(".localhost") || host == "::1" || LOOPBACK_V4.is_match(&host)
}

/// Node's `net.isIP`: 4, 6 or 0. An IPv6 address may carry a zone (`fe80::1%eth0`).
pub(crate) fn ip_version(host: &str) -> u8 {
    if host.parse::<Ipv4Addr>().is_ok() {
        return 4;
    }
    let (address, zone) = match host.split_once('%') {
        Some((address, zone)) => (address, Some(zone)),
        None => (host, None),
    };
    let zone_ok = zone.is_none_or(|zone| !zone.is_empty() && zone.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b':')));
    if zone_ok && address.parse::<Ipv6Addr>().is_ok() { 6 } else { 0 }
}

fn parse_ipv4(hostname: &str) -> Option<[u8; 4]> {
    normalized_hostname(hostname).parse::<Ipv4Addr>().ok().map(|address| address.octets())
}

fn is_private_ipv4(hostname: &str) -> bool {
    let Some([a, b, _, _]) = parse_ipv4(hostname) else { return false };
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || a >= 224
}

/// The IPv4 address an IPv4-mapped IPv6 one stands for, in dotted form.
fn mapped_ipv4(hostname: &str) -> Option<String> {
    let host = normalized_hostname(hostname);
    if ip_version(&host) != 6 {
        return None;
    }
    // URL canonicalization expands dotted IPv4 tails into two hexadecimal words.
    let canonical = Url::parse(&format!("http://[{host}]/")).ok()?.host_str()?.trim_start_matches('[').trim_end_matches(']').to_owned();
    let caps = MAPPED_V4.captures(&canonical)?;
    let high = u32::from_str_radix(caps.get(1)?, 16).ok()?;
    let low = u32::from_str_radix(caps.get(2)?, 16).ok()?;
    Some(format!("{}.{}.{}.{}", high >> 8, high & 255, low >> 8, low & 255))
}

fn is_private_network_address(address: &str) -> bool {
    let host = normalized_hostname(address);
    if let Some(mapped) = mapped_ipv4(&host) {
        return is_private_ipv4(&mapped);
    }
    match ip_version(&host) {
        4 => is_private_ipv4(&host),
        6 => host == "::" || host == "::1" || UNIQUE_LOCAL_V6.is_match(&host) || LINK_LOCAL_V6.is_match(&host),
        _ => false,
    }
}

fn is_cloud_metadata_host(hostname: &str) -> bool {
    let host = mapped_ipv4(hostname).unwrap_or_else(|| normalized_hostname(hostname));
    matches!(
        host.as_str(),
        "169.254.169.254" | "169.254.170.2" | "100.100.100.200" | "metadata.google.internal" | "metadata.goog" | "fd00:ec2::254"
    )
}

fn allowed_by_domain_policy(hostname: &str, allowed_domains: &[&str]) -> bool {
    let host = normalized_hostname(hostname);
    allowed_domains.iter().any(|raw| {
        let wildcard = js_trim(raw).starts_with("*.");
        let domain = normalized_hostname(raw.strip_prefix("*.").unwrap_or(raw));
        !domain.is_empty() && (host == domain || (wildcard && host.ends_with(&format!(".{domain}"))))
    })
}

/// Browser navigation stays on the web. Cloud metadata endpoints are always refused; private networks are refused unless the policy
/// allows them (a local session on the user's own PC). Loopback remains available for local web-app development.
fn normalize_browser_url(raw: &str, policy: &UrlPolicy, reject_secrets: bool) -> Result<String, Refusal> {
    let text = js_trim(raw);
    if text.is_empty() {
        return Err(Refusal::new("navigate requires url"));
    }
    let candidate = if SCHEME.is_match(text) { text.to_owned() } else { format!("https://{text}") };
    let Ok(parsed) = Url::parse(&candidate) else {
        return Err(Refusal::new(format!("invalid url: {}", redact_browser_text(text))));
    };
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(Refusal::new(format!("only http(s) navigation is allowed (got {}:)", parsed.scheme())));
    }
    if !parsed.username().is_empty() || parsed.password().is_some_and(|password| !password.is_empty()) {
        return Err(Refusal::new("URLs containing embedded credentials are not allowed"));
    }
    let host = normalized_hostname(parsed.host_str().unwrap_or_default());
    if reject_secrets && !is_loopback_hostname(&host) && url_contains_secret(parsed.as_str()) {
        return Err(Refusal::new("navigation URLs may not contain credential-like query values or secret tokens"));
    }
    if is_cloud_metadata_host(&host) {
        return Err(Refusal::new("navigation to cloud metadata endpoints is blocked"));
    }
    if !policy.allow_private_network && !is_loopback_hostname(&host) && is_private_network_address(&host) {
        return Err(Refusal::new(format!("navigation to private or internal address {host} is blocked")));
    }
    let allowed: Vec<&str> = policy.allowed_domains.iter().map(|domain| js_trim(domain)).filter(|domain| !domain.is_empty()).collect();
    if !allowed.is_empty() && !allowed_by_domain_policy(&host, &allowed) {
        return Err(Refusal::new(format!("navigation to {host} is blocked by the Browser Use domain policy")));
    }
    Ok(parsed.to_string())
}

/// The normalized form of a URL an agent typed. `mail_link` lifts only the secret-token refusal, and only for the exact link it
/// names; every other rule still applies.
pub fn normalize_agent_url(raw: &str, policy: &UrlPolicy, mail_link: Option<&MailLink>, now_ms: i64) -> Result<String, Refusal> {
    normalize_browser_url(raw, policy, !mail_link_admits(raw, mail_link, now_ms))
}

/// The normalized form of a URL a page asked for: OAuth or tracking tokens the site needs are kept, so only the agent-input
/// secret refusal is skipped; the scheme, credential, domain, metadata and private-network checks stay.
pub fn normalize_page_url(raw: &str, policy: &UrlPolicy) -> Result<String, Refusal> {
    normalize_browser_url(raw, policy, false)
}

/// Whether `url` is admitted under `policy` by the rule set `ctx` names.
pub fn admit(url: &str, policy: &UrlPolicy, ctx: &AdmitCtx) -> Result<(), Refusal> {
    match ctx.kind {
        AdmitKind::Agent => normalize_agent_url(url, policy, ctx.mail_link.as_ref(), ctx.now_ms),
        AdmitKind::Page => normalize_page_url(url, policy),
    }
    .map(|_| ())
}

/// The check of an address a name resolved to (`hostname` is the name asked for): a metadata endpoint is always refused, a private
/// one unless the policy allows it or the name is loopback.
pub fn assert_resolved_address_allowed(address: &str, hostname: &str, policy: &UrlPolicy) -> Result<(), Refusal> {
    if is_cloud_metadata_host(address) {
        return Err(Refusal::new(format!("navigation to {hostname} resolved to a blocked cloud metadata endpoint")));
    }
    if policy.allow_private_network || is_loopback_hostname(hostname) {
        return Ok(());
    }
    if is_private_network_address(address) {
        return Err(Refusal::new(format!("navigation to {hostname} resolved to blocked private or internal address {address}")));
    }
    Ok(())
}
