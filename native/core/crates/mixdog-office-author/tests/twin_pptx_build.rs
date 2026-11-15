//! Twin test `pptx_build`: the recording of Node's HTML deck builder and runner (`native/core/fixtures/office-pptx-build/
//! golden.json`, written by `benchmarks/rust-core/recorders/record-office-pptx-build.mjs`) against this crate's
//! `pptx_build` and `pptx_html_runner`.
//!
//! Replayed without a browser: `textPlacement` and `coverOffset` (every recorded item and position, numbers within 1e-9);
//! every recorded measure built by `build_pptx_from_measure` and normalised, whose package must have the recorded
//! entries in the recorded order and every XML part equal after canonicalisation (attribute order, white space between
//! tags; the two timestamps of `docProps/core.xml` are the moment of writing; the random identifiers pptxgenjs draws are
//! masked), an embedded workbook part by part, and every picture of the same size with the same pixels within a tolerance
//! (the SVG drawings are rasterised by a different engine than sharp's); a measure Node could not build must be refused
//! with the text it threw; the offline half of every recorded run (the measure Node read from the browser built into
//! the recorded package, and what the run keeps of it: the logs, the text read at each item, the geometry); and the
//! drift read and the comparison images over the recorded synthetic pages.
//!
//! The decks themselves are laid out by a browser, whose fonts and rendering belong to the machine that recorded them:
//! `twin_live_pptx_build` (ignored: it starts a Chromium-family browser and Node) records again and runs Rust against the
//! same installed browser. Without a browser it says so and passes, as Node's tests skip.
//! `html_run_*` are the ports of `pptx-html.slow.test.mjs` and the rebuild half of `pptx-html-reauthor.slow.test.mjs`,
//! ignored for the same reason.

use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_core_api::domain::ext::BrowserHold;
use mixdog_office_author::html_browser::RunError;
use mixdog_office_author::measure_deck::Canvas;
use mixdog_office_author::pptx_build::Pictures;
use mixdog_office_author::pptx_build::build_pptx_from_measure;
use mixdog_office_author::pptx_build::cover_offset;
use mixdog_office_author::pptx_build::text_placement;
use mixdog_office_author::pptx_html_runner::RunOptions;
use mixdog_office_author::pptx_html_runner::html_artifacts;
use mixdog_office_author::pptx_html_runner::html_text_of;
use mixdog_office_author::pptx_html_runner::measure_html_drift;
use mixdog_office_author::pptx_html_runner::normalize_built_deck;
use mixdog_office_author::pptx_html_runner::run_pptx_html_authoring;
use mixdog_office_author::pptx_html_runner::write_html_comparisons;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::WriteNote;
use mixdog_ooxml::zipio::Package;
use mixdog_raster::Image;
use mixdog_raster::svg::SvgFonts;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    twin::load_golden("office-pptx-build")
}

fn array<'a>(value: &'a Value, what: &str) -> &'a [Value] {
    let items = value.as_array().unwrap_or_else(|| panic!("{what} is not an array"));
    assert!(!items.is_empty(), "{what} is empty");
    items
}

fn no_failures(what: &str, total: usize, failures: &[String]) {
    assert!(failures.is_empty(), "{what}: {} of {total} cases differ\n{}", failures.len(), failures.iter().take(4).cloned().collect::<Vec<_>>().join("\n"));
}

// ---- comparisons -------------------------------------------------------------------------------------------------------

/// The XML with the attributes of each tag in name order and the white space between tags gone.
fn canonical(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(open) = rest.find('<') {
        let between = &rest[..open];
        if !between.trim().is_empty() {
            out.push_str(between);
        }
        let tail = &rest[open..];
        let mut quote = None;
        let mut end = tail.len() - 1;
        for (at, ch) in tail.char_indices() {
            match (quote, ch) {
                (None, '"' | '\'') => quote = Some(ch),
                (Some(open_quote), found) if found == open_quote => quote = None,
                (None, '>') => {
                    end = at;
                    break;
                }
                _ => {}
            }
        }
        out.push_str(&canonical_tag(&tail[..=end]));
        rest = &tail[end + 1..];
    }
    if !rest.trim().is_empty() {
        out.push_str(rest);
    }
    out
}

