//! The push services a browser subscribes through (`validWebPushEndpoint` of `lib/web-push.mjs`). The relay POSTs to whatever
//! endpoint a browser registers, so the endpoint's host is matched against the known services rather than screened for
//! "private" names: a public DNS name may resolve anywhere, and a name check cannot see that.
//!
//! | Browser                                    | Host                                |
//! |--------------------------------------------|-------------------------------------|
//! | Chrome, Edge, Opera, Brave, Samsung        | `fcm.googleapis.com`                |
//! | Firefox                                    | `updates.push.services.mozilla.com` |
//! | Safari (macOS 13+, iOS 16.4+)              | `web.push.apple.com`                |
//! | Edge on WNS (legacy)                       | `*.notify.windows.com`              |

use url::Url;

const MAX_ENDPOINT_CHARS: usize = 2048;
const PUSH_SERVICE_HOSTS: [&str; 1] = ["fcm.googleapis.com"];
const PUSH_SERVICE_SUFFIXES: [&str; 3] = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

/// The host in the one spelling it is matched in: lower case, no trailing root dot(s) (`fcm.googleapis.com.` names the same
/// host).
fn canonical_host(hostname: &str) -> String {
    hostname.to_ascii_lowercase().trim_end_matches('.').to_owned()
}

fn known_push_service_host(hostname: &str) -> bool {
    let host = canonical_host(hostname);
    PUSH_SERVICE_HOSTS.contains(&host.as_str()) || PUSH_SERVICE_SUFFIXES.iter().any(|suffix| host.ends_with(suffix))
}

/// The canonical endpoint, or `None` when it is not an https URL on a known push service: anything else would make the relay a
/// confused deputy for the network it runs in. Checked when a browser registers and again before each send.
pub fn valid_endpoint(value: &str) -> Option<String> {
    if value.is_empty() || value.encode_utf16().count() > MAX_ENDPOINT_CHARS {
        return None;
    }
    let mut url = Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty()) || url.port().is_some() {
        return None;
    }
    let host = url.host_str()?;
    if !known_push_service_host(host) {
        return None;
    }
    let canonical = canonical_host(host);
    url.set_host(Some(&canonical)).ok()?;
    Some(url.to_string())
}
