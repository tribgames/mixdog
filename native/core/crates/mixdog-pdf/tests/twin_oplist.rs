//! Twin test `oplist`: pdf.js 6.4's operator list, annotations and outline (the recording
//! `native/core/fixtures/office-oplist/golden.json`, written by `benchmarks/rust-core/recorders/record-office-oplist.mjs`)
//! against `mixdog_pdf::oplist`, `annotations` and `outline_read`. Each document is a generated PDF; this test opens
//! the same bytes and reduces what the Rust passes return to the shapes the recorder reduces pdf.js's to: the
//! operators with their arguments (single-precision path data as stored, image ids numbered by first use, text
//! operators by name only: the font object is another task's) and, for the operators that paint a path or an image,
//! the transform in force there; the viewable annotations with the links' actions; the outline tree with the page
//! every destination opens; and the named destinations. Every number is compared as a double, exactly. Re-recording is
//! `twin_live_oplist` (ignored: it runs Node).

use mixdog_office_base::twin;
use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::oplist::{
    self, GStateValue, MarkedData, Op, OperatorList, OptionalContent, PaintOp, ParamOp,
};
use mixdog_pdf::outline_read::{self, Dest, OutlineItem};
use mixdog_pdf::{Obj, annotations};
use serde_json::{Map, Value, json};

const SET: &str = "office-oplist";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-oplist.mjs";

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect()
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

/// `plain` of the recorder: a PDF value as JSON.
fn plain(obj: &Obj) -> Value {
    match obj {
        Obj::Null => Value::Null,
        Obj::Bool(b) => json!(b),
        Obj::Num(n) => json!(n),
        Obj::Str(s) => Value::String(latin1(s)),
        Obj::Name(n) => json!({ "name": &**n }),
        Obj::Ref(r) => json!({ "ref": r.to_string() }),
        Obj::Array(items) => Value::Array(items.iter().map(plain).collect()),
        _ => json!("[object]"),
    }
}

fn numbers<T: Copy + Into<f64>>(values: &[T]) -> Value {
    Value::Array(values.iter().map(|&v| json!(v.into())).collect())
}

fn paint_name(paint: PaintOp) -> &'static str {
    match paint {
        PaintOp::Stroke => "stroke",
        PaintOp::CloseStroke => "closeStroke",
        PaintOp::Fill => "fill",
        PaintOp::EoFill => "eoFill",
        PaintOp::FillStroke => "fillStroke",
        PaintOp::EoFillStroke => "eoFillStroke",
        PaintOp::CloseFillStroke => "closeFillStroke",
        PaintOp::CloseEoFillStroke => "closeEOFillStroke",
        PaintOp::EndPath => "endPath",
    }
}

fn param_name(op: ParamOp) -> &'static str {
    match op {
        ParamOp::SetLineCap => "setLineCap",
        ParamOp::SetLineJoin => "setLineJoin",
        ParamOp::SetMiterLimit => "setMiterLimit",
        ParamOp::SetRenderingIntent => "setRenderingIntent",
        ParamOp::SetFlatness => "setFlatness",
        ParamOp::SetCharSpacing => "setCharSpacing",
        ParamOp::SetWordSpacing => "setWordSpacing",
        ParamOp::SetHScale => "setHScale",
        ParamOp::SetLeading => "setLeading",
        ParamOp::SetTextRenderingMode => "setTextRenderingMode",
        ParamOp::SetTextRise => "setTextRise",
        ParamOp::MoveText => "moveText",
        ParamOp::SetLeadingMoveText => "setLeadingMoveText",
        ParamOp::NextLine => "nextLine",
        ParamOp::SetCharWidth => "setCharWidth",
        ParamOp::SetCharWidthAndBounds => "setCharWidthAndBounds",
    }
}

