//! The saved-login check and type steps (Do-SavedLoginCheck and
//! Do-SavedLoginType, runtime-saved-login.ps1:349-432). The host decides
//! what a login may go into and in what order it is proven; the platform's
//! `SavedLoginReads` read the live browser and make the one write. A login
//! goes only into the focused field of a top-level HTTPS page of a Chrome or
//! Edge window whose live process image is signed by that vendor, with every
//! address bar confirming the page. The value is written once through the
//! field's own value pattern, never as keystrokes, and no reply carries it.

use super::{Host, Res};
use crate::obj;
use crate::platform::{
    parse_window_id, saved_login_changed, saved_login_refused, window_id, SavedLoginField,
    SavedLoginFocus, SavedLoginImage, SavedLoginReads, Wid, WindowInfo, SAVED_LOGIN_NO_FOCUS,
    SAVED_LOGIN_UNSUPPORTED,
};
use crate::protocol::{Obj, Req};
use serde_json::{json, Value};
use std::cell::Cell;

/// The Authenticode signer organisation of each supported browser's image, as
/// measured with WinVerifyTrust on the shipped binaries. Brave is not listed:
/// its signer was not measured, so it is refused until it is ($SavedLoginVendors).
const VENDORS: [(&str, &str); 2] = [("chrome", "Google LLC"), ("msedge", "Microsoft Corporation")];

/// The reply once the value may be in the field and is not confirmed.
const UNCONFIRMED: &str = "saved_login_unconfirmed: the saved value may have been written into the checked field, but the field did not confirm it; it is not retried";
/// A failure after the write was invoked (Do-SavedLoginType's catch).
const INCOMPLETE: &str = "saved_login_unconfirmed: the saved value may have been written into the checked field, but the write did not complete cleanly; it is not retried";

/// The window class of a Chromium browser's top-level frame.
const FRAME_CLASS: &str = "Chrome_WidgetWin_1";

fn vendor_of(process: &str) -> Option<&'static str> {
    VENDORS
        .iter()
        .find(|(name, _)| *name == process)
        .map(|(_, vendor)| *vendor)
}

/// Why a window is no browser a login may go into (Assert-SavedLoginBrowser).
fn browser_refusal(process: &str, class: &str, top_level: bool) -> Option<String> {
    match process {
        "firefox" => Some("Firefox is not supported yet: its page address cannot be read reliably through accessibility".into()),
        "brave" => Some("Brave is not supported yet: its code signer has not been verified".into()),
        _ if vendor_of(process).is_none() || class != FRAME_CLASS || !top_level => Some(format!(
            "the window belongs to '{process}', not a Chrome or Edge browser window; saved logins are web logins"
        )),
        _ => None,
    }
}

/// The process creation time a verified image binds later reads to, or why
/// the image proves nothing (Assert-SavedLoginSignedImage).
fn verified_start(process: &str, image: Option<SavedLoginImage>) -> Result<i64, String> {
    let Some(image) = image.filter(|image| !image.signer.is_empty() && image.start_time != 0) else {
        return Err(format!(
            "the '{process}' window's program could not be verified as a signed browser"
        ));
    };
    let name = image.path.rsplit(['\\', '/']).next().unwrap_or_default();
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem).to_lowercase();
    match vendor_of(process) {
        Some(vendor) if stem == process && image.signer == vendor => Ok(image.start_time),
        vendor => Err(format!(
            "the '{process}' window's program is not signed by {}",
            vendor.unwrap_or("its vendor")
        )),
    }
}

/// The rule `kind` puts on the focused element: why the value may not go
/// there (Get-SavedLoginFieldRefusal).
fn field_refusal(field: &SavedLoginField, kind: &str) -> Option<&'static str> {
    if !field.edit {
        Some("the focused element is not a text field")
    } else if !field.focused {
        Some("the field does not hold keyboard focus")
    } else if !field.enabled || field.read_only {
        Some("the focused field is disabled or read-only")
    } else if kind == "password" {
        (!field.password).then_some("the focused field is not a password field")
    } else {
        field
            .password
            .then_some("the focused field is a password field, not a username field")
    }
}

