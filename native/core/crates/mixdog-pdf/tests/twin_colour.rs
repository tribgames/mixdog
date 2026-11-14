//! Twin test `colour`: pdf.js 6.4's colour conversion (the recording `native/core/fixtures/office-colour/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-colour.mjs`) against `mixdog_pdf::color`, `function` and
//! `function_ps`. Each case is a generated PDF holding one colour space (and the functions of its tint transform) and a
//! grid of sample colours with the `#rrggbb` pdf.js's `ColorSpace.getRgbHex` gave; this test parses the colour space
//! out of the same bytes and requires every colour to be equal. A colour space pdf.js cannot build (it keeps DeviceGray)
//! must fail to parse here. Re-recording is `twin_live_colour` (ignored: it runs Node).

use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_pdf::color::{self, ColorSpace};
use mixdog_pdf::{Dict, FilterResult, Guard, Obj, Ref, StreamFilters, Xref, XrefOptions};

// ---- a JSON reader for the recording (numbers are read correctly rounded, as `JSON.parse` reads them) ---------------

#[derive(Debug, Clone)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Map(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> &Json {
        match self {
            Json::Map(entries) => entries
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v)
                .unwrap_or_else(|| panic!("no key {key}")),
            other => panic!("not an object: {other:?}"),
        }
    }

    fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(items) => items,
            other => panic!("not an array: {other:?}"),
        }
    }

    fn str(&self) -> &str {
        match self {
            Json::Str(text) => text,
            other => panic!("not a string: {other:?}"),
        }
    }

    fn num(&self) -> f64 {
        match self {
            Json::Num(n) => *n,
            other => panic!("not a number: {other:?}"),
        }
    }

    fn bool(&self) -> bool {
        match self {
            Json::Bool(b) => *b,
            other => panic!("not a boolean: {other:?}"),
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn skip(&mut self) {
        while self.at < self.bytes.len() && self.bytes[self.at].is_ascii_whitespace() {
            self.at += 1;
        }
    }

    fn value(&mut self) -> Json {
        self.skip();
        match self.bytes[self.at] {
            b'{' => {
                self.at += 1;
                let mut entries = Vec::new();
                loop {
                    self.skip();
                    if self.bytes[self.at] == b'}' {
                        self.at += 1;
                        return Json::Map(entries);
                    }
                    if self.bytes[self.at] == b',' {
                        self.at += 1;
                        continue;
                    }
                    let key = self.string();
                    self.skip();
                    assert_eq!(self.bytes[self.at], b':');
                    self.at += 1;
                    entries.push((key, self.value()));
                }
            }
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                loop {
                    self.skip();
                    if self.bytes[self.at] == b']' {
                        self.at += 1;
                        return Json::Arr(items);
                    }
                    if self.bytes[self.at] == b',' {
                        self.at += 1;
                        continue;
                    }
                    items.push(self.value());
                }
            }
            b'"' => Json::Str(self.string()),
            b't' => {
                self.at += 4;
                Json::Bool(true)
            }
            b'f' => {
                self.at += 5;
                Json::Bool(false)
            }
            b'n' => {
                self.at += 4;
                Json::Null
            }
            _ => {
                let start = self.at;
                while self.at < self.bytes.len()
                    && matches!(
                        self.bytes[self.at],
                        b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9'
                    )
                {
                    self.at += 1;
                }
                let text = std::str::from_utf8(&self.bytes[start..self.at]).expect("number text");
                Json::Num(text.parse().unwrap_or_else(|_| panic!("number {text}")))
            }
        }
    }

    fn string(&mut self) -> String {
        assert_eq!(self.bytes[self.at], b'"');
        self.at += 1;
        let mut out = Vec::new();
        loop {
            let b = self.bytes[self.at];
            self.at += 1;
            match b {
                b'"' => return String::from_utf8(out).expect("utf-8 string"),
                b'\\' => {
                    let escape = self.bytes[self.at];
                    self.at += 1;
                    let unit = match escape {
                        b'n' => b'\n',
                        b't' => b'\t',
                        b'r' => b'\r',
                        b'b' => 8,
                        b'f' => 12,
                        b'u' => {
                            let code = u32::from_str_radix(
                                std::str::from_utf8(&self.bytes[self.at..self.at + 4])
                                    .expect("hex"),
                                16,
                            )
                            .expect("hex digits");
                            self.at += 4;
                            let mut buffer = [0u8; 4];
                            out.extend_from_slice(
                                char::from_u32(code)
                                    .unwrap_or('?')
                                    .encode_utf8(&mut buffer)
                                    .as_bytes(),
                            );
                            continue;
                        }
                        other => other,
                    };
                    out.push(unit);
                }
                other => out.push(other),
            }
        }
    }
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/office-colour/golden.json")
}

