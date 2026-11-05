//! Address facts the proxy policy needs: `net.isIP`, the local-host test and the
//! `BlockList` shapes of `NO_PROXY` style entries (Node's `net` module, and
//! `http-agent.mjs` for the local ranges).

use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::str::FromStr;

/// `net.isIP(text)`: 4, 6 or 0. An IPv6 literal may carry a `%zone`.
pub fn is_ip(text: &str) -> u8 {
    if Ipv4Addr::from_str(text).is_ok() {
        return 4;
    }
    let bare = match text.split_once('%') {
        Some((address, zone)) if !zone.is_empty() && zone.chars().all(|c| c.is_ascii_alphanumeric() || "-.:".contains(c)) => address,
        Some(_) => return 0,
        None => text,
    };
    if Ipv6Addr::from_str(bare).is_ok() { 6 } else { 0 }
}

/// `normalizeHost`: no brackets, no trailing dot, lower case.
pub fn normalize_host(hostname: &str) -> String {
    let unbracketed = hostname
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(hostname);
    unbracketed.strip_suffix('.').unwrap_or(unbracketed).to_lowercase()
}

/// `new URL(`http://${address}`).hostname` without brackets, or the address
/// itself when it is not a URL host.
pub fn canonical_host(address: &str) -> String {
    let wrapped = if is_ip(address) == 6 { format!("[{address}]") } else { address.to_owned() };
    match url::Url::parse(&format!("http://{wrapped}")) {
        Ok(url) => {
            let host = url.host_str().unwrap_or_default();
            host.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).unwrap_or(host).to_owned()
        }
        Err(_) => address.to_owned(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family {
    V4,
    V6,
}

impl Family {
    pub fn of(version: u8) -> Option<Family> {
        match version {
            4 => Some(Family::V4),
            6 => Some(Family::V6),
            _ => None,
        }
    }
}

/// One `BlockList` rule: a subnet or an inclusive range, in one family.
#[derive(Clone, Debug)]
pub enum Rule {
    Subnet { network: u128, prefix: u32, family: Family },
    Range { start: u128, end: u128, family: Family },
}

fn bits(address: &str, family: Family) -> Option<u128> {
    match family {
        Family::V4 => Ipv4Addr::from_str(address).ok().map(|a| u128::from(u32::from(a))),
        Family::V6 => Ipv6Addr::from_str(address).ok().map(u128::from),
    }
}

fn width(family: Family) -> u32 {
    match family {
        Family::V4 => 32,
        Family::V6 => 128,
    }
}

impl Rule {
    /// `list.addSubnet(network, prefix, family)`; `None` where `BlockList` throws.
    pub fn subnet(network: &str, prefix: u32, family: Family) -> Option<Rule> {
        if prefix > width(family) {
            return None;
        }
        Some(Rule::Subnet { network: bits(network, family)?, prefix, family })
    }

    /// `list.addRange(start, end, 'ipv4')`; `None` where `BlockList` throws.
    pub fn range(start: &str, end: &str, family: Family) -> Option<Rule> {
        let (start, end) = (bits(start, family)?, bits(end, family)?);
        (start <= end).then_some(Rule::Range { start, end, family })
    }

    pub fn family(&self) -> Family {
        match self {
            Rule::Subnet { family, .. } | Rule::Range { family, .. } => *family,
        }
    }

    fn holds(&self, address: u128) -> bool {
        match self {
            Rule::Subnet { network, prefix, family } => {
                let shift = width(*family) - prefix;
                if shift >= 128 { true } else { (address >> shift) == (network >> shift) }
            }
            Rule::Range { start, end, .. } => *start <= address && address <= *end,
        }
    }

    /// `list.check(address, family)` for a list holding this rule. An IPv4-mapped
    /// IPv6 address is also checked against IPv4 rules, as `SocketAddress` does.
    pub fn check(&self, address: &str, family: Family) -> bool {
        if self.family() == family {
            return bits(address, family).is_some_and(|a| self.holds(a));
        }
        if family == Family::V6 && self.family() == Family::V4 {
            if let Some(mapped) = Ipv6Addr::from_str(address).ok().and_then(|a| a.to_ipv4_mapped()) {
                return self.holds(u128::from(u32::from(mapped)));
            }
        }
        false
    }
}

fn local_rules() -> Vec<Rule> {
    let v4 = [
        ("127.0.0.0", "127.255.255.255"),
        ("10.0.0.0", "10.255.255.255"),
        ("172.16.0.0", "172.31.255.255"),
        ("192.168.0.0", "192.168.255.255"),
        ("169.254.0.0", "169.254.255.255"),
    ];
    let v6 = [("::1", 128), ("fc00::", 7), ("fe80::", 10)];
    v4.iter()
        .filter_map(|(start, end)| Rule::range(start, end, Family::V4))
        .chain(v6.iter().filter_map(|(network, prefix)| Rule::subnet(network, *prefix, Family::V6)))
        .collect()
}

/// A host that never goes through the proxy: a loopback, private or
/// link-local address, a dotless name or a `.local` / `.localhost` name.
pub fn is_local_host(hostname: &str) -> bool {
    let host = normalize_host(hostname);
    match Family::of(is_ip(&host)) {
        Some(family) => local_rules().iter().any(|rule| rule.check(&host, family)),
        None => !host.contains('.') || host.ends_with(".local") || host.ends_with(".localhost"),
    }
}

/// `decodeURIComponent`, or `None` where it throws `URIError`.
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok().filter(|_| hex.bytes().all(|b| b.is_ascii_hexdigit()))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
