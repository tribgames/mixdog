#![allow(clippy::disallowed_methods, reason = "fixtures are written and read directly")]
//! `ooxml-validator-cache.test.mjs` (the three cases) against a fake npm tarball served from a local socket, and the
//! classification and parsing of the validator's output. Nothing here starts a validator: the one test that does is ignored.

use mixdog_rt::LaneToken;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine;
use mixdog_ooxml::ooxml_validator::{
    Environment, PlatformPackage, Request, ValidatorRuntime, classify_ooxml_validation_errors, ensure_in, node_platform,
    ooxml_validator_manifest, parse_validator_output, pinned_packages,
};
use mixdog_rt::{CancellationToken, DurabilityIo, InLane};
use serde_json::{Value, json};
use sha2::{Digest, Sha512};

const FAKE_BINARY: &str = "ooxml-validator-test";

fn fake_package() -> PlatformPackage {
    PlatformPackage { name: "@xarsh/ooxml-validator-test".into(), integrity: String::new(), binary: FAKE_BINARY.into() }
}

/// The tarball npm would serve for the fake package: a decoy entry, then `package/<binary>` of `len` bytes.
fn fake_tarball(len: usize) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (name, body) in [("package/package.json".to_owned(), vec![b'{', b'}']), (format!("package/{FAKE_BINARY}"), vec![7_u8; len])] {
        let mut header = tar::Header::new_gnu();
        header.set_path(&name).expect("path");
        header.set_size(body.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append(&header, &body[..]).expect("append");
    }
    let tar = builder.into_inner().expect("tar");
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&tar).expect("gzip");
    gzip.finish().expect("gzip end")
}

fn integrity_of(bytes: &[u8]) -> String {
    format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes)))
}

/// Answers every request with `body`; the registry URL and the number of requests served.
fn serve(body: Vec<u8>) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let registry = format!("http://{}", listener.local_addr().expect("address"));
    let hits = Arc::new(AtomicUsize::new(0));
    let counted = hits.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => request.extend_from_slice(&chunk[..read]),
                }
            }
            counted.fetch_add(1, Ordering::SeqCst);
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            drop(stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(&body)));
        }
    });
    (registry, hits)
}

struct Fixture {
    root: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        Fixture { root: tempfile::tempdir().expect("tempdir") }
    }

    fn shared(&self) -> PathBuf {
        self.root.path().join("shared")
    }

    fn session(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    /// An environment with the shared cache, the fake package for this platform and a registry nobody listens on.
    fn environment(&self, registry: &str, package: PlatformPackage) -> Environment {
        Environment {
            cli_override: None,
            disabled: false,
            shared_cache: Some(self.shared()),
            platform: node_platform(),
            registry: registry.to_owned(),
            packages: vec![(node_platform(), package)],
        }
    }

    /// Where the shared cache keeps the fake package's binary.
    fn binary(&self) -> PathBuf {
        self.shared()
            .join("office")
            .join("tools")
            .join("ooxml-validator")
            .join(ooxml_validator_manifest()["version"].as_str().expect("version"))
            .join(node_platform())
            .join(FAKE_BINARY)
    }
}

#[test]
fn the_manifest_lists_the_pinned_packages() {
    let manifest = ooxml_validator_manifest();
    assert_eq!(manifest["version"], "0.3.0");
    assert_eq!(
        manifest["platforms"],
        json!(["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"])
    );
    assert_eq!(manifest["packages"]["win32-x64"]["name"], "@xarsh/ooxml-validator-win32-x64");
    assert_eq!(pinned_packages().len(), 6);
}

fn issue(path: &str, x_path: &str, description: &str, id: &str) -> Value {
    json!({ "path": path, "xPath": x_path, "description": description, "id": id })
}

