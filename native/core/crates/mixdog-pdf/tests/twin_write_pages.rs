//! Twin test `write_pages`: pdf-lib 1.17.1 as the Node office PDF code drives it for the structure of a document (the
//! recording `native/core/fixtures/office-write-pages/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-write-pages.mjs`, which runs the product's own batch operations:
//! delete, move, extract, merge, rotate, crop, bookmark, attach, extract an attachment) against the page, form,
//! attachment and outline code of this crate.
//!
//! For every recorded case the Rust document is loaded from the same base file, given the same operations (the glue
//! of `pdf-batch-structure.mjs` is written here over the crate's primitives) and saved; what the Rust reader reads
//! back from the output must equal the structural summary pdf-lib read from its own output, and the Rust reader must
//! read pdf-lib's output to that same summary. Re-recording, and having pdf-lib open what Rust wrote, is
//! `twin_live_write_pages` (ignored: it runs Node). The tests after the twin cover what the recording does not.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_pdf::write::attachments::AttachmentOptions;
use mixdog_pdf::write::outline::OutlineEntry;
use mixdog_pdf::write::{LoadOptions, PdfDocument, Rect, SaveOptions, WriteError};
use mixdog_pdf::{Dict, FilterResult, Guard, Obj, PdfError, Ref, StreamFilters};
use serde_json::{Value, json};

// ---- helpers -----------------------------------------------------------------------------------------------------

struct Filters;

impl StreamFilters for Filters {
    fn decode(
        &self,
        name: &str,
        data: &[u8],
        _params: Option<&Dict>,
        _length: Option<usize>,
        _max_output: usize,
    ) -> FilterResult {
        match name {
            "FlateDecode" | "Fl" => {
                let mut out = Vec::new();
                flate2::read::ZlibDecoder::new(data)
                    .read_to_end(&mut out)
                    .map_err(|e| PdfError::Format(e.to_string()))?;
                Ok(Some(out))
            }
            _ => Ok(None),
        }
    }
}

fn options() -> LoadOptions {
    LoadOptions {
        ignore_encryption: true,
        filters: Arc::new(Filters),
        guard: Guard::unbounded(),
    }
}

fn load(bytes: &[u8]) -> Result<PdfDocument, WriteError> {
    PdfDocument::load(bytes.to_vec(), &options())
}

fn unbase64(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut bits = 0u32;
    let mut have = 0;
    for c in text.bytes().take_while(|c| *c != b'=') {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            other => panic!("not base64: {other}"),
        };
        bits = (bits << 6) | u32::from(value);
        have += 6;
        if have >= 8 {
            have -= 8;
            out.push((bits >> have) as u8);
            bits &= (1 << have) - 1;
        }
    }
    out
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(char::from(ALPHABET[(n >> 18) as usize & 63]));
        out.push(char::from(ALPHABET[(n >> 12) as usize & 63]));
        out.push(if chunk.len() > 1 { char::from(ALPHABET[(n >> 6) as usize & 63]) } else { '=' });
        out.push(if chunk.len() > 2 { char::from(ALPHABET[n as usize & 63]) } else { '=' });
    }
    out
}

/// A number as JSON the way Node prints it: an integer when it has no fraction.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn rect(r: Rect) -> Value {
    Value::Array([r.x, r.y, r.width, r.height].into_iter().map(number).collect())
}

fn golden_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/office-write-pages/golden.json")
}