/// An HTML text or password input strips line breaks from its value, so such
/// a value could never be confirmed: it is refused before writing instead of
/// leaving a "possibly written" field.
fn value_refusal(value: &str) -> Option<&'static str> {
    if value.is_empty() {
        Some("no saved value reached the worker")
    } else if value.contains(['\r', '\n']) {
        Some("the saved value holds a line break, which the field would strip")
    } else {
        None
    }
}

/// An absolute URL as System.Uri reads it, for the parts a login is matched
/// on: the lower-case scheme, the ASCII lower-case host (an IPv6 host keeps
/// its brackets) and the port, defaulted by scheme.
#[derive(Debug, PartialEq)]
struct PageUrl {
    scheme: String,
    host: String,
    port: u32,
    user_info: bool,
}

fn default_port(scheme: &str) -> u32 {
    match scheme {
        "https" => 443,
        "http" => 80,
        "ftp" => 21,
        _ => 0,
    }
}

fn has_scheme(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once("://") else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

fn parse_url(text: &str) -> Option<PageUrl> {
    if text.chars().any(|c| c.is_whitespace() || c.is_control()) || !has_scheme(text) {
        return None;
    }
    let (scheme, rest) = text.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let authority = &rest[..rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len())];
    let (user, location) = authority.rsplit_once('@').unwrap_or(("", authority));
    let (host, port) = if location.starts_with('[') {
        let end = location.find(']')?;
        let (host, tail) = location.split_at(end + 1);
        (host, tail.strip_prefix(':').or(tail.is_empty().then_some("")))
    } else {
        match location.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (location, Some("")),
        }
    };
    let port = match port? {
        "" => default_port(&scheme),
        digits if digits.bytes().all(|b| b.is_ascii_digit()) => u32::from(digits.parse::<u16>().ok()?),
        _ => return None,
    };
    if host.is_empty() || host == "[]" {
        return None;
    }
    let host = if host.starts_with('[') {
        host.to_lowercase()
    } else {
        ascii_host(host)?
    };
    Some(PageUrl { scheme, host, port, user_info: !user.is_empty() })
}

/// The page address a login is matched against: absolute https with a host
/// and no user name or password in it (Get-SavedLoginPageUri).
fn page_url(text: &str) -> Option<PageUrl> {
    parse_url(text).filter(|url| url.scheme == "https" && !url.user_info)
}

/// The page's origin as URL.origin spells it: the scheme, the ASCII host and
/// the port only when not 443 (Get-SavedLoginOrigin).
fn origin_of(url: &PageUrl) -> String {
    match url.port {
        443 => format!("https://{}", url.host),
        port => format!("https://{}:{port}", url.host),
    }
}

/// A host name in lower-case ASCII, each non-ASCII label as Punycode
/// (IdnMapping.GetAscii then ToLowerInvariant).
fn ascii_host(host: &str) -> Option<String> {
    let labels: Option<Vec<String>> = host
        .split(['.', '\u{3002}', '\u{ff0e}', '\u{ff61}'])
        .map(|label| {
            let label = label.to_lowercase();
            if label.is_ascii() {
                Some(label)
            } else {
                punycode(&label).map(|encoded| format!("xn--{encoded}"))
            }
        })
        .collect();
    labels.map(|labels| labels.join("."))
}