fn canonical_tag(tag: &str) -> String {
    let inner = tag.trim_start_matches('<').trim_end_matches('>');
    let (inner, closing) = match inner.strip_suffix('/') {
        Some(inner) => (inner, "/"),
        None => match inner.strip_suffix('?') {
            Some(inner) => (inner, "?"),
            None => (inner, ""),
        },
    };
    let name_end = inner.find(|ch: char| ch.is_whitespace()).unwrap_or(inner.len());
    let (name, mut attributes_text) = inner.split_at(name_end);
    if name.starts_with('/') || name.starts_with('!') {
        return format!("<{}>", inner.trim());
    }
    let mut attributes = Vec::new();
    loop {
        attributes_text = attributes_text.trim_start();
        let Some(eq) = attributes_text.find('=') else { break };
        let key = attributes_text[..eq].trim();
        let after = attributes_text[eq + 1..].trim_start();
        let Some(quote) = after.chars().next() else { break };
        let Some(close) = after[1..].find(quote) else { break };
        attributes.push((key.to_owned(), after[1..=close].to_owned()));
        attributes_text = &after[close + 2..];
    }
    attributes.sort();
    let attributes: String = attributes.iter().map(|(key, value)| format!(" {key}=\"{value}\"")).collect();
    format!("<{name}{attributes}{closing}>")
}

/// Replaces what sits between `open` and `close` wherever `open` occurs.
fn masked_between(text: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(open) {
        let from = at + open.len();
        let Some(len) = rest[from..].find(close) else { break };
        out.push_str(&rest[..from]);
        out.push_str("masked");
        rest = &rest[from + len..];
    }
    out.push_str(rest);
    out
}

/// A part with what pptxgenjs draws at random (the identifiers of a scatter chart's custom labels) and the moment of
/// writing (the core properties of the deck and of a chart's workbook) masked.
fn masked(text: &str) -> String {
    let text = masked_between(text, "<c16:uniqueId val=\"{", "}\"");
    let text = masked_between(&text, "<a:fld id=\"{", "}\"");
    let text = masked_between(&text, "<dcterms:created xsi:type=\"dcterms:W3CDTF\">", "</dcterms:created>");
    masked_between(&text, "<dcterms:modified xsi:type=\"dcterms:W3CDTF\">", "</dcterms:modified>")
}

fn cut(text: &str, around: usize) -> String {
    let start = text.char_indices().map(|(at, _)| at).rfind(|at| *at <= around.saturating_sub(60)).unwrap_or(0);
    text[start..].chars().take(200).collect()
}

fn compare_xml(case: &str, part: &str, expected: &str, actual: &str, failures: &mut Vec<String>) {
    let (want, got) = (canonical(&masked(expected)), canonical(&masked(actual)));
    if want != got {
        let at = want.chars().zip(got.chars()).take_while(|(left, right)| left == right).count();
        failures.push(format!("{case}: {part} differs at {at}\n  recorded ...{}\n  produced ...{}", cut(&want, at), cut(&got, at)));
    }
}

/// Two pictures of one size whose pixels differ by more than 8 levels in at most 2 % of the places.
fn compare_picture(case: &str, part: &str, expected: &[u8], actual: &[u8], failures: &mut Vec<String>) {
    let (Ok(want), Ok(got)) = (Image::decode(expected), Image::decode(actual)) else {
        failures.push(format!("{case}: {part} is not a picture"));
        return;
    };
    if (want.width(), want.height()) != (got.width(), got.height()) {
        failures.push(format!("{case}: {part} recorded {}x{}, produced {}x{}", want.width(), want.height(), got.width(), got.height()));
        return;
    }
    let far = want.rgba().chunks_exact(4).zip(got.rgba().chunks_exact(4)).filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 8)).count();
    let total = (want.width() * want.height()) as usize;
    if far * 50 > total {
        failures.push(format!("{case}: {part} has {far} of {total} pixels that differ by more than 8 levels"));
    }
}

fn blob<'a>(golden: &'a Value, id: &Value) -> &'a Value {
    &golden["blobs"][id.as_str().expect("blob id")]
}

fn blob_bytes(golden: &Value, id: &Value) -> Vec<u8> {
    STANDARD.decode(blob(golden, id)["base64"].as_str().expect("base64")).expect("base64 bytes")
}

