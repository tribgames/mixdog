//! `design-template-fill.mjs`: reusing a deck means putting a message on the page whose structure already carries it. The
//! page is chosen by the job it does ([`select_template_page`]), and its boxes are filled by the slot each one holds
//! ([`template_page_fill`]), so the template keeps its own design and only its words change. The work happens before the
//! batch reaches a backend: [`expand_template_page_operations`] turns each `use_template_page` operation into an
//! `import_slides` and the `set_text` and `delete_shape` operations of its fill, which Microsoft Office and the portable
//! writer already do.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_js::{js_trim, json_number, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_ooxml::xml::compiled;
use serde_json::{Map, Value, json};

use super::induct::annotate_pptx_snapshot_roles;
use crate::library::read_json;
use crate::{opt_prop, prop, text};

const GROUP_ROLE: &str = r"^(column|metric|step)-(title|body|value|label|detail)-(\d+)$";
// A sign, not a word: no letter or digit, or at most two Latin letters among marks ("VS", "→", "+").
const SIGN_TEXT: &str = r"^[^\p{L}\p{N}]*(?:[A-Za-z]{1,2}[^\p{L}\p{N}]*)?$";

/// The repeated structure of a page and how many items it holds.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub family: &'static str,
    pub size: f64,
    /// The first line of an item (`title` or `value`).
    pub lead: &'static str,
    /// The second line of an item (`body`, `label` or `detail`).
    pub follow: &'static str,
}

/// What a page's fill writes: the text each shape takes, and the shapes to delete (highest first).
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateFill {
    pub sets: Vec<(f64, String)>,
    pub deletes: Vec<f64>,
    pub group: Option<Group>,
}