/// RFC 3492 encoding of one label.
fn punycode(label: &str) -> Option<String> {
    const BASE: u32 = 36;
    const T_MIN: u32 = 1;
    const T_MAX: u32 = 26;
    const SKEW: u32 = 38;
    const DAMP: u32 = 700;
    fn digit(value: u32) -> char {
        char::from(if value < 26 { b'a' + value as u8 } else { b'0' + (value - 26) as u8 })
    }
    fn adapt(delta: u32, points: u32, first: bool) -> u32 {
        let mut delta = if first { delta / DAMP } else { delta / 2 };
        delta += delta / points;
        let mut k = 0;
        while delta > (BASE - T_MIN) * T_MAX / 2 {
            delta /= BASE - T_MIN;
            k += BASE;
        }
        k + (BASE - T_MIN + 1) * delta / (delta + SKEW)
    }
    let points: Vec<u32> = label.chars().map(u32::from).collect();
    let mut output: String = label.chars().filter(char::is_ascii).collect();
    let basic = output.len() as u32;
    let mut handled = basic;
    if basic > 0 {
        output.push('-');
    }
    let (mut n, mut delta, mut bias) = (128u32, 0u32, 72u32);
    while (handled as usize) < points.len() {
        let next = points.iter().copied().filter(|&point| point >= n).min()?;
        delta = delta.checked_add((next - n).checked_mul(handled + 1)?)?;
        n = next;
        for &point in &points {
            if point < n {
                delta = delta.checked_add(1)?;
            }
            if point == n {
                let (mut q, mut k) = (delta, BASE);
                loop {
                    let t = if k <= bias {
                        T_MIN
                    } else if k >= bias + T_MAX {
                        T_MAX
                    } else {
                        k - bias
                    };
                    if q < t {
                        break;
                    }
                    output.push(digit(t + (q - t) % (BASE - t)));
                    q = (q - t) / (BASE - t);
                    k += BASE;
                }
                output.push(digit(q));
                bias = adapt(delta, handled + 1, handled == basic);
                delta = 0;
                handled += 1;
            }
        }
        delta += 1;
        n += 1;
    }
    Some(output)
}

/// Whether address-bar text names the page's own site: the full address, or
/// the short form Chromium shows (no scheme, no "www.", no path), by host and
/// port. Text being edited, or another site, does not (Test-SavedLoginAddressBar).
fn address_bar_shows(text: &str, page: &PageUrl) -> bool {
    let value = text.trim();
    if value.is_empty() {
        return false;
    }
    if has_scheme(value) {
        return parse_url(value).is_some_and(|shown| {
            shown.scheme == page.scheme && shown.host == page.host && shown.port == page.port
        });
    }
    let authority = &value[..value.find(['/', '?', '#']).unwrap_or(value.len())];
    let (host, tail) = if authority.starts_with('[') {
        match authority.find(']') {
            Some(end) if end > 1 => authority.split_at(end + 1),
            _ => return false,
        }
    } else {
        authority.split_at(
            authority
                .find(|c: char| c == ':' || c.is_whitespace())
                .unwrap_or(authority.len()),
        )
    };
    let port = match tail.strip_prefix(':') {
        None if tail.is_empty() => 443,
        Some(digits)
            if (1..=5).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit()) =>
        {
            digits.parse().unwrap_or(u32::MAX)
        }
        _ => return false,
    };
    let host = if host.starts_with('[') {
        host.to_lowercase()
    } else if host.is_empty() {
        return false;
    } else {
        match ascii_host(host) {
            Some(host) => host,
            None => return false,
        }
    };
    port == page.port && (host == page.host || format!("www.{host}") == page.host)
}

/// What the check read and the type step compares: the host-facing ids of one
/// checked target.
#[derive(Debug, PartialEq)]
struct Target {
    window_id: String,
    pid: String,
    origin: String,
    document_id: String,
    runtime_id: String,
    field: String,
    value_length: i64,
    start_time: String,
}

impl Target {
    fn from_request(req: &Req) -> Target {
        Target {
            window_id: req.text("window_id"),
            pid: req.text("pid"),
            origin: req.text("origin"),
            document_id: req.text("document_id"),
            runtime_id: req.text("runtime_id"),
            field: req.text("field"),
            value_length: req.int("value_length").unwrap_or(0),
            start_time: req.text("start_time"),
        }
    }

    fn json(&self) -> Value {
        json!({
            "window_id": self.window_id,
            "pid": self.pid,
            "origin": self.origin,
            "document_id": self.document_id,
            "runtime_id": self.runtime_id,
            "field": self.field,
            "value_length": self.value_length,
            "start_time": self.start_time,
        })
    }
}