fn compare_workbook(case: &str, part: &str, expected: &[u8], actual: &[u8], failures: &mut Vec<String>) {
    let (Ok(recorded), Ok(produced)) = (Package::load(expected), Package::load(actual)) else {
        failures.push(format!("{case}: {part} is not a workbook"));
        return;
    };
    if recorded.names() != produced.names() {
        failures.push(format!("{case}: {part} entries differ\n  recorded {:?}\n  produced {:?}", recorded.names(), produced.names()));
        return;
    }
    for entry in recorded.entries().into_iter().filter(|entry| !entry.dir) {
        compare_xml(case, &format!("{part} {}", entry.name), &recorded.text(&entry.name), &produced.text(&entry.name), failures);
    }
}

/// The produced package against the recorded parts: the entries in order, then each part by its kind.
fn compare_package(case: &str, golden: &Value, parts: &[Value], package: &Package, failures: &mut Vec<String>) {
    let recorded: Vec<&str> = parts.iter().map(|part| part["name"].as_str().expect("part name")).collect();
    let produced = package.names();
    if recorded != produced.iter().map(String::as_str).collect::<Vec<_>>() {
        failures.push(format!("{case}: entries\n  recorded {recorded:?}\n  produced {produced:?}"));
        return;
    }
    for part in parts {
        let name = part["name"].as_str().expect("part name");
        if part["dir"].as_bool().unwrap_or(false) {
            if !package.entry(name).is_some_and(|entry| entry.dir) {
                failures.push(format!("{case}: {name} is a folder"));
            }
            continue;
        }
        let Some(bytes) = package.file(name) else {
            failures.push(format!("{case}: {name} has no content"));
            continue;
        };
        let body = blob(golden, &part["blob"]);
        match body["text"].as_str() {
            Some(expected) => compare_xml(case, name, expected, &String::from_utf8_lossy(bytes), failures),
            None if name.ends_with(".xlsx") => compare_workbook(case, name, &blob_bytes(golden, &part["blob"]), bytes, failures),
            None if name.ends_with(".png") => compare_picture(case, name, &blob_bytes(golden, &part["blob"]), bytes, failures),
            None => {
                if blob_bytes(golden, &part["blob"]) != bytes {
                    failures.push(format!("{case}: {name} bytes differ"));
                }
            }
        }
    }
}

/// Integers equal exactly and floats within 1e-6, everywhere in the value.
fn close(path: &str, want: &Value, got: &Value, failures: &mut Vec<String>) {
    match (want, got) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap_or(f64::NAN), b.as_f64().unwrap_or(f64::NAN));
            let integer = want.is_i64() || want.is_u64();
            if !(if integer { a == b } else { (a - b).abs() <= 1e-6 }) {
                failures.push(format!("{path}: recorded {a}, produced {b}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => close(&format!("{path}/{key}"), value, other, failures),
                    None => failures.push(format!("{path}/{key}: missing from the output")),
                }
            }
            for key in b.keys().filter(|key| !a.contains_key(*key)) {
                failures.push(format!("{path}/{key}: not in the recording"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                failures.push(format!("{path}: {} items recorded, {} produced", a.len(), b.len()));
                return;
            }
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                close(&format!("{path}/{index}"), x, y, failures);
            }
        }
        _ => {
            if want != got {
                failures.push(format!("{path}: recorded {want}, produced {got}"));
            }
        }
    }
}

// ---- placements -------------------------------------------------------------------------------------------------------

fn every_placement_equals_the_recording() {
    let g = golden();
    let mut failures = Vec::new();
    for case in array(&g["placements"]["text"], "placements") {
        let name = case["name"].as_str().expect("name");
        let placed = text_placement(&case["item"], case["canvasWidth"].as_f64().expect("canvas width")).unwrap_or_else(|error| panic!("{name}: {error}"));
        let produced = json!({
            "x": placed.x,
            "y": placed.y,
            "w": placed.w,
            "h": placed.h,
            "inset": { "l": placed.inset.l, "r": placed.inset.r, "t": placed.inset.t, "b": placed.inset.b },
            "valign": placed.valign,
            "centerAlign": placed.center_align,
            "wrap": placed.wrap,
            "spacing": placed.spacing,
        });
        close_exactly(name, &case["output"], &produced, &mut failures);
    }
    no_failures("text placements", g["placements"]["text"].as_array().map_or(0, Vec::len), &failures);

    let mut failures = Vec::new();
    for case in array(&g["placements"]["cover"], "cover offsets") {
        let produced = cover_offset(case["position"].as_str().unwrap_or(""), case["overflowX"].as_f64().expect("x"), case["overflowY"].as_f64().expect("y"), case["scale"].as_f64().expect("scale"));
        let wanted = (case["output"][0].as_f64().expect("x"), case["output"][1].as_f64().expect("y"));
        if produced != wanted {
            failures.push(format!("{}: recorded {wanted:?}, produced {produced:?}", case["position"]));
        }
    }
    no_failures("cover offsets", g["placements"]["cover"].as_array().map_or(0, Vec::len), &failures);
}