/// What a value reads as in a template literal (`${value}`).
fn literal(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `String(item?.a ?? item?.b ?? item?.c ?? '')`: the first field that is neither null nor undefined.
fn first_present(item: Option<&Value>, keys: &[&str]) -> String {
    for key in keys {
        match opt_prop(item, key) {
            None | Some(Value::Null) => {}
            Some(value) => return value_to_string(value),
        }
    }
    String::new()
}

fn compare(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

/// `Map<string, number>` of a page's slot roles to their shape numbers, in the order the page lists them.
struct Slots(Vec<(String, f64)>);

impl Slots {
    fn get(&self, role: &str) -> Option<f64> {
        self.0.iter().find(|(known, _)| known == role).map(|(_, shape)| *shape)
    }

    fn roles(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(role, _)| role.as_str())
    }
}

fn shapes_of(page: Option<&Value>) -> &[Value] {
    opt_prop(page, "shapes").and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
}

fn page_slots(page: Option<&Value>) -> Slots {
    let mut slots: Vec<(String, f64)> = Vec::new();
    for shape in shapes_of(page) {
        let Some(slot) = prop(shape, "slot").filter(|slot| truthy(slot)) else { continue };
        let index = to_number_of(prop(shape, "index"));
        if !(index > 0.0) {
            continue;
        }
        let role = value_to_string(slot);
        match slots.iter_mut().find(|(known, _)| *known == role) {
            Some(entry) => entry.1 = index,
            None => slots.push((role, index)),
        }
    }
    Slots(slots)
}

fn group_fields(family: &str) -> (&'static str, &'static str, &'static str) {
    match family {
        "column" => ("column", "title", "body"),
        "metric" => ("metric", "value", "label"),
        _ => ("step", "title", "detail"),
    }
}

// The page's repeated structure and how many items it holds: the capacity the content has to fit, since a page takes one
// more item by being replaced, never by shrinking its type.
fn page_group(slots: &Slots) -> Option<Group> {
    let pattern = compiled(GROUP_ROLE, "");
    let mut sizes: Vec<(String, f64)> = Vec::new();
    for role in slots.roles() {
        let Some(found) = pattern.captures(role) else { continue };
        let family = found.get(1).unwrap_or("").to_owned();
        let number = mixdog_js::string_to_number(found.get(3).unwrap_or(""));
        match sizes.iter_mut().find(|(known, _)| *known == family) {
            Some(entry) => entry.1 = entry.1.max(number),
            None => sizes.push((family, number.max(0.0))),
        }
    }
    let mut best: Option<&(String, f64)> = None;
    for entry in &sizes {
        if best.is_none_or(|held| entry.1 > held.1) {
            best = Some(entry);
        }
    }
    best.map(|(family, size)| {
        let (name, lead, follow) = group_fields(family);
        Group { family: name, size: *size, lead, follow }
    })
}

/// Whether the request holds an integer under `key` (`Number.isInteger`).
fn integer_of(request: &Value, key: &str) -> Option<f64> {
    prop(request, key).and_then(Value::as_f64).filter(|number| number.is_finite() && number.fract() == 0.0)
}

/// `selectTemplatePage(document, request)`: the page of a deck snapshot that a request names (`slide`, one exact page) or
/// describes (`role`, the job it does, with the `items` it has to hold); of the pages of that role, the one that takes the
/// items with the least room left over, or the widest one where none holds them.
pub fn select_template_page<'a>(document: &'a Value, request: &Value) -> Result<&'a Value, String> {
    let pages: &[Value] = prop(document, "slides").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    if let Some(slide) = integer_of(request, "slide") {
        return match pages.get((slide - 1.0) as usize).filter(|_| slide >= 1.0) {
            Some(page) => Ok(page),
            None => Err(format!("The template has no slide {}; it holds {}", mixdog_js::number_to_string(slide), pages.len())),
        };
    }
    let role = text(prop(request, "role"));
    if role.is_empty() {
        return Err("use_template_page needs the page to use: role for the job it does, or slide for one exact page".to_owned());
    }
    let matches: Vec<&Value> = pages.iter().filter(|page| text(prop(page, "role")) == role).collect();
    if matches.is_empty() {
        let mut carried: Vec<String> = Vec::new();
        for page in pages {
            let carried_role = text(prop(page, "role"));
            if !carried_role.is_empty() && !carried.contains(&carried_role) {
                carried.push(carried_role);
            }
        }
        let carried = if carried.is_empty() { "unread".to_owned() } else { carried.join(", ") };
        return Err(format!("The template carries no {role} page; its pages are: {carried}"));
    }
    let requested: &[Value] = prop(request, "items").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let items = requested.len() as f64;
    // Items that carry a second line (a step's detail, a column's body, a metric's label) need a page with a box for it:
    // between two four-step process pages the one without detail lines answered first, and the fill was refused for text
    // the other page had room for.
    let follows = requested.iter().any(|item| !js_trim(&first_present(Some(item), &["body", "label", "detail"])).is_empty());
    let holds_follow = |slots: &Slots| match page_group(slots) {
        Some(group) => slots.roles().any(|role| role.starts_with(&format!("{}-{}-", group.family, group.follow))),
        None => false,
    };
    let mut sized: Vec<(&Value, f64, bool)> = matches
        .iter()
        .map(|&page| {
            let slots = page_slots(Some(page));
            (page, page_group(&slots).map_or(0.0, |group| group.size), holds_follow(&slots))
        })
        .collect();
    if follows {
        sized.sort_by(|left, right| u8::from(right.2).cmp(&u8::from(left.2)));
    }
    // The page that takes the items with the least room left over; when none holds them the widest one answers and the
    // fill reports how far it falls short.
    let any_follow_fits = sized.iter().any(|other| other.2 && other.1 >= items);
    let mut fits: Vec<(&Value, f64, bool)> = sized.iter().filter(|entry| entry.1 >= items && (!follows || entry.2 || !any_follow_fits)).copied().collect();
    let chosen = if fits.is_empty() {
        sized.sort_by(|left, right| compare(right.1, left.1));
        sized[0]
    } else {
        fits.sort_by(|left, right| compare(left.1, right.1));
        fits[0]
    };
    Ok(chosen.0)
}