/// What changed between the check and the write step, if anything. The
/// origin, not the full address, is compared: a path, query or fragment
/// change on the same site keeps the login valid (Get-SavedLoginChange).
fn change(expected: &Target, actual: &Target) -> Option<&'static str> {
    if actual.window_id != expected.window_id {
        Some("the browser window changed")
    } else if actual.pid != expected.pid {
        Some("the browser process changed")
    } else if actual.origin != expected.origin {
        Some("the page origin changed")
    } else if actual.document_id != expected.document_id {
        Some("the page was replaced")
    } else if actual.runtime_id != expected.runtime_id {
        Some("focus moved to another element")
    } else if actual.field != expected.field {
        Some("another field kind was asked for")
    } else if actual.value_length != expected.value_length {
        Some("the field content changed")
    } else {
        None
    }
}

/// The reason inside a `saved_login_refused` text.
fn refusal_reason(error: &str) -> Option<&str> {
    error
        .strip_prefix("saved_login_refused: ")?
        .strip_suffix("; no input was sent")
}

/// The window's address bars must positively confirm the page before any
/// input. Fail closed: a window with no readable omnibox cannot prove its
/// page, and any bar that is blank, being edited, or naming another site
/// refuses (Assert-SavedLoginAddressBars).
fn assert_address_bars(reads: &dyn SavedLoginReads, window: Wid, page: &PageUrl) -> Res<()> {
    let bars = reads.address_bars(window)?;
    if bars.is_empty() {
        return Err(saved_login_refused(
            "this window exposes no readable address bar to confirm the page",
        ));
    }
    if bars.iter().any(|text| !address_bar_shows(text, page)) {
        return Err(saved_login_refused(
            "the address bar does not show the page's own site",
        ));
    }
    Ok(())
}

impl Host {
    /// One saved-login step. A browser above this host's integrity is never
    /// driven (host/input-dispatch.ts:147).
    pub(super) fn saved_login(&self, action: &str, req: &Req) -> Res<Obj> {
        let Some(reads) = self.desktop.saved_login() else {
            return Err(SAVED_LOGIN_UNSUPPORTED.into());
        };
        let handle = parse_window_id(&req.text("window_id"));
        if self
            .desktop
            .integrity(handle)
            .is_some_and(|level| level.known() && level.higher())
        {
            return Err(saved_login_refused("the browser runs elevated"));
        }
        if action == "saved_login_check" {
            self.saved_login_check(reads, handle, req)
        } else {
            self.saved_login_type(reads, handle, req)
        }
    }

    /// The window a login may go into, by its own word, and its lower-case
    /// process name (Assert-SavedLoginBrowser).
    fn saved_login_browser(
        &self,
        reads: &dyn SavedLoginReads,
        handle: Wid,
    ) -> Res<(WindowInfo, String)> {
        let info = self
            .desktop
            .info(handle)
            .filter(|_| handle != 0)
            .ok_or_else(|| format!("window_id is stale or invalid: {}", window_id(handle)))?;
        let process = info.app.to_lowercase();
        match browser_refusal(&process, &info.class_name, reads.top_level(handle)) {
            Some(reason) => Err(saved_login_refused(&reason)),
            None => Ok((info, process)),
        }
    }

    /// Everything the login may be written into, read from the live window:
    /// the browser in the foreground, the focused field and the origin of the
    /// page document holding it (Get-SavedLoginTarget). `start_time` is left
    /// for the caller.
    fn saved_login_target(
        &self,
        reads: &dyn SavedLoginReads,
        info: &WindowInfo,
        field: &str,
    ) -> Res<(Target, PageUrl)> {
        if self.desktop.foreground() != info.handle {
            return Err(saved_login_refused("the browser window is not in the foreground"));
        }
        let SavedLoginFocus { runtime_id, document_id, document_url, field: facts } =
            reads.focus(info.handle, info.pid as u32)?;
        let Some(page) = page_url(&document_url) else {
            return Err(saved_login_refused("the page is not an HTTPS page"));
        };
        if let Some(reason) = field_refusal(&facts, field) {
            return Err(saved_login_refused(reason));
        }
        let target = Target {
            window_id: info.id(),
            pid: info.pid.to_string(),
            origin: origin_of(&page),
            document_id,
            runtime_id,
            field: field.into(),
            value_length: facts.value_length,
            start_time: String::new(),
        };
        Ok((target, page))
    }

