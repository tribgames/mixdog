//! Address policy. A URL is checked by its parsed host, and every connection is
//! made to an address the resolver validated here, so the decision is taken on
//! the address actually dialled (no second lookup can change it).

use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::net::SocketAddr;

use super::error::FetchKind;
use super::gai;
use super::gai::LookupError;
use super::gai::LookupKind;
use reqwest::dns::Addrs;
use reqwest::dns::Name;
use reqwest::dns::Resolve;
use reqwest::dns::Resolving;
use url::Host;
use url::Url;

use super::error::FetchError;

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

fn v6_not_public(ip: Ipv6Addr) -> bool {
    let h = ip.segments();
    let quad = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    // ::1, ::, multicast, unique-local, link-local.
    if ip == Ipv6Addr::LOCALHOST
        || ip == Ipv6Addr::UNSPECIFIED
        || h[0] >> 8 == 0xff
        || h[0] & 0xfe00 == 0xfc00
        || h[0] & 0xffc0 == 0xfe80
    {
        return true;
    }
    // IPv4-mapped (::ffff:a.b.c.d) in either textual form.
    if h[..5] == [0; 5] && h[5] == 0xffff {
        return v4_not_public(quad(h[6], h[7]));
    }
    // Site-local, documentation, discard-only and local-use NAT64.
    if h[0] & 0xffc0 == 0xfec0
        || (h[0] == 0x2001 && h[1] == 0x0db8)
        || (h[0] == 0x3fff && h[1] < 0x1000)
        || (h[0] == 0x0100 && h[1] == 0 && h[2] == 0 && h[3] == 0)
        || (h[0] == 0x64 && h[1] == 0xff9b && h[2] == 1)
    {
        return true;
    }
    // Forms that carry an IPv4 destination: IPv4-compatible, NAT64, 6to4.
    if h[..6] == [0; 6] {
        return v4_not_public(quad(h[6], h[7]));
    }
    if h[0] == 0x64 && h[1] == 0xff9b && h[2..6] == [0; 4] {
        return v4_not_public(quad(h[6], h[7]));
    }
    if h[0] == 0x2002 {
        return v4_not_public(quad(h[1], h[2]));
    }
    false
}

impl AddressPolicy {
    pub fn allows(self, ip: IpAddr) -> bool {
        match self {
            Self::PublicOnly => match ip {
                IpAddr::V4(v4) => !v4_not_public(v4),
                IpAddr::V6(v6) => !v6_not_public(v6),
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
            Some(Host::Ipv4(ip)) if !self.allows(IpAddr::V4(ip)) => Err(self.blocked(&host_text)),
            Some(Host::Ipv6(ip)) if !self.allows(IpAddr::V6(ip)) => Err(self.blocked(&host_text)),
            Some(Host::Domain(name)) if self.domain_blocked(name) => Err(self.blocked(&host_text)),
            Some(_) => Ok(()),
            None => Err(FetchError::policy("Blocked URL without host")),
        }
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
    FetchError::new(kind, format!("fetch failed: getaddrinfo {name} {host}"))
}

/// Resolver handed to the HTTP client: every returned address must satisfy the
/// policy, so a DNS answer cannot smuggle a private address behind a public one.
pub struct PolicyResolver(pub AddressPolicy);

impl Resolve for PolicyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let policy = self.0;
        Box::pin(async move {
            let host = name.as_str().to_string();
            let name = host.clone();
            let looked_up = tokio::task::spawn_blocking(move || gai::lookup(&name)).await;
            let found: Vec<SocketAddr> = match looked_up {
                Ok(Ok(ips)) => ips.into_iter().map(|ip| SocketAddr::new(ip, 0)).collect(),
                Ok(Err(error)) => {
                    return Err(Box::new(lookup_failure(&host, error)) as Box<dyn std::error::Error + Send + Sync>);
                }
                Err(error) => {
                    return Err(Box::new(FetchError::new(FetchKind::Network, format!("fetch failed: {error}")))
                        as Box<dyn std::error::Error + Send + Sync>);
                }
            };
            if found.is_empty() {
                return Err(Box::new(FetchError::policy(format!(
                    "DNS returned no addresses for {host}"
                ))) as Box<dyn std::error::Error + Send + Sync>);
            }
            for addr in &found {
                if !policy.allows(addr.ip()) {
                    let error = match policy {
                        AddressPolicy::LoopbackOnly => FetchError::policy(format!(
                            "Blocked non-loopback local_fetch resolution: {host}"
                        )),
                        _ => blocked_private(&host),
                    };
                    return Err(Box::new(error) as Box<dyn std::error::Error + Send + Sync>);
                }
            }
            Ok(Box::new(found.into_iter()) as Addrs)
        })
    }
}