/// The placement's numbers within 1e-9 (the same arithmetic in the same order, so only the last bit may differ).
fn close_exactly(path: &str, want: &Value, got: &Value, failures: &mut Vec<String>) {
    match (want, got) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap_or(f64::NAN), b.as_f64().unwrap_or(f64::NAN));
            if (a - b).abs() > 1e-9 {
                failures.push(format!("{path}: recorded {a}, produced {b}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => close_exactly(&format!("{path}/{key}"), value, other, failures),
                    None => failures.push(format!("{path}/{key}: missing from the output")),
                }
            }
        }
        _ => {
            if want != got {
                failures.push(format!("{path}: recorded {want}, produced {got}"));
            }
        }
    }
}

// ---- builds -----------------------------------------------------------------------------------------------------------

fn canvas_of(measure: &Value) -> Canvas {
    Canvas {
        width: measure["width"].as_u64().expect("width") as u32,
        height: measure["height"].as_u64().expect("height") as u32,
        inch_width: measure["inchWidth"].as_f64().unwrap_or(0.0),
        inch_height: measure["inchHeight"].as_f64().unwrap_or(0.0),
    }
}

/// The measure built and normalised as the run does.
fn built(measure: &Value) -> Result<(Package, usize), String> {
    let slides = measure["slides"].as_array().cloned().unwrap_or_default();
    let bytes = build_pptx_from_measure(canvas_of(measure), &slides, &SvgFonts::none(), &Pictures::new())?;
    let (bytes, removed) = normalize_built_deck(bytes, Path::new("deck.pptx"))?;
    Ok((Package::load(&bytes)?, removed))
}

fn every_build_equals_the_recording() {
    let g = golden();
    let builds = array(&g["builds"], "builds");
    assert!(builds.len() > 12, "the recording has {} builds", builds.len());
    assert!(builds.iter().any(|case| case["thrown"].is_string()), "the recording holds a refusal");
    let mut failures = Vec::new();
    for case in builds {
        let name = case["name"].as_str().expect("name");
        match (case["thrown"].as_str(), built(&case["measure"])) {
            (Some(thrown), Err(error)) => {
                if error != thrown {
                    failures.push(format!("{name}: recorded the error {thrown:?}, produced {error:?}"));
                }
            }
            (None, Ok((package, removed))) => {
                compare_package(name, &g, array(&case["parts"], "parts"), &package, &mut failures);
                if case["normalized"]["removed"].as_u64() != Some(removed as u64) {
                    failures.push(format!("{name}: the normaliser removed {removed} paragraphs, recorded {}", case["normalized"]["removed"]));
                }
            }
            (thrown, produced) => failures.push(format!("{name}: recorded {thrown:?}, produced {}", produced.map_or_else(|error| error, |_| "a deck".to_owned()))),
        }
    }
    no_failures("builds", builds.len(), &failures);
}

// ---- runs, offline ------------------------------------------------------------------------------------------------------

fn logs_of(notes: &Value) -> Value {
    Value::Array(notes.as_array().map_or_else(Vec::new, |notes| notes.iter().map(|text| json!({ "level": "warn", "text": text })).collect()))
}

fn every_run_builds_from_its_recorded_measure() {
    let g = golden();
    let runs = array(&g["runs"], "runs");
    let mut failures = Vec::new();
    let mut built_runs = 0;
    for run in runs {
        let name = run["name"].as_str().expect("name");
        let Some(parts) = run["parts"].as_array() else {
            // The refusals: a page of the wrong size is a failure result, a deck with no pages is an error.
            assert!(run["result"]["ok"] == json!(false) || run["thrown"].is_string(), "{name}: a run with no package is a refusal");
            continue;
        };
        built_runs += 1;
        let measure = &run["measure"];
        let (package, removed) = match built(measure) {
            Ok(built) => built,
            Err(error) => {
                failures.push(format!("{name}: {error}"));
                continue;
            }
        };
        compare_package(name, &g, parts, &package, &mut failures);
        let result = &run["result"];
        if result["normalizedParagraphs"].as_u64() != Some(removed as u64) {
            failures.push(format!("{name}: normalizedParagraphs {removed}, recorded {}", result["normalizedParagraphs"]));
        }
        let slides = measure["slides"].as_array().cloned().unwrap_or_default();
        if result["slideCount"].as_u64() != Some(slides.len() as u64) {
            failures.push(format!("{name}: slideCount {}, recorded {}", slides.len(), result["slideCount"]));
        }
        close(&format!("{name}/htmlText"), &result["htmlText"], &Value::Array(html_text_of(&slides)), &mut failures);
        close(&format!("{name}/logs"), &result["logs"], &logs_of(&measure["notes"]), &mut failures);
        close(&format!("{name}/geometry"), &result["geometry"], &measure["geometry"], &mut failures);
    }
    assert_eq!(built_runs, 2, "the two decks of the suites are in the recording");
    no_failures("runs", runs.len(), &failures);
}

