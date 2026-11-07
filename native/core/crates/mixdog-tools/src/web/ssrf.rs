//! Address policy. A URL is checked by its parsed host, and every connection is
//! made to an address the resolver validated here, so the decision is taken on
//! the address actually dialled (no second lookup can change it).

use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::net::SocketAddr;

use super::error::FetchKind;
use super::gai;
use super::lanes;
use super::lanes::WebLanes;
use super::gai::LookupError;
use super::gai::LookupKind;
use reqwest::dns::Addrs;
use reqwest::dns::Name;
use reqwest::dns::Resolve;
use reqwest::dns::Resolving;
use url::Host;
use url::Url;

use super::error::FetchError;
use super::error::LookupFailure;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AddressPolicy {
    /// `web_fetch`, `image_fetch`: globally reachable addresses only.
    PublicOnly,
    /// `local_fetch`: loopback addresses only.
    LoopbackOnly,
    /// Tests dial a local fake server.
    #[cfg(test)]
    AnyForTest,
}

fn blocked_private(host: &str) -> FetchError {
    FetchError::policy(format!("Blocked request to private address: {host}"))
}

fn v4_not_public(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 127
        || a == 10
        || a == 0
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (b == 18 || b == 19))
        // IANA special-purpose blocks that are not globally reachable.
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || (224..=239).contains(&a)
        || a >= 240
}

/// What Node's message calls a refused address: the address itself, or the IPv4 destination it
/// carries (Node hands that one to the IPv4 rule, which names it).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Named {
    Itself,
    Embedded(Ipv4Addr),
}

/// `_validateIpv6` (`ssrf-guard.mjs`), in its order. The first rule reads the address's text, as
/// Node does: a first group written `ff..`, `fc..`/`fd..` or `fe8..`-`feb..` matches whatever its
/// leading zeros, so `fc::1` and `fe8::1` are refused as well as `fc00::1` and `fe80::1`.
fn v6_refusal(ip: Ipv6Addr) -> Option<Named> {
    let h = ip.segments();
    let quad = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    let embedded = |hi: u16, lo: u16| {
        let v4 = quad(hi, lo);
        v4_not_public(v4).then_some(Named::Embedded(v4))
    };
    let first = format!("{:x}", h[0]);
    let by_text = first.starts_with("ff")
        || first.starts_with("fc")
        || first.starts_with("fd")
        || (first.starts_with("fe") && matches!(first.as_bytes().get(2), Some(b'8' | b'9' | b'a' | b'b')));
    // ::1, ::, multicast, unique-local, link-local.
    if ip == Ipv6Addr::LOCALHOST || ip == Ipv6Addr::UNSPECIFIED || by_text {
        return Some(Named::Itself);
    }
    // IPv4-mapped (::ffff:a.b.c.d) in either textual form.
    if h[..5] == [0; 5]
        && h[5] == 0xffff
        && let refused @ Some(_) = embedded(h[6], h[7])
    {
        return refused;
    }
    // Site-local, documentation, discard-only and local-use NAT64.
    if h[0] & 0xffc0 == 0xfec0
        || (h[0] == 0x2001 && h[1] == 0x0db8)
        || (h[0] == 0x3fff && h[1] < 0x1000)
        || (h[0] == 0x0100 && h[1] == 0 && h[2] == 0 && h[3] == 0)
        || (h[0] == 0x64 && h[1] == 0xff9b && h[2] == 1)
    {
        return Some(Named::Itself);
    }
    // Forms that carry an IPv4 destination: IPv4-compatible, NAT64, 6to4.
    if h[..6] == [0; 6]
        && let refused @ Some(_) = embedded(h[6], h[7])
    {
        return refused;
    }
    if h[0] == 0x64
        && h[1] == 0xff9b
        && h[2..6] == [0; 4]
        && let refused @ Some(_) = embedded(h[6], h[7])
    {
        return refused;
    }
    if h[0] == 0x2002 {
        return embedded(h[1], h[2]);
    }
    None
}

/// Whether the public-only rules refuse `ip`, and the address Node's message names (`itself` is
/// how the caller writes the address).
fn public_refusal(ip: IpAddr, itself: &str) -> Option<String> {
    match ip {
        IpAddr::V4(v4) => v4_not_public(v4).then(|| itself.to_owned()),
        IpAddr::V6(v6) => v6_refusal(v6).map(|named| match named {
            Named::Itself => itself.to_owned(),
            Named::Embedded(v4) => v4.to_string(),
        }),
    }
}

impl AddressPolicy {
    pub fn allows(self, ip: IpAddr) -> bool {
        match self {
            Self::PublicOnly => match ip {
                IpAddr::V4(v4) => !v4_not_public(v4),
                IpAddr::V6(v6) => v6_refusal(v6).is_none(),
            },
            Self::LoopbackOnly => ip.is_loopback(),
            #[cfg(test)]
            Self::AnyForTest => true,
        }
    }

