//! The public-address rule of the Node product's `ssrf-guard.mjs` (`_validateIpv4`, `_validateIpv6`), in its order: which
//! addresses a request meant for the public network may reach. Callers word their own refusals.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// What the rule refused: the address itself, or the IPv4 destination an IPv6 form carries (Node hands that one to the IPv4
/// rule, which names it).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Refused {
    Itself,
    Embedded(Ipv4Addr),
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

/// `_validateIpv6`, in its order. The first rule reads the address's text, as Node does: a first group written `ff..`,
/// `fc..`/`fd..` or `fe8..`-`feb..` matches whatever its leading zeros, so `fc::1` and `fe8::1` are refused as well as
/// `fc00::1` and `fe80::1`.
fn v6_refusal(ip: Ipv6Addr) -> Option<Refused> {
    let h = ip.segments();
    let quad = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    let embedded = |hi: u16, lo: u16| {
        let v4 = quad(hi, lo);
        v4_not_public(v4).then_some(Refused::Embedded(v4))
    };
    let first = format!("{:x}", h[0]);
    let by_text = first.starts_with("ff")
        || first.starts_with("fc")
        || first.starts_with("fd")
        || (first.starts_with("fe") && matches!(first.as_bytes().get(2), Some(b'8' | b'9' | b'a' | b'b')));
    // ::1, ::, multicast, unique-local, link-local.
    if ip == Ipv6Addr::LOCALHOST || ip == Ipv6Addr::UNSPECIFIED || by_text {
        return Some(Refused::Itself);
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
        return Some(Refused::Itself);
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

/// Whether the rule refuses `ip`, and which address a refusal names.
pub fn public_refusal(ip: IpAddr) -> Option<Refused> {
    match ip {
        IpAddr::V4(v4) => v4_not_public(v4).then_some(Refused::Itself),
        IpAddr::V6(v6) => v6_refusal(v6),
    }
}

/// Whether `ip` is a globally reachable address.
pub fn is_public(ip: IpAddr) -> bool {
    public_refusal(ip).is_none()
}
