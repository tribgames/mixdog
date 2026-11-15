//! Twin test `measure_deck`: the recording of Node's HTML deck measurement (`native/core/fixtures/office-measure-deck/
//! golden.json`, written by `benchmarks/rust-core/recorders/record-office-measure-deck.mjs`) against this crate.
//!
//! What needs no browser is replayed by `twin_measure_deck`: every icon name and option the recording has gives the
//! recorded markup, SVG or error text, and every recorded photograph of a decoration becomes the recorded nothing,
//! whole picture or trimmed picture (pixels equal, place on the canvas equal).
//!
//! The decks themselves are laid out by a browser, whose fonts and rendering belong to the machine that recorded them:
//! `twin_live_measure_deck` (ignored: it starts a Chromium-family browser and Node) records again and runs Rust against
//! the same installed browser, and holds the measure to the recording (integers exactly, floats within 1e-6, screenshot
//! sizes exactly and their pixels within a tolerance). Without a browser it says so and passes, as Node's tests skip.
//! `geometry_reads_*` is the port of `pptx-html-geometry.slow.test.mjs`, ignored for the same reason.

use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_core_api::domain::ext::BrowserHold;
use mixdog_office_author::html_browser::AuthorLanes;
use mixdog_office_author::html_browser::RunError;
use mixdog_office_author::icons::SvgOptions;
use mixdog_office_author::icons::icons;
use mixdog_office_author::measure_deck::Canvas;
use mixdog_office_author::measure_deck::HTML_CANVAS;
use mixdog_office_author::measure_deck::MeasureOptions;
use mixdog_office_author::measure_deck::Measured;
use mixdog_office_author::measure_deck::measure_html_deck;
use mixdog_office_author::measure_deck::paint_of_photograph;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::WriteNote;
use mixdog_raster::Image;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    twin::load_golden("office-measure-deck")
}

fn array<'a>(value: &'a Value, what: &str) -> &'a [Value] {
    let items = value.as_array().unwrap_or_else(|| panic!("{what} is not an array"));
    assert!(!items.is_empty(), "{what} is empty");
    items
}

