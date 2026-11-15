//! `/connect` (`lib/connect-page.mjs`): the public browser entry for pairing. Self-contained: the visitor types the 6-digit
//! code shown on the PC, the page posts it to `/pair-code/resolve` (10 s abort) and continues at
//! `/d/<deviceId>/#pair=<ticket>&host=<name>`. The page itself grants nothing.

use std::sync::LazyLock;

use super::{PageReply, PageRequest, fill, is_get_or_head};

const CONNECT_PAGE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";

static PAGE: LazyLock<String> = LazyLock::new(|| fill(include_str!("../../assets/pages/connect.html"), &[]));

/// `sendConnectPage`.
pub fn connect_page(request: PageRequest<'_>) -> PageReply {
    if !is_get_or_head(request.method) {
        return PageReply::method_not_allowed();
    }
    PageReply::html(CONNECT_PAGE_CSP, &PAGE, request.method == "HEAD")
}
