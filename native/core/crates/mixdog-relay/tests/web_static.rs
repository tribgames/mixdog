//! Static file serving: conditional requests, precompressed siblings, security headers, cache rules, cookies, and
//! resolution of request paths inside the renderer root.

use std::path::{Path, PathBuf};

use mixdog_fsio::Unlaned;
use mixdog_relay::http1::Headers;
use mixdog_relay::web::files::{
    StaticBody, StaticOptions, StaticRequest, StaticResolution, answer_static_file, mime_type, not_modified, resolve_static_target,
};
use mixdog_relay::web::headers::{
    ResponseHeaders, browser_security_headers, device_cookie_headers, pairing_cookie_headers, request_cookie_token, security_headers_for_target,
};
use mixdog_relay::web::negotiate::{encoding_accepted, parse_accept_encoding, select_precompressed};
use mixdog_rt::InteractiveIo;
use sha2::{Digest, Sha256};

fn write(path: &Path, bytes: impl AsRef<[u8]>) {
    mixdog_fsio::create_dir_all(&Unlaned, path.parent().unwrap()).unwrap();
    mixdog_fsio::write(&Unlaned, path, bytes).unwrap();
}

#[test]
fn the_cookie_of_a_cross_site_request_never_authenticates() {
    let mut headers = Headers::default();
    headers.add("cookie", "mixdog_token=abcd".to_owned());
    assert_eq!(request_cookie_token(&headers), "abcd");
    headers.add("origin", "null".to_owned());
    assert_eq!(request_cookie_token(&headers), "");
}

#[test]
fn weak_comparison_and_the_method_decide_not_modified() {
    assert!(not_modified("GET", Some("W/\"a\""), "\"a\""));
    assert!(not_modified("HEAD", Some("\"a\", \"b\""), "W/\"b\""));
    assert!(not_modified("GET", Some(" * "), "W/\"z\""));
    assert!(!not_modified("POST", Some("*"), "W/\"z\""));
    assert!(!not_modified("GET", None, "W/\"z\""));
    assert!(!not_modified("GET", Some("w/\"z\""), "W/\"z\""));
}

#[test]
fn the_mime_table_names_every_extension_and_falls_back_to_octet_stream() {
    for (extension, mime) in mixdog_relay::web::files::MIME_TYPES {
        assert_eq!(mime_type(Path::new(&format!("dir/file{extension}"))), mime);
        assert_eq!(mime_type(Path::new(&format!("dir/file{}", extension.to_uppercase()))), mime);
    }
    assert_eq!(mime_type(Path::new("file.bin")), "application/octet-stream");
    assert_eq!(mime_type(Path::new("file")), "application/octet-stream");
}

#[test]
fn pairing_and_device_cookies_keep_max_age_httponly_samesite_forms() {
    let token = "abcd";
    let device = "12345678-abcd-4321-abcd-1234567890ab";
    assert_eq!(pairing_cookie_headers(token, false).get("Set-Cookie"), Some("mixdog_token=abcd; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax"));
    assert_eq!(pairing_cookie_headers(token, true).get("Set-Cookie"), Some("mixdog_token=abcd; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure"));
    assert_eq!(
        device_cookie_headers(device, false).get("Set-Cookie"),
        Some(format!("mixdog_device={device}; Path=/; Max-Age=31536000; SameSite=Lax").as_str())
    );
    assert_eq!(
        device_cookie_headers(device, true).get("Set-Cookie"),
        Some(format!("mixdog_device={device}; Path=/; Max-Age=31536000; SameSite=Lax; Secure").as_str())
    );
    assert!(pairing_cookie_headers("", true).is_empty());
}

#[test]
fn the_exact_csp_hash_only_for_the_inlined_boot_script() {
    use base64::Engine as _;
    let dir = tempfile::tempdir().unwrap();
    let source = "window.mixdogBoot = true;";
    let target = dir.path().join("index.html");
    write(&dir.path().join("boot.js"), source);
    write(&target, format!("<!doctype html><script>{source}</script>"));
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(source.as_bytes()));
    let headers = security_headers_for_target(&Unlaned, &target);
    let script = headers.get("Content-Security-Policy").unwrap().split("; ").find(|part| part.starts_with("script-src")).unwrap().to_owned();
    assert_eq!(script, format!("script-src 'self' 'sha256-{hash}'"));

    // The document does not inline it, or the script differs: the self-only policy stays.
    write(&target, "<!doctype html><script src=\"/boot.js\"></script>");
    assert_eq!(security_headers_for_target(&Unlaned, &target), browser_security_headers());
    write(&target, "<!doctype html><script>window.other = 1;</script>");
    assert_eq!(security_headers_for_target(&Unlaned, &target), browser_security_headers());
    // Without a boot.js beside it nothing is granted; another file name is never granted.
    mixdog_fsio::remove_file(&Unlaned, dir.path().join("boot.js")).unwrap();
    write(&target, format!("<!doctype html><script>{source}</script>"));
    assert_eq!(security_headers_for_target(&Unlaned, &target), browser_security_headers());
    write(&dir.path().join("boot.js"), source);
    let other = dir.path().join("other.html");
    write(&other, format!("<!doctype html><script>{source}</script>"));
    assert_eq!(security_headers_for_target(&Unlaned, &other), browser_security_headers());
}