fn no_failures(what: &str, total: usize, failures: &[String]) {
    assert!(failures.is_empty(), "{what}: {} of {total} cases differ\n{}", failures.len(), failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n"));
}

/// The answer of a case that either gave `output` or threw `error`.
fn answered(case: &Value) -> Result<&str, &str> {
    match (case["output"].as_str(), case["error"].as_str()) {
        (Some(output), _) => Ok(output),
        (None, Some(error)) => Err(error),
        (None, None) => panic!("a case with neither an output nor an error: {case}"),
    }
}

fn every_icon_equals_the_recording() {
    let g = golden();
    let recorded = &g["icons"];
    let set = icons();
    assert_eq!(recorded["count"].as_u64(), Some(set.names().len() as u64));
    assert_eq!(recorded["source"].as_str(), Some(set.source().as_str()));
    assert_eq!(recorded["viewBox"].as_str(), Some(set.view_box()));
    let names: Vec<&str> = array(&recorded["names"], "icon names").iter().map(|name| name.as_str().expect("a name")).collect();
    assert_eq!(names, set.names());

    let mut failures = Vec::new();
    for case in array(&recorded["markup"], "markup cases") {
        let input = case["input"].as_str().expect("input");
        let produced = set.markup(input).map(str::to_string);
        let wanted = answered(case).map(str::to_string).map_err(str::to_string);
        if produced != wanted {
            failures.push(format!("markup {input:?}\n  recorded {wanted:?}\n  produced {produced:?}"));
        }
    }
    no_failures("markup", recorded["markup"].as_array().map_or(0, Vec::len), &failures);

    let mut failures = Vec::new();
    for case in array(&recorded["svg"], "svg cases") {
        let name = case["input"]["name"].as_str().expect("name");
        let mut options = SvgOptions::default();
        let given = &case["input"]["options"];
        if let Some(color) = given["color"].as_str() {
            options.color = color.to_string();
        }
        if let Some(size) = given["size"].as_f64() {
            options.size = size;
        }
        if let Some(width) = given["strokeWidth"].as_f64() {
            options.stroke_width = width;
        }
        let produced = set.svg(name, &options);
        let wanted = answered(case).map(str::to_string).map_err(str::to_string);
        if produced != wanted {
            failures.push(format!("svg {} \n  recorded {wanted:?}\n  produced {produced:?}", case["input"]));
        }
    }
    no_failures("svg", recorded["svg"].as_array().map_or(0, Vec::len), &failures);
}

fn every_photograph_equals_the_recording() {
    let g = golden();
    let mut failures = Vec::new();
    for case in array(&g["photographs"], "photographs") {
        let name = case["name"].as_str().expect("name");
        let canvas = Canvas {
            width: case["canvas"]["width"].as_u64().expect("width") as u32,
            height: case["canvas"]["height"].as_u64().expect("height") as u32,
            inch_width: 1.0,
            inch_height: 1.0,
        };
        let png = STANDARD.decode(case["png"].as_str().expect("png")).expect("base64");
        let produced = paint_of_photograph(&png, canvas).unwrap_or_else(|error| panic!("{name}: {error}"));
        let wanted = &case["output"];
        match (wanted["kind"].as_str().expect("kind"), produced) {
            ("none", None) => {}
            ("whole", Some(paint)) => {
                if paint.draw != wanted["draw"] || STANDARD.decode(&paint.png).expect("base64") != png {
                    failures.push(format!("{name}: the whole picture came back as {}", paint.draw));
                }
            }
            ("trimmed", Some(paint)) => {
                let picture = Image::decode(&STANDARD.decode(&paint.png).expect("base64")).expect("a PNG");
                let rgba = STANDARD.encode(picture.rgba());
                let same_size = Some(u64::from(picture.width())) == wanted["width"].as_u64() && Some(u64::from(picture.height())) == wanted["height"].as_u64();
                if paint.draw != wanted["draw"] || !same_size || Some(rgba.as_str()) != wanted["rgba"].as_str() {
                    failures.push(format!("{name}: recorded {} {}x{}, produced {} {}x{}", wanted["draw"], wanted["width"], wanted["height"], paint.draw, picture.width(), picture.height()));
                }
            }
            (kind, produced) => failures.push(format!("{name}: recorded {kind}, produced {}", produced.map_or("nothing", |_| "a picture"))),
        }
    }
    no_failures("photographs", g["photographs"].as_array().map_or(0, Vec::len), &failures);
}

#[test]
fn twin_measure_deck() {
    every_icon_equals_the_recording();
    every_photograph_equals_the_recording();
    let g = golden();
    let decks = array(&g["decks"], "decks");
    // A recording that holds the decks the plan names, and the three refusals.
    assert!(decks.iter().any(|deck| deck["name"].as_str().is_some_and(|name| name.starts_with("geometry deck"))));
    assert_eq!(decks.iter().filter(|deck| deck["error"].is_string()).count(), 3);
}

// ---- the browser the live replay runs against ------------------------------------------------------------------------

/// A Chromium-family browser started for this test, as the extension host starts the render browser.
struct LocalBrowser {
    child: Mutex<Child>,
    endpoint: String,
    profile: PathBuf,
}

impl Drop for LocalBrowser {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).kill();
        clear_quietly(&self.profile);
    }
}

#[async_trait::async_trait]
impl BrowserEndpoint for LocalBrowser {
    async fn lease(&self) -> Result<(String, BrowserHold), String> {
        Ok((self.endpoint.clone(), Box::new(())))
    }
}

fn clear(path: &Path) {
    if mixdog_testkit::exists(path) {
        mixdog_testkit::remove_dir_all(path);
    }
}

/// [`clear`] for a folder a just-killed browser may still hold open: it is left behind when it cannot be removed.
fn clear_quietly(path: &Path) {
    let path = path.to_path_buf();
    let _ = std::panic::catch_unwind(move || clear(&path));
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
    let profile = std::env::temp_dir().join(format!("mixdog-measure-twin-{}", std::process::id()));
    clear(&profile);
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

struct Noted(Mutex<Vec<PathBuf>>);

impl WriteNote for Noted {
    fn note_write(&self, path: &Path) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).push(path.to_path_buf());
    }
}

/// The recorded summary of a screenshot: its size and the mean of each 40 px block, from the PNG's pixels.
fn summary(path: &Path) -> Value {
    let image = Image::decode(&mixdog_testkit::read(path)).expect("a PNG screenshot");
    let (width, height) = (image.width() as usize, image.height() as usize);
    let block = 40;
    let mut blocks = Vec::new();
    for by in (0..height).step_by(block) {
        for bx in (0..width).step_by(block) {
            let mut sum = [0u64; 4];
            let mut n = 0u64;
            for y in by..(by + block).min(height) {
                for x in bx..(bx + block).min(width) {
                    let at = (y * width + x) * 4;
                    for (channel, total) in sum.iter_mut().enumerate() {
                        *total += u64::from(image.rgba()[at + channel]);
                    }
                    n += 1;
                }
            }
            blocks.push(Value::Array(sum.iter().map(|total| json!((*total as f64 / n as f64).round() as u64)).collect()));
        }
    }
    json!({ "width": width, "height": height, "block": block, "blocks": blocks })
}

