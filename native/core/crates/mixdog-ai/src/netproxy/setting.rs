//! The network proxy setting model (`runtime/shared/llm/proxy-policy.mjs`): the
//! stored `{ mode, url, exceptions }`, its normalisation, the strict patch and
//! the `NO_PROXY` style exception list.

use std::sync::OnceLock;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::slice_utf16;
use mixdog_js::to_number;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use url::Url;

use super::hosts::Family;
use super::hosts::Rule;
use super::hosts::canonical_host;
use super::hosts::decode_uri_component;
use super::hosts::is_ip;

pub const NETWORK_PROXY_MODES: [&str; 3] = ["system", "manual", "off"];
/// Starting exceptions of a manual proxy, so local providers keep working.
pub const DEFAULT_PROXY_EXCEPTIONS: &str = "localhost, 127.0.0.1, ::1";
/// Schemes the proxy clients can tunnel (http, https, socks5) on every path.
pub const PROXY_SCHEMES: [&str; 3] = ["http:", "https:", "socks5:"];

const MAX_URL_LENGTH: usize = 2048;
const MAX_EXCEPTIONS_LENGTH: usize = 4096;

fn regex(slot: &'static OnceLock<JsRegex>, source: &str, flags: &str) -> &'static JsRegex {
    slot.get_or_init(|| JsRegex::new_static(source, flags))
}

/// A proxy URL as `parseProxyUrl` returns it: the canonical text, or why not.
pub fn parse_proxy_url(text: &Value, schemes: &[&str], credentials: bool) -> Result<String, String> {
    let value = text.as_str().map(js_trim).unwrap_or("");
    if value.is_empty() || utf16_len(value) > MAX_URL_LENGTH || value.chars().any(is_js_space) {
        return Err("is not a proxy address".into());
    }
    let not_an_address = || "is not a proxy address".to_owned();
    let url = Url::parse(value).map_err(|_| not_an_address())?;
    if decode_uri_component(url.username()).is_none() || decode_uri_component(url.password().unwrap_or("")).is_none() {
        return Err(not_an_address());
    }
    let protocol = format!("{}:", url.scheme());
    if !schemes.contains(&protocol.as_str()) {
        let list: Vec<String> = schemes.iter().map(|scheme| format!("{scheme}//")).collect();
        return Err(format!("must start with {}", list.join(", ")));
    }
    let query = url.query().is_some_and(|query| !query.is_empty());
    let fragment = url.fragment().is_some_and(|fragment| !fragment.is_empty());
    let path_ok = matches!(url.path(), "/" | "");
    if url.host_str().is_none_or(str::is_empty) || !path_ok || query || fragment {
        return Err("must be a scheme, host and optional port only".into());
    }
    let password = url.password().unwrap_or("");
    if !credentials && (!url.username().is_empty() || !password.is_empty()) {
        return Err("must not contain a user name or password".into());
    }
    let auth = if url.username().is_empty() {
        String::new()
    } else if password.is_empty() {
        format!("{}@", url.username())
    } else {
        format!("{}:{}@", url.username(), password)
    };
    Ok(format!("{protocol}//{auth}{}", host_with_port(&url)))
}

/// `URL.host`: the host and, unless it is the scheme's default, the port.
pub fn host_with_port(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// `host:port` of a proxy URL for display: no credentials, and the scheme only
/// when it is not http.
pub fn proxy_display(proxy_url: &str) -> String {
    match Url::parse(proxy_url) {
        Ok(url) if url.scheme() == "http" => host_with_port(&url),
        Ok(url) => format!("{}://{}", url.scheme(), host_with_port(&url)),
        Err(_) => String::new(),
    }
}

/// The entries of an exception list: split at white space, commas and semicolons.
fn split_entries(text: &str) -> Vec<&str> {
    text.split(|c: char| is_js_space(c) || c == ',' || c == ';').filter(|part| !part.is_empty()).collect()
}

#[derive(Clone, Debug)]
pub(crate) enum Entry {
    Any,
    Ip { ip: String, family: Family, port: Option<f64> },
    List { rule: Rule },
    Host { host: String, subdomains_only: bool, port: Option<f64> },
}

static BRACKET: OnceLock<JsRegex> = OnceLock::new();
static CIDR: OnceLock<JsRegex> = OnceLock::new();
static RANGE: OnceLock<JsRegex> = OnceLock::new();
static HOST: OnceLock<JsRegex> = OnceLock::new();

fn number(text: &str) -> f64 {
    to_number(&Value::String(text.to_owned()))
}

/// One NO_PROXY / exception entry as a matcher, or `None` when it is none.
pub(crate) fn parse_entry(raw: &str) -> Option<Entry> {
    let entry = raw.to_lowercase();
    if entry == "*" {
        return Some(Entry::Any);
    }
    let bracket = regex(&BRACKET, r"^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$", "").captures(&entry);
    let bare = bracket.as_ref().and_then(|b| b.get(1)).unwrap_or(&entry);
    if is_ip(bare) == 6 {
        let port = bracket.as_ref().and_then(|b| b.get(2)).map(number);
        return Some(Entry::Ip { ip: bare.to_owned(), family: Family::V6, port });
    }
    if let Some(cidr) = regex(&CIDR, r"^([0-9a-f:.]+)/(\d{1,3})$", "").captures(&entry) {
        let network = cidr.get(1).unwrap_or_default();
        if let Some(family) = Family::of(is_ip(network)) {
            let prefix = number(cidr.get(2).unwrap_or_default());
            let rule = (prefix.fract() == 0.0 && prefix >= 0.0)
                .then(|| Rule::subnet(network, prefix as u32, family))
                .flatten();
            return rule.map(|rule| Entry::List { rule });
        }
    }
    let range_source = r"^(\d{1,3}(?:\.\d{1,3}){3})-(\d{1,3}(?:\.\d{1,3}){3})$";
    if let Some(range) = regex(&RANGE, range_source, "").captures(&entry) {
        let (start, end) = (range.get(1).unwrap_or_default(), range.get(2).unwrap_or_default());
        if is_ip(start) == 4 && is_ip(end) == 4 {
            return Rule::range(start, end, Family::V4).map(|rule| Entry::List { rule });
        }
    }
    let host_source = r"^(\*?\.)?([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)(?::(\d{1,5}))?$";
    let host = regex(&HOST, host_source, "").captures(&entry)?;
    let port = host.get(3).map(number);
    if port.is_some_and(|port| port > 65535.0) {
        return None;
    }
    let name = host.get(2).unwrap_or_default();
    if is_ip(name) == 4 {
        return Some(Entry::Ip { ip: name.to_owned(), family: Family::V4, port });
    }
    Some(Entry::Host { host: name.to_owned(), subdomains_only: host.get(1).is_some(), port })
}

fn entry_matches(entry: &Entry, hostname: &str, port: f64, family: Option<Family>) -> bool {
    let entry_port = match entry {
        Entry::Ip { port, .. } | Entry::Host { port, .. } => *port,
        _ => None,
    };
    if matches!(entry, Entry::Any) {
        return true;
    }
    if entry_port.is_some_and(|wanted| wanted != port) {
        return false;
    }
    if let Entry::Host { host, subdomains_only, .. } = entry {
        return (!subdomains_only && hostname == host) || hostname.ends_with(&format!(".{host}"));
    }
    let (entry_family, ip) = match entry {
        Entry::Ip { family, ip, .. } => (*family, Some(ip)),
        Entry::List { rule } => (rule.family(), None),
        _ => return false,
    };
    if family != Some(entry_family) {
        return false;
    }
    match (ip, entry) {
        (Some(ip), _) => hostname == ip || canonical_host(hostname) == canonical_host(ip),
        (None, Entry::List { rule }) => rule.check(hostname, entry_family),
        _ => false,
    }
}

/// Why `text` is not a list of exceptions, or `None`.
pub fn exceptions_error(text: &Value) -> Option<String> {
    let Some(text) = text.as_str() else { return Some("must be a string".into()) };
    if utf16_len(text) > MAX_EXCEPTIONS_LENGTH {
        return Some("is too long".into());
    }
    split_entries(text)
        .into_iter()
        .find(|entry| parse_entry(entry).is_none())
        .map(|bad| format!("has an entry that is not an address: {}", slice_utf16(bad, 64)))
}

/// `text` as the stored list: entries lower-cased, deduplicated, `, `-separated.
pub fn canonical_exceptions(text: &str) -> String {
    let mut seen: Vec<String> = Vec::new();
    for entry in split_entries(text) {
        let lower = entry.to_lowercase();
        if !seen.contains(&lower) {
            seen.push(lower);
        }
    }
    seen.join(", ")
}

/// True when the host (and port) of `url` is covered by the list `text`;
/// entries that do not parse match nothing.
pub fn exceptions_cover(text: &str, url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    let host = host.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).unwrap_or(host);
    let hostname = host.strip_suffix('.').unwrap_or(host).to_lowercase();
    let port = url.port().map(f64::from).unwrap_or(if url.scheme() == "https" { 443.0 } else { 80.0 });
    let family = Family::of(is_ip(&hostname));
    split_entries(text)
        .into_iter()
        .filter_map(parse_entry)
        .any(|entry| entry_matches(&entry, &hostname, port, family))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    System,
    Manual,
    Off,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::System => "system",
            Mode::Manual => "manual",
            Mode::Off => "off",
        }
    }

    fn of(text: &str) -> Option<Mode> {
        match text {
            "system" => Some(Mode::System),
            "manual" => Some(Mode::Manual),
            "off" => Some(Mode::Off),
            _ => None,
        }
    }
}