fn optional_content(content: &Option<OptionalContent>) -> Value {
    fn expression(items: &[oplist::Expression]) -> Value {
        Value::Array(
            items
                .iter()
                .map(|item| match item {
                    oplist::Expression::Operator(name) | oplist::Expression::Reference(name) => {
                        json!(name)
                    }
                    oplist::Expression::Nested(inner) => expression(inner),
                })
                .collect(),
        )
    }
    match content {
        None => Value::Null,
        Some(OptionalContent::Group { id }) => {
            let mut map = Map::new();
            map.insert("type".into(), json!("OCG"));
            if let Some(id) = id {
                map.insert("id".into(), json!(id));
            }
            Value::Object(map)
        }
        Some(OptionalContent::Membership {
            expression: Some(items),
            ..
        }) => json!({ "type": "OCMD", "expression": expression(items) }),
        Some(OptionalContent::Membership {
            ids,
            policy,
            expression: None,
        }) => json!({ "type": "OCMD", "ids": ids, "policy": policy, "expression": null }),
    }
}

fn gstate_value(key: &str, value: &GStateValue) -> Value {
    match value {
        GStateValue::Number(n) => json!(n),
        GStateValue::Bool(b) => json!(b),
        GStateValue::Value(obj) => plain(obj),
        GStateValue::BlendMode(mode) => json!(mode),
        GStateValue::Font { size, .. } => Value::Array(vec![plain(size)]),
        GStateValue::Transfer(maps) => {
            assert_eq!(key, "TR");
            match maps {
                None => Value::Null,
                Some(maps) => Value::Array(
                    maps.iter()
                        .map(|m| match m {
                            Some(table) => {
                                numbers(&table.iter().map(|&b| f64::from(b)).collect::<Vec<_>>())
                            }
                            None => Value::Null,
                        })
                        .collect(),
                ),
            }
        }
    }
}

fn group_value(group: &oplist::Group) -> Value {
    json!({
        "isolated": group.isolated,
        "knockout": group.knockout,
        "needsIsolation": group.needs_isolation,
        "hasSoftMask": group.has_soft_mask,
        "isGray": group.is_gray,
        "smask": group.smask.as_ref().map(|s| json!({
            "subtype": s.subtype,
            "backdrop": s.backdrop,
            "transferMap": s.transfer_map.as_ref().map(|t| numbers(&t.iter().map(|&b| f64::from(b)).collect::<Vec<_>>())),
        })),
        "bbox": group.bbox.as_ref().map(|b| numbers(b)),
        "matrix": group.matrix.as_ref().map(|m| numbers(m)),
    })
}