    /// Scheme, userinfo and literal-host rules for one URL (the initial URL and
    /// every redirect hop).
    pub fn check_url(self, url: &Url) -> Result<(), FetchError> {
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(FetchError::policy(format!(
                "Blocked non-HTTP protocol: {}:",
                url.scheme()
            )));
        }
        let host_text = url.host_str().unwrap_or_default().to_ascii_lowercase();
        if !url.username().is_empty() || url.password().is_some() {
            let message = match self {
                Self::LoopbackOnly => "Blocked loopback URL with userinfo credentials".to_string(),
                _ => format!("Blocked URL with userinfo credentials: {host_text}"),
            };
            return Err(FetchError::policy(message));
        }
        match url.host() {
            Some(Host::Ipv4(ip)) => self.refuse_literal(IpAddr::V4(ip), &host_text),
            Some(Host::Ipv6(ip)) => self.refuse_literal(IpAddr::V6(ip), &host_text),
            Some(Host::Domain(name)) if self.domain_blocked(name) => Err(self.blocked(&host_text)),
            Some(_) => Ok(()),
            None => Err(FetchError::policy("Blocked URL without host")),
        }
    }

    /// An address written in the URL. Under the public rules Node names the address an IPv6 form
    /// carries inside it, not the form.
    fn refuse_literal(self, ip: IpAddr, host_text: &str) -> Result<(), FetchError> {
        match self {
            Self::PublicOnly => match public_refusal(ip, host_text) {
                Some(named) => Err(blocked_private(&named)),
                None => Ok(()),
            },
            _ if self.allows(ip) => Ok(()),
            _ => Err(self.blocked(host_text)),
        }
    }

    /// An address a name resolved to (`resolveAndValidate`): Node names the address itself.
    fn refuse_resolved(self, ip: IpAddr, host: &str) -> Result<(), FetchError> {
        match self {
            Self::PublicOnly => match public_refusal(ip, &ip.to_string()) {
                Some(named) => Err(blocked_private(&named)),
                None => Ok(()),
            },
            Self::LoopbackOnly if !ip.is_loopback() => {
                Err(FetchError::policy(format!("Blocked non-loopback local_fetch resolution: {host}")))
            }
            _ => Ok(()),
        }
    }

    /// Every address a name resolved to must pass, in the order given, so a DNS answer cannot
    /// smuggle a private address behind a public one; an empty answer is a block of its own.
    pub(super) fn validate_resolved(self, host: &str, ips: &[IpAddr]) -> Result<Vec<SocketAddr>, FetchError> {
        if ips.is_empty() {
            return Err(FetchError::policy(format!("DNS returned no addresses for {host}")));
        }
        for ip in ips {
            self.refuse_resolved(*ip, host)?;
        }
        Ok(ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect())
    }

    fn domain_blocked(self, name: &str) -> bool {
        match self {
            Self::PublicOnly => name.eq_ignore_ascii_case("localhost"),
            Self::LoopbackOnly => !name.eq_ignore_ascii_case("localhost"),
            #[cfg(test)]
            Self::AnyForTest => false,
        }
    }

    fn blocked(self, host: &str) -> FetchError {
        match self {
            Self::LoopbackOnly => {
                FetchError::policy(format!("Blocked non-loopback local_fetch target: {host}"))
            }
            _ => blocked_private(host),
        }
    }
}

/// Node treats `ENOTFOUND` and `ENODATA` as "no addresses" (a policy block) and retries
/// `EAI_AGAIN`; any other lookup failure is a plain network error.
pub(super) fn lookup_failure(host: &str, error: LookupError) -> FetchError {
    let name = match error.kind {
        LookupKind::NotFound | LookupKind::NoData => {
            return FetchError::policy(format!("DNS returned no addresses for {host}"));
        }
        LookupKind::TryAgain => "EAI_AGAIN".to_string(),
        LookupKind::Other => format!("error {}", error.code),
    };
    let kind = if error.kind == LookupKind::TryAgain { FetchKind::NetworkTransient } else { FetchKind::Network };
    // The web tools' wording; the media fetch words the same failure from `lookup` itself.
    let mut failure = FetchError::new(kind, format!("fetch failed: getaddrinfo {name} {host}"));
    failure.lookup = Some(LookupFailure { code: name, host: host.to_owned() });
    failure
}

/// Resolver handed to the HTTP client: every returned address must satisfy the
/// policy, so a DNS answer cannot smuggle a private address behind a public one.
pub struct PolicyResolver(pub AddressPolicy, pub WebLanes);

impl Resolve for PolicyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let policy = self.0;
        let dns = self.1.dns;
        Box::pin(async move {
            let host = name.as_str().to_string();
            let name = host.clone();
            let looked_up = lanes::run(dns, move |_| gai::lookup(&name)).await;
            let ips = match looked_up {
                Ok(Ok(ips)) => ips,
                Ok(Err(error)) => {
                    return Err(Box::new(lookup_failure(&host, error)) as Box<dyn std::error::Error + Send + Sync>);
                }
                Err(error) => {
                    return Err(Box::new(FetchError::new(FetchKind::Network, format!("fetch failed: {error}")))
                        as Box<dyn std::error::Error + Send + Sync>);
                }
            };
            let found = policy
                .validate_resolved(&host, &ips)
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)?;
            Ok(Box::new(found.into_iter()) as Addrs)
        })
    }
}
