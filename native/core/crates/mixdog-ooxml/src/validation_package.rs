//! `portable/portable-validation-package.mjs`: package-level validation of a portable OOXML file: every XML part parsed,
//! content types, relationships and their targets, presentation structures PowerPoint refuses, the parts a rewrite must
//! carry through untouched (checked against the opened source), and the redlining audit and lint of a Word document. The
//! answer is the object the tools hand the model, key for key.
//!
//! An XML part is parsed the way `new JSDOM(xml, { contentType: 'text/xml' })` parses it (`saxes` 6 with jsdom's options),
//! and a part that fails is reported with the parser's own text, line and column included; [`xml_parse_error`] is that
//! check, ported rule by rule rather than through another XML library, whose messages differ.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_js::js_to_lowercase;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::docx_revisions::{Story, StoryParts, audit_docx_redlining_stories, lint_docx_revisions};
use crate::opc::{part_relationship_path, posix, relationship_target};
use crate::package::load_package;
use crate::xml::{compiled, ooxml_required, xml_attribute, xml_decode};
use crate::zipio::Package;

/// What the caller says about the file besides its path.
#[derive(Debug, Clone, Copy, Default)]
pub struct ValidateOptions<'a> {
    /// The source file the package was edited from; empty when there is none.
    pub original: &'a str,
    /// The backend that saved the file (`microsoft-office-com` when the Office application itself did).
    pub saved_by: &'a str,
    /// `redlining` asks for the audit of tracked changes against the source.
    pub audit_profile: &'a str,
    /// The author every new tracked change must carry.
    pub author: &'a str,
}

