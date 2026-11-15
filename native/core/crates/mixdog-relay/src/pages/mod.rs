//! The public pages the relay serves itself: `/app` (the install page for the phone app) with `/app/latest.json`, `/connect`
//! (the browser code entry) and the "update your PC" page. Each page is a function from the request to a [`PageReply`] that
//! the router writes; the pages take no parameters and grant nothing.
//!
//! The HTML of every page is the Node page byte for byte (`assets/pages/*.html`), split only where Node inserts a value: the
//! shared base and pairing CSS, the inline logo, and the page's own values. The pairing CSS is one contiguous file
//! (`pairing.css`) that the phone app's `index.html` and the desktop's remote pairing screen carry too.

pub mod app;
pub mod connect;
pub mod update_pc;

use std::sync::LazyLock;

/// What a page function needs of a request: its method (case as received) and its `User-Agent` header, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageRequest<'a> {
    pub method: &'a str,
    pub user_agent: Option<&'a str>,
}

/// The status, the headers in the order Node writes them and the body. A `None` body is `end()` without data: HEAD, a 302, a
/// 404 and a 405.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageReply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<Vec<u8>>,
}

impl PageReply {
    fn bodyless(status: u16, headers: Vec<(&'static str, String)>) -> Self {
        Self { status, headers, body: None }
    }

    /// `response.writeHead(405).end()`.
    fn method_not_allowed() -> Self {
        Self::bodyless(405, Vec::new())
    }

    /// A 200 with Node's headers (`Content-Security-Policy` only where the page has one); `body` is left out for HEAD.
    fn ok(content_type: &'static str, csp: Option<&'static str>, body: &str, head: bool) -> Self {
        let mut headers = vec![("Content-Type", content_type.to_owned()), ("Cache-Control", "no-store".to_owned())];
        if let Some(csp) = csp {
            headers.push(("Content-Security-Policy", csp.to_owned()));
        }
        headers.push(("X-Content-Type-Options", "nosniff".to_owned()));
        Self { status: 200, headers, body: (!head).then(|| body.as_bytes().to_vec()) }
    }

    /// The reply of an HTML page.
    fn html(csp: &'static str, body: &str, head: bool) -> Self {
        Self::ok("text/html; charset=utf-8", Some(csp), body, head)
    }
}

/// `request.method === 'GET' || 'HEAD'`: the check is case-sensitive.
fn is_get_or_head(method: &str) -> bool {
    method == "GET" || method == "HEAD"
}

/// The CSP of `/app` and the update page.
const STATIC_PAGE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const PAGE_BASE_CSS: &str = "html,body{margin:0;background:#181818}";
/// The shared pairing layout CSS, one block.
const PAIRING_CSS: &str = include_str!("../../assets/pages/pairing.css");
const LOGO_SVG: &str = include_str!("../../assets/pages/logo.svg");

/// The logo as the data URL the pages carry inline: `data:image/svg+xml,` and `encodeURIComponent(svg)`.
static LOGO_SRC: LazyLock<String> = LazyLock::new(|| format!("data:image/svg+xml,{}", encode_uri_component(LOGO_SVG)));

/// `encodeURIComponent`: everything but `A-Za-z0-9 - _ . ! ~ * ' ( )` as upper-case `%XX` of its UTF-8 bytes.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A template with its `@@NAME@@` markers replaced in one left-to-right pass, so a value that contains a marker is never
/// expanded again. The shared values (`PAGE_BASE_CSS`, `PAIRING_CSS`, `LOGO_SRC`) are known to every page; `values` holds the
/// page's own.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len() + PAIRING_CSS.len() + LOGO_SRC.len());
    let mut rest = template;
    while let Some(start) = rest.find("@@") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find("@@");
        let value = end.and_then(|end| match &after[..end] {
            "PAGE_BASE_CSS" => Some(PAGE_BASE_CSS),
            "PAIRING_CSS" => Some(PAIRING_CSS),
            "LOGO_SRC" => Some(LOGO_SRC.as_str()),
            name => values.iter().find(|(key, _)| *key == name).map(|(_, value)| *value),
        });
        match (value, end) {
            (Some(value), Some(end)) => {
                out.push_str(value);
                rest = &after[end + 2..];
            }
            _ => {
                out.push_str("@@");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}