#[test]
fn static_target_resolution_rejects_symlink_escapes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("renderer");
    let outside = dir.path().join("outside");
    write(&root.join("index.html"), "inside");
    write(&outside.join("secret.txt"), "outside");
    assert!(matches!(resolve_static_target(&root, "/index.html"), StaticResolution::Found(_)));
    assert_eq!(resolve_static_target(&root, "/../outside/secret.txt"), StaticResolution::Forbidden);
    let linked = root.join("linked");
    // A link is a junction on Windows (it needs no privilege) and a directory symlink elsewhere.
    #[cfg(windows)]
    junction(&linked, &outside);
    #[cfg(not(windows))]
    mixdog_fsio::symlink_dir(&Unlaned, &outside, &linked).unwrap();
    assert_eq!(resolve_static_target(&root, "/linked/secret.txt"), StaticResolution::Forbidden);
}

/// A junction `link` -> `target`, as `symlinkSync(target, link, 'junction')` makes it.
#[cfg(windows)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: mklink is the one way to make a junction without a privilege")]
fn junction(link: &Path, target: &Path) {
    // `mklink` takes backslash paths only.
    let backslashed = |path: &Path| path.to_string_lossy().replace('/', "\\");
    let made = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(backslashed(link)).arg(backslashed(target)).output().expect("mklink");
    assert!(made.status.success(), "mklink: {}", String::from_utf8_lossy(&made.stderr));
}

fn io() -> InteractiveIo {
    mixdog_rt::testing::tokens().interactive_io
}
async fn answer(method: &str, accept: Option<&str>, if_none_match: Option<&str>, target: &Path) -> mixdog_relay::web::files::StaticAnswer {
    let request = StaticRequest { method, accept_encoding: accept, if_none_match };
    answer_static_file(&io(), &request, target, &ResponseHeaders::new(), StaticOptions::default()).await.unwrap()
}
// ---- the recording: whole exchanges over a connection ----

// ---- conditional requests and compression ----

#[tokio::test]
async fn conditional_assets_retain_security_and_cookies_and_distinguish_changed_representations() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("index.html");
    let original = "<p>asset content</p>".repeat(200);
    write(&target, &original);
    write(&dir.path().join("index.html.gz"), "gzip sibling");
    write(&dir.path().join("index.html.br"), "brotli sibling");
    let mut extra = ResponseHeaders::new();
    extra.set("Set-Cookie", "device=test; HttpOnly");
    let get = |accept: Option<&'static str>, tag: Option<String>, method: &'static str| {
        let (target, extra) = (target.clone(), extra.clone());
        async move {
            let request = StaticRequest { method, accept_encoding: accept, if_none_match: tag.as_deref() };
            answer_static_file(&io(), &request, &target, &extra, StaticOptions::default()).await.unwrap()
        }
    };
    let raw = get(None, None, "GET").await;
    let br = get(Some("br"), None, "GET").await;
    let gz = get(Some("gzip"), None, "GET").await;
    let tags: Vec<String> = [&raw, &br, &gz].iter().map(|a| a.headers.get("ETag").unwrap().to_owned()).collect();
    assert_eq!(tags.iter().collect::<std::collections::HashSet<_>>().len(), 3);
    for (accept, tag) in [(None, &tags[0]), (Some("br"), &tags[1]), (Some("gzip"), &tags[2])] {
        for method in ["GET", "HEAD"] {
            let unrelated = format!("\"unrelated\", {}", tag.replace("W/", ""));
            let cached = get(accept, Some(unrelated), method).await;
            assert_eq!(cached.status, 304);
            assert_eq!(cached.body, StaticBody::None);
            assert_eq!(cached.headers.get("Content-Length"), None);
            assert_eq!(cached.headers.get("Cache-Control"), Some("no-cache"));
            assert_eq!(cached.headers.get("Vary"), Some("Accept-Encoding"));
            assert_eq!(cached.headers.get("X-Content-Type-Options"), Some("nosniff"));
            assert_eq!(cached.headers.values("Set-Cookie"), ["device=test; HttpOnly"]);
        }
    }
    assert_eq!(get(None, Some("*".to_owned()), "GET").await.status, 304);
    assert_eq!(get(Some("br"), Some(tags[0].clone()), "GET").await.status, 200);
    write(&target, format!("{original}!"));
    let changed = get(None, Some(tags[0].clone()), "GET").await;
    assert_eq!(changed.status, 200);
    assert_ne!(changed.headers.get("ETag"), Some(tags[0].as_str()));
    write(&dir.path().join("index.html.br"), "brotli sibling, changed");
    assert_eq!(get(Some("br"), Some(tags[1].clone()), "GET").await.status, 200);
}
// ---- the gate and the static routes ----