fn golden() -> Value {
    let path = golden_path();
    serde_json::from_str(&mixdog_testkit::read_string(&path)).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn file(golden: &Value, name: &str) -> Vec<u8> {
    unbase64(golden["files"][name]["bytes"].as_str().unwrap_or_else(|| panic!("file {name}")))
}

/// The summary of the recorder's `summarize`.
fn summarize(document: &PdfDocument) -> Value {
    let pages: Vec<Value> = document
        .pages()
        .into_iter()
        .map(|page| {
            let annotations: Vec<Value> = document
                .page_annotations(page)
                .iter()
                .map(|entry| match document.store().resolve(entry) {
                    Some(Obj::Dict(annot)) => match annot.get_raw("Subtype") {
                        Some(Obj::Name(kind)) => json!(&**kind),
                        _ => Value::Null,
                    },
                    _ => Value::Null,
                })
                .collect();
            json!({
                "mediaBox": rect(document.media_box(page).unwrap()),
                "cropBox": rect(document.crop_box(page).unwrap()),
                "rotation": number(document.rotation(page).unwrap()),
                "annotations": annotations,
            })
        })
        .collect();
    let fields = if document.has_acro_form() {
        Value::Array(
            document
                .form_fields()
                .into_iter()
                .map(|field| json!({"name": field.name, "type": field.field_type, "value": field.value}))
                .collect(),
        )
    } else {
        Value::Null
    };
    let guard = Guard::unbounded();
    let attachments: Vec<Value> = document
        .attachments()
        .into_iter()
        .map(|entry| {
            let bytes = document.attachment_bytes(&entry.spec, &Filters, &guard).unwrap().unwrap_or_default();
            json!({"name": entry.name, "description": entry.description, "bytes": base64(&bytes)})
        })
        .collect();
    let outline: Vec<Value> = document
        .outline_items()
        .into_iter()
        .map(|item| json!({"title": item.title, "page": item.page_index.map_or(-1, |at| at as i64)}))
        .collect();
    json!({
        "pageCount": pages.len(),
        "pages": pages,
        "fields": fields,
        "attachments": attachments,
        "outline": outline,
    })
}

// ---- the operations of pdf-batch-structure.mjs over the primitives ----------------------------------------------------

struct World {
    golden: Value,
    outputs: BTreeMap<String, Vec<u8>>,
}

/// `selectedPages`: the zero-based indexes an operation names (all pages when it names none).
fn selected(document: &PdfDocument, op: &Value) -> Vec<usize> {
    let count = document.page_count();
    let named: Vec<usize> = match op["pages"].as_array().filter(|list| !list.is_empty()) {
        Some(list) => list.iter().map(|page| page.as_u64().expect("page") as usize).collect(),
        None => match op["page"].as_u64() {
            Some(page) => vec![page as usize],
            None => (1..=count).collect(),
        },
    };
    named
        .into_iter()
        .map(|page| {
            assert!(page >= 1 && page <= count, "PDF page out of range: {page}");
            page - 1
        })
        .collect()
}

const SIDES: [&str; 4] = ["left", "right", "top", "bottom"];

/// `DISPLAYED_SIDES`: which side of the unrotated page the side a reader sees falls on.
fn source_side(rotation: i64, displayed: &str) -> &'static str {
    let table: [(&str, &'static str); 4] = match rotation {
        90 => [("top", "left"), ("right", "top"), ("bottom", "right"), ("left", "bottom")],
        180 => [("left", "right"), ("right", "left"), ("top", "bottom"), ("bottom", "top")],
        270 => [("top", "right"), ("right", "bottom"), ("bottom", "left"), ("left", "top")],
        _ => [("left", "left"), ("right", "right"), ("top", "top"), ("bottom", "bottom")],
    };
    table.iter().find(|(shown, _)| *shown == displayed).expect("side").1
}

fn apply(world: &mut World, document: &mut PdfDocument, op: &Value) -> Value {
    let name = op["op"].as_str().expect("op");
    let mut returned = json!({"op": name});
    match name {
        "rotate_pages" => {
            let delta = op["rotation"].as_i64().unwrap_or(90);
            let absolute = op["absolute"].as_bool().unwrap_or(false);
            for index in selected(document, op) {
                let page = document.pages()[index];
                let current = document.rotation(page).unwrap() as i64;
                let next = (((if absolute { delta } else { current + delta }) % 360) + 360) % 360;
                document.set_rotation(page, next as f64).unwrap();
            }
        }
        "crop_pages" => {
            let trim = |side: &str| op[side].as_f64().or_else(|| op["margin"].as_f64()).unwrap_or(0.0);
            for index in selected(document, op) {
                let page = document.pages()[index];
                let rotation = ((document.rotation(page).unwrap() as i64 % 360) + 360) % 360;
                let mut cut: BTreeMap<&str, f64> = BTreeMap::new();
                for side in SIDES {
                    cut.insert(source_side(rotation, side), trim(side));
                }
                let current = document.crop_box(page).unwrap();
                let width = current.width - cut["left"] - cut["right"];
                let height = current.height - cut["bottom"] - cut["top"];
                assert!(width >= 1.0 && height >= 1.0, "crop would leave the page empty");
                let area = Rect {
                    x: current.x + cut["left"],
                    y: current.y + cut["bottom"],
                    width,
                    height,
                };
                document.set_media_box(page, area).unwrap();
                document.set_crop_box(page, area).unwrap();
            }
        }
        "delete_pages" => {
            let mut indexes = selected(document, op);
            indexes.sort_unstable_by(|a, b| b.cmp(a));
            assert!(indexes.len() < document.page_count(), "delete_pages cannot remove every page");
            for index in &indexes {
                document.remove_page(*index).unwrap();
            }
            document.drop_fields_off_the_pages().unwrap();
            returned["count"] = json!(indexes.len());
            returned["pageCount"] = json!(document.page_count());
        }
        "extract_pages" => {
            let indexes = selected(document, op);
            if let Some(output) = op["output"].as_str() {
                let next = document.copy_to_new_document(&indexes).unwrap();
                world
                    .outputs
                    .insert(output.to_owned(), next.save(SaveOptions::default()));
            } else {
                document.keep_pages_in_order(&indexes).unwrap();
            }
            returned["count"] = json!(indexes.len());
        }
        "move_page" => {
            let from = op["page"].as_u64().expect("page") as usize - 1;
            let to = op["index"].as_u64().expect("index") as usize - 1;
            let mut order: Vec<usize> = (0..document.page_count()).collect();
            let moved = order.remove(from);
            order.insert(to, moved);
            document.keep_pages_in_order(&order).unwrap();
        }
        "merge_pdf" => merge(world, document, op, &mut returned),
        "add_bookmark" => {
            let title = op["title"].as_str().expect("title").trim().to_owned();
            let index = selected(document, &json!({"page": op["page"]}))[0];
            document
                .add_outline_entries(&[OutlineEntry { title, page_index: index }])
                .unwrap();
        }
        "add_attachment" => {
            let path = op["path"].as_str().expect("path");
            let name = op["name"].as_str().unwrap_or(path);
            let attachment = AttachmentOptions {
                mime_type: Some(op["mimeType"].as_str().unwrap_or("application/octet-stream").to_owned()),
                description: Some(op["description"].as_str().unwrap_or("").to_owned()),
                ..AttachmentOptions::default()
            };
            document.attach(&file(&world.golden, path), name, &attachment).unwrap();
        }
        "extract_attachment" => {
            let entries = document.attachments();
            let wanted = entries
                .iter()
                .find(|entry| {
                    op["name"].as_str().is_some_and(|name| entry.name == name)
                        || op["index"].as_u64().is_some_and(|index| entry.index == index as usize)
                })
                .expect("attachment");
            let bytes = document
                .attachment_bytes(&wanted.spec, &Filters, &Guard::unbounded())
                .unwrap()
                .expect("embedded file stream");
            world.outputs.insert(op["output"].as_str().expect("output").to_owned(), bytes);
        }
        other => panic!("unknown operation {other}"),
    }
    returned
}

fn merge(world: &World, document: &mut PdfDocument, op: &Value, returned: &mut Value) {
    let sources: Vec<Value> = match op["sources"].as_array() {
        Some(list) if !list.is_empty() => list.clone(),
        _ => vec![op["path"].clone()],
    };
    let mut insert_at = op["index"].as_u64().map(|index| index as usize - 1);
    let mut merged: Vec<(usize, usize, String)> = Vec::new();
    let mut pages_added = 0;
    let mut form_fields_total = 0;
    for entry in &sources {
        let path = entry.as_str().or_else(|| entry["path"].as_str()).expect("source path");
        let other = load(&file(&world.golden, path)).unwrap();
        let selection = if entry.is_string() { json!({}) } else { json!({"pages": entry["pages"], "page": entry["page"]}) };
        let indexes = selected(&other, &selection);
        let copied = document.copy_pages(&other, &indexes).unwrap();
        let first_page = insert_at.unwrap_or_else(|| document.page_count());
        for page in &copied {
            match insert_at {
                None => document.append_page(*page).unwrap(),
                Some(at) => {
                    document.insert_page(at, *page).unwrap();
                    insert_at = Some(at + 1);
                }
            }
        }
        form_fields_total += document.register_copied_fields(&copied).unwrap();
        let title = entry["title"].as_str().filter(|title| !title.is_empty()).map_or_else(
            || path.rsplit_once('.').map_or(path, |(stem, _)| stem).to_owned(),
            str::to_owned,
        );
        merged.push((copied.len(), first_page, title));
        pages_added += copied.len();
    }
    if op["bookmarks"].as_bool() == Some(true) {
        let entries: Vec<OutlineEntry> = merged
            .iter()
            .filter(|(added, _, _)| *added > 0)
            .map(|(_, at, title)| OutlineEntry { title: title.clone(), page_index: *at })
            .collect();
        returned["bookmarks"] = json!(document.add_outline_entries(&entries).unwrap());
    }
    returned["pagesAdded"] = json!(pages_added);
    returned["pageCount"] = json!(document.page_count());
    if form_fields_total > 0 {
        returned["formFields"] = json!(form_fields_total);
    }
}

/// The document of a recorded case with its operations applied, what each operation returned, and the files it wrote.
fn run_case(golden: &Value, case: &Value) -> (PdfDocument, Vec<Value>, BTreeMap<String, Vec<u8>>) {
    let mut world = World {
        golden: golden.clone(),
        outputs: BTreeMap::new(),
    };
    let mut document = load(&file(golden, case["base"].as_str().expect("base"))).unwrap();
    let returned = case["ops"]
        .as_array()
        .expect("ops")
        .iter()
        .map(|op| apply(&mut world, &mut document, op))
        .collect();
    (document, returned, world.outputs)
}

fn every_case_equals_the_recording() {
    let golden = golden();
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() >= 20);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let (document, returned, outputs) = run_case(&golden, case);
        assert_eq!(Value::Array(returned), case["returned"], "{name}: what the operations returned");
        let written = document.save(SaveOptions::default());
        let reread = load(&written).unwrap_or_else(|e| panic!("{name}: Rust output: {e}"));
        assert_eq!(summarize(&reread), case["summary"], "{name}: Rust output read back");
        let theirs = unbase64(case["pdf"].as_str().expect("pdf"));
        let read_theirs = load(&theirs).unwrap_or_else(|e| panic!("{name}: pdf-lib output: {e}"));
        assert_eq!(summarize(&read_theirs), case["summary"], "{name}: pdf-lib output read by Rust");

        let recorded = case["outputs"].as_object().expect("outputs");
        assert_eq!(
            outputs.keys().cloned().collect::<Vec<_>>(),
            recorded.keys().cloned().collect::<Vec<_>>(),
            "{name}: files written"
        );
        for (file, bytes) in &outputs {
            let record = &recorded[file];
            if let Some(pdf) = record["pdf"].as_str() {
                let mine = load(bytes).unwrap_or_else(|e| panic!("{name}/{file}: Rust output: {e}"));
                assert_eq!(summarize(&mine), record["summary"], "{name}/{file}: Rust output read back");
                let theirs = load(&unbase64(pdf)).unwrap();
                assert_eq!(summarize(&theirs), record["summary"], "{name}/{file}: pdf-lib output read by Rust");
            } else {
                assert_eq!(base64(bytes), record["bytes"].as_str().expect("bytes"), "{name}/{file}: bytes");
            }
        }
    }
}

