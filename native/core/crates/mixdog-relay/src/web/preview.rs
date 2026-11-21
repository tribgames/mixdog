//! The dedicated preview frame for remote HTML page previews (`GET /preview-frame`).
//!
//! The app embeds it as `<iframe sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer">` and posts one
//! HTML document into it. The response CSP repeats that sandbox (never `allow-same-origin`, top navigation or popups): the page
//! runs in an opaque origin and cannot reach the app's storage, pairing token or relay socket.
//!
//! Outside network is on, over https only. The relay's own origin is covered by `https:` (a CSP cannot exclude it) and is
//! unreachable WITH credentials: the relay's cookies are `SameSite=Lax` and a request from an opaque origin is cross-site, so none
//! is attached; the relay ignores cookie credentials on any cross-site request that is not a top-level navigation and on any
//! `Origin: null` request (`web::headers::cookie_credential_allowed`); the other credentials live in the app's storage, which the
//! opaque frame cannot read; and relay responses carry `Cross-Origin-Resource-Policy: same-origin` and no CORS grant. The page is
//! static and public: no cookie is read or set, and nothing in it is user data.

use crate::http1::{HeaderError, ResponseWriter};

pub const PREVIEW_FRAME_PATH: &str = "/preview-frame";

/// `PREVIEW_FRAME_CSP`.
pub const PREVIEW_FRAME_CSP: &str = "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data: https:; style-src 'unsafe-inline' data: https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:; frame-src https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const PREVIEW_FRAME_HTML: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Preview</title>
<script>
(function () {
  var received = false;
  window.addEventListener('message', function (event) {
    if (received || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'mixdog-preview-document' || typeof data.html !== 'string') return;
    received = true;
    document.open();
    document.write(data.html);
    document.close();
  });
  window.parent.postMessage({ type: 'mixdog-preview-ready' }, '*');
})();
</script>
"#;

/// `sendPreviewFrame`: answers a GET or HEAD for the preview frame.
pub fn send_preview_frame(method: &str, response: &mut ResponseWriter) -> Result<(), HeaderError> {
    let length = PREVIEW_FRAME_HTML.len().to_string();
    response.write_head(
        200,
        &[
            ("Content-Security-Policy", PREVIEW_FRAME_CSP),
            ("Content-Type", "text/html; charset=utf-8"),
            ("Cache-Control", "public, max-age=300"),
            ("Referrer-Policy", "no-referrer"),
            ("X-Content-Type-Options", "nosniff"),
            ("Content-Length", length.as_str()),
        ],
    )?;
    response.end(if method == "HEAD" { None } else { Some(PREVIEW_FRAME_HTML.as_bytes()) });
    Ok(())
}
