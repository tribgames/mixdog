//! Twin test `validation`: the recording of Node's portable validation
//! (`native/core/fixtures/office-validation/golden.json`, written by `benchmarks/rust-core/recorders/record-office-validation.mjs`)
//! against this crate. `issues` reads each recorded document at each recorded request and compares the JSON text with the one
//! `issuesPortableOoxml` produced, key order included; a deck is reviewed for structure by the quality crate, so the findings
//! that review answered are handed back (after checking the review was handed the snapshot Node handed it); `snapshots` the
//! snapshot dispatcher; `orphans` the package after the sweep of parts no relationship reaches; `pure` the picture description
//! rule. Text widths are measured in the fixture faces of `office-measure` registered on both sides (the Miriam face also as
//! Calibri). The tests ported from `portable-snapshot-text.test.mjs` follow the replay. Re-recording is
//! `twin_live_validation` (ignored: it runs Node).

use std::path::Path;

use base64::Engine;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_ooxml::snapshot::snapshot_portable_ooxml;
use mixdog_ooxml::snapshot_docx::snapshot_docx;
use mixdog_ooxml::snapshot_pptx::snapshot_pptx;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::validation::{issues_portable_ooxml, picture_description_issues, remove_orphan_package_parts};
use mixdog_ooxml::xml::{block_text, paragraph_texts};
use mixdog_ooxml::zipio::Package;
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-validation")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[][..], Vec::as_slice)
}

