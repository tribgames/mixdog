//! The public pages: `/app`, `/app/latest.json`, `/connect`, the update-your-PC page, and the pairing CSS they share.

use std::path::PathBuf;

use mixdog_fsio::Unlaned;
use mixdog_relay::logline::Stream;
use mixdog_relay::pages::app::{ANDROID_FALLBACK_URL, AppPages, is_android_apk_url, read_android_url, render_app_page};
use mixdog_relay::pages::connect::connect_page;
use mixdog_relay::pages::update_pc::{is_native_app_request, render_update_pc_page, update_pc_page};
use mixdog_relay::pages::{PageReply, PageRequest};
use serde_json::Value;

const RELEASE_URL: &str = "https://github.com/tribgames/mixdog/releases/download/mobile-v0.1.13/Mixdog-0.1.13.apk";
const ANDROID_AGENT: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8)";

fn request<'a>(method: &'a str, user_agent: Option<&'a str>) -> PageRequest<'a> {
    PageRequest { method, user_agent }
}

fn header<'a>(reply: &'a PageReply, name: &str) -> Option<&'a str> {
    reply.headers.iter().find(|(key, _)| *key == name).map(|(_, value)| value.as_str())
}

fn text(reply: &PageReply) -> &str {
    std::str::from_utf8(reply.body.as_deref().expect("a body")).expect("utf-8")
}


// ---- /app and /app/latest.json ----

#[test]
fn latest_json_reports_the_version_and_apk_of_the_deployed_release() {
    let pages = AppPages::new(RELEASE_URL);
    let ok = pages.latest_release(request("GET", None));
    assert_eq!(ok.status, 200);
    let body: Value = serde_json::from_str(text(&ok)).expect("json");
    assert_eq!(body, serde_json::json!({"version": "0.1.13", "url": RELEASE_URL}));
    assert_eq!(header(&ok, "Cache-Control"), Some("no-store"));
    assert_eq!(header(&ok, "X-Content-Type-Options"), Some("nosniff"));
    assert!(header(&ok, "Content-Type").expect("type").starts_with("application/json"));
    assert_eq!(pages.latest_release(request("HEAD", None)).body, None);
    assert_eq!(pages.latest_release(request("POST", None)).status, 405);
}

#[test]
fn latest_json_is_404_when_only_the_releases_page_is_known() {
    let missing = AppPages::new(ANDROID_FALLBACK_URL).latest_release(request("GET", None));
    assert_eq!(missing.status, 404);
    assert_eq!(header(&missing, "Cache-Control"), Some("no-store"));
}

#[test]
fn app_links_the_android_release_recorded_at_deploy_time() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("mobile-release.json");
    mixdog_fsio::write(&Unlaned, &file, serde_json::json!({"androidUrl": RELEASE_URL}).to_string()).expect("write");
    assert_eq!(read_android_url(&file), (RELEASE_URL.to_owned(), None));
    mixdog_fsio::write(&Unlaned, &file, serde_json::json!({"androidUrl": ANDROID_FALLBACK_URL}).to_string()).expect("write");
    assert_eq!(read_android_url(&file), (ANDROID_FALLBACK_URL.to_owned(), None));
    let page = render_app_page(RELEASE_URL);
    assert!(page.contains(&format!("<a class=\"mxp-btn\" id=\"androidBtn\" href=\"{RELEASE_URL}\"")));
    assert!(page.contains("href=\"https://testflight.apple.com/join/UNPBM2hU\""));
}

#[test]
fn app_sends_an_android_phone_straight_to_the_apk_and_others_to_the_install_page() {
    let pages = AppPages::new(RELEASE_URL);
    let android = pages.app_page(request("GET", Some(ANDROID_AGENT)));
    assert_eq!(android.status, 302);
    assert_eq!(header(&android, "Location"), Some(RELEASE_URL));
    assert_eq!(header(&android, "Cache-Control"), Some("no-store"));
    let iphone = pages.app_page(request("GET", Some("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")));
    assert_eq!(iphone.status, 200);
    assert!(text(&iphone).contains("Get it for iPhone"));
    // Without a known APK, Android sees the page whose button opens the releases list.
    assert_eq!(AppPages::new(ANDROID_FALLBACK_URL).app_page(request("GET", Some("Android"))).status, 200);
}

#[test]
fn app_falls_back_to_the_releases_list_without_a_usable_deployed_link() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("mobile-release.json");
    assert_eq!(read_android_url(&file), (ANDROID_FALLBACK_URL.to_owned(), None), "a missing file is silent");
    let bad = [
        "{not json".to_owned(),
        "{}".to_owned(),
        serde_json::json!({"androidUrl": 42}).to_string(),
        serde_json::json!({"androidUrl": "javascript:alert(1)"}).to_string(),
        serde_json::json!({"androidUrl": "https://evil.example/releases/tag/mobile-v1.0.0"}).to_string(),
        serde_json::json!({"androidUrl": format!("{RELEASE_URL}\"><script>")}).to_string(),
        serde_json::json!({"androidUrl": "https://github.com/tribgames/mixdog/releases/tag/mobile-v0.1.13"}).to_string(),
        serde_json::json!({"androidUrl": "https://github.com/other/repo/releases/download/mobile-v0.1.13/a.apk"}).to_string(),
        serde_json::json!({"androidUrl": "https://github.com/tribgames/mixdog/releases/download/v1.2.3/a.apk"}).to_string(),
        serde_json::json!({"androidUrl": "https://github.com/tribgames/mixdog/releases/download/mobile-v0.1.13/a.zip"}).to_string(),
        serde_json::json!({"androidUrl": "https://github.com/tribgames/mixdog/releases/tag/v1.2.3"}).to_string(),
    ];
    for contents in &bad {
        mixdog_fsio::write(&Unlaned, &file, contents).expect("write");
        let (url, line) = read_android_url(&file);
        assert_eq!(url, ANDROID_FALLBACK_URL, "{contents}");
        let line = line.expect("a malformed file is reported");
        assert_eq!(line.stream, Stream::Err);
        assert!(line.text.starts_with("[relay] ignoring malformed file:///"), "{}", line.text);
        assert!(line.text.ends_with("/mobile-release.json; /app links the releases list"), "{}", line.text);
    }
}