/// Integers equal exactly, floats within 1e-6, a picture within two levels per channel, and a screenshot's size exactly with
/// its blocks within three levels.
fn close(path: &str, want: &Value, got: &Value, failures: &mut Vec<String>) {
    match (want, got) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap_or(f64::NAN), b.as_f64().unwrap_or(f64::NAN));
            let integer = want.is_i64() || want.is_u64();
            let ok = if integer { a == b } else { (a - b).abs() <= 1e-6 };
            if !ok {
                failures.push(format!("{path}: recorded {a}, produced {b}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            if a.contains_key("blocks") && a.contains_key("block") {
                close_shot(path, want, got, failures);
                return;
            }
            for (key, value) in a {
                match b.get(key) {
                    Some(other) if key == "png" => close_picture(&format!("{path}/{key}"), value, other, failures),
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

fn close_picture(path: &str, want: &Value, got: &Value, failures: &mut Vec<String>) {
    let decode = |value: &Value| Image::decode(&STANDARD.decode(value.as_str().unwrap_or_default()).expect("base64")).expect("a PNG");
    let (a, b) = (decode(want), decode(got));
    if (a.width(), a.height()) != (b.width(), b.height()) {
        failures.push(format!("{path}: recorded {}x{}, produced {}x{}", a.width(), a.height(), b.width(), b.height()));
    } else if a.rgba().iter().zip(b.rgba()).any(|(x, y)| x.abs_diff(*y) > 2) {
        failures.push(format!("{path}: the pixels differ by more than 2 levels"));
    }
}

fn close_shot(path: &str, want: &Value, got: &Value, failures: &mut Vec<String>) {
    if want["width"] != got["width"] || want["height"] != got["height"] {
        failures.push(format!("{path}: recorded {}x{}, produced {}x{}", want["width"], want["height"], got["width"], got["height"]));
        return;
    }
    let (a, b) = (want["blocks"].as_array().expect("blocks"), got["blocks"].as_array().expect("blocks"));
    let off = a.iter().zip(b).filter(|(x, y)| x.as_array().into_iter().flatten().zip(y.as_array().into_iter().flatten()).any(|(p, q)| p.as_i64().unwrap_or(0).abs_diff(q.as_i64().unwrap_or(0)) > 3)).count();
    if a.len() != b.len() || off > 0 {
        failures.push(format!("{path}: {off} of {} blocks differ by more than 3 levels", a.len()));
    }
}

fn canvas_of(recorded: &Value) -> Canvas {
    Canvas {
        width: recorded["width"].as_u64().expect("width") as u32,
        height: recorded["height"].as_u64().expect("height") as u32,
        inch_width: recorded["inchWidth"].as_f64().expect("inchWidth"),
        inch_height: recorded["inchHeight"].as_f64().expect("inchHeight"),
    }
}

/// The measure as the recording writes it: the canvas fields, the slides, the notes, the geometry and a summary of each shot.
fn recorded_shape(measured: &Measured) -> Value {
    json!({
        "width": measured.canvas.width,
        "height": measured.canvas.height,
        "inchWidth": measured.canvas.inch_width,
        "inchHeight": measured.canvas.inch_height,
        "slides": measured.slides,
        "shots": measured.shots.iter().map(|shot| summary(shot)).collect::<Vec<_>>(),
        "notes": measured.notes,
        "geometry": measured.geometry,
    })
}

async fn measure(browser: &LocalBrowser, scratch: &Path, html: &str, canvas: Option<Canvas>) -> Result<(Measured, Vec<PathBuf>), RunError> {
    let lanes = AuthorLanes::new(mixdog_rt::testing::tokens());
    let note = Noted(Mutex::new(Vec::new()));
    let source = scratch.join("deck.html");
    let shots = |page: usize| scratch.join(format!("page-{page}.png"));
    let mut options = MeasureOptions::new(&source, &shots);
    if let Some(canvas) = canvas {
        options.prepare = Some(Box::new(move |_page| Box::pin(async move { Ok(canvas) })));
    }
    let measured = measure_html_deck(browser, &lanes, &note, html, options).await?;
    let noted = note.0.into_inner().unwrap_or_else(|p| p.into_inner());
    Ok((measured, noted))
}

fn on_runtime<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime").block_on(future)
}

fn scratch_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-measure-{tag}-{}", std::process::id()));
    clear(&dir);
    mixdog_testkit::create_dir_all(&dir);
    dir
}

fn every_deck_equals_the_recording() {
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the decks are not laid out");
        return;
    };
    let g = golden();
    on_runtime(async {
        let browser = start_browser(&program).await;
        let mut failures = Vec::new();
        for deck in array(&g["decks"], "decks") {
            let name = deck["name"].as_str().expect("name");
            let scratch = scratch_dir("deck");
            let canvas = deck["canvas"].as_object().map(|_| canvas_of(&deck["canvas"]));
            let produced = measure(&browser, &scratch, deck["html"].as_str().expect("html"), canvas).await;
            match (deck["error"].as_str(), produced) {
                (Some(error), Err(RunError::Failed(message))) => {
                    if message != error {
                        failures.push(format!("{name}: recorded the error {error:?}, produced {message:?}"));
                    }
                }
                (None, Ok((measured, noted))) => {
                    close(name, &deck["output"], &recorded_shape(&measured), &mut failures);
                    if noted != measured.shots {
                        failures.push(format!("{name}: the ledger was told of {noted:?}, the shots are {:?}", measured.shots));
                    }
                }
                (error, produced) => failures.push(format!("{name}: recorded {error:?}, produced {:?}", produced.map(|_| "a measure"))),
            }
            clear(&scratch);
        }
        no_failures("decks", array(&g["decks"], "decks").len(), &failures);
    });
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_measure_deck -- --ignored`.
#[test]
#[ignore = "re-records through Node and starts the installed browser"]
fn twin_live_measure_deck() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-measure-deck.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_icon_equals_the_recording();
    every_photograph_equals_the_recording();
    every_deck_equals_the_recording();
}

/// The geometry read refuses the misses a page makes and passes the relations that hold
/// (`pptx-html-geometry.slow.test.mjs`).
#[test]
#[ignore = "starts the installed browser"]
fn geometry_reads_refuse_the_misses_a_page_makes_and_pass_the_relations_that_hold() {
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the geometry deck is not laid out");
        return;
    };
    let g = golden();
    let deck = array(&g["decks"], "decks").iter().find(|deck| deck["name"].as_str().is_some_and(|name| name.starts_with("geometry deck"))).expect("the geometry deck");
    on_runtime(async {
        let browser = start_browser(&program).await;
        let scratch = scratch_dir("geometry");
        let (measured, _) = measure(&browser, &scratch, deck["html"].as_str().expect("html"), None).await.expect("the geometry deck is measured");
        assert_eq!(measured.canvas, HTML_CANVAS);
        let page = |n: u64| -> Vec<Value> {
            measured.geometry.iter().find(|entry| entry["slide"].as_u64() == Some(n)).and_then(|entry| entry["findings"].as_array().cloned()).unwrap_or_default()
        };
        let checks = |n: u64| -> Vec<String> {
            let mut checks: Vec<String> = page(n).iter().map(|finding| finding["check"].as_str().expect("check").to_string()).collect();
            checks.sort();
            checks
        };
        let off = |n: u64, check: &str| page(n).iter().find(|finding| finding["check"] == check).and_then(|finding| finding["off"].as_f64());

        // An arrow under the midline of staggered cards, and a block 22 px out of the column above it.
        assert_eq!(checks(1), ["connector", "near_miss"]);
        assert_eq!(off(1, "connector"), Some(100.0));
        assert_eq!(off(1, "near_miss"), Some(22.0));
        // A circle declared inside another, and the same circle undeclared, both reach 17 px past the edge.
        assert_eq!(checks(2), ["inside"]);
        assert!((off(2, "inside").expect("inside") - 17.3).abs() < 0.2, "{:?}", page(2));
        assert_eq!(checks(3), ["containment"]);
        // A dot set on a clipped band with no relation, and a dot declared on a line but 20 px below it, and a caption
        // whose lower half runs onto the drawn line.
        assert_eq!(checks(4), ["marker", "on", "text_on_drawing"]);
        assert!((off(4, "on").expect("on") - 20.0).abs() < 0.5, "{:?}", page(4));
        // The same page with every related position computed: nothing to report.
        assert!(page(5).is_empty(), "{:?}", page(5));
        // Words clear of a band by less than 8 px, though they touch none of it.
        assert_eq!(checks(6), ["text_on_drawing"]);
        clear(&scratch);
    });
}