// ---- drift and comparisons ----------------------------------------------------------------------------------------------

fn scratch_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-pptx-build-{tag}-{}", std::process::id()));
    if mixdog_testkit::exists(&dir) {
        mixdog_testkit::remove_dir_all(&dir);
    }
    mixdog_testkit::create_dir_all(&dir);
    dir
}

fn on_runtime<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime").block_on(future)
}

struct Noted(Mutex<Vec<PathBuf>>);

impl WriteNote for Noted {
    fn note_write(&self, path: &Path) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).push(path.to_path_buf());
    }
}

fn every_drift_read_and_comparison_equals_the_recording() {
    let g = golden();
    let drift = &g["drift"];
    let dir = scratch_dir("drift");
    let images = drift["images"].as_object().expect("images");
    let path_of = |name: &str| dir.join(format!("{name}.png"));
    for (name, id) in images {
        mixdog_testkit::write(path_of(name), blob_bytes(&g, id));
    }
    let shots: Vec<Value> = (1..=3).map(|n| json!(path_of(&format!("html-{n}")).display().to_string())).collect();
    let rendered: Vec<Value> = array(&drift["rendered"], "rendered images")
        .iter()
        .map(|entry| {
            let mut entry = entry.clone();
            entry["path"] = entry["path"].as_str().map_or(Value::Null, |name| json!(path_of(name).display().to_string()));
            entry
        })
        .collect();
    let tokens = mixdog_rt::testing::tokens();
    let mut failures = Vec::new();
    on_runtime(async {
        let text = drift["targets"].clone();
        let read = measure_html_drift(tokens, &Value::Array(shots.clone()), &text, &rendered, 3.0).await.expect("the drift read");
        close("drift", &drift["result"], &read, &mut failures);
        let looser = measure_html_drift(tokens, &Value::Array(shots.clone()), &text, &rendered, 12.0).await.expect("the drift read");
        close("drift at 12 px", &drift["looser"], &looser, &mut failures);

        let note = Noted(Mutex::new(Vec::new()));
        let written = scratch_dir("compare");
        let target = written.join("deck.pptx");
        let pairs = write_html_comparisons(tokens, &note, &target, &Value::Array(shots.clone()), &rendered).await.expect("the comparisons");
        let wanted = array(&drift["comparisons"], "comparisons");
        if pairs.len() != wanted.len() {
            failures.push(format!("comparisons: {} recorded, {} written", wanted.len(), pairs.len()));
        }
        for (pair, recorded) in pairs.iter().zip(wanted) {
            let path = PathBuf::from(pair["path"].as_str().expect("path"));
            if pair["page"] != recorded["page"] || path != html_artifacts(&target).compare(pair["page"].as_u64().expect("page") as usize) {
                failures.push(format!("comparison {pair}: not the recorded page or place"));
                continue;
            }
            compare_picture(&format!("comparison {}", recorded["page"]), "png", &blob_bytes(&g, &recorded["png"]), &mixdog_testkit::read(&path), &mut failures);
        }
        let noted = note.0.into_inner().unwrap_or_else(|p| p.into_inner());
        let paths: Vec<PathBuf> = pairs.iter().map(|pair| PathBuf::from(pair["path"].as_str().expect("path"))).collect();
        if noted != paths {
            failures.push(format!("the ledger was told of {noted:?}, the images are {paths:?}"));
        }
        mixdog_testkit::remove_dir_all(&written);
    });
    mixdog_testkit::remove_dir_all(&dir);
    no_failures("drift and comparisons", 1, &failures);
}