#[test]
fn an_unreadable_release_file_is_reported_and_falls_back() {
    let dir = tempfile::tempdir().expect("tempdir");
    // A directory where the file should be: it exists and cannot be read.
    let file = dir.path().join("mobile-release.json");
    mixdog_fsio::create_dir(&Unlaned, &file).expect("mkdir");
    let (url, line) = read_android_url(&file);
    assert_eq!(url, ANDROID_FALLBACK_URL);
    let line = line.expect("reported");
    assert_eq!(line.stream, Stream::Err);
    assert!(line.text.starts_with("[relay] cannot read file:///"), "{}", line.text);
}

#[test]
fn only_the_releases_list_and_a_release_apk_are_apk_links() {
    assert!(is_android_apk_url(RELEASE_URL));
    assert!(!is_android_apk_url(ANDROID_FALLBACK_URL));
    assert!(!is_android_apk_url(&format!("{RELEASE_URL}\n")));
    assert!(!is_android_apk_url("https://github.com/tribgames/mixdog/releases/download/mobile-v\u{0661}.1.1/a.apk"));
}

// ---- /connect ----

#[test]
fn connect_and_app_carry_their_logo_inline_and_not_from_a_relay_root_asset() {
    let connect = connect_page(request("GET", None));
    let app = AppPages::new(RELEASE_URL).app_page(request("GET", None));
    for (name, reply) in [("/connect", &connect), ("/app", &app)] {
        let body = text(reply);
        let logo = body.split("<img class=\"mxp-logo\" src=\"").nth(1).and_then(|rest| rest.split('"').next()).expect(name);
        assert!(logo.starts_with("data:image/svg+xml,%3Csvg"), "{name}");
        assert!(!body.contains("src=\"/mixdog-logo-titanium.svg\""), "{name}");
        assert!(header(reply, "Content-Security-Policy").expect("csp").contains("img-src data:;"), "{name}");
        assert!(logo.contains("%3Csvg"), "{name}");
    }
}

// ---- the shared layout CSS ----

fn repo_file(path: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    mixdog_fsio::read_to_string(&Unlaned, root.join(path)).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

#[test]
fn the_pairing_css_is_the_block_the_phone_app_and_the_desktop_screen_carry() {
    let asset = include_str!("../assets/pages/pairing.css");
    let html = repo_file("apps/mobile/src/index.html");
    let start = html.find(".mxp-screen{").expect("the app's css block");
    let end = html.find("</style>").expect("end of the style");
    assert_eq!(html[start..end].trim(), asset, "apps/mobile/src/index.html");
    assert!(repo_file("apps/desktop/src/renderer/remote-pairing-screen.ts").contains(asset), "the desktop pairing screen");
    assert!(text(&connect_page(request("GET", None))).contains(asset), "/connect");
    assert!(asset.contains(".mxp-col{width:calc(100% - 40px);max-width:340px;"));
}

#[test]
fn the_phone_app_is_told_by_its_user_agent_token() {
    assert!(is_native_app_request(Some("MixdogApp/1.2.3 (Android)")));
    assert!(!is_native_app_request(Some("Mozilla/5.0 (iPhone)")));
    assert!(!is_native_app_request(Some("mixdogapp/1")));
    assert!(!is_native_app_request(None));
}


// ---- byte equality with the Node pages ----


#[test]
fn the_connect_page_is_served_to_get_and_head_and_refused_to_other_methods() {
    let get = connect_page(request("GET", None));
    assert_eq!(get.status, 200);
    assert!(header(&get, "Content-Type").expect("type").starts_with("text/html"));
    assert!(header(&get, "Content-Security-Policy").expect("csp").starts_with("default-src 'none'"));
    assert!(text(&get).contains("/pair-code/resolve"), "the page posts the typed code to the relay");
    let head = connect_page(request("HEAD", None));
    assert_eq!((head.status, head.body), (200, None));
    assert_eq!(connect_page(request("POST", None)).status, 405);
}

#[test]
fn the_update_page_is_always_served_and_shows_the_versions_escaped() {
    let reply = update_pc_page("GET", "1.4.0", "1.5.0");
    assert_eq!(reply.status, 200);
    assert!(header(&reply, "Content-Type").expect("type").starts_with("text/html"));
    assert!(header(&reply, "Content-Security-Policy").is_some());
    assert!(text(&reply).contains("data-current=\"1.4.0\" data-min=\"1.5.0\""));
    assert_eq!(update_pc_page("HEAD", "1.4.0", "1.5.0").body, None);
    let page = render_update_pc_page("<b>", "\"x\" & 'y'");
    assert!(page.contains("data-current=\"&#60;b&#62;\" data-min=\"&#34;x&#34; &#38; &#39;y&#39;\""));
}