// ---- the twin ----------------------------------------------------------------------------------------------------

#[test]
fn write_pages_equals_the_recording() {
    every_case_equals_the_recording();
}

/// Records again with Node, compares, then has pdf-lib open what Rust wrote:
/// `cargo test -p mixdog-pdf --test twin_write_pages -- --ignored`.
#[test]
#[ignore = "re-records through Node (pdf-lib) and has it open the Rust output"]
fn twin_live_write_pages() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let tree = std::env::var_os("MIXDOG_NODE_TREE").map_or_else(|| root.clone(), PathBuf::from);
    let recorder = root.join("benchmarks/rust-core/recorders/record-office-write-pages.mjs");
    let tree_arg = std::ffi::OsString::from("--tree");
    mixdog_testkit::output("node", &[recorder.as_os_str(), tree_arg.as_os_str(), tree.as_os_str()]);
    every_case_equals_the_recording();

    let golden = golden();
    let directory = std::env::temp_dir().join(format!("mixdog-write-pages-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    let mut expected = serde_json::Map::new();
    for case in golden["cases"].as_array().expect("cases") {
        let (document, _, outputs) = run_case(&golden, case);
        let name = case["name"].as_str().expect("name");
        let written = document.save(SaveOptions::default());
        mixdog_testkit::write(directory.join(format!("{name}.pdf")), &written);
        expected.insert(format!("{name}.pdf"), summarize(&load(&written).expect("reread")));
        for (file, bytes) in outputs.iter().filter(|(file, _)| file.ends_with(".pdf")) {
            let key = format!("{name}--{file}");
            mixdog_testkit::write(directory.join(&key), bytes);
            expected.insert(key, summarize(&load(bytes).expect("reread")));
        }
    }
    let verify_arg = std::ffi::OsString::from("--verify");
    let printed = mixdog_testkit::output(
        "node",
        &[
            recorder.as_os_str(),
            tree_arg.as_os_str(),
            tree.as_os_str(),
            verify_arg.as_os_str(),
            directory.as_os_str(),
        ],
    );
    mixdog_testkit::remove_dir_all(&directory);
    let theirs: Value = serde_json::from_str(printed.trim()).expect("pdf-lib's summaries");
    assert_eq!(theirs, Value::Object(expected), "pdf-lib reading the Rust output");
}

// ---- what the recording does not cover ----------------------------------------------------------------------------

fn document_with_pages(count: usize) -> (PdfDocument, Vec<Ref>) {
    let mut document = PdfDocument::create_at(0);
    let pages = (0..count)
        .map(|at| document.add_page(100.0 + at as f64, 200.0).unwrap())
        .collect();
    (document, pages)
}

fn count_of(document: &PdfDocument, node: Ref) -> f64 {
    let store = document.store();
    let dict = store.dict(node).unwrap();
    store.lookup(dict, "Count").and_then(Obj::as_num).unwrap()
}

#[test]
fn a_removed_page_leaves_the_tree_and_counts_follow() {
    let (mut document, pages) = document_with_pages(3);
    let root = document.store().dict(document.catalog_ref().unwrap()).unwrap().get_raw("Pages").unwrap().as_ref_value().unwrap();
    let removed = document.remove_page(1).unwrap();
    assert_eq!(removed, pages[1]);
    assert_eq!(document.pages(), vec![pages[0], pages[2]]);
    assert_eq!(count_of(&document, root), 2.0);
    assert!(document.store().get(removed).is_some(), "the page object stays in the store");
    document.insert_page(0, removed).unwrap();
    assert_eq!(document.pages(), vec![removed, pages[0], pages[2]]);
    assert_eq!(count_of(&document, root), 3.0);
}

#[test]
fn page_indexes_out_of_range_are_refused_with_pdf_libs_words() {
    let (mut document, pages) = document_with_pages(2);
    let error = document.insert_page(3, pages[0]).unwrap_err();
    assert_eq!(
        error.to_string(),
        "`index` must be at least 0 and at most 2, but was actually 3"
    );
    let error = document.remove_page(2).unwrap_err();
    assert_eq!(
        error.to_string(),
        "`index` must be at least 0 and at most 1, but was actually 2"
    );
    assert!(document.set_rotation(pages[0], 45.0).is_err());
    document.set_rotation(pages[0], -90.0).unwrap();
    assert_eq!(document.rotation(pages[0]).unwrap(), -90.0);
}

#[test]
fn insertion_digs_into_a_nested_node_and_removal_prunes_an_emptied_one() {
    // root -> [leaf p0, node n -> [leaf p1, leaf p2]]
    let (mut document, pages) = document_with_pages(3);
    let root = document.store().dict(document.catalog_ref().unwrap()).unwrap().get_raw("Pages").unwrap().as_ref_value().unwrap();
    let mut node = Dict::new();
    node.set("Type", Obj::name("Pages"));
    node.set("Parent", Obj::Ref(root));
    node.set("Kids", Obj::Array(Arc::new(vec![Obj::Ref(pages[1]), Obj::Ref(pages[2])])));
    node.set("Count", Obj::Num(2.0));
    let node_ref = document.store_mut().register(Obj::Dict(Arc::new(node)));
    for page in &pages[1..] {
        document.store_mut().modify_dict(*page, |dict| dict.set("Parent", Obj::Ref(node_ref)));
    }
    document.store_mut().modify_dict(root, |tree| {
        tree.set("Kids", Obj::Array(Arc::new(vec![Obj::Ref(pages[0]), Obj::Ref(node_ref)])));
    });
    assert_eq!(document.pages(), pages);

    let extra = document.add_page(5.0, 5.0).unwrap();
    document.remove_page(3).unwrap();
    assert_eq!(count_of(&document, root), 3.0);
    document.insert_page(2, extra).unwrap();
    assert_eq!(document.pages(), vec![pages[0], pages[1], extra, pages[2]]);
    let parent = document.store().dict(extra).unwrap().get_raw("Parent").unwrap().as_ref_value().unwrap();
    assert_eq!(parent, node_ref, "the page landed in the node that held the index");
    assert_eq!(count_of(&document, node_ref), 3.0);
    assert_eq!(count_of(&document, root), 4.0);

    for _ in 0..3 {
        document.remove_page(1).unwrap();
    }
    assert_eq!(document.pages(), vec![pages[0]]);
    let kids = document.store().dict(root).unwrap().get_raw("Kids").unwrap().as_array().unwrap().clone();
    assert_eq!(kids.len(), 1, "the node left without kids was pruned");
    assert_eq!(count_of(&document, root), 1.0);
}

fn resources_with_font(document: &mut PdfDocument) -> Ref {
    let mut font = Dict::new();
    font.set("Type", Obj::name("Font"));
    font.set("BaseFont", Obj::name("Helvetica"));
    let font_ref = document.store_mut().register(Obj::Dict(Arc::new(font)));
    let mut fonts = Dict::new();
    fonts.set("F1", Obj::Ref(font_ref));
    let mut resources = Dict::new();
    resources.set("Font", Obj::Dict(Arc::new(fonts)));
    document.store_mut().register(Obj::Dict(Arc::new(resources)))
}

#[test]
fn copied_pages_share_what_one_call_shares_and_leave_the_donors_tree_behind() {
    let (mut donor, pages) = document_with_pages(2);
    let resources = resources_with_font(&mut donor);
    let root = donor.store().dict(donor.catalog_ref().unwrap()).unwrap().get_raw("Pages").unwrap().as_ref_value().unwrap();
    for page in &pages {
        donor.store_mut().modify_dict(*page, |dict| dict.delete("Resources"));
    }
    // Inherited from the tree: Resources and Rotate; each page has its own MediaBox.
    donor.store_mut().modify_dict(root, |tree| {
        tree.set("Resources", Obj::Ref(resources));
        tree.set("Rotate", Obj::Num(90.0));
    });
    let (mut target, _) = document_with_pages(1);
    let copies = target.copy_pages(&donor, &[0, 1]).unwrap();
    assert_eq!(copies.len(), 2);
    let first = target.store().dict(copies[0]).unwrap().clone();
    let second = target.store().dict(copies[1]).unwrap().clone();
    assert!(!first.has("Parent"), "Parent is dropped");
    assert_eq!(first.get_raw("Rotate").and_then(Obj::as_num), Some(90.0), "inherited Rotate is written into the copy");
    let shared = first.get_raw("Resources").unwrap().as_ref_value().unwrap();
    assert_eq!(second.get_raw("Resources").unwrap().as_ref_value().unwrap(), shared, "one call copies a shared object once");
    assert_ne!(shared, resources, "the copy is a new object of this document");
    assert_eq!(target.page_count(), 1, "copies are not in the tree until inserted");
    target.insert_page(1, copies[0]).unwrap();
    target.append_page(copies[1]).unwrap();
    assert_eq!(target.page_count(), 3);
    assert_eq!(target.media_box(copies[1]).unwrap().width, 101.0);
    assert_eq!(target.rotation(copies[1]).unwrap(), 90.0);
    assert_eq!(donor.pages(), pages, "the donor is untouched");

    // A second call copies the shared object again.
    let again = target.copy_pages(&donor, &[0]).unwrap();
    let other = target.store().dict(again[0]).unwrap().get_raw("Resources").unwrap().as_ref_value().unwrap();
    assert_ne!(other, shared);
}

#[test]
fn a_reference_to_nothing_stays_a_reference_to_a_new_empty_number() {
    let (mut donor, pages) = document_with_pages(1);
    donor.store_mut().modify_dict(pages[0], |page| page.set("Contents", Obj::Ref(Ref::new(900, 0))));
    let (mut target, _) = document_with_pages(1);
    let copies = target.copy_pages(&donor, &[0]).unwrap();
    let contents = target.store().dict(copies[0]).unwrap().get_raw("Contents").unwrap().as_ref_value().unwrap();
    assert!(target.store().get(contents).is_none());
    assert_ne!(contents, Ref::new(900, 0));
    assert!(target.copy_pages(&donor, &[1]).is_err(), "a page that does not exist");
}

fn text_field(document: &mut PdfDocument, name: &str, value: &str, page: Ref) -> Ref {
    let mut widget = Dict::new();
    widget.set("Type", Obj::name("Annot"));
    widget.set("Subtype", Obj::name("Widget"));
    widget.set("FT", Obj::name("Tx"));
    widget.set("T", Obj::string(name.as_bytes()));
    widget.set("V", Obj::string(value.as_bytes()));
    widget.set("P", Obj::Ref(page));
    let widget_ref = document.store_mut().register(Obj::Dict(Arc::new(widget)));
    document.store_mut().modify_dict(page, |dict| {
        dict.set("Annots", Obj::Array(Arc::new(vec![Obj::Ref(widget_ref)])));
    });
    widget_ref
}

#[test]
fn copied_fields_join_the_form_and_a_taken_name_gets_a_suffix() {
    let (mut donor, pages) = document_with_pages(1);
    text_field(&mut donor, "name", "Ada", pages[0]);
    let (mut target, _) = document_with_pages(0);
    for expected in ["name", "name_2", "name_3"] {
        let copies = target.copy_pages(&donor, &[0]).unwrap();
        target.append_page(copies[0]).unwrap();
        assert_eq!(target.register_copied_fields(&copies).unwrap(), 1);
        let names: Vec<String> = target.form_fields().into_iter().map(|field| field.name).collect();
        assert_eq!(names.last().map(String::as_str), Some(expected));
    }
    let values: Vec<Option<String>> = target.form_fields().into_iter().map(|field| field.value).collect();
    assert_eq!(values, vec![Some("Ada".to_owned()); 3]);
    // A page without widgets still makes the form (pdf-lib's getForm does).
    let (mut bare, _) = document_with_pages(1);
    assert!(!bare.has_acro_form());
    assert_eq!(bare.register_copied_fields(&[]).unwrap(), 0);
    assert!(bare.has_acro_form());
}

#[test]
fn a_field_whose_widgets_left_with_a_removed_page_leaves_the_form() {
    let (mut document, pages) = document_with_pages(2);
    text_field(&mut document, "gone", "x", pages[0]);
    text_field(&mut document, "kept", "y", pages[1]);
    document.register_copied_fields(&pages).unwrap();
    assert_eq!(document.form_fields().len(), 2);
    document.remove_page(0).unwrap();
    document.drop_fields_off_the_pages().unwrap();
    let names: Vec<String> = document.form_fields().into_iter().map(|field| field.name).collect();
    assert_eq!(names, vec!["kept".to_owned()]);
}

#[test]
fn keeping_pages_in_order_copies_a_named_twice_page_and_drops_the_rest() {
    let (mut document, pages) = document_with_pages(3);
    text_field(&mut document, "f", "v", pages[1]);
    document.register_copied_fields(&pages[1..2]).unwrap();
    document.keep_pages_in_order(&[1, 0, 1]).unwrap();
    let order = document.pages();
    assert_eq!(order.len(), 3);
    assert_eq!(order[0], pages[1]);
    assert_eq!(order[1], pages[0]);
    assert_ne!(order[2], pages[1], "the second mention is a copy");
    assert_eq!(document.media_box(order[2]).unwrap().width, 101.0);
    let names: Vec<String> = document.form_fields().into_iter().map(|field| field.name).collect();
    assert_eq!(names, vec!["f".to_owned(), "f_2".to_owned()]);
    assert!(document.keep_pages_in_order(&[5]).is_err());
}

#[test]
fn an_outline_grows_after_what_the_file_has() {
    let (mut document, pages) = document_with_pages(3);
    assert_eq!(document.add_outline_entries(&[]).unwrap(), 0);
    let first = [
        OutlineEntry { title: "One".to_owned(), page_index: 0 },
        OutlineEntry { title: "Two".to_owned(), page_index: 2 },
    ];
    assert_eq!(document.add_outline_entries(&first).unwrap(), 2);
    assert_eq!(document.add_outline_entries(&[OutlineEntry { title: "Three".to_owned(), page_index: 1 }]).unwrap(), 1);
    let items = document.outline_items();
    let titles: Vec<&str> = items.iter().map(|item| item.title.as_str()).collect();
    assert_eq!(titles, ["One", "Two", "Three"]);
    let opened: Vec<Option<usize>> = items.iter().map(|item| item.page_index).collect();
    assert_eq!(opened, [Some(0), Some(2), Some(1)]);

    let store = document.store();
    let root = store.lookup(store.dict(document.catalog_ref().unwrap()).unwrap(), "Outlines").and_then(|o| o.dict_or_stream_dict()).unwrap();
    assert_eq!(root.get_raw("Count").and_then(Obj::as_num), Some(3.0));
    let last = root.get_raw("Last").unwrap().as_ref_value().unwrap();
    let last_item = store.dict(last).unwrap();
    assert!(last_item.get_raw("Next").is_none());
    assert!(last_item.get_raw("Prev").is_some());
    assert_eq!(last_item.get_raw("Dest").and_then(Obj::as_array).unwrap()[0].as_ref_value(), Some(pages[1]));
    assert!(document.add_outline_entries(&[OutlineEntry { title: "X".to_owned(), page_index: 3 }]).is_err());
}

#[test]
fn an_attachment_is_a_flate_stream_a_filespec_and_two_catalog_entries() {
    let (mut document, _) = document_with_pages(1);
    let data = b"hello hello hello hello".to_vec();
    let kind = AttachmentOptions {
        mime_type: Some("text/plain".to_owned()),
        description: Some(String::new()),
        creation_date: Some(0),
        ..AttachmentOptions::default()
    };
    let spec_ref = document.attach(&data, "a.txt", &kind).unwrap();
    document.attach(b"second", "b.bin", &AttachmentOptions::default()).unwrap();

    let spec = document.store().dict(spec_ref).unwrap().clone();
    assert_eq!(spec.get_raw("Type").and_then(Obj::as_name), Some("Filespec"));
    assert!(!spec.has("Desc"), "an empty description is left out");
    let stream_ref = match spec.get_raw("EF") {
        Some(Obj::Dict(files)) => files.get_raw("F").unwrap().as_ref_value().unwrap(),
        _ => panic!("EF"),
    };
    let Some(Obj::Stream(stream)) = document.store().get(stream_ref) else {
        panic!("the embedded file is a stream");
    };
    assert_eq!(stream.dict.get_raw("Type").and_then(Obj::as_name), Some("EmbeddedFile"));
    assert_eq!(stream.dict.get_raw("Subtype").and_then(Obj::as_name), Some("text/plain"));
    assert_eq!(stream.dict.get_raw("Filter").and_then(Obj::as_name), Some("FlateDecode"));
    let Some(Obj::Dict(params)) = stream.dict.get_raw("Params") else {
        panic!("Params");
    };
    assert_eq!(params.get_raw("Size").and_then(Obj::as_num), Some(data.len() as f64));
    assert_eq!(params.get_raw("CreationDate").and_then(Obj::as_str), Some(&b"D:19700101000000Z"[..]));
    assert!(!params.has("ModDate"));

    let catalog = document.store().dict(document.catalog_ref().unwrap()).unwrap().clone();
    let af = document.store().lookup(&catalog, "AF").and_then(Obj::as_array).unwrap();
    assert_eq!(af.len(), 2);

    let written = document.save(SaveOptions::default());
    let reread = load(&written).unwrap();
    let entries = reread.attachments();
    assert_eq!(entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(), ["a.txt", "b.bin"]);
    assert_eq!(entries[1].index, 2);
    let bytes = reread.attachment_bytes(&entries[0].spec, &Filters, &Guard::unbounded()).unwrap();
    assert_eq!(bytes, Some(data));
    assert!(reread.attachment_bytes(&Dict::new(), &Filters, &Guard::unbounded()).is_err());
}

#[test]
fn a_catalog_whose_names_are_not_what_the_path_needs_lists_no_attachments() {
    let (mut document, _) = document_with_pages(1);
    let root = document.catalog_ref().unwrap();
    document.store_mut().modify_dict(root, |catalog| catalog.set("Names", Obj::Num(1.0)));
    assert!(document.attachments().is_empty());
    assert!(document.attach(b"x", "x", &AttachmentOptions::default()).is_err());
}