#[test]
fn twin_pptx_build() {
    every_placement_equals_the_recording();
    every_build_equals_the_recording();
    every_run_builds_from_its_recorded_measure();
    every_drift_read_and_comparison_equals_the_recording();
}

#[test]
fn the_canonical_form_sorts_attributes_and_drops_the_white_space_between_tags() {
    assert_eq!(canonical("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<a:x b=\"2\"  a=\"1\">\n\t<a:y z='3'/> text </a:x>"), "<?xml encoding=\"UTF-8\" version=\"1.0\"?><a:x a=\"1\" b=\"2\"><a:y z=\"3\"/> text </a:x>");
}

// ---- the browser the live replay runs against ----------------------------------------------------------------------------

/// A Chromium-family browser started for this test, as the extension host starts the render browser.
struct LocalBrowser {
    child: Mutex<Child>,
    endpoint: String,
    profile: PathBuf,
}

impl Drop for LocalBrowser {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).kill();
        let profile = self.profile.clone();
        let _ = std::panic::catch_unwind(move || {
            if mixdog_testkit::exists(&profile) {
                mixdog_testkit::remove_dir_all(&profile);
            }
        });
    }
}

#[async_trait::async_trait]
impl BrowserEndpoint for LocalBrowser {
    async fn lease(&self) -> Result<(String, BrowserHold), String> {
        Ok((self.endpoint.clone(), Box::new(())))
    }
}