/// The message `new JSDOM(xml, { contentType: 'text/xml' })` throws for a part that is not well-formed XML, `None` when it
/// is. The text is `saxes`' with jsdom's file name and the position of the fault: `about:blank:LINE:COLUMN: message`.
pub fn xml_parse_error(xml: &str) -> Option<String> {
    saxes::first_error(xml)
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `inspectXmlParts`: every `.xml` and `.rels` part that does not parse, with the parser's message.
fn inspect_xml_parts(zip: &Package, entries: &[String]) -> Vec<Value> {
    let xml_part = compiled(r"\.(?:xml|rels)$", "i");
    entries
        .iter()
        .filter(|name| xml_part.is_match(name))
        .filter_map(|name| xml_parse_error(&zip.text(name)).map(|error| json!({ "part": name, "error": error })))
        .collect()
}

/// The attribute text of every `<Relationship ...>` tag of a relationships part.
fn relationship_tags(xml: &str) -> Vec<String> {
    compiled(r"<Relationship\b([^>]+?)\/?>", "gi").captures_iter(xml).map(|found| found.get(1).unwrap_or("").to_owned()).collect()
}

/// `path.posix.extname(name)` without its dot.
fn extension_of(name: &str) -> &str {
    let base = name.rsplit('/').next().unwrap_or("");
    match base.rfind('.') {
        Some(at) if at > 0 && base != ".." => &base[at + 1..],
        _ => "",
    }
}

struct ContentTypes {
    missing: Vec<String>,
    main_part: String,
    main_content_type: String,
    main_missing: bool,
}

impl ContentTypes {
    fn write(&self, into: &mut Map<String, Value>) {
        into.insert("missingContentTypes".into(), json!(self.missing));
        into.insert("mainPart".into(), json!(self.main_part));
        into.insert("mainContentType".into(), json!(self.main_content_type));
        into.insert("mainContentTypeMissing".into(), json!(self.main_missing));
    }
}

fn content_type_coverage(entries: &[String], xml: &str, format: &str) -> ContentTypes {
    let mut defaults: HashMap<String, String> = HashMap::new();
    let mut overrides: HashMap<String, String> = HashMap::new();
    for found in compiled(r"<Default\b([^>]*?)\/?>", "gi").captures_iter(xml) {
        let attrs = found.get(1).unwrap_or("");
        defaults.insert(js_to_lowercase(&xml_attribute(attrs, "Extension")), xml_attribute(attrs, "ContentType"));
    }
    let leading_slashes = compiled(r"^\/+", "");
    for found in compiled(r"<Override\b([^>]*?)\/?>", "gi").captures_iter(xml) {
        let attrs = found.get(1).unwrap_or("");
        let part = xml_attribute(attrs, "PartName");
        let key = leading_slashes.replace_all_with(&part, |_| String::new());
        overrides.insert(key, xml_attribute(attrs, "ContentType"));
    }
    let missing = entries
        .iter()
        .filter(|name| {
            if name.as_str() == "[Content_Types].xml" || overrides.contains_key(name.as_str()) {
                return false;
            }
            let extension = if js_to_lowercase(name).ends_with(".rels") { "rels".to_owned() } else { js_to_lowercase(extension_of(name)) };
            extension.is_empty() || !defaults.contains_key(&extension)
        })
        .cloned()
        .collect();
    let main_part = ooxml_required(format).map_or("", |required| required[1]).to_owned();
    let main_content_type = overrides.get(&main_part).cloned().unwrap_or_default();
    let main_missing = !main_part.is_empty() && main_content_type.is_empty();
    ContentTypes { missing, main_part, main_content_type, main_missing }
}

/// The chart data workbooks a package's chart relationships point at (native chart evidence, not activatable objects).
fn chart_workbooks_of(zip: &Package, entries: &[String]) -> HashSet<String> {
    let chart_rels = compiled(r"(?:^|\/)charts\/_rels\/chart[^/]*\.xml\.rels$", "i");
    let package_type = compiled(r"\/package$", "i");
    let mut workbooks = HashSet::new();
    for rel_path in entries.iter().filter(|name| chart_rels.is_match(name)) {
        for attrs in relationship_tags(&zip.text(rel_path)) {
            if !package_type.is_match(&xml_attribute(&attrs, "Type")) {
                continue;
            }
            let target = xml_attribute(&attrs, "Target");
            let directory = posix::dirname(&rel_path.replacen("_rels/", "", 1));
            workbooks.insert(posix::normalize(&posix::join(&[directory.as_str(), target.as_str()])));
        }
    }
    workbooks
}

// The parts a rewrite must carry through untouched. When the Office application itself saved the file (the background
// backend), masters, layouts and themes are normalised by that save and a chart's data workbook may be renumbered
// (Microsoft_Excel_Worksheet2.xlsx -> Microsoft_Excel_Worksheet.xlsx): those are the application's own serialisation, not
// damage, and are reported as normalised instead. Macros, signatures, ribbon customisation, external links, connections
// and embedded objects stay protected under every backend.
const PROTECTED_ALWAYS: &str =
    r"(?:^|\/)(?:vbaProject\.bin|vbaData\.xml|_xmlsignatures\/|origin\.sigs$|signatures?\.xml$|customUI\/|embeddings\/|externalLinks\/|connections\.xml$)";
const PROTECTED_UNLESS_APPLICATION_SAVED: &str = r"(?:^|\/)(?:slideMasters\/|slideLayouts\/|theme\/)";
/// The parts a digital signature is stored in.
const SIGNATURE_PART: &str = r"(?:^|\/)(?:_xmlsignatures\/|origin\.sigs$|signatures?\.xml$)";
const APPLICATION_BACKENDS: [&str; 1] = ["microsoft-office-com"];

fn matches_part(source: &str, name: &str) -> bool {
    compiled(source, "i").is_match(name)
}

/// The names of the files (not folders) of a package, in entry order.
fn package_entry_names(zip: &Package) -> Vec<String> {
    zip.entries().into_iter().filter(|entry| !entry.dir).map(|entry| entry.name.clone()).collect()
}

fn part_hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// What the comparison with the source found.
struct Baseline {
    value: Value,
    lost_protected: usize,
    changed_protected: usize,
    signature_invalidated: bool,
}

struct Comparison {
    application_saved: bool,
    original_workbooks: HashSet<String>,
    workbooks: HashSet<String>,
}

impl Comparison {
    /// A chart workbook the application renumbered is not lost while the saved package still carries one per chart.
    fn renumbered_workbook(&self, name: &str) -> bool {
        self.application_saved && self.original_workbooks.contains(name) && self.workbooks.len() >= self.original_workbooks.len()
    }

    /// A chart's data workbook its chart still names is that chart's own data: set_chart_data rewrites it on either
    /// backend, and the portable path's chart edit failed finalize as a changed embedded object. Renumbered or dropped by
    /// another backend, it stays protected.
    fn chart_data_rewritten(&self, name: &str) -> bool {
        self.original_workbooks.contains(name) && self.workbooks.contains(name)
    }

    fn is_protected(&self, name: &str) -> bool {
        matches_part(PROTECTED_ALWAYS, name) || (!self.application_saved && matches_part(PROTECTED_UNLESS_APPLICATION_SAVED, name))
    }

    fn application_normalized(&self, name: &str) -> bool {
        self.application_saved && (matches_part(PROTECTED_UNLESS_APPLICATION_SAVED, name) || self.renumbered_workbook(name))
    }
}

fn baseline_package<P: ReadProof>(proof: &P, zip: &Package, options: &ValidateOptions<'_>, workbooks: &HashSet<String>) -> Result<Baseline, String> {
    if options.original.is_empty() {
        return Ok(Baseline { value: json!({ "compared": false }), lost_protected: 0, changed_protected: 0, signature_invalidated: false });
    }
    let original_zip = load_package(proof, Path::new(options.original))?;
    let application_saved = APPLICATION_BACKENDS.contains(&options.saved_by);
    let current_entries = package_entry_names(zip);
    let current_set: HashSet<&str> = current_entries.iter().map(String::as_str).collect();
    let original_entries = package_entry_names(&original_zip);
    let comparison = Comparison { application_saved, original_workbooks: chart_workbooks_of(&original_zip, &original_entries), workbooks: workbooks.clone() };
    let protected_parts: Vec<&String> = original_entries.iter().filter(|name| comparison.is_protected(name) && !comparison.renumbered_workbook(name)).collect();
    // Every original part against the saved copy: the protected ones that changed, the ones the application itself
    // rewrote or dropped, and everything that differs.
    let mut changed_protected: Vec<Value> = Vec::new();
    let mut normalized: Vec<&String> = Vec::new();
    let mut changed_parts = 0;
    for name in &original_entries {
        let Some(current) = zip.file(name) else {
            if comparison.application_normalized(name) {
                normalized.push(name);
            }
            continue;
        };
        let before = part_hash(original_zip.file(name).unwrap_or_default());
        let after = part_hash(current);
        if before == after {
            continue;
        }
        changed_parts += 1;
        if comparison.is_protected(name) && !comparison.renumbered_workbook(name) && !comparison.chart_data_rewritten(name) {
            changed_protected.push(json!({ "part": name, "before": before, "after": after }));
        } else if comparison.application_normalized(name) {
            normalized.push(name);
        }
    }
    let signature_parts: Vec<&String> = original_entries.iter().filter(|name| matches_part(SIGNATURE_PART, name)).collect();
    let lost: Vec<&&String> = protected_parts.iter().filter(|name| !current_set.contains(name.as_str())).collect();
    let signature_invalidated = !signature_parts.is_empty() && changed_parts > 0;
    let added: Vec<&String> = current_entries.iter().filter(|name| original_zip.file(name).is_none()).collect();
    let value = json!({
        "compared": true,
        "original": options.original,
        "savedBy": options.saved_by,
        "applicationSaved": application_saved,
        "originalEntries": original_entries.len(),
        "addedParts": added,
        "lostProtectedParts": lost,
        "changedProtectedParts": changed_protected,
        "applicationNormalizedParts": normalized,
        "signatureParts": signature_parts,
        "digitalSignatureInvalidated": signature_invalidated,
    });
    Ok(Baseline { value, lost_protected: lost.len(), changed_protected: changed_protected.len(), signature_invalidated })
}

const DOCX_STORY_PART: &str = r"^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$";

/// Every story part by name: the audit compares each one with its source counterpart, so a header edited untracked is
/// caught like the body.
fn docx_story_parts(zip: &Package) -> StoryParts {
    let story = compiled(DOCX_STORY_PART, "i");
    zip.names()
        .into_iter()
        .filter(|name| story.is_match(name))
        .map(|name| {
            let text = zip.text(&name);
            (name, text)
        })
        .collect()
}

fn validate_docx_redlining<P: ReadProof>(proof: &P, story_parts: &StoryParts, original_path: &str, author: &str) -> Value {
    if original_path.is_empty() {
        return json!({ "requested": true, "ok": false, "reason": "Redlining audit requires an opened source document." });
    }
    match load_package(proof, Path::new(original_path)) {
        Ok(original) => audit_docx_redlining_stories(story_parts, &docx_story_parts(&original), author).to_value(),
        Err(reason) => json!({ "requested": true, "ok": false, "reason": reason }),
    }
}

/// Every `.rels` part: duplicate ids, external targets, and targets that do not resolve to a package entry.
struct RelationshipIssues {
    missing: Vec<Value>,
    duplicate_ids: Vec<Value>,
    external: Vec<Value>,
}

fn relationship_issues(zip: &Package, entries: &[String]) -> RelationshipIssues {
    let mut issues = RelationshipIssues { missing: Vec::new(), duplicate_ids: Vec::new(), external: Vec::new() };
    for rel_path in entries.iter().filter(|name| name.ends_with(".rels")) {
        let mut ids: HashSet<String> = HashSet::new();
        for attrs in relationship_tags(&zip.text(rel_path)) {
            let id = xml_attribute(&attrs, "Id");
            let target = xml_attribute(&attrs, "Target");
            let mode = xml_attribute(&attrs, "TargetMode");
            if !id.is_empty() && ids.contains(&id) {
                issues.duplicate_ids.push(json!({ "relationship": rel_path, "id": id }));
            }
            if !id.is_empty() {
                ids.insert(id.clone());
            }
            if js_to_lowercase(&mode) == "external" {
                issues.external.push(json!({ "relationship": rel_path, "id": id, "target": xml_decode(&target) }));
                continue;
            }
            let resolved = relationship_target(rel_path, &target);
            if resolved.is_empty() || resolved.starts_with("../") || zip.file(&resolved).is_none() {
                issues.missing.push(json!({ "relationship": rel_path, "id": id, "target": xml_decode(&target), "resolved": resolved }));
            }
        }
    }
    issues
}

/// A relationship of a part with its target resolved to a package path.
struct PartRelationship {
    id: String,
    kind: String,
    external: bool,
    part: String,
}

/// A part's relationships with their targets resolved to package paths; `None` when the part has no relationships part.
fn part_relationships(zip: &Package, part: &str) -> Option<Vec<PartRelationship>> {
    let rel_path = part_relationship_path(part);
    let xml = zip.text(&rel_path);
    if xml.is_empty() {
        return None;
    }
    Some(
        relationship_tags(&xml)
            .iter()
            .map(|attrs| PartRelationship {
                id: xml_attribute(attrs, "Id"),
                kind: xml_attribute(attrs, "Type"),
                external: js_to_lowercase(&xml_attribute(attrs, "TargetMode")) == "external",
                part: relationship_target(&rel_path, &xml_attribute(attrs, "Target")),
            })
            .collect(),
    )
}

const PRESENTATION_MASTER: &str = r"^ppt\/(slideMasters|notesMasters|handoutMasters)\/(?:slide|notes|handout)Master(\d+)\.xml$";

fn master_order(name: &str) -> f64 {
    let Some(found) = compiled(PRESENTATION_MASTER, "").captures(name) else { return 0.0 };
    let group = match found.get(1) {
        Some("slideMasters") => 0.0,
        Some("notesMasters") => 1.0,
        _ => 2.0,
    };
    group * 1e6 + found.get(2).and_then(|digits| digits.parse::<f64>().ok()).unwrap_or(0.0)
}

fn fault(code: &str, part: &str, message: String) -> Value {
    json!({ "code": code, "part": part, "message": message })
}

/// Structures PowerPoint refuses to open, or opens only through a repair prompt, although every part and relationship
/// resolves: a slide on two layouts, one notes page claimed by two slides, a master listing a layout its relationships do
/// not name, and two masters sharing one theme part.
fn presentation_faults(zip: &Package, entries: &[String]) -> Vec<Value> {
    let mut faults = Vec::new();
    let mut notes_owners: HashMap<String, String> = HashMap::new();
    let slide_part = compiled(r"^ppt\/slides\/slide\d+\.xml$", "");
    for slide in entries.iter().filter(|name| slide_part.is_match(name)) {
        let relationships = part_relationships(zip, slide).unwrap_or_default();
        let layouts = relationships.iter().filter(|entry| entry.kind.ends_with("/slideLayout")).count();
        if layouts > 1 {
            faults.push(fault("slide_layout_duplicated", slide, format!("{slide} names {layouts} slide layouts; a slide has exactly one.")));
        }
        for notes in relationships.iter().filter(|entry| entry.kind.ends_with("/notesSlide") && !entry.external) {
            match notes_owners.get(&notes.part) {
                Some(owner) if !owner.is_empty() => {
                    faults.push(fault("notes_slide_shared", &notes.part, format!("{owner} and {slide} share {}; each slide owns its notes page.", notes.part)))
                }
                _ => {
                    notes_owners.insert(notes.part.clone(), slide.clone());
                }
            }
        }
    }
    // pptxgenjs points the notes master at the slide master's theme. PowerPoint opens that deck only while
    // <p:notesMasterIdLst> directly follows <p:sldIdLst>.
    let presentation = compiled(r"<!--[\s\S]*?-->", "g").replace_all_with(&zip.text("ppt/presentation.xml"), |_| String::new());
    let notes_share_tolerated = compiled(r"<p:sldIdLst\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/p:sldIdLst\s*>)\s*<p:notesMasterIdLst\b", "").is_match(&presentation);
    let mut theme_owners: HashMap<String, String> = HashMap::new();
    let master_part = compiled(PRESENTATION_MASTER, "");
    let mut masters: Vec<&String> = entries.iter().filter(|name| master_part.is_match(name)).collect();
    masters.sort_by(|left, right| master_order(left).total_cmp(&master_order(right)));
    for master in masters {
        let Some(relationships) = part_relationships(zip, master) else { continue };
        if master.starts_with("ppt/slideMasters/") {
            let layout_ids: HashSet<&str> = relationships.iter().filter(|entry| entry.kind.ends_with("/slideLayout")).map(|entry| entry.id.as_str()).collect();
            for found in compiled(r"<p:sldLayoutId\b([^>]*?)\/?>", "g").captures_iter(&zip.text(master)) {
                let id = xml_attribute(found.get(1).unwrap_or(""), "r:id");
                if !id.is_empty() && !layout_ids.contains(id.as_str()) {
                    faults.push(fault(
                        "layout_reference_missing",
                        master,
                        format!("{master} lists layout {id}, which its relationships do not name as a slide layout."),
                    ));
                }
            }
        }
        let theme = relationships.iter().find(|entry| entry.kind.ends_with("/theme") && !entry.external).map(|entry| entry.part.as_str());
        let Some(theme) = theme.filter(|theme| !theme.is_empty() && zip.file(theme).is_some()) else { continue };
        let Some(owner) = theme_owners.get(theme) else {
            theme_owners.insert(theme.to_owned(), master.clone());
            continue;
        };
        let notes_master = master.starts_with("ppt/notesMasters/");
        if notes_master && notes_share_tolerated {
            continue;
        }
        let advice = if notes_master {
            "move <p:notesMasterIdLst> to directly after <p:sldIdLst> in ppt/presentation.xml, or give the notes master its own theme."
        } else {
            "give each master its own theme part."
        };
        faults.push(fault("master_theme_shared", master, format!("{master} shares {theme} with {owner}; {advice}")));
    }
    faults
}

fn package_entry_findings(entries: &[String], chart_workbooks: &HashSet<String>) -> PackageFindings {
    let drive_letter = compiled(r"^[A-Za-z]:", "");
    let of = |source: &str| -> Vec<String> { entries.iter().filter(|name| matches_part(source, name)).cloned().collect() };
    PackageFindings {
        unsafe_entries: entries.iter().filter(|name| name.contains("..") || name.starts_with('/') || drive_letter.is_match(name)).cloned().collect(),
        macros: of(r"vbaProject\.bin$"),
        signatures: of(SIGNATURE_PART),
        external_links: of(r"(?:^|\/)externalLinks\/"),
        data_connections: of(r"(?:^|\/)connections\.xml$"),
        // A chart's data workbook is native chart evidence, not an activatable object: it is excluded from the
        // embedded-object security finding.
        embedded_objects: entries
            .iter()
            .filter(|name| matches_part(r"(?:^|\/)embeddings\/", name) && !chart_workbooks.contains(name.as_str()))
            .cloned()
            .collect(),
    }
}

struct PackageFindings {
    unsafe_entries: Vec<String>,
    macros: Vec<String>,
    signatures: Vec<String>,
    external_links: Vec<String>,
    data_connections: Vec<String>,
    embedded_objects: Vec<String>,
}

/// `validatePortableOoxml(path, format, options)`: the package at `path` checked as a `format` (`docx`, `xlsx`, `pptx`)
/// file. An error (the reason the package cannot be opened) only when the file or the source named in `options` cannot be
/// read as a package; every fault of an openable one is part of the answer.
pub fn validate_portable_ooxml<P: ReadProof>(proof: &P, path: &Path, format: &str, options: &ValidateOptions<'_>) -> Result<Value, String> {
    let zip = load_package(proof, path)?;
    let entries = package_entry_names(&zip);
    let missing: Vec<&str> = ooxml_required(format).into_iter().flatten().filter(|name| zip.file(name).is_none()).collect();
    let chart_workbooks = chart_workbooks_of(&zip, &entries);
    let findings = package_entry_findings(&entries, &chart_workbooks);
    let malformed_xml = inspect_xml_parts(&zip, &entries);
    let content_types = content_type_coverage(&entries, &zip.text("[Content_Types].xml"), format);
    let relationships = relationship_issues(&zip, &entries);
    let presentation = if format == "pptx" { presentation_faults(&zip, &entries) } else { Vec::new() };
    let baseline = baseline_package(proof, &zip, options, &chart_workbooks)?;
    // The lint and the redlining audit read the same story parts; reading them once keeps a redlining docx from unpacking
    // every story twice.
    let story_parts = (format == "docx").then(|| docx_story_parts(&zip));
    let document_lint = story_parts.as_ref().map_or_else(Vec::new, |parts| {
        let stories: Vec<Story<'_>> = parts.iter().map(|(part, xml)| Story { part, xml }).collect();
        lint_docx_revisions(&stories, &zip.text("word/comments.xml"))
    });
    let redlining = match &story_parts {
        Some(parts) if options.audit_profile == "redlining" => Some(validate_docx_redlining(proof, parts, options.original, options.author)),
        _ => None,
    };
    let ok = missing.is_empty()
        && presentation.is_empty()
        && !document_lint.iter().any(|finding| finding.severity == "error")
        && findings.unsafe_entries.is_empty()
        && malformed_xml.is_empty()
        && content_types.missing.is_empty()
        && !content_types.main_missing
        && relationships.missing.is_empty()
        && relationships.duplicate_ids.is_empty()
        && baseline.lost_protected == 0
        && baseline.changed_protected == 0
        && !baseline.signature_invalidated
        && redlining.as_ref().is_none_or(|audit| audit["ok"].as_bool() == Some(true));
    let mut answer = Map::new();
    answer.insert("ok".into(), json!(ok));
    answer.insert("format".into(), json!(format));
    answer.insert("entries".into(), json!(entries.len()));
    answer.insert("missing".into(), json!(missing));
    answer.insert("unsafeEntries".into(), json!(findings.unsafe_entries));
    answer.insert("macros".into(), json!(findings.macros));
    answer.insert(
        "security".into(),
        json!({
            "macros": findings.macros,
            "signatures": findings.signatures,
            "externalLinks": findings.external_links,
            "dataConnections": findings.data_connections,
            "embeddedObjects": findings.embedded_objects,
            "macroExecution": "disabled",
            "digitalSignatureInvalidated": baseline.signature_invalidated,
        }),
    );
    answer.insert("malformedXml".into(), Value::Array(malformed_xml));
    answer.insert("missingRelationships".into(), Value::Array(relationships.missing));
    answer.insert("duplicateRelationshipIds".into(), Value::Array(relationships.duplicate_ids));
    answer.insert("externalRelationships".into(), Value::Array(relationships.external));
    answer.insert("presentationFaults".into(), Value::Array(presentation));
    content_types.write(&mut answer);
    answer.insert("baseline".into(), baseline.value);
    answer.insert("redlining".into(), redlining.unwrap_or(Value::Null));
    answer.insert("documentLint".into(), Value::Array(document_lint.iter().map(|finding| finding.to_value()).collect()));
    answer.insert("validation".into(), json!("opc-relationships-content-types-xml"));
    Ok(Value::Object(answer))
}

/// The XML parser `new JSDOM(xml, { contentType: 'text/xml' })` runs a part through, which is `saxes` 6.0.0 with the
/// options jsdom gives it (namespaces on, XML 1.0 forced, the file name `about:blank`) and an error handler that throws:
/// the first rule a part breaks is the one reported, with `saxes`' own text and its `line:column` prefix. Only the
/// well-formedness rules are kept: the events jsdom turns into a DOM cannot fail, except for a doctype whose name
/// jsdom cannot read. A rule is checked where `saxes` checks it, so the first of two faults is the same one.
mod saxes {
    use std::collections::HashMap;

    use mixdog_js::{js_to_lowercase, js_trim, utf16_len};

    use crate::xml::compiled;

    /// End of the chunk, and a line break that was not written as `\n` (`\r`, `\r\n`).
    const EOC: i32 = -1;
    const NL_LIKE: i32 = -2;

    const TAB: i32 = 0x9;
    const NL: i32 = 0xA;
    const CR: i32 = 0xD;
    const SPACE: i32 = 0x20;
    const BANG: i32 = 0x21;
    const DQUOTE: i32 = 0x22;
    const AMP: i32 = 0x26;
    const SQUOTE: i32 = 0x27;
    const MINUS: i32 = 0x2D;
    const FORWARD_SLASH: i32 = 0x2F;
    const SEMICOLON: i32 = 0x3B;
    const LESS: i32 = 0x3C;
    const EQUAL: i32 = 0x3D;
    const GREATER: i32 = 0x3E;
    const QUESTION: i32 = 0x3F;
    const OPEN_BRACKET: i32 = 0x5B;
    const CLOSE_BRACKET: i32 = 0x5D;

    const XML_NAMESPACE: &str = "http://www.w3.org/XML/1998/namespace";
    const XMLNS_NAMESPACE: &str = "http://www.w3.org/2000/xmlns/";

    const DOCTYPE_TERMINATOR: [i32; 4] = [DQUOTE, SQUOTE, OPEN_BRACKET, GREATER];
    const DTD_TERMINATOR: [i32; 4] = [DQUOTE, SQUOTE, LESS, CLOSE_BRACKET];
    const XML_DECL_NAME_TERMINATOR: [i32; 6] = [EQUAL, QUESTION, SPACE, NL, CR, TAB];

    fn is_quote(c: i32) -> bool {
        c == DQUOTE || c == SQUOTE
    }

    /// `isS` of the XML 1.0 grammar.
    fn is_s(c: i32) -> bool {
        c == SPACE || c == NL || c == CR || c == TAB
    }

    /// `isChar` of XML 1.0 (fifth edition).
    fn is_char(c: u64) -> bool {
        (0x20..=0xD7FF).contains(&c) || c == 0xA || c == 0xD || c == 0x9 || (0xE000..=0xFFFD).contains(&c) || (0x10000..=0x10FFFF).contains(&c)
    }

    fn is_ncname_start_char(c: i32) -> bool {
        (0x41..=0x5A).contains(&c)
            || c == 0x5F
            || (0x61..=0x7A).contains(&c)
            || (0xC0..=0xD6).contains(&c)
            || (0xD8..=0xF6).contains(&c)
            || (0xF8..=0x2FF).contains(&c)
            || (0x370..=0x37D).contains(&c)
            || (0x37F..=0x1FFF).contains(&c)
            || (0x200C..=0x200D).contains(&c)
            || (0x2070..=0x218F).contains(&c)
            || (0x2C00..=0x2FEF).contains(&c)
            || (0x3001..=0xD7FF).contains(&c)
            || (0xF900..=0xFDCF).contains(&c)
            || (0xFDF0..=0xFFFD).contains(&c)
            || (0x10000..=0xEFFFF).contains(&c)
    }

    fn is_ncname_char(c: i32) -> bool {
        is_ncname_start_char(c)
            || c == 0x2D
            || c == 0x2E
            || (0x30..=0x39).contains(&c)
            || c == 0xB7
            || (0x300..=0x36F).contains(&c)
            || (0x203F..=0x2040).contains(&c)
    }

    /// `isNameStartChar`: the NCName start characters and the colon.
    fn is_name_start_char(c: i32) -> bool {
        c == 0x3A || is_ncname_start_char(c)
    }

    fn is_name_char(c: i32) -> bool {
        c == 0x3A || is_ncname_char(c)
    }

    /// `NC_NAME_RE.test(name)`.
    fn is_ncname(name: &str) -> bool {
        let mut chars = name.chars();
        chars.next().is_some_and(|first| is_ncname_start_char(first as i32)) && chars.all(|c| is_ncname_char(c as i32))
    }

    fn code_point(c: i32) -> char {
        u32::try_from(c).ok().and_then(char::from_u32).unwrap_or('\u{fffd}')
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum State {
        Begin,
        BeginWhitespace,
        Doctype,
        DoctypeQuote,
        Dtd,
        DtdQuoted,
        DtdOpenWaka,
        DtdOpenWakaBang,
        DtdComment,
        DtdCommentEnding,
        DtdCommentEnded,
        DtdPi,
        DtdPiEnding,
        Text,
        Entity,
        OpenWaka,
        OpenWakaBang,
        Comment,
        CommentEnding,
        CommentEnded,
        CData,
        CDataEnding,
        CDataEnding2,
        PiFirstChar,
        PiRest,
        PiBody,
        PiEnding,
        XmlDeclNameStart,
        XmlDeclName,
        XmlDeclEq,
        XmlDeclValueStart,
        XmlDeclValue,
        XmlDeclSeparator,
        XmlDeclEnding,
        OpenTag,
        OpenTagSlash,
        Attrib,
        AttribName,
        AttribNameSawWhite,
        AttribValue,
        AttribValueQuoted,
        AttribValueClosed,
        CloseTag,
        CloseTagSawWhite,
    }

    /// The `]]>` tracker of character data.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Forbidden {
        Start,
        Bracket,
        BracketBracket,
    }

    /// An element being opened or open: its name and the namespace prefixes it declares.
    struct Tag {
        name: String,
        ns: HashMap<String, String>,
    }

    struct Attribute {
        name: String,
        prefix: String,
        local: String,
    }

    type Outcome = Result<(), String>;

    struct Parser {
        chunk: Vec<char>,
        i: usize,
        prev_i: usize,
        line: u64,
        column: u64,
        state: State,
        text: String,
        name: String,
        pi_target: String,
        entity: String,
        q: i32,
        tags: Vec<Tag>,
        /// The tag whose start is being read; it joins `tags` when the start is complete.
        tag: Option<Tag>,
        open_waka_bang: String,
        forbidden: Forbidden,
        attrib_list: Vec<Attribute>,
        xml_decl_possible: bool,
        xml_decl_expects: Vec<&'static str>,
        entity_return_state: State,
        closed_root: bool,
        saw_root: bool,
        doctype: bool,
        entities: HashMap<String, String>,
    }

    /// The message `saxes` throws for the first well-formedness fault of `xml`, `None` for a well-formed document.
    pub(super) fn first_error(xml: &str) -> Option<String> {
        let mut chars: Vec<char> = xml.chars().collect();
        // A trailing CR is carried to the closing call, where it is read as the line break it is.
        let carried = if chars.last() == Some(&'\r') { chars.pop() } else { None };
        let mut parser = Parser::new();
        parse(&mut parser, chars, carried.into_iter().collect()).err()
    }

    fn parse(parser: &mut Parser, written: Vec<char>, closing: Vec<char>) -> Outcome {
        parser.run(written)?;
        parser.run(closing)?;
        parser.end()
    }

    impl Parser {
        fn new() -> Self {
            let entities = [("amp", "&"), ("gt", ">"), ("lt", "<"), ("quot", "\""), ("apos", "'")]
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value.to_owned()))
                .collect();
            Self {
                chunk: Vec::new(),
                i: 0,
                prev_i: 0,
                line: 1,
                column: 0,
                state: State::Begin,
                text: String::new(),
                name: String::new(),
                pi_target: String::new(),
                entity: String::new(),
                q: 0,
                tags: Vec::new(),
                tag: None,
                open_waka_bang: String::new(),
                forbidden: Forbidden::Start,
                attrib_list: Vec::new(),
                xml_decl_possible: true,
                xml_decl_expects: vec!["version"],
                entity_return_state: State::Text,
                closed_root: false,
                saw_root: false,
                doctype: false,
                entities,
            }
        }

        /// `fail`: the error handler throws, so the first fault ends the parse.
        fn fail<T>(&self, message: &str) -> Result<T, String> {
            Err(format!("about:blank:{}:{}: {message}", self.line, self.column))
        }

        /// One chunk of the input (`write`).
        fn run(&mut self, chunk: Vec<char>) -> Outcome {
            self.chunk = chunk;
            self.i = 0;
            while self.i < self.chunk.len() {
                self.step()?;
            }
            Ok(())
        }

        fn slice(&self, from: usize, to: usize) -> String {
            let to = to.min(self.chunk.len());
            if from >= to { String::new() } else { self.chunk[from..to].iter().collect() }
        }

        fn step(&mut self) -> Outcome {
            match self.state {
                State::Begin => self.s_begin(),
                State::BeginWhitespace => self.s_begin_whitespace(),
                State::Doctype => self.s_doctype(),
                State::DoctypeQuote => self.s_doctype_quote(),
                State::Dtd => self.s_dtd(),
                State::DtdQuoted => self.s_dtd_quoted(),
                State::DtdOpenWaka => self.s_dtd_open_waka(),
                State::DtdOpenWakaBang => self.s_dtd_open_waka_bang(),
                State::DtdComment => self.s_dtd_comment(),
                State::DtdCommentEnding => self.s_dtd_comment_ending(),
                State::DtdCommentEnded => self.s_dtd_comment_ended(),
                State::DtdPi => self.s_dtd_pi(),
                State::DtdPiEnding => self.s_dtd_pi_ending(),
                State::Text => self.s_text(),
                State::Entity => self.s_entity(),
                State::OpenWaka => self.s_open_waka(),
                State::OpenWakaBang => self.s_open_waka_bang(),
                State::Comment => self.s_comment(),
                State::CommentEnding => self.s_comment_ending(),
                State::CommentEnded => self.s_comment_ended(),
                State::CData => self.s_cdata(),
                State::CDataEnding => self.s_cdata_ending(),
                State::CDataEnding2 => self.s_cdata_ending2(),
                State::PiFirstChar => self.s_pi_first_char(),
                State::PiRest => self.s_pi_rest(),
                State::PiBody => self.s_pi_body(),
                State::PiEnding => self.s_pi_ending(),
                State::XmlDeclNameStart => self.s_xml_decl_name_start(),
                State::XmlDeclName => self.s_xml_decl_name(),
                State::XmlDeclEq => self.s_xml_decl_eq(),
                State::XmlDeclValueStart => self.s_xml_decl_value_start(),
                State::XmlDeclValue => self.s_xml_decl_value(),
                State::XmlDeclSeparator => self.s_xml_decl_separator(),
                State::XmlDeclEnding => self.s_xml_decl_ending(),
                State::OpenTag => self.s_open_tag(),
                State::OpenTagSlash => self.s_open_tag_slash(),
                State::Attrib => self.s_attrib(),
                State::AttribName => self.s_attrib_name(),
                State::AttribNameSawWhite => self.s_attrib_name_saw_white(),
                State::AttribValue => self.s_attrib_value(),
                State::AttribValueQuoted => self.s_attrib_value_quoted(),
                State::AttribValueClosed => self.s_attrib_value_closed(),
                State::CloseTag => self.s_close_tag(),
                State::CloseTagSawWhite => self.s_close_tag_saw_white(),
            }
        }

        /// `getCode10`: one code point, with the position kept; a line break that is not `\n` reads as [`NL_LIKE`].
        fn get_code(&mut self) -> Result<i32, String> {
            let i = self.i;
            self.prev_i = i;
            self.i = i + 1;
            if i >= self.chunk.len() {
                return Ok(EOC);
            }
            let code = self.chunk[i] as u32;
            self.column += 1;
            if code < 0xD800 {
                let code = code as i32;
                if code >= SPACE || code == TAB {
                    return Ok(code);
                }
                return match code {
                    NL => {
                        self.line += 1;
                        self.column = 0;
                        Ok(NL)
                    }
                    CR => {
                        if self.chunk.get(i + 1) == Some(&'\n') {
                            self.i = i + 2;
                        }
                        self.line += 1;
                        self.column = 0;
                        Ok(NL_LIKE)
                    }
                    _ => self.fail("disallowed character."),
                };
            }
            if code <= 0xFFFF && !(0xE000..=0xFFFD).contains(&code) {
                return self.fail("disallowed character.");
            }
            Ok(code as i32)
        }

        /// `getCodeNorm`.
        fn get_code_norm(&mut self) -> Result<i32, String> {
            let c = self.get_code()?;
            Ok(if c == NL_LIKE { NL } else { c })
        }

        fn unget(&mut self) {
            self.i = self.prev_i;
            self.column = self.column.saturating_sub(1);
        }

        /// Adds what was read since `start` to the text.
        fn capture(&mut self, start: usize, end: usize) {
            let captured = self.slice(start, end);
            self.text.push_str(&captured);
        }

        /// `captureTo`: characters into the text up to one of `chars`, which is returned; [`EOC`] at the end of the chunk.
        fn capture_to(&mut self, chars: &[i32]) -> Result<i32, String> {
            let mut start = self.i;
            loop {
                let c = self.get_code()?;
                let is_nl_like = c == NL_LIKE;
                let last = if is_nl_like { NL } else { c };
                if last == EOC || chars.contains(&last) {
                    self.capture(start, self.prev_i);
                    return Ok(last);
                }
                if is_nl_like {
                    self.capture(start, self.prev_i);
                    self.text.push('\n');
                    start = self.i;
                }
            }
        }

        /// `captureToChar`: whether the character was met (rather than the end of the chunk).
        fn capture_to_char(&mut self, target: i32) -> Result<bool, String> {
            let mut start = self.i;
            loop {
                let mut c = self.get_code()?;
                match c {
                    NL_LIKE => {
                        self.capture(start, self.prev_i);
                        self.text.push('\n');
                        start = self.i;
                        c = NL;
                    }
                    EOC => {
                        self.capture(start, self.chunk.len());
                        return Ok(false);
                    }
                    _ => {}
                }
                if c == target {
                    self.capture(start, self.prev_i);
                    return Ok(true);
                }
            }
        }

        /// `captureNameChars`: name characters into the name; what ended them.
        fn capture_name_chars(&mut self) -> Result<i32, String> {
            let start = self.i;
            loop {
                let c = self.get_code()?;
                if c == EOC {
                    let captured = self.slice(start, self.chunk.len());
                    self.name.push_str(&captured);
                    return Ok(EOC);
                }
                if !is_name_char(c) {
                    let captured = self.slice(start, self.prev_i);
                    self.name.push_str(&captured);
                    return Ok(if c == NL_LIKE { NL } else { c });
                }
            }
        }

        fn skip_spaces(&mut self) -> Result<i32, String> {
            loop {
                let c = self.get_code_norm()?;
                if c == EOC || !is_s(c) {
                    return Ok(c);
                }
            }
        }

        fn s_begin(&mut self) -> Outcome {
            if self.chunk.first() == Some(&'\u{feff}') {
                self.i += 1;
                self.column += 1;
            }
            self.state = State::BeginWhitespace;
            Ok(())
        }

        fn s_begin_whitespace(&mut self) -> Outcome {
            let before = self.i;
            let c = self.skip_spaces()?;
            if self.prev_i != before {
                self.xml_decl_possible = false;
            }
            match c {
                LESS => self.state = State::OpenWaka,
                EOC => {}
                _ => {
                    self.unget();
                    self.state = State::Text;
                    self.xml_decl_possible = false;
                }
            }
            Ok(())
        }

        fn s_doctype(&mut self) -> Outcome {
            let c = self.capture_to(&DOCTYPE_TERMINATOR)?;
            match c {
                GREATER => {
                    let declaration = std::mem::take(&mut self.text);
                    self.doctype_event(&declaration)?;
                    self.state = State::Text;
                    self.doctype = true;
                }
                EOC => {}
                _ => {
                    self.text.push(code_point(c));
                    if c == OPEN_BRACKET {
                        self.state = State::Dtd;
                    } else if is_quote(c) {
                        self.state = State::DoctypeQuote;
                        self.q = c;
                    }
                }
            }
            Ok(())
        }

        /// The `doctype` handler of jsdom: it reads the name of the declaration with four patterns and fails on a
        /// declaration none of them reads; the entities the declaration defines are added to the parser's.
        fn doctype_event(&mut self, declaration: &str) -> Outcome {
            let html = format!("<!doctype {declaration}>");
            let readable = [
                r"<!doctype html>",
                r#"<!doctype\s+([^\s]+)\s+public\s+"([^"]+)"\s+"([^"]+)""#,
                r#"<!doctype\s+([^\s]+)\s+system\s+"([^"]+)""#,
                r"<!doctype\s+([^\s>]+)",
            ]
            .into_iter()
            .any(|source| compiled(source, "i").is_match(&html));
            if !readable {
                return Err("Cannot read properties of null (reading '1')".to_owned());
            }
            let defined = compiled(r#"<!ENTITY ([^ ]+) "([^"]+)">"#, "g");
            for found in defined.captures_iter(declaration) {
                let name = found.get(1).unwrap_or("");
                if !self.entities.contains_key(name) {
                    self.entities.insert(name.to_owned(), found.get(2).unwrap_or("").to_owned());
                }
            }
            Ok(())
        }

        fn s_doctype_quote(&mut self) -> Outcome {
            let q = self.q;
            if self.capture_to_char(q)? {
                self.text.push(code_point(q));
                self.state = State::Doctype;
            }
            Ok(())
        }

        fn s_dtd(&mut self) -> Outcome {
            let c = self.capture_to(&DTD_TERMINATOR)?;
            if c == EOC {
                return Ok(());
            }
            self.text.push(code_point(c));
            if c == CLOSE_BRACKET {
                self.state = State::Doctype;
            } else if c == LESS {
                self.state = State::DtdOpenWaka;
            } else if is_quote(c) {
                self.state = State::DtdQuoted;
                self.q = c;
            }
            Ok(())
        }

        fn s_dtd_quoted(&mut self) -> Outcome {
            let q = self.q;
            if self.capture_to_char(q)? {
                self.text.push(code_point(q));
                self.state = State::Dtd;
            }
            Ok(())
        }

        fn s_dtd_open_waka(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            self.text.push(code_point(c));
            match c {
                BANG => {
                    self.state = State::DtdOpenWakaBang;
                    self.open_waka_bang.clear();
                }
                QUESTION => self.state = State::DtdPi,
                _ => self.state = State::Dtd,
            }
            Ok(())
        }

        fn s_dtd_open_waka_bang(&mut self) -> Outcome {
            let c = code_point(self.get_code_norm()?);
            self.open_waka_bang.push(c);
            self.text.push(c);
            if self.open_waka_bang != "-" {
                self.state = if self.open_waka_bang == "--" { State::DtdComment } else { State::Dtd };
                self.open_waka_bang.clear();
            }
            Ok(())
        }

        fn s_dtd_comment(&mut self) -> Outcome {
            if self.capture_to_char(MINUS)? {
                self.text.push('-');
                self.state = State::DtdCommentEnding;
            }
            Ok(())
        }

        fn s_dtd_comment_ending(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            self.text.push(code_point(c));
            self.state = if c == MINUS { State::DtdCommentEnded } else { State::DtdComment };
            Ok(())
        }

        fn s_dtd_comment_ended(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            self.text.push(code_point(c));
            if c == GREATER {
                self.state = State::Dtd;
                return Ok(());
            }
            self.fail("malformed comment.")
        }

        fn s_dtd_pi(&mut self) -> Outcome {
            if self.capture_to_char(QUESTION)? {
                self.text.push('?');
                self.state = State::DtdPiEnding;
            }
            Ok(())
        }

        fn s_dtd_pi_ending(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            self.text.push(code_point(c));
            if c == GREATER {
                self.state = State::Dtd;
            }
            Ok(())
        }

        fn s_text(&mut self) -> Outcome {
            if self.tags.is_empty() { self.handle_text_outside_root() } else { self.handle_text_in_root() }
        }

        fn s_entity(&mut self) -> Outcome {
            let mut start = self.i;
            loop {
                match self.get_code()? {
                    NL_LIKE => {
                        let captured = self.slice(start, self.prev_i);
                        self.entity.push_str(&captured);
                        self.entity.push('\n');
                        start = self.i;
                    }
                    SEMICOLON => {
                        let entity = format!("{}{}", self.entity, self.slice(start, self.prev_i));
                        self.state = self.entity_return_state;
                        if entity.is_empty() {
                            return self.fail("empty entity name.");
                        }
                        let parsed = self.parse_entity(&entity)?;
                        self.entity.clear();
                        self.text.push_str(&parsed);
                        return Ok(());
                    }
                    EOC => {
                        let captured = self.slice(start, self.chunk.len());
                        self.entity.push_str(&captured);
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }

        fn s_open_waka(&mut self) -> Outcome {
            let c = self.get_code()?;
            if is_name_start_char(c) {
                self.state = State::OpenTag;
                self.unget();
                self.xml_decl_possible = false;
                return Ok(());
            }
            match c {
                FORWARD_SLASH => {
                    self.state = State::CloseTag;
                    self.xml_decl_possible = false;
                    Ok(())
                }
                BANG => {
                    self.state = State::OpenWakaBang;
                    self.open_waka_bang.clear();
                    self.xml_decl_possible = false;
                    Ok(())
                }
                QUESTION => {
                    self.state = State::PiFirstChar;
                    Ok(())
                }
                _ => self.fail("disallowed character in tag name"),
            }
        }

        fn s_open_waka_bang(&mut self) -> Outcome {
            let c = code_point(self.get_code_norm()?);
            self.open_waka_bang.push(c);
            match self.open_waka_bang.as_str() {
                "[CDATA[" => {
                    // Character data outside the root is a fault whether it comes before or after it.
                    if !self.saw_root || self.closed_root {
                        return self.fail("text data outside of root node.");
                    }
                    self.state = State::CData;
                    self.open_waka_bang.clear();
                }
                "--" => {
                    self.state = State::Comment;
                    self.open_waka_bang.clear();
                }
                "DOCTYPE" => {
                    if self.doctype || self.saw_root {
                        return self.fail("inappropriately located doctype declaration.");
                    }
                    self.state = State::Doctype;
                    self.open_waka_bang.clear();
                }
                other => {
                    // 7 is the length of the longest string that can still match one of the cases above.
                    if utf16_len(other) >= 7 {
                        return self.fail("incorrect syntax.");
                    }
                }
            }
            Ok(())
        }

        fn s_comment(&mut self) -> Outcome {
            if self.capture_to_char(MINUS)? {
                self.state = State::CommentEnding;
            }
            Ok(())
        }

        fn s_comment_ending(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if c == MINUS {
                self.state = State::CommentEnded;
                self.text.clear();
            } else {
                self.text.push('-');
                self.text.push(code_point(c));
                self.state = State::Comment;
            }
            Ok(())
        }

        fn s_comment_ended(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if c != GREATER {
                return self.fail("malformed comment.");
            }
            self.state = State::Text;
            Ok(())
        }

        fn s_cdata(&mut self) -> Outcome {
            if self.capture_to_char(CLOSE_BRACKET)? {
                self.state = State::CDataEnding;
            }
            Ok(())
        }

        fn s_cdata_ending(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if c == CLOSE_BRACKET {
                self.state = State::CDataEnding2;
            } else {
                self.text.push(']');
                self.text.push(code_point(c));
                self.state = State::CData;
            }
            Ok(())
        }

        fn s_cdata_ending2(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            match c {
                GREATER => {
                    self.text.clear();
                    self.state = State::Text;
                }
                CLOSE_BRACKET => self.text.push(']'),
                _ => {
                    self.text.push_str("]]");
                    self.text.push(code_point(c));
                    self.state = State::CData;
                }
            }
            Ok(())
        }

        fn s_pi_first_char(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if is_ncname_start_char(c) {
                self.pi_target.push(code_point(c));
                self.state = State::PiRest;
                return Ok(());
            }
            if c == QUESTION || is_s(c) {
                return self.fail("processing instruction without a target.");
            }
            self.fail("disallowed character in processing instruction name.")
        }

        fn s_pi_rest(&mut self) -> Outcome {
            let start = self.i;
            loop {
                let c = self.get_code_norm()?;
                if c == EOC {
                    let captured = self.slice(start, self.chunk.len());
                    self.pi_target.push_str(&captured);
                    return Ok(());
                }
                if !is_ncname_char(c) {
                    let captured = self.slice(start, self.prev_i);
                    self.pi_target.push_str(&captured);
                    let is_question = c == QUESTION;
                    if !(is_question || is_s(c)) {
                        return self.fail("disallowed character in processing instruction name.");
                    }
                    if self.pi_target == "xml" {
                        if !self.xml_decl_possible {
                            return self.fail("an XML declaration must be at the start of the document.");
                        }
                        self.state = if is_question { State::XmlDeclEnding } else { State::XmlDeclNameStart };
                    } else {
                        self.state = if is_question { State::PiEnding } else { State::PiBody };
                    }
                    return Ok(());
                }
            }
        }

        fn s_pi_body(&mut self) -> Outcome {
            if self.text.is_empty() {
                let c = self.get_code_norm()?;
                if c == QUESTION {
                    self.state = State::PiEnding;
                } else if !is_s(c) {
                    self.text = code_point(c).to_string();
                }
            } else if self.capture_to_char(QUESTION)? {
                self.state = State::PiEnding;
            }
            Ok(())
        }

        fn s_pi_ending(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if c == GREATER {
                if js_to_lowercase(&self.pi_target) == "xml" {
                    return self.fail("the XML declaration must appear at the start of the document.");
                }
                self.pi_target.clear();
                self.text.clear();
                self.state = State::Text;
            } else if c == QUESTION {
                self.text.push('?');
            } else {
                self.text.push('?');
                self.text.push(code_point(c));
                self.state = State::PiBody;
            }
            self.xml_decl_possible = false;
            Ok(())
        }

        fn s_xml_decl_name_start(&mut self) -> Outcome {
            let c = self.skip_spaces()?;
            if c == QUESTION {
                self.state = State::XmlDeclEnding;
                return Ok(());
            }
            if c != EOC {
                self.state = State::XmlDeclName;
                self.name = code_point(c).to_string();
            }
            Ok(())
        }

        fn s_xml_decl_name(&mut self) -> Outcome {
            let c = self.capture_to(&XML_DECL_NAME_TERMINATOR)?;
            if c == QUESTION {
                return self.fail("XML declaration is incomplete.");
            }
            if !(is_s(c) || c == EQUAL) {
                return Ok(());
            }
            let captured = std::mem::take(&mut self.text);
            self.name.push_str(&captured);
            if !self.xml_decl_expects.iter().any(|expected| *expected == self.name) {
                return match utf16_len(&self.name) {
                    0 => self.fail("did not expect any more name/value pairs."),
                    1 => {
                        let message = format!("expected the name {}.", self.xml_decl_expects.first().copied().unwrap_or("undefined"));
                        self.fail(&message)
                    }
                    _ => {
                        let message = format!("expected one of {}", self.xml_decl_expects.join(", "));
                        self.fail(&message)
                    }
                };
            }
            self.state = if c == EQUAL { State::XmlDeclValueStart } else { State::XmlDeclEq };
            Ok(())
        }

        fn s_xml_decl_eq(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if c == QUESTION {
                return self.fail("XML declaration is incomplete.");
            }
            if is_s(c) {
                return Ok(());
            }
            if c != EQUAL {
                return self.fail("value required.");
            }
            self.state = State::XmlDeclValueStart;
            Ok(())
        }

        fn s_xml_decl_value_start(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if c == QUESTION {
                return self.fail("XML declaration is incomplete.");
            }
            if is_s(c) {
                return Ok(());
            }
            if !is_quote(c) {
                return self.fail("value must be quoted.");
            }
            self.q = c;
            self.state = State::XmlDeclValue;
            Ok(())
        }

        fn s_xml_decl_value(&mut self) -> Outcome {
            let c = self.capture_to(&[self.q, QUESTION])?;
            if c == QUESTION {
                return self.fail("XML declaration is incomplete.");
            }
            if c == EOC {
                return Ok(());
            }
            let value = std::mem::take(&mut self.text);
            match self.name.as_str() {
                "version" => {
                    self.xml_decl_expects = vec!["encoding", "standalone"];
                    // `/^1\.[0-9]+$/`; the declaration is otherwise ignored (the version is forced to 1.0).
                    let digits = value.strip_prefix("1.");
                    if !digits.is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())) {
                        return self.fail("version number must match /^1\\.[0-9]+$/.");
                    }
                }
                "encoding" => {
                    // `/^[A-Za-z][A-Za-z0-9._-]*$/`.
                    let mut chars = value.chars();
                    let valid = chars.next().is_some_and(|first| first.is_ascii_alphabetic())
                        && chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
                    if !valid {
                        return self.fail("encoding value must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.");
                    }
                    self.xml_decl_expects = vec!["standalone"];
                }
                "standalone" => {
                    if value != "yes" && value != "no" {
                        return self.fail("standalone value must match \"yes\" or \"no\".");
                    }
                    self.xml_decl_expects = Vec::new();
                }
                _ => {}
            }
            self.name.clear();
            self.state = State::XmlDeclSeparator;
            Ok(())
        }

        fn s_xml_decl_separator(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if c == QUESTION {
                self.state = State::XmlDeclEnding;
                return Ok(());
            }
            if !is_s(c) {
                return self.fail("whitespace required.");
            }
            self.state = State::XmlDeclNameStart;
            Ok(())
        }

        fn s_xml_decl_ending(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if c != GREATER {
                return self.fail("The character ? is disallowed anywhere in XML declarations.");
            }
            if self.pi_target != "xml" {
                return self.fail("processing instructions are not allowed before root.");
            }
            if self.name != "version" && self.xml_decl_expects.contains(&"version") {
                return self.fail("XML declaration must contain a version.");
            }
            self.name.clear();
            self.pi_target.clear();
            self.text.clear();
            self.state = State::Text;
            self.xml_decl_possible = false;
            Ok(())
        }

        fn s_open_tag(&mut self) -> Outcome {
            let c = self.capture_name_chars()?;
            if c == EOC {
                return Ok(());
            }
            self.tag = Some(Tag { name: std::mem::take(&mut self.name), ns: HashMap::new() });
            self.saw_root = true;
            if self.closed_root {
                return self.fail("documents may contain only one root.");
            }
            match c {
                GREATER => self.open_tag(),
                FORWARD_SLASH => {
                    self.state = State::OpenTagSlash;
                    Ok(())
                }
                _ => {
                    if !is_s(c) {
                        return self.fail("disallowed character in tag name.");
                    }
                    self.state = State::Attrib;
                    Ok(())
                }
            }
        }

        fn s_open_tag_slash(&mut self) -> Outcome {
            if self.get_code()? == GREATER {
                return self.open_self_closing_tag();
            }
            self.fail("forward-slash in opening tag not followed by >.")
        }

        fn s_attrib(&mut self) -> Outcome {
            let c = self.skip_spaces()?;
            if c == EOC {
                return Ok(());
            }
            if is_name_start_char(c) {
                self.unget();
                self.state = State::AttribName;
                Ok(())
            } else if c == GREATER {
                self.open_tag()
            } else if c == FORWARD_SLASH {
                self.state = State::OpenTagSlash;
                Ok(())
            } else {
                self.fail("disallowed character in attribute name.")
            }
        }

        fn s_attrib_name(&mut self) -> Outcome {
            let c = self.capture_name_chars()?;
            if c == EQUAL {
                self.state = State::AttribValue;
                Ok(())
            } else if is_s(c) {
                self.state = State::AttribNameSawWhite;
                Ok(())
            } else if c == GREATER {
                self.fail("attribute without value.")
            } else if c != EOC {
                self.fail("disallowed character in attribute name.")
            } else {
                Ok(())
            }
        }

        fn s_attrib_name_saw_white(&mut self) -> Outcome {
            match self.skip_spaces()? {
                EOC => Ok(()),
                EQUAL => {
                    self.state = State::AttribValue;
                    Ok(())
                }
                _ => self.fail("attribute without value."),
            }
        }

        fn s_attrib_value(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if is_quote(c) {
                self.q = c;
                self.state = State::AttribValueQuoted;
                Ok(())
            } else if !is_s(c) {
                self.fail("unquoted attribute value.")
            } else {
                Ok(())
            }
        }

        fn s_attrib_value_quoted(&mut self) -> Outcome {
            let q = self.q;
            let mut start = self.i;
            loop {
                let c = self.get_code()?;
                if c == q {
                    let value = format!("{}{}", self.text, self.slice(start, self.prev_i));
                    self.push_attribute(&value)?;
                    self.name.clear();
                    self.text.clear();
                    self.state = State::AttribValueClosed;
                    return Ok(());
                }
                match c {
                    AMP => {
                        self.capture(start, self.prev_i);
                        self.state = State::Entity;
                        self.entity_return_state = State::AttribValueQuoted;
                        return Ok(());
                    }
                    NL | NL_LIKE | TAB => {
                        self.capture(start, self.prev_i);
                        self.text.push(' ');
                        start = self.i;
                    }
                    LESS => return self.fail("disallowed character."),
                    EOC => {
                        self.capture(start, self.chunk.len());
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }

        fn s_attrib_value_closed(&mut self) -> Outcome {
            let c = self.get_code_norm()?;
            if is_s(c) {
                self.state = State::Attrib;
                Ok(())
            } else if c == GREATER {
                self.open_tag()
            } else if c == FORWARD_SLASH {
                self.state = State::OpenTagSlash;
                Ok(())
            } else if is_name_start_char(c) {
                self.fail("no whitespace between attributes.")
            } else {
                self.fail("disallowed character in attribute name.")
            }
        }

        fn s_close_tag(&mut self) -> Outcome {
            let c = self.capture_name_chars()?;
            if c == GREATER {
                self.close_tag()
            } else if is_s(c) {
                self.state = State::CloseTagSawWhite;
                Ok(())
            } else if c != EOC {
                self.fail("disallowed character in closing tag.")
            } else {
                Ok(())
            }
        }

        fn s_close_tag_saw_white(&mut self) -> Outcome {
            match self.skip_spaces()? {
                GREATER => self.close_tag(),
                EOC => Ok(()),
                _ => self.fail("disallowed character in closing tag."),
            }
        }

        fn handle_text_in_root(&mut self) -> Outcome {
            let mut start = self.i;
            let mut forbidden = self.forbidden;
            loop {
                match self.get_code()? {
                    LESS => {
                        self.state = State::OpenWaka;
                        self.text.clear();
                        self.forbidden = Forbidden::Start;
                        return Ok(());
                    }
                    AMP => {
                        self.state = State::Entity;
                        self.entity_return_state = State::Text;
                        self.capture(start, self.prev_i);
                        self.forbidden = Forbidden::Start;
                        return Ok(());
                    }
                    CLOSE_BRACKET => {
                        forbidden = match forbidden {
                            Forbidden::Start => Forbidden::Bracket,
                            Forbidden::Bracket | Forbidden::BracketBracket => Forbidden::BracketBracket,
                        };
                    }
                    GREATER => {
                        if forbidden == Forbidden::BracketBracket {
                            return self.fail("the string \"]]>\" is disallowed in char data.");
                        }
                        forbidden = Forbidden::Start;
                    }
                    NL_LIKE => {
                        self.capture(start, self.prev_i);
                        self.text.push('\n');
                        start = self.i;
                        forbidden = Forbidden::Start;
                    }
                    EOC => {
                        self.capture(start, self.chunk.len());
                        self.forbidden = forbidden;
                        return Ok(());
                    }
                    _ => forbidden = Forbidden::Start,
                }
            }
        }

        fn handle_text_outside_root(&mut self) -> Outcome {
            let mut start = self.i;
            let mut non_space = false;
            loop {
                let code = self.get_code()?;
                match code {
                    LESS => {
                        self.state = State::OpenWaka;
                        self.text.clear();
                        break;
                    }
                    AMP => {
                        self.state = State::Entity;
                        self.entity_return_state = State::Text;
                        self.capture(start, self.prev_i);
                        non_space = true;
                        break;
                    }
                    NL_LIKE => {
                        self.capture(start, self.prev_i);
                        self.text.push('\n');
                        start = self.i;
                    }
                    EOC => {
                        self.capture(start, self.chunk.len());
                        break;
                    }
                    _ => {
                        if !is_s(code) {
                            non_space = true;
                        }
                    }
                }
            }
            // The text before the root and the text after it are each reported once; the first report ends the parse.
            if non_space && (!self.saw_root || self.closed_root) {
                return self.fail("text data outside of root node.");
            }
            Ok(())
        }

        /// `qname`: the prefix and local part of a name.
        fn qname(&self, name: &str) -> Result<(String, String), String> {
            let Some(colon) = name.find(':') else { return Ok((String::new(), name.to_owned())) };
            let local = &name[colon + 1..];
            let prefix = &name[..colon];
            if prefix.is_empty() || local.is_empty() || local.contains(':') {
                return self.fail(&format!("malformed name: {name}."));
            }
            Ok((prefix.to_owned(), local.to_owned()))
        }

        /// `nsPairCheck`.
        fn namespace_pair_check(&self, prefix: &str, uri: &str) -> Outcome {
            if prefix == "xml" && uri != XML_NAMESPACE {
                return self.fail(&format!("xml prefix must be bound to {XML_NAMESPACE}."));
            }
            if prefix == "xmlns" && uri != XMLNS_NAMESPACE {
                return self.fail(&format!("xmlns prefix must be bound to {XMLNS_NAMESPACE}."));
            }
            if uri == XMLNS_NAMESPACE {
                return if prefix.is_empty() {
                    self.fail(&format!("the default namespace may not be set to {uri}."))
                } else {
                    self.fail(&format!("may not assign a prefix (even \"xmlns\") to the URI {XMLNS_NAMESPACE}."))
                };
            }
            if uri == XML_NAMESPACE {
                return match prefix {
                    "xml" => Ok(()),
                    "" => self.fail(&format!("the default namespace may not be set to {uri}.")),
                    _ => self.fail("may not assign the xml namespace to another prefix."),
                };
            }
            Ok(())
        }

        /// `pushAttribNS` (the name being read is `self.name`).
        fn push_attribute(&mut self, value: &str) -> Outcome {
            let name = self.name.clone();
            let (prefix, local) = self.qname(&name)?;
            self.attrib_list.push(Attribute { name: name.clone(), prefix: prefix.clone(), local: local.clone() });
            if prefix == "xmlns" {
                let trimmed = js_trim(value).to_owned();
                if trimmed.is_empty() {
                    return self.fail("invalid attempt to undefine prefix in XML 1.0");
                }
                if let Some(tag) = self.tag.as_mut() {
                    tag.ns.insert(local.clone(), trimmed.clone());
                }
                self.namespace_pair_check(&local, &trimmed)?;
            } else if name == "xmlns" {
                let trimmed = js_trim(value).to_owned();
                if let Some(tag) = self.tag.as_mut() {
                    tag.ns.insert(String::new(), trimmed.clone());
                }
                self.namespace_pair_check("", &trimmed)?;
            }
            Ok(())
        }

        /// `resolve`: the namespace a prefix is bound to, looking at the tag being read first, then the open ones from
        /// the innermost out, then the two the language fixes. `None` when it is unbound.
        fn resolve(&self, prefix: &str) -> Option<String> {
            if let Some(uri) = self.tag.as_ref().and_then(|tag| tag.ns.get(prefix)) {
                return Some(uri.clone());
            }
            if let Some(uri) = self.tags.iter().rev().find_map(|tag| tag.ns.get(prefix)) {
                return Some(uri.clone());
            }
            match prefix {
                "xml" => Some(XML_NAMESPACE.to_owned()),
                "xmlns" => Some(XMLNS_NAMESPACE.to_owned()),
                _ => None,
            }
        }

        /// `processAttribsNS`.
        fn process_attributes(&mut self) -> Outcome {
            let name = self.tag.as_ref().map(|tag| tag.name.clone()).unwrap_or_default();
            let (prefix, _) = self.qname(&name)?;
            let uri = self.resolve(&prefix).unwrap_or_default();
            if !prefix.is_empty() {
                if prefix == "xmlns" {
                    return self.fail("tags may not have \"xmlns\" as prefix.");
                }
                if uri.is_empty() {
                    return self.fail(&format!("unbound namespace prefix: \"{prefix}\"."));
                }
            }
            let mut seen: Vec<String> = Vec::new();
            for attribute in &self.attrib_list {
                let equal_name = if attribute.prefix.is_empty() {
                    attribute.name.clone()
                } else {
                    let Some(uri) = self.resolve(&attribute.prefix) else {
                        return self.fail(&format!("unbound namespace prefix: \"{}\".", attribute.prefix));
                    };
                    format!("{{{uri}}}{}", attribute.local)
                };
                if seen.contains(&equal_name) {
                    return self.fail(&format!("duplicate attribute: {equal_name}."));
                }
                seen.push(equal_name);
            }
            self.attrib_list.clear();
            Ok(())
        }

        fn open_tag(&mut self) -> Outcome {
            self.process_attributes()?;
            if let Some(tag) = self.tag.take() {
                self.tags.push(tag);
            }
            self.state = State::Text;
            self.name.clear();
            Ok(())
        }

        fn open_self_closing_tag(&mut self) -> Outcome {
            self.process_attributes()?;
            self.tag = None;
            if self.tags.is_empty() {
                self.closed_root = true;
            }
            self.state = State::Text;
            self.name.clear();
            Ok(())
        }

        /// `closeTag`: the innermost open tag is the one that closes; any other name is a fault at once.
        fn close_tag(&mut self) -> Outcome {
            let name = std::mem::take(&mut self.name);
            self.state = State::Text;
            if name.is_empty() {
                return self.fail("weird empty close tag.");
            }
            let Some(tag) = self.tags.pop() else {
                return self.fail(&format!("unmatched closing tag: {name}."));
            };
            if tag.name != name {
                return self.fail("unexpected close tag.");
            }
            if self.tags.is_empty() {
                self.closed_root = true;
            }
            Ok(())
        }

        /// `parseEntity`: the text an entity stands for.
        fn parse_entity(&self, entity: &str) -> Result<String, String> {
            if !entity.starts_with('#') {
                if let Some(defined) = self.entities.get(entity) {
                    return Ok(defined.clone());
                }
                return if is_ncname(entity) { self.fail("undefined entity.") } else { self.fail("disallowed character in entity name.") };
            }
            let hex = entity.strip_prefix("#x").filter(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_hexdigit()));
            let decimal = entity.strip_prefix('#').filter(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()));
            let number = match (hex, decimal) {
                (Some(digits), _) => u64::from_str_radix(digits, 16).ok(),
                (None, Some(digits)) => digits.parse::<u64>().ok(),
                (None, None) => None,
            };
            match number.filter(|value| is_char(*value)).and_then(|value| u32::try_from(value).ok()).and_then(char::from_u32) {
                Some(character) => Ok(character.to_string()),
                None => self.fail("malformed character entity."),
            }
        }

        /// `end`: the checks that need the whole document.
        fn end(&mut self) -> Outcome {
            if !self.saw_root {
                return self.fail("document must contain a root element.");
            }
            if let Some(tag) = self.tags.pop() {
                return self.fail(&format!("unclosed tag: {}", tag.name));
            }
            if self.state != State::Begin && self.state != State::Text {
                return self.fail("unexpected end.");
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_fsio::Unlaned;

    use super::*;

    const RELATIONSHIP_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";

    fn content_types(extra: &str) -> String {
        format!(
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>{extra}</Types>"#
        )
    }

    fn docx() -> Package {
        let mut package = Package::new();
        package.set("[Content_Types].xml", content_types(""));
        package.set(
            "_rels/.rels",
            format!(r#"<Relationships xmlns="{RELATIONSHIP_NS}"><Relationship Id="rId1" Type="http://x/officeDocument" Target="word/document.xml"/></Relationships>"#),
        );
        package.set("word/document.xml", r#"<w:document xmlns:w="http://x/w"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>"#);
        package
    }

    fn write(dir: &Path, name: &str, package: &Package) -> std::path::PathBuf {
        let path = dir.join(name);
        mixdog_fsio::write(&Unlaned, &path, package.generate().expect("a package")).expect("written");
        path
    }

    fn validate(package: &Package, format: &str, options: &ValidateOptions<'_>) -> Value {
        let dir = tempfile::tempdir().expect("work directory");
        let path = write(dir.path(), "file.pkg", package);
        validate_portable_ooxml(&Unlaned, &path, format, options).expect("validated")
    }

    #[test]
    fn a_valid_document_is_ok_and_answers_every_section() {
        let answer = validate(&docx(), "docx", &ValidateOptions::default());
        assert_eq!(answer["ok"], true, "{answer}");
        assert_eq!(answer["entries"], 3);
        assert_eq!(answer["mainPart"], "word/document.xml");
        assert_eq!(answer["baseline"], json!({ "compared": false }));
        assert_eq!(answer["redlining"], Value::Null);
        assert_eq!(answer["security"]["macroExecution"], "disabled");
        assert_eq!(answer["validation"], "opc-relationships-content-types-xml");
        let keys: Vec<&str> = answer.as_object().map(|map| map.keys().map(String::as_str).collect()).unwrap_or_default();
        assert_eq!(
            keys,
            [
                "ok",
                "format",
                "entries",
                "missing",
                "unsafeEntries",
                "macros",
                "security",
                "malformedXml",
                "missingRelationships",
                "duplicateRelationshipIds",
                "externalRelationships",
                "presentationFaults",
                "missingContentTypes",
                "mainPart",
                "mainContentType",
                "mainContentTypeMissing",
                "baseline",
                "redlining",
                "documentLint",
                "validation"
            ]
        );
    }

    #[test]
    fn missing_parts_unsafe_names_and_uncovered_content_types_fail_the_package() {
        let mut package = docx();
        package.remove("word/document.xml");
        package.set("word/a..b.txt", "x");
        package.set("word/media/a.png", "x");
        let answer = validate(&package, "docx", &ValidateOptions::default());
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["missing"], json!(["word/document.xml"]));
        assert_eq!(answer["unsafeEntries"], json!(["word/a..b.txt"]));
        assert_eq!(answer["missingContentTypes"], json!(["word/a..b.txt", "word/media/a.png"]));
        assert_eq!(answer["mainContentTypeMissing"], false);
    }

    #[test]
    fn a_part_that_is_not_xml_is_reported_with_the_parsers_own_message() {
        let mut package = docx();
        package.set("word/document.xml", "<w:document xmlns:w=\"http://x/w\">\n  <w:body></w:document>");
        let answer = validate(&package, "docx", &ValidateOptions::default());
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["malformedXml"], json!([{ "part": "word/document.xml", "error": "about:blank:2:23: unexpected close tag." }]));
    }

    #[test]
    fn relationships_are_checked_for_duplicates_external_targets_and_dangling_targets() {
        let mut package = docx();
        package.set(
            "word/_rels/document.xml.rels",
            format!(
                r#"<Relationships xmlns="{RELATIONSHIP_NS}"><Relationship Id="rId1" Type="t" Target="styles.xml"/><Relationship Id="rId1" Type="t" Target="media/a%20b.png"/><Relationship Id="rId2" Type="t" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/><Relationship Id="rId3" Type="t" Target="../../outside.xml"/></Relationships>"#
            ),
        );
        let answer = validate(&package, "docx", &ValidateOptions::default());
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["duplicateRelationshipIds"], json!([{ "relationship": "word/_rels/document.xml.rels", "id": "rId1" }]));
        assert_eq!(
            answer["externalRelationships"],
            json!([{ "relationship": "word/_rels/document.xml.rels", "id": "rId2", "target": "https://example.com/?a=1&b=2" }])
        );
        let missing = answer["missingRelationships"].as_array().expect("a list");
        assert_eq!(missing.len(), 3);
        assert_eq!(missing[0]["resolved"], "word/styles.xml");
        assert_eq!(missing[1]["resolved"], "word/media/a b.png");
    }

    #[test]
    fn the_word_lint_makes_a_package_fail_only_for_errors() {
        let mut package = docx();
        package.set("word/document.xml", r#"<w:document xmlns:w="http://x/w"><w:body><w:p><w:r><w:t> x</w:t></w:r></w:p></w:body></w:document>"#);
        let warned = validate(&package, "docx", &ValidateOptions::default());
        assert_eq!(warned["ok"], true);
        assert_eq!(warned["documentLint"][0]["code"], "whitespace_not_preserved");
        package.set(
            "word/document.xml",
            r#"<w:document xmlns:w="http://x/w"><w:body><w:p><w:del w:id="1"><w:r><w:t>x</w:t></w:r></w:del></w:p></w:body></w:document>"#,
        );
        let failed = validate(&package, "docx", &ValidateOptions::default());
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["documentLint"][0]["code"], "text_in_deletion");
    }

    #[test]
    fn the_redlining_audit_needs_a_source_and_reports_untracked_edits() {
        let package = docx();
        let asked = ValidateOptions { audit_profile: "redlining", ..ValidateOptions::default() };
        let answer = validate(&package, "docx", &asked);
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["redlining"], json!({ "requested": true, "ok": false, "reason": "Redlining audit requires an opened source document." }));
        let dir = tempfile::tempdir().expect("work directory");
        let mut changed = docx();
        changed.set("word/document.xml", r#"<w:document xmlns:w="http://x/w"><w:body><w:p><w:r><w:t>Hallo</w:t></w:r></w:p></w:body></w:document>"#);
        let current = write(dir.path(), "current.docx", &changed);
        let source = write(dir.path(), "source.docx", &package);
        let source_text = source.display().to_string();
        let options = ValidateOptions { original: &source_text, audit_profile: "redlining", ..ValidateOptions::default() };
        let answer = validate_portable_ooxml(&Unlaned, &current, "docx", &options).expect("validated");
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["redlining"]["ok"], false);
        assert_eq!(answer["redlining"]["untrackedEdits"]["part"], "word/document.xml");
        assert_eq!(answer["baseline"]["compared"], true);
        assert_eq!(answer["baseline"]["original"], source_text.as_str());
    }

    #[test]
    fn protected_parts_that_change_or_vanish_fail_and_a_signature_is_invalidated() {
        let mut source = docx();
        source.set("word/vbaProject.bin", "macro");
        source.set("_xmlsignatures/sig1.xml", "<s/>");
        source.set("word/theme/theme1.xml", "<a:theme/>");
        let mut saved = docx();
        saved.set("word/vbaProject.bin", "changed");
        saved.set("word/theme/theme1.xml", "<a:theme x=\"1\"/>");
        let dir = tempfile::tempdir().expect("work directory");
        let source_path = write(dir.path(), "source.docx", &source).display().to_string();
        let current = write(dir.path(), "saved.docx", &saved);
        let options = ValidateOptions { original: &source_path, ..ValidateOptions::default() };
        let answer = validate_portable_ooxml(&Unlaned, &current, "docx", &options).expect("validated");
        let baseline = &answer["baseline"];
        assert_eq!(answer["ok"], false);
        assert_eq!(baseline["lostProtectedParts"], json!(["_xmlsignatures/sig1.xml"]));
        assert_eq!(baseline["changedProtectedParts"].as_array().map(Vec::len), Some(2));
        assert_eq!(baseline["digitalSignatureInvalidated"], true);
        // Saved by the application itself, the theme is its own serialisation; the macro stays protected.
        let by_application = ValidateOptions { original: &source_path, saved_by: "microsoft-office-com", ..ValidateOptions::default() };
        let answer = validate_portable_ooxml(&Unlaned, &current, "docx", &by_application).expect("validated");
        assert_eq!(answer["baseline"]["changedProtectedParts"].as_array().map(Vec::len), Some(1));
        assert_eq!(answer["baseline"]["applicationNormalizedParts"], json!(["word/theme/theme1.xml"]));
    }

    fn deck() -> Package {
        let mut package = Package::new();
        package.set(
            "[Content_Types].xml",
            r#"<Types><Default Extension="rels" ContentType="r"/><Default Extension="xml" ContentType="x"/><Override PartName="/ppt/presentation.xml" ContentType="p"/></Types>"#,
        );
        package.set("ppt/presentation.xml", "<p:presentation><p:sldMasterIdLst/></p:presentation>");
        package
    }

    fn rels(items: &[(&str, &str, &str)]) -> String {
        let body: String = items.iter().map(|(id, kind, target)| format!(r#"<Relationship Id="{id}" Type="http://x/{kind}" Target="{target}"/>"#)).collect();
        format!("<Relationships>{body}</Relationships>")
    }

    #[test]
    fn a_deck_with_a_slide_on_two_layouts_and_a_shared_notes_page_is_refused() {
        let mut package = deck();
        package.set("ppt/slides/slide1.xml", "<p:sld/>");
        package.set("ppt/slides/slide2.xml", "<p:sld/>");
        package.set(
            "ppt/slides/_rels/slide1.xml.rels",
            rels(&[
                ("rId1", "slideLayout", "../slideLayouts/l1.xml"),
                ("rId2", "slideLayout", "../slideLayouts/l2.xml"),
                ("rId3", "notesSlide", "../notesSlides/n1.xml"),
            ]),
        );
        package.set("ppt/slides/_rels/slide2.xml.rels", rels(&[("rId1", "notesSlide", "../notesSlides/n1.xml")]));
        let answer = validate(&package, "pptx", &ValidateOptions::default());
        assert_eq!(answer["ok"], false);
        let codes: Vec<&str> = answer["presentationFaults"].as_array().expect("faults").iter().filter_map(|fault| fault["code"].as_str()).collect();
        assert_eq!(codes, ["slide_layout_duplicated", "notes_slide_shared"]);
        assert_eq!(
            answer["presentationFaults"][1]["message"],
            "ppt/slides/slide1.xml and ppt/slides/slide2.xml share ppt/notesSlides/n1.xml; each slide owns its notes page."
        );
    }

    #[test]
    fn masters_sharing_a_theme_and_layouts_a_master_does_not_name_are_refused() {
        let mut package = deck();
        package.set(
            "ppt/slideMasters/slideMaster1.xml",
            r#"<p:sldMaster><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId9"/><p:sldLayoutId id="2" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>"#,
        );
        package.set(
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            rels(&[("rId1", "slideLayout", "../slideLayouts/l1.xml"), ("rId2", "theme", "../theme/theme1.xml")]),
        );
        package.set("ppt/notesMasters/notesMaster1.xml", "<p:notesMaster/>");
        package.set("ppt/notesMasters/_rels/notesMaster1.xml.rels", rels(&[("rId1", "theme", "../theme/theme1.xml")]));
        package.set("ppt/theme/theme1.xml", "<a:theme/>");
        let answer = validate(&package, "pptx", &ValidateOptions::default());
        let faults = answer["presentationFaults"].as_array().expect("faults");
        assert_eq!(faults.len(), 2);
        assert_eq!(faults[0]["code"], "layout_reference_missing");
        assert_eq!(faults[1]["code"], "master_theme_shared");
        assert!(
            faults[1]["message"]
                .as_str()
                .unwrap_or("")
                .ends_with("move <p:notesMasterIdLst> to directly after <p:sldIdLst> in ppt/presentation.xml, or give the notes master its own theme.")
        );
        // pptxgenjs' layout is tolerated while the notes master follows the slide list.
        package.set("ppt/presentation.xml", "<p:presentation><p:sldIdLst/><p:notesMasterIdLst/></p:presentation>");
        let tolerated = validate(&package, "pptx", &ValidateOptions::default());
        assert_eq!(tolerated["presentationFaults"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn a_charts_data_workbook_is_not_an_embedded_object_finding() {
        let mut package = deck();
        package.set("ppt/charts/_rels/chart1.xml.rels", rels(&[("rId1", "package", "../embeddings/w.xlsx")]));
        package.set("ppt/embeddings/w.xlsx", "x");
        package.set("ppt/embeddings/ole.bin", "x");
        let answer = validate(&package, "pptx", &ValidateOptions::default());
        assert_eq!(answer["security"]["embeddedObjects"], json!(["ppt/embeddings/ole.bin"]));
    }

    #[test]
    fn the_source_is_unreadable_the_validation_is_an_error() {
        let dir = tempfile::tempdir().expect("work directory");
        let path = write(dir.path(), "file.docx", &docx());
        let missing = dir.path().join("none.docx").display().to_string();
        let options = ValidateOptions { original: &missing, ..ValidateOptions::default() };
        assert!(validate_portable_ooxml(&Unlaned, &path, "docx", &options).is_err());
    }

    #[test]
    fn extensions_follow_path_extname() {
        assert_eq!(extension_of("word/media/a.PNG"), "PNG");
        assert_eq!(extension_of("word/.hidden"), "");
        assert_eq!(extension_of("word/noext"), "");
        assert_eq!(extension_of("a."), "");
        assert_eq!(extension_of("dir.d/file"), "");
    }

    #[test]
    fn the_parser_reports_what_saxes_reports_for_each_fault() {
        let cases: &[(&str, Option<&str>)] = &[
            ("<a><b></a>", Some("about:blank:1:10: unexpected close tag.")),
            ("<a>&foo;</a>", Some("about:blank:1:8: undefined entity.")),
            ("<a x=1/>", Some("about:blank:1:6: unquoted attribute value.")),
            ("", Some("about:blank:1:0: document must contain a root element.")),
            ("<a/><b/>", Some("about:blank:1:7: documents may contain only one root.")),
            ("<?xml version=\"1.0\"?>\n<a>\n  <b></a>", Some("about:blank:3:9: unexpected close tag.")),
            ("<a><b>", Some("about:blank:1:6: unclosed tag: b")),
            ("<a b=\"1\" b=\"2\"/>", Some("about:blank:1:16: duplicate attribute: b.")),
            ("<p:a/>", Some("about:blank:1:6: unbound namespace prefix: \"p\".")),
            ("<a xmlns:p=\"u\"><p:b p:x=\"1\" p:x=\"2\"/></a>", Some("about:blank:1:37: duplicate attribute: {u}x.")),
            ("text<a/>", Some("about:blank:1:5: text data outside of root node.")),
            ("<a/>text", Some("about:blank:1:8: text data outside of root node.")),
            ("<a>]]></a>", Some("about:blank:1:6: the string \"]]>\" is disallowed in char data.")),
            ("<!-- a -- b --><a/>", Some("about:blank:1:10: malformed comment.")),
            ("<a><!-- x --></a>", None),
            ("<a>&#0;</a>", Some("about:blank:1:7: malformed character entity.")),
            ("<a>&#x41;&#65;&amp;</a>", None),
            ("<a>&;</a>", Some("about:blank:1:5: empty entity name.")),
            ("<a>&a b;</a>", Some("about:blank:1:8: disallowed character in entity name.")),
            ("<a b=\"<\"/>", Some("about:blank:1:7: disallowed character.")),
            ("<a b/>", Some("about:blank:1:5: disallowed character in attribute name.")),
            ("<a b =\"1\"/>", None),
            ("<a b='1'c='2'/>", Some("about:blank:1:9: no whitespace between attributes.")),
            ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<a/>", None),
            ("\n<?xml version=\"1.0\"?><a/>", Some("about:blank:2:6: an XML declaration must be at the start of the document.")),
            ("<?xml version=\"2.0\"?><a/>", Some("about:blank:1:19: version number must match /^1\\.[0-9]+$/.")),
            ("<?xml encoding=\"UTF-8\"?><a/>", Some("about:blank:1:15: expected one of version")),
            ("<?xml version=\"1.0\" standalone=\"maybe\"?><a/>", Some("about:blank:1:38: standalone value must match \"yes\" or \"no\".")),
            ("<?xml version=\"1.0\"?", Some("about:blank:1:20: document must contain a root element.")),
            ("<?xml?><a/>", Some("about:blank:1:7: XML declaration must contain a version.")),
            ("<a/><?xml version=\"1.0\"?>", Some("about:blank:1:10: an XML declaration must be at the start of the document.")),
            ("<?pi body?><a/>", None),
            ("<?pi ?", Some("about:blank:1:6: document must contain a root element.")),
            ("<!DOCTYPE a [<!ENTITY e \"v\">]><a>&e;</a>", None),
            ("<!DOCTYPE a><a/><!DOCTYPE a>", Some("about:blank:1:25: inappropriately located doctype declaration.")),
            ("<a><![CDATA[ x ]]></a>", None),
            ("<![CDATA[x]]><a/>", Some("about:blank:1:9: text data outside of root node.")),
            ("<a/><![CDATA[x]]>", Some("about:blank:1:13: text data outside of root node.")),
            ("<a>\u{1}</a>", Some("about:blank:1:4: disallowed character.")),
            ("<a>\u{fffe}</a>", Some("about:blank:1:4: disallowed character.")),
            ("<a></b>", Some("about:blank:1:7: unexpected close tag.")),
            ("</a>", Some("about:blank:1:4: unmatched closing tag: a.")),
            ("<a x:y=\"1\"/>", Some("about:blank:1:12: unbound namespace prefix: \"x\".")),
            ("<a xmlns:xml=\"u\"/>", Some("about:blank:1:16: xml prefix must be bound to http://www.w3.org/XML/1998/namespace.")),
            ("<a xmlns:p=\"\"/>", Some("about:blank:1:13: invalid attempt to undefine prefix in XML 1.0")),
            ("<a xmlns=\"http://www.w3.org/2000/xmlns/\"/>", Some("about:blank:1:40: the default namespace may not be set to http://www.w3.org/2000/xmlns/.")),
            ("<a xmlns:p=\"http://www.w3.org/XML/1998/namespace\"/>", Some("about:blank:1:49: may not assign the xml namespace to another prefix.")),
            ("<:a/>", Some("about:blank:1:5: malformed name: :a.")),
            ("<a:/>", Some("about:blank:1:5: malformed name: a:.")),
            ("<a:b:c/>", Some("about:blank:1:8: malformed name: a:b:c.")),
            ("<a ", Some("about:blank:1:3: unexpected end.")),
            ("<a b=\"x", Some("about:blank:1:7: unexpected end.")),
            ("<a>\r\n<b>\r</a>", Some("about:blank:3:4: unexpected close tag.")),
            ("<a>\r", Some("about:blank:2:0: unclosed tag: a")),
            ("\u{feff}<a/>", None),
            ("\u{feff} <a/>", None),
            ("<a>\u{1f600}</a>", None),
            ("<a><b/>&bad;</a>", Some("about:blank:1:12: undefined entity.")),
            ("< a/>", Some("about:blank:1:2: disallowed character in tag name")),
            ("<a / >", Some("about:blank:1:5: forward-slash in opening tag not followed by >.")),
            ("<a b=\"1\"/ >", Some("about:blank:1:10: forward-slash in opening tag not followed by >.")),
            ("<1a/>", Some("about:blank:1:2: disallowed character in tag name")),
            ("<a 1b=\"x\"/>", Some("about:blank:1:4: disallowed character in attribute name.")),
            ("<a><!- x --></a>", Some("about:blank:1:12: incorrect syntax.")),
            ("<a><!DOCTYPE b></a>", Some("about:blank:1:12: inappropriately located doctype declaration.")),
            ("<!DOCTYPE >\n<a/>", Some("Cannot read properties of null (reading '1')")),
            ("<!DOCTYPE html><html/>", None),
            ("<a><?pi?></a>", None),
            ("<a>a&#x110000;</a>", Some("about:blank:1:14: malformed character entity.")),
            ("<a>&#xD800;</a>", Some("about:blank:1:11: malformed character entity.")),
            ("<a>&lt;&gt;&quot;&apos;</a>", None),
            ("<a>\n\n  <b>\n\t</c></a>", Some("about:blank:4:5: unexpected close tag.")),
            ("<?xml version='1.0'?><a/>", None),
            ("<?xml version=\"1.0\" ?><a/>", None),
            ("<?xml version=\"1.0\"encoding=\"UTF-8\"?><a/>", Some("about:blank:1:20: whitespace required.")),
            ("<?xml version =\"1.0\"?><a/>", None),
            ("<?xml version\"1.0\"?><a/>", Some("about:blank:1:19: XML declaration is incomplete.")),
            ("<?xml version=1.0?><a/>", Some("about:blank:1:15: value must be quoted.")),
            ("<?xml version=\"1.0\" encoding=\"1x\"?><a/>", Some("about:blank:1:33: encoding value must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.")),
            ("<?xml version=\"1.0\" encoding=\"_x\"?><a/>", Some("about:blank:1:33: encoding value must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.")),
            ("<?xml standalone=\"yes\"?><a/>", Some("about:blank:1:17: expected one of version")),
            ("<?xml version=\"1.0\" version=\"1.0\"?><a/>", Some("about:blank:1:28: expected one of encoding, standalone")),
        ];
        for &(input, expected) in cases {
            assert_eq!(xml_parse_error(input).as_deref(), expected, "{input:?}");
        }
    }
}