    /// The host's check: refuse anything but a verified browser before
    /// touching it, bring it forward, then read the target the login is looked
    /// up for (Do-SavedLoginCheck).
    fn saved_login_check(&self, reads: &dyn SavedLoginReads, handle: Wid, req: &Req) -> Res<Obj> {
        let (info, process) = self.saved_login_browser(reads, handle)?;
        let start_time = verified_start(&process, reads.verified_image(info.pid as u32))
            .map_err(|reason| saved_login_refused(&reason))?;
        // Do-Focus begins its own input observation: input during the
        // activation and its settle is the person's, never missed.
        self.scope.borrow_mut().begin(&self.observer)?;
        let focus = self.do_focus(req);
        self.scope.borrow_mut().end();
        let mut focus = focus?;
        if focus.get("code").and_then(Value::as_str).is_some_and(|code| !code.is_empty()) {
            focus.insert("action".into(), json!("fill_saved_login"));
            return Ok(focus);
        }
        let (mut target, page) = self.saved_login_target(reads, &info, &req.text("field"))?;
        assert_address_bars(reads, handle, &page)?;
        if reads.start_time(info.pid as u32) != start_time {
            return Err(saved_login_refused("the browser process changed during the check"));
        }
        // A FILETIME exceeds a JSON number's exact range, so it travels as text.
        target.start_time = start_time.to_string();
        Ok(obj! {
            "text" => "saved login target checked; no input was sent",
            "saved_login_target" => target.json(),
        })
    }

    /// The last reads before the write: the browser still in the foreground
    /// and still the verified process; the focused element still the checked
    /// one, still the field kind asked for, inside the same page document,
    /// whose live address is still the origin. These are separate reads
    /// followed by a separate write, not an atomic compare-and-write
    /// (Assert-SavedLoginStill).
    fn saved_login_still(
        &self,
        reads: &dyn SavedLoginReads,
        info: &WindowInfo,
        start_time: i64,
        expected: &Target,
        field: &str,
    ) -> Res<()> {
        let pid = info.pid as u32;
        let why = if self.desktop.foreground() != info.handle {
            Some("the browser window left the foreground".to_owned())
        } else if reads.start_time(pid) != start_time
            || self.desktop.info(info.handle).map(|now| now.pid) != Some(info.pid)
        {
            Some("the browser process changed".to_owned())
        } else {
            match reads.focus(info.handle, pid) {
                Err(error) if error == saved_login_refused(SAVED_LOGIN_NO_FOCUS) => {
                    Some("focus moved to another element".to_owned())
                }
                Err(error) => Some(
                    refusal_reason(&error)
                        .unwrap_or("the field could not be re-read")
                        .to_owned(),
                ),
                Ok(focus) if focus.runtime_id != expected.runtime_id => {
                    Some("focus moved to another element".to_owned())
                }
                Ok(focus) => match field_refusal(&focus.field, field) {
                    Some(refusal) => Some(format!("the field changed ({refusal})")),
                    None if focus.document_id != expected.document_id => {
                        Some("the field left the checked page".to_owned())
                    }
                    None => match page_url(&focus.document_url) {
                        Some(page) if origin_of(&page) == expected.origin => None,
                        _ => Some("the page origin changed".to_owned()),
                    },
                },
            }
        };
        match why {
            Some(reason) => Err(saved_login_changed(&reason)),
            None => Ok(()),
        }
    }