#[test]
fn office_extensions_and_element_order_are_compatibility_warnings_and_real_errors_stay_errors() {
    let extension = issue("/ppt/charts/chart1.xml", "/c:chartSpace[1]/c:extLst[1]/c:ext[2]", "The element is unexpected.", "Sch_X");
    let namespace = issue(
        "/xl/charts/chart2.xml",
        "/c:chartSpace[1]/c:chart[1]",
        "uses http://schemas.microsoft.com/office/drawing/2014/chartex",
        "Sch_Y",
    );
    let masters = issue(
        "/ppt/presentation.xml",
        "/p:presentation[1]",
        "The element has unexpected child element 'http://schemas.openxmlformats.org/presentationml/2006/main:notesMasterIdLst'.",
        "Sch_UnexpectedElementContent",
    );
    let chart_order = issue(
        "/ppt/charts/chart3.xml",
        "/c:chartSpace[1]/c:chart[1]/c:plotArea[1]/c:barChart[1]",
        "The element has unexpected child element 'http://schemas.openxmlformats.org/drawingml/2006/chart:axId'.",
        "Sch_UnexpectedElementContent",
    );
    let unknown_in_chart = issue(
        "/ppt/charts/chart3.xml",
        "/c:chartSpace[1]",
        "The element has unexpected child element 'urn:custom:bogus'.",
        "Sch_UnexpectedElementContent",
    );
    let body = issue("/word/document.xml", "/w:document[1]", "The attribute is not declared.", "Sch_UndeclaredAttribute");
    let wrong_xpath = issue("/ppt/presentation.xml", "/p:presentation[2]", masters["description"].as_str().expect("text"), "Sch_Z");

    let reported = vec![
        extension.clone(),
        namespace.clone(),
        masters.clone(),
        chart_order.clone(),
        unknown_in_chart.clone(),
        body.clone(),
        wrong_xpath.clone(),
        Value::Null,
        json!("text"),
    ];
    let classified = classify_ooxml_validation_errors(&reported);
    assert_eq!(classified.compatibility_warnings, vec![extension, namespace, masters, chart_order]);
    assert_eq!(classified.errors, vec![unknown_in_chart, body, wrong_xpath, Value::Null, json!("text")]);
}

fn runtime() -> ValidatorRuntime {
    ValidatorRuntime {
        available: true,
        cached: Some(true),
        path: Some(PathBuf::from("validator")),
        version: Some("0.3.0".into()),
        ..Default::default()
    }
}

#[test]
fn output_with_only_compatibility_errors_is_ok_and_keeps_the_raw_verdict() {
    let warning = issue("/ppt/charts/chart1.xml", "/c:chartSpace[1]/c:extLst[1]", "x", "Sch_X");
    let output = json!({ "isValid": false, "errors": [warning] }).to_string();
    let result = parse_validator_output(&format!("  {output}\n"), runtime(), "Microsoft365");
    assert!(result.ok);
    assert_eq!(result.raw_valid, Some(false));
    assert!(result.errors.is_empty());
    assert_eq!(result.compatibility_warnings.as_ref().map(Vec::len), Some(1));
    assert_eq!(result.validation, Some("open-xml-sdk"));
    let object = result.to_json();
    assert_eq!(object["officeVersion"], "Microsoft365");
    assert_eq!(object["omittedErrors"], 0);
    assert_eq!(object["path"], "validator");
}

