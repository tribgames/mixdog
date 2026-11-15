//! Twin test `glyphs`: the glyph paths pdf.js draws in Node (`native/core/fixtures/office-glyphs/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-glyphs.mjs`) replayed over the Rust renderer. For every font the
//! recording holds the program pdf.js drew from (the sanitised OpenType file: glyf outlines for the Liberation Sans
//! substitutes, a CFF table for the Foxit substitutes) and the path of every glyph it sent; every coordinate
//! must equal pdf.js's within 1e-6.
//!
//! The Foxit fonts (bare CFF files) are replayed twice: from the recorded OpenType file, and from the original file in
//! `assets/standard_fonts` with the recorded file's `cmap` (the glyph ids agree: both number glyphs in the font's
//! order). Re-recording is running the recorder against a Node product tree (`MIXDOG_BENCH_TREE`), which
//! `twin_live_glyphs` does.

use std::path::{Path, PathBuf};

use mixdog_fsio::{read, read_to_string, Unlaned};
use mixdog_pdf::glyph::truetype::read_sfnt;
use mixdog_pdf::glyph::type2::parse_cff;
use mixdog_pdf::glyph::FontRenderer;
use serde_json::Value;

const GOLDEN: &str = include_str!("../../../fixtures/office-glyphs/golden.json");
const TOLERANCE: f64 = 1e-6;

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden.json parses")
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/office-glyphs")
}

fn font_matrix(font: &Value) -> Option<[f64; 6]> {
    let words = font["fontMatrix"].as_array()?;
    let mut matrix = [0.0; 6];
    for (slot, word) in matrix.iter_mut().zip(words) {
        *slot = word.as_f64()?;
    }
    Some(matrix)
}

fn assert_path(font: &str, character: &str, got: &[f32], want: &[Value]) {
    assert_eq!(
        got.len(),
        want.len(),
        "{font}: path of {character:?} has {} words, pdf.js sent {}",
        got.len(),
        want.len()
    );
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        let w = w.as_f64().expect("path word is a number");
        assert!(
            (f64::from(*g) - w).abs() <= TOLERANCE,
            "{font}: path of {character:?} differs at word {i}: {g} against {w}"
        );
    }
}

fn replay_cases(name: &str, renderer: &mut FontRenderer, font: &Value) {
    let cases = font["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "{name}: no glyphs recorded");
    for case in cases {
        let character = case["char"].as_str().expect("char");
        let code = case["code"].as_u64().expect("code") as u32;
        let path = renderer
            .get_path(code)
            .unwrap_or_else(|e| panic!("{name}: glyph {character:?} fails: {e}"))
            .unwrap_or_else(|| panic!("{name}: glyph {character:?} was already handed out"));
        assert_path(
            name,
            character,
            &path,
            case["path"].as_array().expect("path"),
        );
    }
}

fn replay(golden: &Value, dir: &Path) {
    for font in golden["fonts"].as_array().expect("fonts") {
        let name = font["name"].as_str().expect("name");
        let bytes =
            read(&Unlaned, dir.join(font["file"].as_str().expect("file"))).expect("font file");
        let mut renderer = FontRenderer::create(&bytes, font_matrix(font))
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        replay_cases(name, &mut renderer, font);

        // The Foxit standard fonts are bare CFF files: read from the original file (not the recompiled table of the
        // recording) with the recording's cmap, the glyphs must come out the same.
        let standard = font["standardFile"].as_str().expect("standardFile");
        if standard.ends_with(".pfb") {
            let original = read(
                &Unlaned,
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("assets/standard_fonts")
                    .join(standard),
            )
            .expect("standard font");
            let cmap = read_sfnt(&bytes).expect("sfnt").cmap.expect("cmap");
            let program = parse_cff(&original, true).unwrap_or_else(|e| panic!("{name}: {e}"));
            let mut from_original = FontRenderer::from_type2(program, cmap, font_matrix(font));
            replay_cases(&format!("{name} (original file)"), &mut from_original, font);
        }
    }
}

#[test]
fn twin_glyphs() {
    replay(&golden(), &fixtures_dir());
}

/// Records again with Node and compares: `MIXDOG_BENCH_TREE=<product tree> cargo test -p mixdog-pdf --test
/// twin_glyphs -- --ignored`.
#[test]
#[ignore = "re-records through Node (pdfjs-dist from MIXDOG_BENCH_TREE)"]
fn twin_live_glyphs() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let status = std::process::Command::new("node")
        .arg(root.join("benchmarks/rust-core/recorders/record-office-glyphs.mjs"))
        .status()
        .expect("run node");
    assert!(status.success(), "the recorder failed");
    let dir = fixtures_dir();
    let recorded = read_to_string(&Unlaned, dir.join("golden.json")).expect("golden.json");
    replay(
        &serde_json::from_str(&recorded).expect("golden.json parses"),
        &dir,
    );
}