fn golden() -> Json {
    let text = mixdog_testkit::read_string(fixture_path());
    Reader {
        bytes: text.as_bytes(),
        at: 0,
    }
    .value()
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
    case: &Json,
    colour_object: i64,
) -> (Xref, Result<Arc<ColorSpace>, mixdog_pdf::PdfError>) {
    let xref = open(case.get("pdf").str());
    let resources = resources(colour_object);
    let parsed = color::parse(
        &operand_object(case.get("operand").str()),
        &xref,
        Some(&resources),
    );
    (xref, parsed)
}

#[test]
fn colour_conversion_equals_pdfjs_on_every_recorded_colour() {
    let golden = golden();
    let colour_object = golden.get("csObject").num() as i64;
    let cases = golden.get("cases").arr();
    assert!(cases.len() > 100, "the recording is complete");
    let mut colours = 0usize;
    let mut mismatches = Vec::new();
    for case in cases {
        let name = case.get("name").str();
        let (_xref, parsed) = parse_case(case, colour_object);
        let space = parsed
            .unwrap_or_else(|error| panic!("{name}: the colour space does not parse: {error:?}"));
        let comps = case.get("comps").num() as usize;
        let rows = case.get("samples").arr();
        let expected = case.get("rgb").arr();
        assert_eq!(rows.len(), expected.len(), "{name}");
        for (row, want) in rows.iter().zip(expected) {
            let values: Vec<f64> = row.arr().iter().map(Json::num).collect();
            assert_eq!(values.len(), comps, "{name}: sample width");
            let got = space
                .get_rgb_hex(&values, 0)
                .unwrap_or_else(|error| panic!("{name} {values:?}: {error:?}"));
            colours += 1;
            if got != want.str() {
                mismatches.push(format!(
                    "{name} {values:?}: pdf.js {} rust {got}",
                    want.str()
                ));
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
    let colour_object = golden.get("csObject").num() as i64;
    let failing = golden.get("failing").arr();
    assert!(failing.len() >= 8);
    for case in failing {
        assert_eq!(case.get("fallback").str(), "gray");
        let (_xref, parsed) = parse_case(case, colour_object);
        assert!(parsed.is_err(), "{}: parsed", case.get("name").str());
    }
}

#[test]
fn icc_based_goes_without_qcms_as_pdfjs_does() {
    let golden = golden();
    // pdf.js in this configuration builds no ICC transform (no wasmUrl): the alternate or the device space is used.
    assert!(!golden.get("icc").get("qcmsLoads").bool());
    let colour_object = golden.get("csObject").num() as i64;
    let icc: Vec<&Json> = golden
        .get("cases")
        .arr()
        .iter()
        .filter(|case| case.get("group").str() == "icc")
        .collect();
    assert!(icc.len() >= 9);
    // the real CMYK profile reads as DeviceCMYK
    let profile = icc
        .iter()
        .find(|case| case.get("name").str() == "ICC real CMYK profile")
        .expect("the profile case");
    let (_xref, parsed) = parse_case(profile, colour_object);
    assert_eq!(parsed.expect("parses").name(), "DeviceCMYK");
}

#[test]
fn colour_spaces_are_named_and_counted_as_pdfjs_names_them() {
    let golden = golden();
    let colour_object = golden.get("csObject").num() as i64;
    for case in golden.get("cases").arr() {
        let (_xref, parsed) = parse_case(case, colour_object);
        let space = parsed.expect("parses");
        let group = case.get("group").str();
        let comps = case.get("comps").num() as usize;
        match group {
            "device" | "cal" | "lab" | "devicen" | "tint" | "postscript" => {
                assert_eq!(space.num_comps(), comps, "{}", case.get("name").str());
            }
            "indexed" => assert_eq!(
                (space.name(), space.num_comps()),
                ("Indexed", 1),
                "{}",
                case.get("name").str()
            ),
            _ => {}
        }
        if group == "tint" || group == "devicen" || group == "postscript" {
            assert_eq!(space.name(), "Alternate", "{}", case.get("name").str());
        }
    }
}

/// Re-records with Node and compares: runs `node` on this machine (the tree named by `MIXDOG_NODE_TREE`, else this
/// checkout), so it is ignored by default.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_colour() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let tree = std::env::var_os("MIXDOG_NODE_TREE")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    let script = root.join("benchmarks/rust-core/recorders/record-office-colour.mjs");
    let before = mixdog_testkit::read(fixture_path());
    let args: [&OsStr; 3] = [script.as_os_str(), OsStr::new("--tree"), tree.as_os_str()];
    let printed = mixdog_testkit::output("node", &args);
    assert!(
        printed.contains("golden.json"),
        "the recorder wrote nothing: {printed}"
    );
    let after = mixdog_testkit::read(fixture_path());
    assert!(before == after, "the recording differs from a new one");
}