/// The effective setting: `{ mode, url, exceptions }`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NetworkProxySetting {
    pub mode: Mode,
    pub url: String,
    pub exceptions: String,
}

impl NetworkProxySetting {
    pub fn to_value(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("mode".into(), json!(self.mode.as_str()));
        out.insert("url".into(), json!(self.url));
        out.insert("exceptions".into(), json!(self.exceptions));
        out
    }
}

/// The effective setting from the stored value. An invalid stored field reads
/// as its default, so a hand edit never breaks boot.
pub fn normalize_network_proxy(stored: &Value) -> NetworkProxySetting {
    let empty = Map::new();
    let source = stored.as_object().unwrap_or(&empty);
    let url = match source.get("url") {
        Some(value @ Value::String(_)) => parse_proxy_url(value, &PROXY_SCHEMES, false).unwrap_or_default(),
        _ => String::new(),
    };
    let exceptions = match source.get("exceptions") {
        Some(value @ Value::String(text)) if exceptions_error(value).is_none() => canonical_exceptions(text),
        _ => DEFAULT_PROXY_EXCEPTIONS.to_owned(),
    };
    NetworkProxySetting {
        mode: source.get("mode").and_then(Value::as_str).and_then(Mode::of).unwrap_or(Mode::System),
        url,
        exceptions,
    }
}