fn installed_browser() -> Option<PathBuf> {
    let explicit = std::env::var_os("PUPPETEER_EXECUTABLE_PATH").map(PathBuf::from);
    let program_files = std::env::var_os("PROGRAMFILES").map_or_else(|| PathBuf::from("C:/Program Files"), PathBuf::from);
    let program_files_x86 = std::env::var_os("PROGRAMFILES(X86)").map_or_else(|| PathBuf::from("C:/Program Files (x86)"), PathBuf::from);
    let candidates = [
        program_files.join("Google/Chrome/Application/chrome.exe"),
        program_files_x86.join("Google/Chrome/Application/chrome.exe"),
        program_files.join("Microsoft/Edge/Application/msedge.exe"),
        program_files_x86.join("Microsoft/Edge/Application/msedge.exe"),
        PathBuf::from("/usr/bin/google-chrome"),
        PathBuf::from("/usr/bin/chromium"),
        PathBuf::from("/usr/bin/chromium-browser"),
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
    explicit.into_iter().chain(candidates).find(|path| mixdog_testkit::exists(path))
}

/// Starts the browser with the flags the render browser has and waits (at most 30 seconds) for its DevTools address.
async fn start_browser(program: &Path) -> LocalBrowser {
    let profile = std::env::temp_dir().join(format!("mixdog-pptx-build-browser-{}", std::process::id()));
    if mixdog_testkit::exists(&profile) {
        mixdog_testkit::remove_dir_all(&profile);
    }
    mixdog_testkit::create_dir_all(&profile);
    let flags = [
        "--headless=new".to_string(),
        "--remote-debugging-port=0".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--force-color-profile=srgb".to_string(),
        "--font-render-hinting=none".to_string(),
        "--hide-scrollbars".to_string(),
        "--mute-audio".to_string(),
        format!("--user-data-dir={}", profile.display()),
    ];
    let args: Vec<&std::ffi::OsStr> = flags.iter().map(std::ffi::OsStr::new).collect();
    let child = mixdog_testkit::spawn_piped(program, &args);
    let announced = profile.join("DevToolsActivePort");
    for _ in 0..300 {
        if mixdog_testkit::exists(&announced) {
            let text = mixdog_testkit::read_string(&announced);
            let mut lines = text.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                return LocalBrowser { child: Mutex::new(child), endpoint: format!("ws://127.0.0.1:{port}{path}"), profile };
            }
        }
        mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{} did not announce its DevTools address", program.display());
}

/// What a run answers that does not depend on where it ran: everything but the output, its size, the paths and the time.
fn comparable(result: &Value) -> Value {
    let mut result = result.clone();
    if let Some(map) = result.as_object_mut() {
        for key in ["output", "bytes", "htmlShots", "htmlSource", "elapsedMs"] {
            map.remove(key);
        }
    }
    result
}

fn every_run_equals_the_recording_in_the_browser() {
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the decks are not laid out");
        return;
    };
    let g = golden();
    on_runtime(async {
        let browser = start_browser(&program).await;
        let mut failures = Vec::new();
        for run in array(&g["runs"], "runs") {
            let name = run["name"].as_str().expect("name");
            let dir = scratch_dir("run");
            let target = dir.join("deck.pptx");
            let staged = dir.join("staged.pptx");
            let note = Noted(Mutex::new(Vec::new()));
            let answered = run_pptx_html_authoring(&browser, mixdog_rt::testing::tokens(), &SvgFonts::none(), &note, run["html"].as_str().expect("html"), &staged, RunOptions::new(&target)).await;
            match (run["thrown"].as_str(), answered) {
                (Some(thrown), Err(RunError::Failed(message))) => {
                    if message != thrown {
                        failures.push(format!("{name}: recorded the error {thrown:?}, produced {message:?}"));
                    }
                }
                (None, Ok(result)) => {
                    close(name, &run["result"], &comparable(&result), &mut failures);
                    if result["ok"] == json!(true) {
                        let package = Package::load(&mixdog_testkit::read(&staged)).expect("a package");
                        compare_package(name, &g, array(&run["parts"], "parts"), &package, &mut failures);
                        let source = html_artifacts(&target).source();
                        if mixdog_testkit::read_string(&source) != run["html"].as_str().expect("html") {
                            failures.push(format!("{name}: the kept source is not the HTML"));
                        }
                        let shots = result["htmlShots"].as_array().map_or(0, Vec::len) as u64;
                        if Some(shots) != run["shots"].as_u64() {
                            failures.push(format!("{name}: {shots} page images, recorded {}", run["shots"]));
                        }
                    }
                }
                (thrown, produced) => failures.push(format!("{name}: recorded {thrown:?}, produced {:?}", produced.map(|_| "a result"))),
            }
            mixdog_testkit::remove_dir_all(&dir);
        }
        no_failures("runs in the browser", array(&g["runs"], "runs").len(), &failures);
    });
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_pptx_build -- --ignored`.
#[test]
#[ignore = "re-records through Node and starts the installed browser"]
fn twin_live_pptx_build() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-pptx-build.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_placement_equals_the_recording();
    every_build_equals_the_recording();
    every_run_builds_from_its_recorded_measure();
    every_drift_read_and_comparison_equals_the_recording();
    every_run_equals_the_recording_in_the_browser();
}

/// The HTML deck of `pptx-html.slow.test.mjs` is laid out, built and kept beside the deck; a page that is not 1920x1080
/// is refused with the size it measured.
#[test]
#[ignore = "starts the installed browser"]
fn html_run_writes_an_editable_deck_and_refuses_a_page_of_another_size() {
    every_run_equals_the_recording_in_the_browser();
}

/// The rebuild half of `pptx-html-reauthor.slow.test.mjs`: the HTML kept beside a deck, edited, builds the deck again
/// with the edit (the session half, `batch` and `replacedEdits`, belongs to the author action).
#[test]
#[ignore = "starts the installed browser"]
fn html_run_builds_again_from_the_kept_source_with_its_edit() {
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the deck is not laid out");
        return;
    };
    let g = golden();
    let run = array(&g["runs"], "runs").iter().find(|run| run["name"].as_str().is_some_and(|name| name.contains("reauthor"))).expect("the reauthor deck");
    on_runtime(async {
        let browser = start_browser(&program).await;
        let dir = scratch_dir("reauthor");
        let target = dir.join("deck.pptx");
        let note = Noted(Mutex::new(Vec::new()));
        let tokens = mixdog_rt::testing::tokens();
        let html = run["html"].as_str().expect("html");
        let first = run_pptx_html_authoring(&browser, tokens, &SvgFonts::none(), &note, html, &target, RunOptions::new(&target)).await.expect("a run");
        assert_eq!(first["ok"], json!(true), "{first}");
        let source = html_artifacts(&target).source();
        let edited = mixdog_testkit::read_string(&source).replace("첫 번째 제목", "고친 제목");
        let second = run_pptx_html_authoring(&browser, tokens, &SvgFonts::none(), &note, &edited, &target, RunOptions::new(&target)).await.expect("a run");
        assert_eq!(second["ok"], json!(true), "{second}");
        let package = Package::load(&mixdog_testkit::read(&target)).expect("a package");
        assert!(package.text("ppt/slides/slide1.xml").contains("<a:t>고친 제목</a:t>"));
        mixdog_testkit::remove_dir_all(&dir);
    });
}