    /// The write step: the process verified again and bound to the check's,
    /// the address bar re-proven, every target read again and matched to the
    /// check; then the last re-read and exactly one value-pattern write. A
    /// refusal before it writes nothing; once the write was invoked, an
    /// unconfirmed field is "possibly written", never retried
    /// (Do-SavedLoginType).
    fn saved_login_type(&self, reads: &dyn SavedLoginReads, handle: Wid, req: &Req) -> Res<Obj> {
        let value = req.text("text");
        if let Some(reason) = value_refusal(&value) {
            return Err(saved_login_refused(reason));
        }
        let field = req.text("field");
        let expected = Target::from_request(&req.child("expected").unwrap_or(Req(json!({}))));
        let (info, process) = self.saved_login_browser(reads, handle)?;
        let pid = info.pid as u32;
        // Some(confirmed) once the value pattern was written.
        let written: Cell<Option<bool>> = Cell::new(None);
        let mut write = || -> Res<()> {
            let start_time = verified_start(&process, reads.verified_image(pid))
                .map_err(|reason| saved_login_refused(&reason))?;
            if info.pid.to_string() != expected.pid || start_time.to_string() != expected.start_time {
                return Err(saved_login_changed("the browser process changed"));
            }
            let Some(checked) = page_url(&expected.origin) else {
                return Err(saved_login_refused("the checked origin is not an HTTPS origin"));
            };
            assert_address_bars(reads, handle, &checked)?;
            let (target, _) = self.saved_login_target(reads, &info, &field)?;
            if let Some(reason) = change(&expected, &target) {
                return Err(saved_login_changed(reason));
            }
            self.saved_login_still(reads, &info, start_time, &expected, &field)?;
            let confirmed =
                reads.set_value(pid, &expected.runtime_id, &value, &|| self.assert_continue())?;
            written.set(Some(confirmed));
            Ok(())
        };
        let outcome = self.foreground_input(handle, "type", false, &mut write);
        // Once the value pattern was written, any later failure is "possibly
        // written", never a plain refusal.
        let mut result = match outcome {
            Err(_) if written.get().is_some() => return Err(INCOMPLETE.into()),
            outcome => outcome?,
        };
        result.insert("action".into(), json!("fill_saved_login"));
        // The foreground protocol refused before the body ran: its answer stands.
        let Some(confirmed) = written.get() else {
            return Ok(result);
        };
        if !confirmed {
            return Err(UNCONFIRMED.into());
        }
        result.insert("path".into(), json!("uia_setvalue"));
        result.insert("effect".into(), json!("confirmed"));
        result.insert(
            "text".into(),
            json!(format!("wrote the saved {field} into the checked field")),
        );
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(url: &str) -> PageUrl {
        page_url(url).expect("an https page")
    }

    fn field(edit: bool, focused: bool, enabled: bool, read_only: bool, password: bool) -> SavedLoginField {
        SavedLoginField { edit, focused, enabled, read_only, password, value_length: 0 }
    }

    #[test]
    fn the_field_refusal_table() {
        let ok = |password| field(true, true, true, false, password);
        assert_eq!(field_refusal(&ok(true), "password"), None);
        assert_eq!(field_refusal(&ok(false), "username"), None);
        assert_eq!(
            field_refusal(&field(false, true, true, false, false), "username"),
            Some("the focused element is not a text field")
        );
        assert_eq!(
            field_refusal(&field(true, false, true, false, false), "username"),
            Some("the field does not hold keyboard focus")
        );
        for (enabled, read_only) in [(false, false), (true, true)] {
            assert_eq!(
                field_refusal(&field(true, true, enabled, read_only, true), "password"),
                Some("the focused field is disabled or read-only")
            );
        }
        assert_eq!(
            field_refusal(&ok(false), "password"),
            Some("the focused field is not a password field")
        );
        assert_eq!(
            field_refusal(&ok(true), "username"),
            Some("the focused field is a password field, not a username field")
        );
    }

    #[test]
    fn origins_are_normalised_as_url_origin_spells_them() {
        let origin = |url: &str| page_url(url).map(|url| origin_of(&url));
        assert_eq!(origin("https://Login.Example.COM/a?b#c"), Some("https://login.example.com".into()));
        assert_eq!(origin("HTTPS://example.com:443/"), Some("https://example.com".into()));
        assert_eq!(origin("https://example.com:8443/x"), Some("https://example.com:8443".into()));
        assert_eq!(origin("https://example.com:/x"), Some("https://example.com".into()));
        assert_eq!(origin("https://bücher.example/"), Some("https://xn--bcher-kva.example".into()));
        assert_eq!(origin("https://MÜNCHEN.de"), Some("https://xn--mnchen-3ya.de".into()));
        assert_eq!(origin("https://[2001:DB8::1]:444/"), Some("https://[2001:db8::1]:444".into()));
        assert_eq!(origin("https://example.com\\path"), Some("https://example.com".into()));
    }

    #[test]
    fn only_an_https_page_with_a_host_and_no_userinfo_is_a_page() {
        for refused in [
            "http://example.com/",
            "https://user@example.com/",
            "https://user:pw@example.com/",
            "https:///path",
            "https://",
            "https://example.com:99999/",
            "https://example.com:80a/",
            "https://exa mple.com/",
            "example.com",
            "chrome://settings",
            "",
        ] {
            assert_eq!(page_url(refused), None, "{refused}");
        }
        // An empty user name is no user name.
        assert!(page_url("https://@example.com/").is_some());
    }

    #[test]
    fn punycode_matches_the_rfc_vectors() {
        assert_eq!(punycode("bücher").as_deref(), Some("bcher-kva"));
        assert_eq!(punycode("münchen").as_deref(), Some("mnchen-3ya"));
        assert_eq!(punycode("例え").as_deref(), Some("r8jz45g"));
        assert_eq!(punycode("ü").as_deref(), Some("tda"));
    }

    #[test]
    fn the_address_bar_must_show_the_pages_own_site() {
        let shown_page = page("https://www.example.com/login?next=1");
        for shown in [
            "https://www.example.com/login",
            "https://WWW.EXAMPLE.COM",
            "www.example.com/login",
            "example.com",
            "  example.com/a/b?c#d  ",
            "https://www.example.com:443/",
        ] {
            assert!(address_bar_shows(shown, &shown_page), "{shown}");
        }
        for shown in [
            "",
            "   ",
            "https://evil.example.org/",
            "https://www.example.com:8443/",
            "http://www.example.com/",
            "evil.com",
            "example.com:8443",
            "example.com:123456",
            "login example.com",
            "a.example.com",
            "https://",
        ] {
            assert!(!address_bar_shows(shown, &shown_page), "{shown}");
        }
        let odd = page("https://example.com:8443/");
        assert!(address_bar_shows("example.com:8443", &odd));
        assert!(!address_bar_shows("example.com", &odd));
        let idn = page("https://xn--bcher-kva.example/");
        assert!(address_bar_shows("bücher.example", &idn));
        let v6 = page("https://[::1]:444/");
        assert!(address_bar_shows("[::1]:444", &v6));
        assert!(!address_bar_shows("[::1]", &v6));
    }

    #[test]
    fn only_a_chrome_or_edge_frame_is_a_browser() {
        assert_eq!(browser_refusal("chrome", "Chrome_WidgetWin_1", true), None);
        assert_eq!(browser_refusal("msedge", "Chrome_WidgetWin_1", true), None);
        assert!(browser_refusal("brave", "Chrome_WidgetWin_1", true).unwrap().starts_with("Brave is not supported yet"));
        assert!(browser_refusal("firefox", "MozillaWindowClass", true).unwrap().starts_with("Firefox is not supported yet"));
        for (process, class, top) in [
            ("notepad", "Notepad", true),
            ("chrome", "Chrome_RenderWidgetHostHWND", true),
            ("chrome", "Chrome_WidgetWin_1", false),
        ] {
            assert_eq!(
                browser_refusal(process, class, top).as_deref(),
                Some(format!("the window belongs to '{process}', not a Chrome or Edge browser window; saved logins are web logins").as_str())
            );
        }
    }

    #[test]
    fn the_signer_organisation_must_be_the_vendors() {
        let image = |path: &str, signer: &str, start_time| {
            Some(SavedLoginImage { path: path.into(), signer: signer.into(), start_time })
        };
        let chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
        assert_eq!(verified_start("chrome", image(chrome, "Google LLC", 77)), Ok(77));
        assert_eq!(
            verified_start("msedge", image(r"C:\Edge\MSEDGE.EXE", "Microsoft Corporation", 5)),
            Ok(5)
        );
        let not_signed = Err("the 'chrome' window's program is not signed by Google LLC".to_owned());
        assert_eq!(verified_start("chrome", image(chrome, "Microsoft Corporation", 77)), not_signed);
        assert_eq!(verified_start("chrome", image(chrome, "google llc", 77)), not_signed);
        assert_eq!(verified_start("chrome", image(r"C:\Temp\other.exe", "Google LLC", 77)), not_signed);
        for unproven in [None, image(chrome, "", 77), image(chrome, "Google LLC", 0)] {
            assert_eq!(
                verified_start("chrome", unproven),
                Err("the 'chrome' window's program could not be verified as a signed browser".into())
            );
        }
    }

    #[test]
    fn a_value_with_a_line_break_or_none_is_refused_before_any_write() {
        assert_eq!(value_refusal("hunter2"), None);
        assert_eq!(value_refusal(""), Some("no saved value reached the worker"));
        for value in ["a\nb", "a\rb", "\r\n"] {
            assert_eq!(
                value_refusal(value),
                Some("the saved value holds a line break, which the field would strip")
            );
        }
    }

    #[test]
    fn the_type_step_compares_its_target_with_the_checked_one() {
        let checked = Target {
            window_id: "hwnd:0x10".into(),
            pid: "42".into(),
            origin: "https://example.com".into(),
            document_id: "42.7".into(),
            runtime_id: "42.9".into(),
            field: "password".into(),
            value_length: 0,
            start_time: "133".into(),
        };
        let compare = |edit: &dyn Fn(&mut Target)| {
            let mut now = Target::from_request(&Req(checked.json()));
            edit(&mut now);
            change(&checked, &now)
        };
        assert_eq!(compare(&|_| {}), None);
        // The start time is bound by its own check, not by this comparison.
        assert_eq!(compare(&|now| now.start_time = "9".into()), None);
        assert_eq!(compare(&|now| now.window_id = "hwnd:0x11".into()), Some("the browser window changed"));
        assert_eq!(compare(&|now| now.pid = "43".into()), Some("the browser process changed"));
        assert_eq!(compare(&|now| now.origin = "https://evil.test".into()), Some("the page origin changed"));
        assert_eq!(compare(&|now| now.document_id = "42.8".into()), Some("the page was replaced"));
        assert_eq!(compare(&|now| now.runtime_id = "42.10".into()), Some("focus moved to another element"));
        assert_eq!(compare(&|now| now.field = "username".into()), Some("another field kind was asked for"));
        assert_eq!(compare(&|now| now.value_length = 3), Some("the field content changed"));
        // A request missing its target compares as empty ids: everything differs.
        assert_eq!(
            change(&Target::from_request(&Req(json!({}))), &checked),
            Some("the browser window changed")
        );
        // The checked target survives the round trip through the reply.
        assert_eq!(Target::from_request(&Req(checked.json())), checked);
    }

    #[test]
    fn a_platform_refusal_keeps_its_own_reason() {
        assert_eq!(
            refusal_reason(&saved_login_refused("focus is not on a web page of this browser window")),
            Some("focus is not on a web page of this browser window")
        );
        assert_eq!(refusal_reason("window_id is stale or invalid: hwnd:0x1"), None);
    }
}