/// The recorder's `reduceOps`.
fn reduce_ops(list: &OperatorList) -> Value {
    let mut image_ids: Vec<String> = Vec::new();
    let mut norm = |id: &str| -> String {
        let at = match image_ids.iter().position(|known| known == id) {
            Some(at) => at,
            None => {
                image_ids.push(id.to_owned());
                image_ids.len() - 1
            }
        };
        format!("img{}", at + 1)
    };
    let mut out = Vec::new();
    for (ctm, op) in list.with_transforms() {
        let mut with_ctm = false;
        let (name, args): (&str, Vec<Value>) = match op {
            Op::Save => ("save", vec![]),
            Op::Restore => ("restore", vec![]),
            Op::Transform(m) => ("transform", m.iter().map(|v| json!(v)).collect()),
            Op::ConstructPath { paint, path } => {
                with_ctm = true;
                (
                    "constructPath",
                    vec![
                        json!(paint_name(*paint)),
                        path.as_ref().map_or(Value::Null, |p| numbers(&p.data)),
                        path.as_ref().map_or(Value::Null, |p| numbers(&p.min_max)),
                    ],
                )
            }
            Op::Clip => ("clip", vec![]),
            Op::EoClip => ("eoClip", vec![]),
            Op::SetLineWidth(w) => ("setLineWidth", vec![json!(w)]),
            Op::SetDash { array, phase } => ("setDash", vec![numbers(array), json!(phase)]),
            Op::SetGState(entries) => (
                "setGState",
                vec![Value::Array(
                    entries
                        .iter()
                        .map(|(key, value)| json!([key, gstate_value(key, value)]))
                        .collect(),
                )],
            ),
            Op::Param(param, args) => (param_name(*param), args.iter().map(plain).collect()),
            Op::BeginText => ("beginText", vec![]),
            Op::EndText => ("endText", vec![]),
            Op::SetFont { size, .. } => ("setFont", vec![plain(size)]),
            Op::ShowText(_) => ("showText", vec![]),
            Op::SetTextMatrix(m) => ("setTextMatrix", vec![numbers(m)]),
            Op::SetFillRgbColor(hex) => ("setFillRGBColor", vec![json!(hex)]),
            Op::SetStrokeRgbColor(hex) => ("setStrokeRGBColor", vec![json!(hex)]),
            Op::SetFillTransparent => ("setFillTransparent", vec![]),
            Op::SetStrokeTransparent => ("setStrokeTransparent", vec![]),
            Op::SetFillPattern(_) => ("setFillColorN", vec![]),
            Op::SetStrokePattern(_) => ("setStrokeColorN", vec![]),
            Op::ShadingFill(_) => ("shadingFill", vec![]),
            Op::FormBegin { matrix, bbox } => (
                "paintFormXObjectBegin",
                vec![
                    matrix.as_ref().map_or(Value::Null, |m| numbers(m)),
                    bbox.as_ref().map_or(Value::Null, |b| numbers(b)),
                ],
            ),
            Op::FormEnd => ("paintFormXObjectEnd", vec![]),
            Op::BeginGroup(group) => ("beginGroup", vec![group_value(group)]),
            Op::EndGroup(group) => ("endGroup", vec![group_value(group)]),
            Op::PaintImage(image) => {
                with_ctm = true;
                (
                    "paintImageXObject",
                    vec![
                        json!(norm(&image.id)),
                        json!(image.width),
                        json!(image.height),
                    ],
                )
            }
            Op::PaintInlineImage(image) => {
                with_ctm = true;
                (
                    "paintInlineImageXObject",
                    vec![json!(image.width), json!(image.height)],
                )
            }
            Op::PaintImageMask(image) => {
                with_ctm = true;
                (
                    "paintImageMaskXObject",
                    vec![json!(image.width), json!(image.height)],
                )
            }
            Op::PaintSolidColorImageMask => ("paintSolidColorImageMask", vec![]),
            Op::BeginMarkedContent(tag) => ("beginMarkedContent", vec![json!(tag)]),
            Op::BeginMarkedContentProps { tag, data } => (
                "beginMarkedContentProps",
                vec![
                    json!(tag),
                    match data {
                        MarkedData::Mcid(value) => plain(value),
                        MarkedData::OptionalContent(content) => optional_content(content),
                    },
                ],
            ),
            Op::EndMarkedContent => ("endMarkedContent", vec![]),
        };
        let mut entry = Map::new();
        entry.insert("op".into(), json!(name));
        entry.insert("args".into(), Value::Array(args));
        if with_ctm {
            entry.insert("ctm".into(), numbers(&ctm));
        }
        out.push(Value::Object(entry));
    }
    Value::Array(out)
}

fn dest_value(dest: &Option<Dest>) -> Value {
    match dest {
        None => Value::Null,
        Some(Dest::Named(name)) => json!(name),
        Some(Dest::Explicit(items)) => Value::Array(items.iter().map(plain).collect()),
    }
}

/// `pageOfDest` of the recorder: the 1-based page a destination opens, `null` when it opens none.
fn page_of(document: &Document, dest: &Option<Dest>) -> Value {
    let explicit: Option<Vec<Obj>> = match dest {
        Some(Dest::Named(name)) => outline_read::get_destination(document, name).unwrap_or(None),
        Some(Dest::Explicit(items)) => Some(items.clone()),
        None => None,
    };
    match explicit.as_ref().and_then(|items| items.first()) {
        Some(Obj::Ref(reference)) => outline_read::get_page_index(document, *reference)
            .map_or(Value::Null, |index| json!(index + 1)),
        Some(other) => other.as_int().map_or(Value::Null, |n| json!(n + 1)),
        None => Value::Null,
    }
}

fn reduce_annotations(document: &Document, page: &mixdog_pdf::page::Page) -> Value {
    let list = annotations::get_annotations(document, page).expect("annotations");
    Value::Array(
        list.iter()
            .map(|a| {
                json!({
                    "id": a.id,
                    "subtype": a.subtype,
                    "rect": a.rect.as_ref().map(|r| numbers(r)),
                    "flags": a.annotation_flags,
                    "contents": a.contents,
                    "hasAppearance": a.has_appearance,
                    "quadPoints": a.quad_points.as_ref().map(|q| numbers(q)),
                    "url": a.action.url,
                    "unsafeUrl": a.action.unsafe_url,
                    "dest": dest_value(&a.action.dest),
                    "action": a.action.action,
                    "newWindow": a.action.new_window,
                    "setOCGState": a.action.set_ocg_state.as_ref().map(|s| json!({"state": s.state, "preserveRB": s.preserve_rb})),
                    "resetForm": a.action.reset_form.as_ref().map(|r| json!({"fields": r.fields, "refs": r.refs, "include": r.include})),
                    "page": page_of(document, &a.action.dest),
                })
            })
            .collect(),
    )
}

