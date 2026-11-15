//! Twin test `colour`: pdf.js 6.4's colour conversion (the recording `native/core/fixtures/office-colour/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-colour.mjs`) against `mixdog_pdf::color`, `function` and
//! `function_ps`. Each case is a generated PDF holding one colour space (and the functions of its tint transform) and a
//! grid of sample colours with the `#rrggbb` pdf.js's `ColorSpace.getRgbHex` gave; this test parses the colour space
//! out of the same bytes and requires every colour to be equal. A colour space pdf.js cannot build (it keeps DeviceGray)
//! must fail to parse here. Re-recording is `twin_live_colour` (ignored: it runs Node). The recording is read with the
//! office twin helpers (`mixdog_office_base::twin`; serde_json reads numbers correctly rounded, as `JSON.parse` does).

use std::sync::Arc;

use mixdog_office_base::twin;
use mixdog_pdf::color::{self, ColorSpace};
use mixdog_pdf::{Dict, FilterResult, Guard, Obj, Ref, StreamFilters, Xref, XrefOptions};
use serde_json::Value;

const SET: &str = "office-colour";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-colour.mjs";

fn golden() -> Value {
    twin::load_golden(SET)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is not a string"))
}

fn number(value: &Value) -> f64 {
    value
        .as_f64()
        .unwrap_or_else(|| panic!("{value} is not a number"))
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is not an array"))
}

// ---- the replay -----------------------------------------------------------------------------------------------------

/// The generated PDFs have no filtered stream.
struct NoFilters;

impl StreamFilters for NoFilters {
    fn decode(
        &self,
        _name: &str,
        _data: &[u8],
        _params: Option<&Dict>,
        _length: Option<usize>,
        _max_output: usize,
    ) -> FilterResult {
        Ok(None)
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect()
}

fn open(pdf: &str) -> Xref {
    let options = XrefOptions {
        filters: Arc::new(NoFilters),
        decryptor: None,
        guard: Guard::unbounded(),
    };
    Xref::open(Arc::from(unhex(pdf)), options).expect("the generated PDF opens")
}

/// The page's resources of every generated PDF: `/ColorSpace << /CS0 colour_object 0 R >>`.
fn resources(colour_object: i64) -> Dict {
    let mut spaces = Dict::new();
    spaces.set("CS0", Obj::Ref(Ref::new(colour_object, 0)));
    let mut resources = Dict::new();
    resources.set("ColorSpace", Obj::Dict(Arc::new(spaces)));
    resources
}

fn operand_object(operand: &str) -> Obj {
    Obj::name(operand.strip_prefix('/').expect("a name operand"))
}

fn parse_case(
    case: &Value,
    colour_object: i64,
) -> (Xref, Result<Arc<ColorSpace>, mixdog_pdf::PdfError>) {
    let xref = open(text(case, "pdf"));
    let resources = resources(colour_object);
    let parsed = color::parse(
        &operand_object(text(case, "operand")),
        &xref,
        Some(&resources),
    );
    (xref, parsed)
}

#[test]
fn colour_conversion_equals_pdfjs_on_every_recorded_colour() {
    let golden = golden();
    let colour_object = number(&golden["csObject"]) as i64;
    let cases = list(&golden, "cases");
    assert!(cases.len() > 100, "the recording is complete");
    let mut colours = 0usize;
    let mut mismatches = Vec::new();
    for case in cases {
        let name = text(case, "name");
        let (_xref, parsed) = parse_case(case, colour_object);
        let space = parsed
            .unwrap_or_else(|error| panic!("{name}: the colour space does not parse: {error:?}"));
        let comps = number(&case["comps"]) as usize;
        let rows = list(case, "samples");
        let expected = list(case, "rgb");
        assert_eq!(rows.len(), expected.len(), "{name}");
        for (row, want) in rows.iter().zip(expected) {
            let values: Vec<f64> = row
                .as_array()
                .expect("a sample row")
                .iter()
                .map(number)
                .collect();
            assert_eq!(values.len(), comps, "{name}: sample width");
            let got = space
                .get_rgb_hex(&values, 0)
                .unwrap_or_else(|error| panic!("{name} {values:?}: {error:?}"));
            colours += 1;
            let want = want.as_str().expect("a recorded colour");
            if got != want {
                mismatches.push(format!("{name} {values:?}: pdf.js {want} rust {got}"));
            }
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} of {colours} colours differ; first: {:?}",
        mismatches.len(),
        &mismatches[..mismatches.len().min(8)]
    );
    assert!(colours > 10_000, "{colours} colours replayed");
}

#[test]
fn colour_spaces_pdfjs_cannot_build_do_not_parse() {
    let golden = golden();
    let colour_object = number(&golden["csObject"]) as i64;
    let failing = list(&golden, "failing");
    assert!(failing.len() >= 8);
    for case in failing {
        assert_eq!(text(case, "fallback"), "gray");
        let (_xref, parsed) = parse_case(case, colour_object);
        assert!(parsed.is_err(), "{}: parsed", text(case, "name"));
    }
}

#[test]
fn icc_based_goes_without_qcms_as_pdfjs_does() {
    let golden = golden();
    // pdf.js in this configuration builds no ICC transform (no wasmUrl): the alternate or the device space is used.
    assert_eq!(golden["icc"]["qcmsLoads"].as_bool(), Some(false));
    let colour_object = number(&golden["csObject"]) as i64;
    let icc: Vec<&Value> = list(&golden, "cases")
        .iter()
        .filter(|case| text(case, "group") == "icc")
        .collect();
    assert!(icc.len() >= 9);
    // the real CMYK profile reads as DeviceCMYK
    let profile = icc
        .iter()
        .find(|case| text(case, "name") == "ICC real CMYK profile")
        .expect("the profile case");
    let (_xref, parsed) = parse_case(profile, colour_object);
    assert_eq!(parsed.expect("parses").name(), "DeviceCMYK");
}

#[test]
fn colour_spaces_are_named_and_counted_as_pdfjs_names_them() {
    let golden = golden();
    let colour_object = number(&golden["csObject"]) as i64;
    for case in list(&golden, "cases") {
        let name = text(case, "name");
        let (_xref, parsed) = parse_case(case, colour_object);
        let space = parsed.expect("parses");
        let group = text(case, "group");
        let comps = number(&case["comps"]) as usize;
        match group {
            "device" | "cal" | "lab" | "devicen" | "tint" | "postscript" => {
                assert_eq!(space.num_comps(), comps, "{name}");
            }
            "indexed" => assert_eq!((space.name(), space.num_comps()), ("Indexed", 1), "{name}"),
            _ => {}
        }
        if group == "tint" || group == "devicen" || group == "postscript" {
            assert_eq!(space.name(), "Alternate", "{name}");
        }
    }
}

/// Re-records with Node and compares: runs `node` on this machine (the tree named by `MIXDOG_NODE_TREE`, else this
/// checkout), so it is ignored by default.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_colour() {
    let path = twin::repo_root()
        .join("native/core/fixtures")
        .join(SET)
        .join("golden.json");
    let before = mixdog_testkit::read(&path);
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(
        printed.contains("golden.json"),
        "the recorder wrote nothing: {printed}"
    );
    let after = mixdog_testkit::read(&path);
    assert!(before == after, "the recording differs from a new one");
}