/// `Object.entries` order: array-index keys ascending, then the rest as written.
fn js_entries(object: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let index = |key: &str| {
        let canonical = key == "0" || (!key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit()) && !key.is_empty());
        canonical.then(|| key.parse::<u64>().ok()).flatten().filter(|n| *n < u64::from(u32::MAX))
    };
    let mut indexed: Vec<(u64, (&String, &Value))> =
        object.iter().filter_map(|(key, value)| index(key).map(|n| (n, (key, value)))).collect();
    indexed.sort_by_key(|(n, _)| *n);
    indexed
        .into_iter()
        .map(|(_, pair)| pair)
        .chain(object.iter().filter(|(key, _)| index(key).is_none()))
        .collect()
}

/// Applies a user patch strictly: an unknown key, an invalid value, or a manual
/// proxy without an address is an error (`TypeError` text) and nothing is stored.
pub fn apply_network_proxy_patch(current: &Value, patch: &Value) -> Result<NetworkProxySetting, String> {
    let patch = match patch.as_object() {
        Some(patch) if !patch.is_empty() => patch,
        _ => return Err("networkProxy requires at least one of mode, url, exceptions.".into()),
    };
    let mut next = normalize_network_proxy(current);
    for (key, value) in js_entries(patch) {
        match key.as_str() {
            "mode" => {
                next.mode = value.as_str().and_then(Mode::of).ok_or_else(|| {
                    format!("networkProxy.mode must be one of {}.", NETWORK_PROXY_MODES.join(", "))
                })?;
            }
            "url" => {
                let parsed = if value.as_str() == Some("") {
                    Ok(String::new())
                } else {
                    parse_proxy_url(value, &PROXY_SCHEMES, false)
                };
                next.url = parsed.map_err(|error| format!("networkProxy.url {error}."))?;
            }
            "exceptions" => {
                if let Some(error) = exceptions_error(value) {
                    return Err(format!("networkProxy.exceptions {error}."));
                }
                next.exceptions = canonical_exceptions(value.as_str().unwrap_or_default());
            }
            other => return Err(format!("networkProxy.{other} is not a network proxy setting.")),
        }
    }
    if next.mode == Mode::Manual && next.url.is_empty() {
        return Err("networkProxy.url is required when mode is manual.".into());
    }
    Ok(next)
}