/// What [`place_group_items`] found.
struct Placed {
    sets: Vec<(f64, String)>,
    deletes: Vec<f64>,
    unplaced: Vec<(usize, &'static str)>,
}

// Places each item's lead and follow text in the group's slots. Fewer items than slots empties the unused ones outright:
// the template's own words are never left behind to read as content. Text with no box is reported, not dropped.
fn place_group_items(slots: &Slots, group: Option<&Group>, items: &[Value]) -> Placed {
    let mut placed = Placed { sets: Vec::new(), deletes: Vec::new(), unplaced: Vec::new() };
    let Some(group) = group else { return placed };
    for position in 1..=(group.size as usize) {
        let item = items.get(position - 1);
        let lead = slots.get(&format!("{}-{}-{position}", group.family, group.lead));
        let follow = slots.get(&format!("{}-{}-{position}", group.family, group.follow));
        let lead_text = first_present(item, &["title", "value"]);
        let follow_text = first_present(item, &["body", "label", "detail"]);
        match lead {
            Some(shape) if !lead_text.is_empty() => placed.sets.push((shape, lead_text)),
            Some(shape) => placed.deletes.push(shape),
            None if !lead_text.is_empty() => placed.unplaced.push((position, group.lead)),
            None => {}
        }
        match follow {
            Some(shape) if !follow_text.is_empty() => placed.sets.push((shape, follow_text)),
            Some(shape) => placed.deletes.push(shape),
            None if !follow_text.is_empty() => placed.unplaced.push((position, group.follow)),
            None => {}
        }
    }
    placed
}

fn unique_in_order<T: PartialEq + Clone>(values: impl Iterator<Item = T>) -> Vec<T> {
    let mut unique: Vec<T> = Vec::new();
    for value in values {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    unique
}

fn unplaced_text_error(page: &Value, group: &Group, unplaced: &[(usize, &'static str)]) -> String {
    let fields = unique_in_order(unplaced.iter().map(|entry| entry.1)).join(" and ");
    let positions = unique_in_order(unplaced.iter().map(|entry| entry.0)).iter().map(ToString::to_string).collect::<Vec<_>>().join(", ");
    format!(
        "Slide {} of the template has no {} {fields} box for item {positions}, so that text has nowhere to go: put it in the item's {}, or use a page whose {}s carry a {fields} line",
        literal(prop(page, "index")),
        group.family,
        group.lead,
        group.family
    )
}

/// `templatePageFill(page, content)`: the text the page's boxes take for the content (`title`, `eyebrow`, `subtitle`,
/// `body`, `source` and the `items` of its group) and the boxes it empties. A page that cannot take the content says so.
pub fn template_page_fill(page: &Value, content: &Value) -> Result<TemplateFill, String> {
    let slots = page_slots(Some(page));
    let group = page_group(&slots);
    let items: &[Value] = prop(content, "items").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let index = literal(prop(page, "index"));
    if !items.is_empty() && group.is_none() {
        return Err(format!("Slide {index} of the template carries no repeated group, so its {} items have nowhere to go", items.len()));
    }
    if let Some(held) = group.as_ref().filter(|held| items.len() as f64 > held.size) {
        return Err(format!(
            "Slide {index} of the template holds {} {} slots and {} items were given: split them across two pages, or use a page that holds more",
            mixdog_js::number_to_string(held.size),
            held.family,
            items.len()
        ));
    }
    let mut sets: Vec<(f64, String)> = Vec::new();
    let title = text(prop(content, "title"));
    if !title.is_empty() {
        let Some(shape) = slots.get("title") else { return Err(format!("Slide {index} of the template has no title slot to fill")) };
        sets.push((shape, title));
    }
    // Text an item carries that the page has no box for: a comparison page whose columns are one line each cannot hold
    // the second line of an item, and writing the first line alone drops the rest without a word.
    let placed = place_group_items(&slots, group.as_ref(), items);
    if !placed.unplaced.is_empty() {
        return Err(unplaced_text_error(page, group.as_ref().expect("a group holds the unplaced text"), &placed.unplaced));
    }
    // The page's other words are the template's, not the deck's: an eyebrow or a subtitle takes the text given for it, and
    // one given none is emptied rather than left reading the template's own words on a page about something else.
    // Decorative type (visual-text) and the carriers (chart, table, image) stay.
    let mut claimed: Vec<f64> = sets.iter().chain(&placed.sets).map(|entry| entry.0).collect();
    let mut extra: Vec<(f64, String)> = Vec::new();
    for field in ["eyebrow", "subtitle", "body", "source"] {
        // The line under a title is a subtitle on a cover and the lead prose on a summary page; which name the author
        // uses for it depends on the page, so either one lands in whichever of the two boxes the page has.
        let partner = match field {
            "subtitle" => Some("body"),
            "body" => Some("subtitle"),
            _ => None,
        };
        let shape = slots.get(field).or_else(|| partner.filter(|partner| text(prop(content, partner)).is_empty()).and_then(|partner| slots.get(partner)));
        let given = text(prop(content, field));
        if !given.is_empty() && shape.is_none() {
            return Err(format!("Slide {index} of the template has no {field} box, so its {field} text has nowhere to go: leave it out, or use a page that carries one"));
        }
        if let (Some(shape), false) = (shape, given.is_empty()) {
            extra.push((shape, given));
            claimed.push(shape);
        }
    }
    let carried = compiled(r"^(eyebrow|subtitle|body(-\d+)?|meta|source|aside-\d+)$", "");
    let group_role = compiled(GROUP_ROLE, "");
    let mut unclaimed: Vec<f64> = slots.0.iter().filter(|(role, shape)| !claimed.contains(shape) && (carried.is_match(role) || group_role.is_match(role))).map(|(_, shape)| *shape).collect();
    // Decorative type stays only as a sign ("VS", "→"). A word or a figure set large in a template's accent block
    // ("MIXDOG", "TIME TO DECISION", "18") is the template's content: kept, it read as the deck's on every page built from
    // the bundled template, the closing page signed with the template's own name.
    let sign = compiled(SIGN_TEXT, "u");
    for shape in shapes_of(Some(page)) {
        let number = to_number_of(prop(shape, "index"));
        if text(prop(shape, "slot")) == "visual-text" && !claimed.contains(&number) && !sign.is_match(js_trim(&text(prop(shape, "text")))) {
            unclaimed.push(number);
        }
    }
    // Deleting a shape renumbers the ones after it, so they go highest first.
    let mut deletes: Vec<f64> = Vec::new();
    for shape in placed.deletes.iter().chain(&unclaimed) {
        if !deletes.contains(shape) {
            deletes.push(*shape);
        }
    }
    deletes.sort_by(|left, right| compare(*right, *left));
    sets.extend(extra);
    sets.extend(placed.sets);
    Ok(TemplateFill { sets, deletes, group })
}

// A page's chart, table, and picture arrive holding the template's own data: its fill writes words, not numbers or
// photographs, so a filled page kept "Coverage 62% · Latency 820ms" and the template's logo unless the caller went on to
// replace them, and nothing said so. Each carrier is named with its shape as it stands after the fill and the operation
// that replaces its content. A chart's title is the template's words too, and new numbers keep it: the record carries it,
// for set_chart_data's title to replace.
fn template_carriers(page: &Value, deletes: &[f64], slide: f64) -> Vec<Value> {
    let mut carriers = Vec::new();
    for shape in shapes_of(Some(page)) {
        let holds = text(prop(shape, "slot"));
        let replace_with = match holds.as_str() {
            "chart" => "set_chart_data",
            "table" => "set_table_data",
            "image" => "replace_image",
            _ => continue,
        };
        let index = to_number_of(prop(shape, "index"));
        if deletes.contains(&index) {
            continue;
        }
        let at = index - deletes.iter().filter(|deleted| **deleted < index).count() as f64;
        let title = if holds == "chart" { text(opt_prop(prop(shape, "chart"), "title")) } else { String::new() };
        let mut carrier = Map::new();
        carrier.insert("slide".to_owned(), json_number(slide));
        carrier.insert("shape".to_owned(), json_number(at));
        carrier.insert("holds".to_owned(), Value::String(holds));
        carrier.insert("replaceWith".to_owned(), Value::String(replace_with.to_owned()));
        if !title.is_empty() {
            carrier.insert("title".to_owned(), Value::String(title));
        }
        carriers.push(Value::Object(carrier));
    }
    carriers
}

/// A template that ships a sidecar (`<deck>.pptx.mixdog.json`) has already said what each page does and which box fills
/// which slot. Those declared roles win over the geometry reading: the bundled executive pages set their metrics on a
/// stepped diagonal, which no row reading recognises, so a request for a metrics page landed on a chart page with no
/// metric slot and was refused. A page the sidecar does not describe keeps its induced roles.
fn overlay_template_sidecar<P: ReadProof>(proof: &P, document: &mut Value, path: &str) {
    let sidecar = read_json(proof, Path::new(&format!("{path}.mixdog.json")), Value::Null);
    let Some(samples) = prop(&sidecar, "samples").and_then(Value::as_array) else { return };
    let Some(slides) = document.get_mut("slides").and_then(Value::as_array_mut) else { return };
    for sample in samples {
        let number = to_number_of(prop(sample, "slide")) - 1.0;
        if !(number >= 0.0 && number.fract() == 0.0) {
            continue;
        }
        let Some(page) = slides.get_mut(number as usize) else { continue };
        // `typeof roles === 'object'`: an object or an array.
        let Some(roles) = prop(sample, "roles").filter(|roles| truthy(roles) && (roles.is_object() || roles.is_array())) else { continue };
        if prop(sample, "kind").is_some_and(truthy) {
            page["role"] = Value::String(value_to_string(&sample["kind"]));
        }
        let Some(shapes) = page.get_mut("shapes").and_then(Value::as_array_mut) else { continue };
        for shape in shapes {
            let key = value_to_string(prop(shape, "index").unwrap_or(&Value::Null));
            let declared = match roles {
                Value::Array(items) => key.parse::<usize>().ok().filter(|at| at.to_string() == key).and_then(|at| items.get(at)),
                other => prop(other, &key),
            };
            match declared.filter(|declared| truthy(declared)) {
                Some(declared) => shape["slot"] = Value::String(value_to_string(declared)),
                None => {
                    if let Some(map) = shape.as_object_mut() {
                        map.shift_remove("slot");
                    }
                }
            }
        }
    }
}

/// `expandTemplatePageOperations(format, operations, carriers)`: every `use_template_page` operation of a pptx batch
/// becomes `import_slides` of the chosen page (at `after`, 0 for the front of the deck), the `set_text` and `delete_shape`
/// operations of its fill and, with `notes`, `set_notes`; other operations pass through. The carriers of each page that
/// still hold the template's data are appended to `carriers`. `snapshot` reads a template's snapshot (the portable
/// reader's `snapshotPortableOoxml(path, 'pptx')`): a deck filled page by page reads its template once.
pub fn expand_template_page_operations<P: ReadProof>(
    proof: &P,
    format: &str,
    operations: &[Value],
    carriers: &mut Vec<Value>,
    snapshot: &mut dyn FnMut(&str) -> Result<Value, String>,
) -> Result<Vec<Value>, String> {
    let is_page = |operation: &Value| prop(operation, "op") == Some(&Value::String("use_template_page".to_owned()));
    if format != "pptx" || !operations.iter().any(is_page) {
        return Ok(operations.to_vec());
    }
    let mut expanded: Vec<Value> = Vec::new();
    let mut documents: HashMap<String, Value> = HashMap::new();
    for operation in operations {
        if !is_page(operation) {
            expanded.push(operation.clone());
            continue;
        }
        let after = to_number_of(prop(operation, "after"));
        if !(after.is_finite() && after.fract() == 0.0 && after >= 0.0) {
            return Err("use_template_page needs after: the slide the new page follows, 0 to put it at the front of the deck".to_owned());
        }
        let path = literal(prop(operation, "path"));
        if !documents.contains_key(&path) {
            let mut document = snapshot(&path)?;
            annotate_pptx_snapshot_roles(&mut document);
            overlay_template_sidecar(proof, &mut document, &path);
            documents.insert(path.clone(), document);
        }
        let document = &documents[&path];
        let page = select_template_page(document, operation)?;
        let fill = template_page_fill(page, operation)?;
        let slide = after + 1.0;
        let page_index = to_number_of(prop(page, "index"));
        expanded.push(json!({ "op": "import_slides", "path": prop(operation, "path").cloned().unwrap_or(Value::Null), "slides": [json_number(page_index)], "after": json_number(after) }));
        for (shape, words) in &fill.sets {
            expanded.push(json!({ "op": "set_text", "slide": json_number(slide), "shape": json_number(*shape), "text": words }));
        }
        for shape in &fill.deletes {
            expanded.push(json!({ "op": "delete_shape", "slide": json_number(slide), "shape": json_number(*shape) }));
        }
        if prop(operation, "notes").is_some_and(truthy) {
            expanded.push(json!({ "op": "set_notes", "slide": json_number(slide), "text": text(prop(operation, "notes")) }));
        }
        carriers.extend(template_carriers(page, &fill.deletes, slide));
    }
    Ok(expanded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comparison_page(index: u32, columns: u32) -> Value {
        let mut shapes = vec![json!({ "index": 1, "slot": "title", "text": "" })];
        for position in 0..columns {
            shapes.push(json!({ "index": 2 + position * 2, "slot": format!("column-title-{}", position + 1), "text": "" }));
            shapes.push(json!({ "index": 3 + position * 2, "slot": format!("column-body-{}", position + 1), "text": "" }));
        }
        json!({ "index": index, "role": "comparison", "shapes": shapes })
    }

    fn index_of(page: Result<&Value, String>) -> f64 {
        page.expect("a page").get("index").and_then(Value::as_f64).expect("an index")
    }

    #[test]
    fn the_closest_fitting_page_answers_and_a_page_refuses_more_items_than_it_holds() {
        let document = json!({ "slides": [comparison_page(1, 4), comparison_page(2, 2)] });
        assert_eq!(index_of(select_template_page(&document, &json!({ "role": "comparison", "items": [{}, {}] }))), 2.0);
        assert_eq!(index_of(select_template_page(&document, &json!({ "role": "comparison", "items": [{}, {}, {}] }))), 1.0);
        let error = template_page_fill(&comparison_page(1, 2), &json!({ "items": [{}, {}, {}] })).expect_err("three items on two columns");
        assert!(error.contains("holds 2 column slots and 3 items were given"), "{error}");
    }

    #[test]
    fn items_with_a_second_line_go_to_the_page_that_has_a_box_for_it() {
        let titles_only = json!({ "index": 3, "role": "comparison", "shapes": [
            { "index": 1, "slot": "title", "text": "" }, { "index": 2, "slot": "column-title-1", "text": "" }, { "index": 3, "slot": "column-title-2", "text": "" } ] });
        let document = json!({ "slides": [titles_only, comparison_page(4, 2)] });
        let with_body = json!({ "role": "comparison", "items": [{ "title": "가", "body": "설명" }, { "title": "나" }] });
        let without = json!({ "role": "comparison", "items": [{ "title": "가" }, { "title": "나" }] });
        assert_eq!(index_of(select_template_page(&document, &with_body)), 4.0);
        assert_eq!(index_of(select_template_page(&document, &without)), 3.0);
    }

    #[test]
    fn the_fill_sets_what_it_is_given_and_empties_the_rest_highest_first() {
        let fill = template_page_fill(&comparison_page(1, 3), &json!({ "title": "비교", "items": [{ "title": "가", "body": "가 설명" }] })).expect("a fill");
        assert_eq!(fill.sets.iter().map(|entry| entry.0).collect::<Vec<_>>(), vec![1.0, 2.0, 3.0]);
        assert_eq!(fill.deletes, vec![7.0, 6.0, 5.0, 4.0]);
    }

    #[test]
    fn text_with_no_box_is_reported_not_dropped() {
        let one_line = json!({ "index": 3, "role": "comparison", "shapes": [
            { "index": 1, "slot": "title", "text": "" }, { "index": 2, "slot": "column-title-1", "text": "" }, { "index": 3, "slot": "column-title-2", "text": "" } ] });
        let error = template_page_fill(&one_line, &json!({ "items": [{ "title": "가", "body": "설명" }] })).expect_err("no body box");
        assert!(error.contains("has no column body box for item 1"), "{error}");
        let error = template_page_fill(&one_line, &json!({ "eyebrow": "KICKER" })).expect_err("no eyebrow box");
        assert!(error.contains("has no eyebrow box"), "{error}");
    }

    #[test]
    fn a_named_slide_or_role_is_required_and_a_missing_one_is_reported() {
        let document = json!({ "slides": [comparison_page(1, 2)] });
        assert!(select_template_page(&document, &json!({ "slide": 2 })).expect_err("beyond the deck").contains("The template has no slide 2; it holds 1"));
        assert!(select_template_page(&document, &json!({})).expect_err("nothing named").starts_with("use_template_page needs the page to use"));
        assert!(select_template_page(&document, &json!({ "role": "metrics" })).expect_err("no such role").ends_with("its pages are: comparison"));
    }

    #[test]
    fn a_decorative_word_goes_and_a_sign_stays() {
        let page = json!({ "index": 1, "role": "closing", "shapes": [
            { "index": 1, "slot": "title", "text": "" },
            { "index": 2, "slot": "visual-text", "text": "MIXDOG" },
            { "index": 3, "slot": "visual-text", "text": "VS" },
            { "index": 4, "slot": "chart", "text": "" } ] });
        let fill = template_page_fill(&page, &json!({ "title": "Thanks" })).expect("a fill");
        assert_eq!(fill.deletes, vec![2.0]);
        assert_eq!(template_carriers(&page, &fill.deletes, 3.0), vec![json!({ "slide": 3, "shape": 3, "holds": "chart", "replaceWith": "set_chart_data" })]);
    }
}