fn registry(golden: &Value) -> Registry {
    let mut registry = Registry::new();
    let dir = twin::repo_root().join("native/core/fixtures/office-measure");
    for (alias, faces) in golden["faces"].as_object().expect("faces") {
        // The recording was made on Windows, where the canvas set "Calibri" in the system's own face (not the fixture face
        // registered under that name): the same files are registered here.
        if alias == "Calibri" {
            let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("WINDIR")).map(std::path::PathBuf::from).expect("the Windows directory");
            for file in ["calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf"] {
                let path = root.join("Fonts").join(file);
                registry.register_file(&Unlaned, &path, Some(alias)).unwrap_or_else(|error| panic!("the recording used the system Calibri, which is not readable here ({}): {error}", path.display()));
            }
            continue;
        }
        for face in list(faces) {
            let path = dir.join(text(&face["file"]));
            registry.register_file(&Unlaned, &path, Some(alias)).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    registry
}

/// The package the recording names: its text parts as written, its rasters decoded.
fn package_of(entry: &Value) -> Package {
    let mut package = Package::new();
    for (name, content) in entry["parts"].as_object().expect("parts") {
        package.set(name, text(content));
    }
    for (name, data) in entry["media"].as_object().expect("media") {
        package.set(name, base64::engine::general_purpose::STANDARD.decode(text(data)).expect("raster bytes"));
    }
    package
}

/// The first place two texts differ, with what lies around it.
fn first_difference(expected: &str, produced: &str) -> String {
    let at = expected.chars().zip(produced.chars()).position(|(a, b)| a != b).unwrap_or_else(|| expected.chars().count().min(produced.chars().count()));
    let around = |text: &str| text.chars().skip(at.saturating_sub(80)).take(180).collect::<String>();
    format!("at character {at} ({} recorded, {} produced):\n recorded: {}\n produced: {}", expected.chars().count(), produced.chars().count(), around(expected), around(produced))
}

/// What Node's `text()` of the recorder keeps of a call: `{ result: <JSON text> }` or `{ error }` with the work directory named
/// `$DIR` and the separators forward slashes.
fn recorded_text(outcome: Result<Value, String>, work: &str) -> Value {
    match outcome {
        Ok(value) => json!({ "result": serde_json::to_string(&value).expect("the answer as JSON") }),
        Err(error) => json!({ "error": (if work.is_empty() { error } else { error.replace(work, "$DIR") }).replace('\\', "/") }),
    }
}

fn assert_text(what: &str, expected: &Value, produced: &Value) {
    if let Some(error) = expected.get("error") {
        assert_eq!(Some(error), produced.get("error"), "{what}: the error");
        return;
    }
    let (want, got) = (text(&expected["result"]), text(&produced["result"]));
    assert!(produced.get("error").is_none(), "{what} failed: {}", produced["error"]);
    assert!(want == got, "{what} differs from the recording {}", first_difference(want, got));
}

/// Writes every recorded package under its name and format in the work directory.
fn write_packages(golden: &Value, dir: &Path) {
    for (name, entry) in golden["packages"].as_object().expect("packages") {
        let bytes = package_of(entry).generate().expect("a package");
        std::fs::write(dir.join(format!("{name}.{}", text(&entry["format"]))), bytes).expect("a package file");
    }
}

fn issues(golden: &Value, measurer: &TextMeasurer<'_, Unlaned>, dir: &Path, work: &str) {
    let cases = list(&golden["issues"]);
    assert!(cases.len() >= 18, "the recording lost cases: {}", cases.len());
    for case in cases {
        let (name, format) = (text(&case["package"]), text(&case["format"]));
        let path = dir.join(format!("{name}.{format}"));
        let what = format!("issues of \"{name}\" ({format}) at {}", case["options"]);
        // The structure review is a module of the quality crate: it answers what Node's answered for the snapshot it was
        // handed, and the snapshot is checked to be that one.
        let review = |document: &Value| -> Vec<Value> {
            let recorded = &case["structure"];
            assert!(!recorded.is_null(), "{what}: the review ran where the recording has none");
            // The review annotates the deck it is handed in place (a `slot` on a shape, a `role` on a slide: the induction of
            // `annotatePptxSnapshotRoles`), and the recording kept the deck after the review: what the snapshot made is
            // what is compared.
            let mut handed = recorded["document"].clone();
            for slide in handed["slides"].as_array_mut().into_iter().flatten() {
                if let Some(slide) = slide.as_object_mut() {
                    slide.remove("role");
                }
                for shape in slide["shapes"].as_array_mut().into_iter().flatten() {
                    if let Some(shape) = shape.as_object_mut() {
                        shape.remove("slot");
                    }
                }
            }
            twin::assert_matches(&format!("{what}: the deck the structure review was handed"), &handed, document);
            list(&recorded["findings"]).to_vec()
        };
        let outcome = issues_portable_ooxml(&Unlaned, measurer, &review, &path, format, &case["options"]);
        assert_text(&what, &case["output"], &recorded_text(outcome, work));
    }
    let absent = issues_portable_ooxml(&Unlaned, measurer, &|_| Vec::new(), &dir.join("absent.docx"), "docx", &json!({}));
    assert_text("issues of a file that is not there", &golden["absentIssues"], &recorded_text(absent, work));
}

fn snapshots(golden: &Value, measurer: &TextMeasurer<'_, Unlaned>, dir: &Path, work: &str) {
    let cases = list(&golden["snapshots"]);
    assert!(cases.len() >= 10, "the recording lost snapshots: {}", cases.len());
    for case in cases {
        let format = text(&case["format"]);
        let path = match case["package"].as_str() {
            Some(name) => dir.join(format!("{name}.{}", if format == "rtf" { "docx" } else { format })),
            None => dir.join("absent.docx"),
        };
        let options = if case["options"].is_null() { json!({}) } else { case["options"].clone() };
        let what = format!("snapshot of {} as {format} at {}", case["package"], case["options"]);
        assert_text(&what, &case["output"], &recorded_text(snapshot_portable_ooxml(&Unlaned, measurer, &path, format, &options), work));
    }
}

fn orphans(golden: &Value) {
    let cases = list(&golden["orphans"]);
    assert!(cases.len() >= 4, "the recording lost sweeps: {}", cases.len());
    for case in cases {
        let what = format!("the sweep of \"{}\"", text(&case["variant"]));
        let mut package = package_of(case);
        let outcome = remove_orphan_package_parts(&mut package).map(|sweep| {
            let mut answer = serde_json::Map::new();
            answer.insert("removed".to_owned(), json!(sweep.removed));
            if let Some(skipped) = sweep.skipped {
                answer.insert("skipped".to_owned(), json!(skipped));
            }
            Value::Object(answer)
        });
        assert_text(&format!("{what}: the answer"), &case["output"], &recorded_text(outcome, ""));
        let mut names: Vec<String> = package.names().into_iter().filter(|name| !name.ends_with('/')).collect();
        names.sort();
        let recorded: Vec<String> = list(&case["names"]).iter().map(|name| text(name).to_owned()).collect();
        assert_eq!(recorded, names, "{what}: the parts left");
        if !text(&case["types"]).is_empty() {
            let (want, got) = (text(&case["types"]), package.text("[Content_Types].xml"));
            assert!(want == got, "{what}: the content types differ from the recording {}", first_difference(want, &got));
        }
    }
}

fn pure(golden: &Value) {
    let cases = list(&golden["pure"]);
    assert!(cases.len() >= 3, "the recording lost pure cases: {}", cases.len());
    for case in cases {
        assert_eq!(text(&case["fn"]), "pictureDescriptionIssues");
        let produced = recorded_text(Ok(Value::Array(picture_description_issues(&case["args"][0]))), "");
        assert_text("pictureDescriptionIssues", &case["output"], &produced);
    }
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let registry = registry(&golden);
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let dir = tempfile::tempdir().expect("work directory");
    let work = dir.path().to_str().expect("a UTF-8 work directory").to_owned();
    write_packages(&golden, dir.path());
    issues(&golden, &measurer, dir.path(), &work);
    snapshots(&golden, &measurer, dir.path(), &work);
    orphans(&golden);
    pure(&golden);
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_validation -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_validation() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-validation.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}

// ---- the tests of `portable-snapshot-text.test.mjs` ---------------------------------------------------------------------

/// Runs stay together, a line or paragraph break becomes a newline, and a slice that starts or ends inside a paragraph keeps
/// every run.
#[test]
fn block_text_keeps_runs_together_and_turns_line_and_paragraph_breaks_into_newlines() {
    let body = "<p:txBody><a:p><a:r><a:t>Reten</a:t></a:r><a:r><a:rPr b=\"1\"/><a:t>tion</a:t></a:r><a:br/><a:r><a:t>rose</a:t></a:r></a:p>\
        <a:p><a:r><a:t>4주차</a:t></a:r><a:br><a:rPr lang=\"ko-KR\"/></a:br><a:r><a:t>잔존율 &amp; 유지</a:t></a:r></a:p><a:p><a:endParaRPr/></a:p></p:txBody>";
    assert_eq!(block_text(body, "a:t"), "Retention\nrose\n4주차\n잔존율 & 유지");
    assert_eq!(paragraph_texts(body, "a:t"), vec!["Reten", "tion", "rose", "4주차", "잔존율 & 유지"]);
    assert_eq!(block_text("<w:p><w:r><w:t xml:space=\"preserve\">a </w:t></w:r><w:r><w:br/><w:t>b</w:t></w:r></w:p>", "w:t"), "a \nb");
    assert_eq!(block_text("<a:r><a:t>no paragraph</a:t></a:r>", "a:t"), "no paragraph");
    assert_eq!(block_text("", "a:t"), "");
    // A comment range or revision span is a slice: runs outside a complete paragraph are kept, the ends it crosses are marked.
    assert_eq!(block_text("<w:r><w:t>x</w:t></w:r></w:p><w:p><w:r><w:t>y</w:t></w:r>", "w:t"), "x\ny");
    assert_eq!(block_text("<w:del><w:r><w:delText>gone</w:delText><w:br/><w:delText>too</w:delText></w:r></w:del>", "w:delText"), "gone\ntoo");
    assert_eq!(block_text("<w:p><w:pPr/><w:r><w:t>A</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>B</w:t></w:r></w:p><w:p/>", "w:t"), "A\n\nB");
}

/// A soft break inside one paragraph, then a paragraph break, in an authored shape; the notes keep their line break.
#[test]
fn a_portable_snapshot_reads_a_shape_with_its_soft_break_and_paragraph_break_intact() {
    const NS: &str = "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"";
    let rels = |entries: &[(&str, &str, &str)]| {
        let items: String = entries
            .iter()
            .map(|(id, kind, target)| format!("<Relationship Id=\"{id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}\" Target=\"{target}\"/>"))
            .collect();
        format!("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{items}</Relationships>")
    };
    let mut package = Package::new();
    package.set("_rels/.rels", rels(&[("rId1", "officeDocument", "ppt/presentation.xml")]));
    package.set(
        "ppt/presentation.xml",
        format!("<p:presentation {NS}><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId1\"/></p:sldIdLst><p:sldSz cx=\"12192000\" cy=\"6858000\"/></p:presentation>"),
    );
    package.set("ppt/_rels/presentation.xml.rels", rels(&[("rId1", "slide", "slides/slide1.xml")]));
    package.set("ppt/slides/_rels/slide1.xml.rels", rels(&[("rId1", "notesSlide", "../notesSlides/notesSlide1.xml")]));
    package.set(
        "ppt/slides/slide1.xml",
        format!(
            "<p:sld {NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>\
             <p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Text 1\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>\
             <p:spPr><a:xfrm><a:off x=\"914400\" y=\"914400\"/><a:ext cx=\"9144000\" cy=\"1828800\"/></a:xfrm></p:spPr>\
             <p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang=\"ko-KR\" sz=\"2400\"/><a:t>안내형 온보딩이</a:t></a:r><a:br><a:rPr sz=\"2400\"/></a:br>\
             <a:r><a:rPr lang=\"ko-KR\" sz=\"2400\"/><a:t>잔존율을 올린다</a:t></a:r></a:p>\
             <a:p><a:r><a:rPr lang=\"en-US\" sz=\"2400\"/><a:t>Second paragraph</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
        ),
    );
    package.set(
        "ppt/notesSlides/notesSlide1.xml",
        format!(
            "<p:notes {NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Notes\"/><p:cNvSpPr/><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/>\
             <p:txBody><a:bodyPr/><a:p><a:r><a:t>첫 줄</a:t></a:r></a:p><a:p><a:r><a:t>둘째 줄</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>"
        ),
    );
    let registry = Registry::new();
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let snapshot = snapshot_pptx(&package, &json!({}), &measurer).expect("a snapshot");
    let slide = &snapshot["slides"][0];
    let shape = list(&slide["shapes"]).iter().find(|entry| text(&entry["text"]).contains("안내형")).unwrap_or_else(|| panic!("{}", slide["shapes"]));
    assert_eq!(text(&shape["text"]), "안내형 온보딩이\n잔존율을 올린다\nSecond paragraph");
    assert_eq!(text(&slide["notes"]).replace("\r\n", "\n"), "첫 줄\n둘째 줄");
}

/// A portable DOCX snapshot keeps line and paragraph breaks in paragraph and cell text.
#[test]
fn a_portable_docx_snapshot_keeps_line_and_paragraph_breaks_in_paragraph_and_cell_text() {
    let mut package = Package::new();
    package.set(
        "[Content_Types].xml",
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
    );
    package.set(
        "word/document.xml",
        "<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>\
         <w:p><w:r><w:t>4주차</w:t><w:br/><w:t>잔존율</w:t></w:r></w:p>\
         <w:p><w:r><w:t>Second</w:t></w:r></w:p>\
         <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell one</w:t></w:r></w:p><w:p><w:r><w:t>Cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>\
         <w:sectPr/></w:body></w:document>",
    );
    let snapshot = snapshot_docx(&package, &json!({}));
    let (paragraphs, tables) = (&snapshot["paragraphs"], &snapshot["tables"]);
    assert_eq!(text(&paragraphs[0]["text"]), "4주차\n잔존율");
    let runs: Vec<&str> = list(&paragraphs[0]["runs"]).iter().map(|run| text(&run["text"])).collect();
    assert_eq!(runs, vec!["4주차", "잔존율"]);
    assert_eq!(text(&paragraphs[1]["text"]), "Second");
    assert_eq!(text(&tables[0]["rows"][0]["cells"][0]["text"]), "Cell one\nCell two");
}