#[tokio::test]
async fn precompressed_siblings_are_negotiated_and_never_served_directly() {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("assets");
    let target = assets.join("index-AbCdEf123.css");
    write(&target, format!("body{{color:red}}{}", " ".repeat(2048)));
    write(&assets.join("index-AbCdEf123.css.br"), "brotli-body-placeholder");
    write(&assets.join("index-AbCdEf123.css.gz"), "gzip-body-placeholder");
    let length = |name: &str| mixdog_fsio::metadata(&Unlaned, assets.join(name)).unwrap().len().to_string();

    let brotli = answer("HEAD", Some("gzip, deflate, br"), None, &target).await;
    assert_eq!(brotli.headers.get("Content-Encoding"), Some("br"));
    assert_eq!(brotli.headers.get("Content-Length"), Some(length("index-AbCdEf123.css.br").as_str()));
    assert_eq!(brotli.headers.get("Vary"), Some("Accept-Encoding"));
    let gzip_only = answer("HEAD", Some("gzip"), None, &target).await;
    assert_eq!(gzip_only.headers.get("Content-Encoding"), Some("gzip"));
    assert_eq!(gzip_only.headers.get("Content-Length"), Some(length("index-AbCdEf123.css.gz").as_str()));
    let identity = answer("HEAD", Some(""), None, &target).await;
    assert_eq!(identity.headers.get("Content-Encoding"), None);
    assert_eq!(identity.headers.get("Content-Length"), Some(length("index-AbCdEf123.css").as_str()));

    // A raw build with nothing staged keeps the on-the-fly gzip, whose length is unknown until the stream ends.
    let plain = assets.join("plain-Zz9YyXx87.css");
    write(&plain, format!("body{{color:blue}}{}", " ".repeat(2048)));
    let live = answer("HEAD", Some("br, gzip"), None, &plain).await;
    assert_eq!(live.headers.get("Content-Encoding"), Some("gzip"));
    assert_eq!(live.headers.get("Content-Length"), None);

    assert_eq!(resolve_static_target(dir.path(), "/assets/index-AbCdEf123.css.br"), StaticResolution::Missing);
    assert_eq!(resolve_static_target(dir.path(), "/assets/index-AbCdEf123.css.gz"), StaticResolution::Missing);
    assert!(matches!(resolve_static_target(dir.path(), "/assets/index-AbCdEf123.css"), StaticResolution::Found(_)));
}
#[tokio::test]
async fn q0_is_honoured_on_staged_and_live_gzip() {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("assets");
    let staged = assets.join("index-Q0AbCdEf1.css");
    write(&staged, format!("body{{color:red}}{}", " ".repeat(2048)));
    write(&assets.join("index-Q0AbCdEf1.css.gz"), "gzip-body-placeholder");
    // No sibling beside this one on purpose: with a `.gz` present the refusal is honoured by sibling selection, which says
    // nothing about the live gzip a raw build actually runs on.
    let live = assets.join("live-Q0ZzYyXx9.css");
    write(&live, format!("body{{color:blue}}{}", " ".repeat(2048)));

    assert!(!encoding_accepted(Some("gzip;q=0"), "gzip"));
    assert!(encoding_accepted(Some("gzip;q=0.001"), "gzip"));
    assert!(!encoding_accepted(Some("*;q=0"), "gzip"));
    assert!(encoding_accepted(Some("*"), "br"));
    assert_eq!(parse_accept_encoding(Some("gzip;q=0.5, br")).get("gzip"), Some(&0.5));

    let encoding = |accept: &'static str, target: PathBuf| async move {
        answer("HEAD", Some(accept), None, &target).await.headers.get("Content-Encoding").map(str::to_owned)
    };
    assert_eq!(encoding("gzip;q=0", staged.clone()).await, None);
    assert_eq!(encoding("br;q=0, gzip;q=0", staged.clone()).await, None);
    assert_eq!(encoding("*;q=0", staged.clone()).await, None);
    assert_eq!(encoding("gzip;q=0.5", staged.clone()).await.as_deref(), Some("gzip"));

    assert!(select_precompressed(&Unlaned, &live, Some("br, gzip")).is_none());
    let compressed = answer("HEAD", Some("gzip"), None, &live).await;
    assert_eq!(compressed.headers.get("Content-Encoding"), Some("gzip"));
    assert_eq!(compressed.headers.get("Content-Length"), None);
    let refused = answer("HEAD", Some("gzip;q=0"), None, &live).await;
    assert_eq!(refused.headers.get("Content-Encoding"), None);
    let size = mixdog_fsio::metadata(&Unlaned, &live).unwrap().len().to_string();
    assert_eq!(refused.headers.get("Content-Length"), Some(size.as_str()));
    assert_eq!(encoding("*;q=0", live.clone()).await, None);
    assert_eq!(encoding("br;q=0, gzip;q=0", live.clone()).await, None);
    // br is only ever served from a staged sibling, so a br-only client on the live path gets identity.
    assert_eq!(encoding("br", live).await, None);
}
#[tokio::test]
async fn a_symlinked_sibling_is_never_negotiated() {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("assets");
    let target = assets.join("index-Sy0AbCdE1.css");
    write(&target, format!("body{{color:red}}{}", " ".repeat(2048)));
    write(&assets.join("index-Sy0AbCdE1.css.gz"), "gzip-body-placeholder");
    write(&dir.path().join("outside").join("secret.br"), "outside");
    if mixdog_fsio::symlink_file(&Unlaned, dir.path().join("outside").join("secret.br"), assets.join("index-Sy0AbCdE1.css.br")).is_err() {
        // The link is the test: a host that cannot create one (Windows without developer mode) has verified nothing here.
        eprintln!("SKIPPED: creating a file symlink is not permitted on this host");
        return;
    }
    assert!(select_precompressed(&Unlaned, &target, Some("br")).is_none());
    let picked = select_precompressed(&Unlaned, &target, Some("br, gzip")).unwrap();
    assert_eq!(picked.encoding.name(), "gzip");
    let headers = answer("HEAD", Some("br, gzip"), None, &target).await.headers;
    assert_eq!(headers.get("Content-Encoding"), Some("gzip"));
    let size = mixdog_fsio::metadata(&Unlaned, assets.join("index-Sy0AbCdE1.css.gz")).unwrap().len().to_string();
    assert_eq!(headers.get("Content-Length"), Some(size.as_str()));
}
#[tokio::test]
async fn static_responses_apply_browser_security_headers_without_changing_head_behaviour() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("index.html");
    write(&target, "<!doctype html><title>Mixdog</title>");
    let head = answer("HEAD", None, None, &target).await;
    assert_eq!(head.status, 200);
    assert_eq!(head.body, StaticBody::None);
    for (name, value) in browser_security_headers().iter() {
        assert_eq!(head.headers.get(name), Some(value[0].as_str()), "{name}");
    }
    let policy = head.headers.get("Content-Security-Policy").unwrap();
    assert!(policy.contains("frame-ancestors 'none'"));
    assert_eq!(policy.split("; ").find(|part| part.starts_with("script-src")), Some("script-src 'self'"));
    assert_eq!(head.headers.get("X-Frame-Options"), Some("DENY"));
    assert_eq!(head.headers.get("Referrer-Policy"), Some("no-referrer"));
    assert!(head.headers.get("Permissions-Policy").unwrap().contains("camera=(self)"));
    // The 304 and the GET carry them too.
    assert_eq!(answer("GET", None, None, &target).await.headers.get("X-Content-Type-Options"), Some("nosniff"));

    let hashed = dir.path().join("assets").join("index-AbCdEf123.js");
    write(&hashed, "export const ready = true;");
    assert_eq!(answer("HEAD", None, None, &hashed).await.headers.get("Cache-Control"), Some("public, max-age=31536000, immutable"));
    let plain = dir.path().join("style.css");
    write(&plain, "body{color:red}");
    assert_eq!(answer("HEAD", None, None, &plain).await.headers.get("Cache-Control"), Some("public, max-age=86400"));
    for name in ["boot.js", "ui-language.js", "sw-shell.js", "sw.js", "sw-media.js", "manifest.webmanifest"] {
        let file = dir.path().join(name);
        write(&file, "window.mixdogBoot = true;");
        assert_eq!(answer("HEAD", None, None, &file).await.headers.get("Cache-Control"), Some("no-cache"), "{name}");
    }
}

// ---- the recording: heads ----