fn reduce_outline(document: &Document, items: &[OutlineItem]) -> Value {
    Value::Array(
        items
            .iter()
            .map(|item| {
                json!({
                    "title": item.title,
                    "dest": dest_value(&item.dest),
                    "url": item.url,
                    "unsafeUrl": item.unsafe_url,
                    "action": item.action,
                    "newWindow": item.new_window,
                    "setOCGState": item.set_ocg_state.as_ref().map(|s| json!({"state": s.state, "preserveRB": s.preserve_rb})),
                    "color": numbers(&item.color.map(f64::from)),
                    "count": item.count,
                    "bold": item.bold,
                    "italic": item.italic,
                    "page": page_of(document, &item.dest),
                    "items": reduce_outline(document, &item.items),
                })
            })
            .collect(),
    )
}

/// What the recorder's `record` returns for one document.
fn replay(pdf: &[u8], links: bool, names: &[String]) -> Value {
    let document =
        Document::open(pdf.to_vec(), &OpenOptions::default()).expect("the generated PDF opens");
    let mut pages = Vec::new();
    for index in 0..usize::try_from(document.num_pages()).expect("pages") {
        let page = document.page(index).expect("page");
        let mut entry = Map::new();
        entry.insert("viewport".into(), numbers(&page.viewport(1.0).transform));
        if links {
            entry.insert("annots".into(), reduce_annotations(&document, &page));
        } else {
            let list = oplist::get_operator_list(&document, &page, None).expect("operator list");
            entry.insert("ops".into(), reduce_ops(&list));
        }
        pages.push(Value::Object(entry));
    }
    let mut result = Map::new();
    result.insert("pages".into(), Value::Array(pages));
    if links {
        let outline = outline_read::get_outline(&document)
            .expect("outline")
            .unwrap_or_default();
        result.insert("outline".into(), reduce_outline(&document, &outline));
        let mut dests = Map::new();
        for name in names {
            let dest = outline_read::get_destination(&document, name).expect("destination");
            dests.insert(
                name.clone(),
                dest.map_or(Value::Null, |items| {
                    Value::Array(items.iter().map(plain).collect())
                }),
            );
        }
        result.insert("dests".into(), Value::Object(dests));
    }
    Value::Object(result)
}

/// Every number as a double: JSON written by Node has integers where this side has floats.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Number(n) => n.as_f64().map_or(Value::Null, |f| json!(f)),
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), canonical(v))).collect())
        }
        other => other.clone(),
    }
}

#[test]
fn operator_lists_annotations_and_outline_equal_pdfjs() {
    let golden = twin::load_golden(SET);
    let names: Vec<String> = golden["destNames"]
        .as_array()
        .expect("destNames")
        .iter()
        .map(|n| n.as_str().expect("name").to_owned())
        .collect();
    let documents = golden["documents"].as_array().expect("documents");
    assert!(documents.len() >= 10, "the recording has too few documents");
    let mut problems = Vec::new();
    for document in documents {
        let name = document["name"].as_str().expect("name");
        let links = document["links"].as_bool().expect("links");
        let pdf = unhex(document["pdf"].as_str().expect("pdf"));
        let produced = replay(&pdf, links, &names);
        let found = twin::differences(&canonical(&document["recorded"]), &canonical(&produced));
        problems.extend(found.into_iter().take(8).map(|d| format!("{name}{d}")));
    }
    assert!(
        problems.is_empty(),
        "differences from pdf.js:\n{}",
        problems.join("\n")
    );
}

/// Re-records with Node and compares: runs `node` on this machine (the tree named by `MIXDOG_NODE_TREE`, else this
/// checkout), so it is ignored by default.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_oplist() {
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