#[test]
fn the_verdict_is_the_first_of_is_valid_valid_and_ok_and_errors_are_capped() {
    let valid = parse_validator_output(r#"{"valid":true}"#, runtime(), "Office2019");
    assert!(valid.ok && valid.raw_valid == Some(true));
    let from_ok = parse_validator_output(r#"{"isValid":null,"valid":null,"ok":true}"#, runtime(), "Office2019");
    assert!(from_ok.ok);
    let empty = parse_validator_output("", runtime(), "Office2019");
    assert!(!empty.ok && empty.raw_valid == Some(false));

    let errors: Vec<Value> = (0..502).map(|n| issue("/word/document.xml", "/w:document[1]", &format!("e{n}"), "Sch_X")).collect();
    let capped = parse_validator_output(&json!({ "isValid": false, "errors": errors }).to_string(), runtime(), "Office2019");
    assert!(!capped.ok);
    assert_eq!((capped.errors.len(), capped.omitted_errors), (500, Some(2)));
}

#[test]
fn unreadable_output_is_reported_with_the_parser_message() {
    let bad = parse_validator_output("{oops", runtime(), "Microsoft365");
    assert!(!bad.ok);
    let reason = bad.reason.clone().expect("reason");
    assert!(reason.starts_with("Invalid OOXML schema validator output: "), "{reason}");
    let keys: Vec<String> = bad.to_json().as_object().expect("object").keys().cloned().collect();
    assert_eq!(keys, ["available", "cached", "downloaded", "path", "version", "ok", "errors", "reason"], "Node's key order");
    let null = parse_validator_output("null", runtime(), "Microsoft365");
    assert_eq!(
        null.reason.as_deref(),
        Some("Invalid OOXML schema validator output: Cannot read properties of null (reading 'isValid')")
    );
}


/// Runs `job` as a durability-lane job (the inline test backend runs it on this thread).
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    let lanes = mixdog_rt::testing::tokens();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(async { lanes.durability_io.submit(&CancellationToken::new(), job).expect("submit").await.expect("job") })
}
fn ensure(environment: &Environment, data_dir: &Path, download: bool) -> Result<ValidatorRuntime, String> {
    let (environment, data_dir) = (environment.clone(), data_dir.to_owned());
    on_lane(move |lane| {
        let request = Request { download, ..Request::new(&data_dir) };
        ensure_in(lane, &environment, &request).map_err(|error| error.to_string())
    })
}
#[test]
fn isolated_document_sessions_reuse_the_same_cached_validator_without_a_network_request() {
    let fixture = Fixture::new();
    // Nothing listens here: a request would fail the test.
    let environment = fixture.environment("http://127.0.0.1:1", fake_package());
    let (first, second) = (fixture.session("session-a"), fixture.session("session-b"));
    let missing = ensure(&environment, &first, false).expect("lookup");
    assert_eq!(missing.download_required, Some(true));
    assert!(!missing.available);

    let binary = fixture.binary();
    std::fs::create_dir_all(binary.parent().expect("parent")).expect("dir");
    std::fs::write(&binary, vec![0_u8; 1024 * 1024 + 1]).expect("binary");
    for data_dir in [&first, &second] {
        let result = ensure(&environment, data_dir, false).expect("lookup");
        assert!(result.available);
        assert_eq!(result.cached, Some(true));
        assert!(!result.downloaded);
        assert_eq!(result.path.as_deref(), Some(binary.as_path()));
    }

    // Without the shared directory the application cache is its own: nothing there.
    let isolated = Environment { shared_cache: None, ..environment };
    assert_eq!(ensure(&isolated, &first, false).expect("lookup").download_required, Some(true));
}
#[test]
fn a_binary_of_a_megabyte_or_less_is_a_failed_download_not_a_validator() {
    let fixture = Fixture::new();
    let environment = fixture.environment("http://127.0.0.1:1", fake_package());
    let binary = fixture.binary();
    std::fs::create_dir_all(binary.parent().expect("parent")).expect("dir");
    std::fs::write(&binary, vec![0_u8; 1024 * 1024]).expect("binary");
    assert_eq!(ensure(&environment, &fixture.session("a"), false).expect("lookup").download_required, Some(true));
}
#[test]
fn shared_caches_preserve_disabled_validation_and_explicit_validator_paths() {
    let fixture = Fixture::new();
    let mut environment = fixture.environment("http://127.0.0.1:1", fake_package());
    let first = fixture.session("session-a");
    environment.disabled = true;
    assert_eq!(ensure(&environment, &first, true).expect("lookup").disabled, Some(true));

    let custom = fixture.session("custom-validator");
    std::fs::write(&custom, "").expect("custom");
    environment.cli_override = Some(custom.clone());
    let result = ensure(&environment, &first, true).expect("lookup");
    assert_eq!(result.path.as_deref(), Some(custom.as_path()));
    assert_eq!(result.version.as_deref(), Some("override"));

    environment.cli_override = Some(fixture.session("missing-validator"));
    let error = ensure(&environment, &first, true).expect_err("missing override");
    assert!(error.starts_with("ENOENT: no such file or directory, access"), "{error}");
}
#[test]
fn an_unsupported_platform_reports_its_name() {
    let fixture = Fixture::new();
    let environment = Environment { platform: "plan9-mips".into(), ..fixture.environment("http://127.0.0.1:1", fake_package()) };
    let result = ensure(&environment, &fixture.session("a"), true).expect("lookup");
    assert!(!result.available);
    assert_eq!(result.reason.as_deref(), Some("OOXML schema validation is unavailable on plan9-mips."));
}
#[test]
fn a_corrupt_download_fails_integrity_validation_and_leaves_no_executable_or_install_lock() {
    let fixture = Fixture::new();
    let (registry, hits) = serve(b"not the pinned archive".to_vec());
    let package = PlatformPackage { integrity: integrity_of(b"the pinned archive"), ..fake_package() };
    let environment = fixture.environment(&registry, package);
    let first = fixture.session("session-a");
    let error = ensure(&environment, &first, true).expect_err("corrupt archive");
    assert!(error.contains("integrity check failed"), "{error}");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    let left: Vec<_> = std::fs::read_dir(fixture.binary().parent().expect("parent")).expect("dir").collect();
    assert!(left.is_empty(), "{left:?}");
    assert_eq!(ensure(&environment, &first, false).expect("lookup").download_required, Some(true));
}
#[test]
fn a_verified_download_installs_the_binary_once_and_is_cached() {
    let fixture = Fixture::new();
    let tarball = fake_tarball(1024 * 1024 + 5);
    let (registry, hits) = serve(tarball.clone());
    let package = PlatformPackage { integrity: integrity_of(&tarball), ..fake_package() };
    let environment = fixture.environment(&registry, package);
    let first = fixture.session("session-a");
    let installed = ensure(&environment, &first, true).expect("install");
    assert!(installed.available && installed.downloaded);
    assert_eq!(installed.cached, Some(false));
    assert_eq!(installed.bytes, Some(1024 * 1024 + 5));
    assert_eq!(installed.path.as_deref(), Some(fixture.binary().as_path()));
    assert_eq!(std::fs::read(fixture.binary()).expect("binary"), vec![7_u8; 1024 * 1024 + 5]);
    let names: Vec<String> = std::fs::read_dir(fixture.binary().parent().expect("parent"))
        .expect("dir")
        .map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec![FAKE_BINARY.to_owned()], "no temporary file and no lock stays");

    let again = ensure(&environment, &fixture.session("session-b"), true).expect("cached");
    assert_eq!((again.cached, again.downloaded), (Some(true), false));
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}
#[test]
fn an_archive_without_the_binary_names_what_is_missing() {
    let fixture = Fixture::new();
    let tarball = fake_tarball(8);
    let (registry, _) = serve(tarball.clone());
    let package = PlatformPackage { integrity: integrity_of(&tarball), binary: "other-binary".into(), ..fake_package() };
    let environment = fixture.environment(&registry, package);
    let error = ensure(&environment, &fixture.session("a"), true).expect_err("missing entry");
    assert_eq!(error, "OOXML validator archive is missing package/other-binary");
}
#[test]
fn an_aborted_install_is_refused_before_any_request() {
    let fixture = Fixture::new();
    let (registry, hits) = serve(Vec::new());
    let environment = fixture.environment(&registry, fake_package());
    let data_dir = fixture.session("a");
    let result = on_lane(move |lane| {
        let cancel = std::sync::atomic::AtomicBool::new(true);
        let request = Request { cancel: Some(&cancel), ..Request::new(&data_dir) };
        ensure_in(lane, &environment, &request).map_err(|error| error.to_string())
    });
    assert_eq!(result.expect_err("aborted"), "This operation was aborted");
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}
/// Runs the real validator (downloads it into the data directory's cache) on a blank document of each kind. Ignored: it
/// fetches 30 MB and starts the validator.
#[test]
#[ignore = "downloads and runs the real Open XML SDK validator"]
fn live_validator_accepts_blank_documents() {
    use mixdog_office_base::write_note::NoWriteNote;
    use mixdog_ooxml::ooxml_validator::validate_in;
    use mixdog_ooxml::package::{CreateOptions, create_portable_ooxml_document};

    let dir = tempfile::tempdir().expect("tempdir");
    let data_dir = dir.path().join("data");
    for kind in ["docx", "xlsx"] {
        let document = dir.path().join(format!("blank.{kind}"));
        let (data_dir, path) = (data_dir.clone(), document.clone());
        let result = on_lane(move |lane| {
            let options = CreateOptions { file_kind: kind, title: "Live", sheet_name: "" };
            create_portable_ooxml_document(lane, &NoWriteNote, &path, &options).expect("create");
            validate_in(lane, &Environment::from_process(), &path, &Request::new(&data_dir)).map_err(|error| error.to_string())
        })
        .expect("validate");
        assert!(result.ok, "{kind}: {}", result.to_json());
        assert!(result.errors.is_empty(), "{kind}: {:?}", result.errors);
    }
}
