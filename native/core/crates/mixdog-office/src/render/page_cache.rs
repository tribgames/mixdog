//! `core/pptx-page-cache.mjs`: which pages of a deck a render can take from the one before it.
//!
//! All non-slide resources form a conservative global dependency. A chart, theme, font, layout or image edit invalidates every
//! page rather than risk a stale visual. Slide-local edits are keyed by the persistent `p:sldId`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_js::{json_number, json_stringify};
use mixdog_office_base::values::{sha256, truthy};
use mixdog_ooxml::opc::{part_relationship_path, posix};
use mixdog_ooxml::package::load_package;
use mixdog_ooxml::pptx_package::presentation_slides;
use mixdog_ooxml::xml::{compiled, xml_attribute, xml_decode};
use serde_json::{Value, json};

use super::RenderEngine;

/// One page a deck exports: its place, the slide that owns it and what the slide (with the slides it links to) and every shared
/// resource looked like.
#[derive(Clone, Debug, PartialEq)]
pub struct PageSignature {
    pub page: usize,
    /// The persistent `p:sldId` (0 when the presentation lists none).
    pub slide_id: f64,
    pub signature: String,
}

/// JavaScript's default `Array.prototype.sort` order of strings: by UTF-16 code unit.
fn utf16_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// `pptxPageSignatures(path)`.
pub fn pptx_page_signatures<P: ReadProof>(proof: &P, path: &Path) -> Result<Vec<PageSignature>, String> {
    let zip = load_package(proof, path)?;
    let slides = presentation_slides(&zip);
    let slide_parts: HashSet<String> = slides.iter().flat_map(|slide| [slide.path.clone(), part_relationship_path(&slide.path)]).collect();
    let mut names = zip.names();
    names.sort_by(|left, right| utf16_order(left, right));
    let mut global: Vec<u8> = Vec::new();
    for name in &names {
        let Some(entry) = zip.entry(name) else { continue };
        if entry.dir || slide_parts.contains(name) || name.starts_with("docProps/") {
            continue;
        }
        global.extend_from_slice(name.as_bytes());
        global.extend_from_slice(&entry.data);
    }
    let seed = sha256(&global);
    let hidden_pattern = compiled(r#"<p:sld\b[^>]*\bshow="(?:0|false)""#, "");
    let relationship_pattern = compiled(r"<Relationship\b([^>]+)\/?>", "g");
    let mut locals: HashMap<String, String> = HashMap::new();
    let mut links: HashMap<String, Vec<String>> = HashMap::new();
    // A hidden slide is skipped by every renderer, so it owns no exported page.
    let mut hidden: HashSet<String> = HashSet::new();
    for slide in &slides {
        let xml = zip.text(&slide.path);
        if hidden_pattern.is_match(&xml) {
            hidden.insert(slide.path.clone());
        }
        let rels = zip.text(&part_relationship_path(&slide.path));
        locals.insert(slide.path.clone(), sha256(format!("{xml}\0{rels}")));
        let mut linked = Vec::new();
        for found in relationship_pattern.captures_iter(&rels) {
            let attributes = found.get(1).unwrap_or("");
            if xml_attribute(attributes, "TargetMode") == "External" {
                continue;
            }
            let target = xml_decode(&xml_attribute(attributes, "Target"));
            let resolved = match target.strip_prefix('/') {
                Some(rooted) => rooted.to_owned(),
                None => posix::normalize(&posix::join(&[&posix::dirname(&slide.path), &target])),
            };
            if slide_parts.contains(&resolved) {
                linked.push(resolved);
            }
        }
        links.insert(slide.path.clone(), linked);
    }
    let visible: Vec<_> = slides.iter().filter(|slide| !hidden.contains(&slide.path)).collect();
    Ok(visible
        .iter()
        .enumerate()
        .map(|(index, slide)| {
            let mut dependencies: Vec<String> = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            let mut pending = vec![slide.path.clone()];
            while let Some(part) = pending.pop() {
                if !seen.insert(part.clone()) {
                    continue;
                }
                dependencies.push(part.clone());
                pending.extend(links.get(&part).into_iter().flatten().cloned());
            }
            dependencies.sort_by(|left, right| utf16_order(left, right));
            let pairs: Vec<Value> = dependencies.iter().map(|part| json!([part, locals.get(part).cloned().unwrap_or_default()])).collect();
            PageSignature {
                page: index + 1,
                slide_id: slide.id,
                signature: sha256(json_stringify(&json!([seed, index, pairs]))),
            }
        })
        .collect())
}

/// `reusablePptxPages(cache, signatures, request)`: the page images of the last render whose slide and signature are unchanged,
/// as that render drew them (same output, same width) and still on disk, keyed by their page now.
pub async fn reusable_pptx_pages<E: RenderEngine>(
    engine: &E,
    cache: Option<&Value>,
    signatures: &[PageSignature],
    output: &str,
    max_width: f64,
) -> HashMap<usize, Value> {
    let mut images = HashMap::new();
    let Some(cache) = cache else { return images };
    if cache.get("maxWidth").and_then(Value::as_f64) != Some(max_width) || cache.get("output").and_then(Value::as_str) != Some(output) {
        return images;
    }
    let pages = cache.get("pages").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    for entry in signatures {
        let prior = pages.iter().find(|page| {
            page.get("slideId").and_then(Value::as_f64) == Some(entry.slide_id) && page.get("signature").and_then(Value::as_str) == Some(entry.signature.as_str())
        });
        let Some(image) = prior.and_then(|page| page.get("image")) else { continue };
        if !image.get("data").is_some_and(truthy) || !image.get("path").is_some_and(truthy) {
            continue;
        }
        let Some(path) = image.get("path").and_then(Value::as_str) else { continue };
        if !engine.exists(Path::new(path)).await {
            continue;
        }
        let mut image = image.clone();
        if let Some(fields) = image.as_object_mut() {
            fields.insert("page".to_owned(), json_number(entry.page as f64));
        }
        images.insert(entry.page, image);
    }
    images
}

/// `completePageCoverage(total, pages)`: the coverage of a render that drew `pages` of a deck of `total`.
pub fn complete_page_coverage(total: usize, pages: &[usize]) -> Value {
    let mut reviewed: Vec<usize> = pages.to_vec();
    reviewed.sort_unstable();
    reviewed.dedup();
    let remaining: Vec<usize> = (1..=total).filter(|page| !reviewed.contains(page)).collect();
    json!({
        "mode": "pages",
        "total": total,
        "reviewed": reviewed.len(),
        "reviewedPages": reviewed,
        "remainingPages": remaining,
        "complete": remaining.is_empty(),
    })
}
