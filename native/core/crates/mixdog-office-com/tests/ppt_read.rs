//! The PowerPoint reader (`Snapshot-PowerPoint`, the pptx `Snapshot-Selection`, `Issues-PowerPoint`) against the replaying fake
//! dispatch object: the reader must make the calls the script makes, in its order, and answer the text the script answers.
//!
//! The call logs below are written by hand from `office-com-host.ps1`.

use mixdog_office_com::com::Obj;
use mixdog_office_com::com::fake::Fake;
use mixdog_office_com::drivers::Drivers;
use mixdog_office_com::format::FormatReader;
use mixdog_office_com::format::issues_document;
use mixdog_office_com::format::snapshot_selection;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::ScriptedApplications;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::platform::FontSet;
use mixdog_office_com::ppt::Reader;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::json::to_json;
use mixdog_office_com::ps::payload;
use serde_json::Value as Json;
use serde_json::json;

// ---------------------------------------------------------------------------------------------------------------------
// The call log of a scenario.

fn s(text: &str) -> Json {
    json!({"t": "str", "v": text})
}

fn i4(number: i32) -> Json {
    json!({"t": "i4", "v": number})
}

fn r4(number: f64) -> Json {
    json!({"t": "r4", "v": number})
}

fn b(flag: bool) -> Json {
    json!({"t": "bool", "v": flag})
}

fn obj(id: u64) -> Json {
    json!({"t": "obj", "v": id})
}

fn null() -> Json {
    json!({"t": "null"})
}

#[derive(Default)]
struct Log {
    lines: Vec<Json>,
}

impl Log {
    fn push(&mut self, mut line: Json) {
        line["seq"] = json!(self.lines.len() + 1);
        self.lines.push(line);
    }

    fn get(&mut self, id: u64, member: &str, result: Json) {
        self.push(json!({"obj": id, "kind": "get", "member": member, "flags": 2, "args": [], "result": result}));
    }

    fn get_with(&mut self, id: u64, member: &str, args: Vec<Json>, result: Json) {
        self.push(json!({"obj": id, "kind": "get", "member": member, "flags": 3, "args": args, "result": result}));
    }

    fn next(&mut self, id: u64, result: Json) {
        self.push(json!({"obj": id, "kind": "enum-next", "member": "", "flags": 0, "args": [], "result": result}));
    }

    fn end_of_enumeration(&mut self, id: u64) {
        self.push(json!({"obj": id, "kind": "enum-next", "member": "", "flags": 0, "args": [], "result": null}));
    }

    fn fake(&self) -> Fake {
        Fake::from_lines(&self.lines.iter().map(Json::to_string).collect::<Vec<_>>().join("\n"))
    }

    /// `$presentation.Slides.Count`.
    fn slide_count(&mut self, count: i32) {
        self.get(1, "Slides", obj(2));
        self.get(2, "Count", i4(count));
    }

    /// `$presentation.SlideMaster.CustomLayouts.Count`.
    fn layout_count(&mut self, count: i32) {
        self.get(1, "SlideMaster", obj(3));
        self.get(3, "CustomLayouts", obj(4));
        self.get(4, "Count", i4(count));
    }
}

fn request(value: &Json) -> Value {
    payload::parse_payload(&value.to_string()).expect("a request")
}

fn text_of(value: &Value) -> String {
    to_json(value, 20)
}

struct World {
    platform: FakePlatform,
    applications: ScriptedApplications,
}

impl World {
    fn new(fonts: &[&str]) -> World {
        let platform = FakePlatform::new();
        let mut set = FontSet::default();
        for font in fonts {
            set.insert(font);
        }
        platform.set_fonts(set);
        World { platform, applications: ScriptedApplications::new() }
    }

    fn env(&self) -> Env<'_> {
        Env { platform: &self.platform, applications: &self.applications }
    }
}

fn snapshot(fake: &Fake, payload: &Json) -> Result<String, String> {
    let world = World::new(&[]);
    let document: Obj = fake.object(1);
    Reader.snapshot(&world.env(), &document, &request(payload)).map(|value| text_of(&value)).map_err(|error| error.message().to_owned())
}

fn issues(fake: &Fake, fonts: &[&str], payload: &Json) -> Result<String, String> {
    let world = World::new(fonts);
    let document: Obj = fake.object(1);
    Reader.issues(&world.env(), &document, &request(payload)).map(|value| text_of(&value)).map_err(|error| error.message().to_owned())
}

fn selection(fake: &Fake) -> String {
    let world = World::new(&[]);
    let document: Obj = fake.object(1);
    let readers: [(&str, &dyn FormatReader); 1] = [("pptx", &Reader)];
    let drivers = Drivers::new(&readers, &[]);
    text_of(&snapshot_selection(&drivers, &world.env(), &document, "pptx"))
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot-PowerPoint.

#[test]
fn a_deck_without_slides_answers_its_lists_and_no_pagination() {
    let mut log = Log::default();
    log.slide_count(0); // the limit of an unpaged read
    log.slide_count(0); // the end of the slide range
    log.layout_count(0);
    log.get(1, "Designs", obj(5));
    log.get(5, "Count", i4(1));
    log.get(1, "Designs", obj(5));
    log.get_with(5, "Item", vec![i4(1)], obj(6));
    log.get(6, "Name", s("Office Theme"));
    log.get(1, "Designs", obj(5));
    log.get(5, "Count", i4(1));
    log.get(1, "FullName", s("C:\\decks\\a.pptx"));
    log.slide_count(0);
    log.get(1, "PageSetup", obj(7));
    log.get(7, "SlideWidth", r4(960.0));
    log.get(1, "PageSetup", obj(7));
    log.get(7, "SlideHeight", r4(540.0));
    log.get(1, "Designs", obj(5));
    log.get_with(5, "Item", vec![i4(1)], obj(6));
    log.get(6, "Name", s("Office Theme"));
    let fake = log.fake();
    let answer = snapshot(&fake, &json!({})).expect("a snapshot");
    assert_eq!(
        answer,
        "{\"format\":\"pptx\",\"path\":\"C:\\\\decks\\\\a.pptx\",\"slideCount\":0,\"slideWidth\":960,\"slideHeight\":540,\"layoutCount\":0,\"layouts\":[],\
         \"designCount\":1,\"designs\":[{\"index\":1,\"name\":\"Office Theme\"}],\"slides\":[],\"theme\":\"Office Theme\",\"pagination\":null}"
    );
    fake.finish();
}

#[test]
fn a_slide_out_of_range_is_refused_with_the_scripts_text_after_the_count_was_read() {
    let mut log = Log::default();
    log.slide_count(3); // the limit of an unpaged read
    log.slide_count(3); // the check of the page
    let fake = log.fake();
    assert_eq!(snapshot(&fake, &json!({"pages": [5]})), Err("PowerPoint slide out of range: 5".to_owned()));
    fake.finish();
}

#[test]
// A one-element array of 0 is false in PowerShell (`if ($payload.pages)`), so the request names two pages.
fn a_slide_number_below_one_is_refused_without_reading_the_count_again() {
    let mut log = Log::default();
    log.slide_count(3);
    let fake = log.fake();
    assert_eq!(snapshot(&fake, &json!({"pages": [0, 2]})), Err("PowerPoint slide out of range: 0".to_owned()));
    fake.finish();
}

/// The calls of a picture shape's whole read (its text chains are empty, so the font, the frame and the bounds read nothing).
fn picture_shape(log: &mut Log, shape: u64) {
    let (fill, line, shadow, picture) = (shape + 1, shape + 2, shape + 3, shape + 4);
    log.get(shape, "Type", i4(13));
    log.get(shape, "HasTextFrame", b(false));
    log.get(shape, "Fill", obj(fill));
    log.get(shape, "Line", obj(line));
    log.get(shape, "Shadow", obj(shadow));
    for (side, value) in [("CropLeft", 1.5), ("CropRight", 0.0), ("CropTop", 2.0), ("CropBottom", 0.0)] {
        log.get(shape, "PictureFormat", obj(picture));
        log.get(picture, side, r4(value));
    }
    log.get(shape, "HasTable", b(false));
    log.get(shape, "Name", s("Picture 1"));
    for (member, value) in [("Left", 10.0), ("Top", 20.0), ("Width", 300.0), ("Height", 200.0), ("Rotation", 0.0)] {
        log.get(shape, member, r4(value));
    }
    log.get(fill, "ForeColor", obj(shape + 10));
    log.get(shape + 10, "RGB", i4(255));
    log.get(fill, "Visible", i4(0));
    log.get(fill, "Transparency", r4(0.0));
    log.get(line, "ForeColor", obj(shape + 11));
    log.get(shape + 11, "RGB", i4(0));
    log.get(line, "Visible", i4(0));
    log.get(line, "Transparency", r4(0.0));
    log.get(shadow, "Visible", i4(0));
    log.get(shadow, "ForeColor", obj(shape + 12));
    log.get(shape + 12, "RGB", i4(0));
    for member in ["Transparency", "Blur", "OffsetX", "OffsetY"] {
        log.get(shadow, member, r4(0.0));
    }
    log.get(shape, "HasChart", b(false));
}

#[test]
fn a_paged_read_of_a_slide_with_a_picture_answers_what_the_script_answers() {
    let mut log = Log::default();
    log.slide_count(1); // the end of the slide range
    log.slide_count(1); // the check of the page
    log.get(1, "Slides", obj(2));
    log.get_with(2, "Item", vec![i4(1)], obj(8));
    log.get(8, "SlideIndex", i4(1));
    // The shapes: the count at every step of the loop.
    log.get(8, "Shapes", obj(9));
    log.get(9, "Count", i4(1));
    log.get(8, "Shapes", obj(9));
    log.get_with(9, "Item", vec![i4(1)], obj(30));
    picture_shape(&mut log, 30);
    log.get(8, "Shapes", obj(9));
    log.get(9, "Count", i4(1));
    // The notes page has no shapes.
    log.get(8, "NotesPage", obj(10));
    log.get(10, "Shapes", obj(11));
    log.end_of_enumeration(11);
    // Comments, animations.
    log.get(8, "Comments", obj(12));
    log.get(12, "Count", i4(0));
    log.get(8, "TimeLine", obj(13));
    log.get(13, "MainSequence", obj(14));
    log.get(14, "Count", i4(0));
    // The layout and its index in the master.
    log.get(8, "CustomLayout", obj(15));
    log.get(15, "Name", s("Title Slide"));
    log.layout_count(2);
    log.get(1, "SlideMaster", obj(3));
    log.get(3, "CustomLayouts", obj(4));
    log.get_with(4, "Item", vec![i4(1)], obj(16));
    log.get(16, "Name", s("title slide"));
    // The background of the layout, then the slide's hidden flag and transition.
    log.get(8, "FollowMasterBackground", b(true));
    log.get(8, "CustomLayout", obj(15));
    log.get(15, "Background", obj(17));
    log.get(17, "Fill", obj(18));
    log.get(18, "ForeColor", obj(19));
    log.get(19, "RGB", i4(16_777_215));
    log.get(8, "SlideShowTransition", obj(20));
    log.get(20, "Hidden", b(false));
    for (member, result) in [("EntryEffect", i4(3849)), ("AdvanceOnTime", b(true)), ("AdvanceTime", r4(3.0))] {
        log.get(8, "SlideShowTransition", obj(20));
        log.get(20, member, result);
    }
    // The layouts of the master, the designs, the deck's own properties.
    log.layout_count(2);
    for (at, name) in [(1, "Title Slide"), (2, "Blank")] {
        log.get(1, "SlideMaster", obj(3));
        log.get(3, "CustomLayouts", obj(4));
        log.get_with(4, "Item", vec![i4(at)], obj(60 + at as u64));
        log.get(60 + at as u64, "Name", s(name));
        log.layout_count(2);
    }
    log.get(1, "Designs", obj(5));
    log.get(5, "Count", i4(0));
    log.get(1, "FullName", s("C:\\decks\\a.pptx"));
    log.slide_count(1);
    log.get(1, "PageSetup", obj(7));
    log.get(7, "SlideWidth", r4(960.0));
    log.get(1, "PageSetup", obj(7));
    log.get(7, "SlideHeight", r4(540.0));
    log.get(1, "Designs", obj(5));
    log.get_with(5, "Item", vec![i4(1)], obj(6));
    log.get(6, "Name", s("Office Theme"));
    log.slide_count(1); // the total of the pagination
    log.slide_count(1); // the check of its next offset
    let fake = log.fake();
    let answer = snapshot(&fake, &json!({"paged": true, "offset": 0, "limit": 10})).expect("a snapshot");
    let picture = "{\"path\":\"/slide[1]/shape[1]\",\"index\":1,\"name\":\"Picture 1\",\"type\":13,\"geometry\":\"\",\"text\":null,\"placeholder\":null,\
        \"group\":null,\"crop\":{\"left\":1.5,\"right\":0,\"top\":2,\"bottom\":0},\"table\":null,\"left\":10,\"top\":20,\"width\":300,\"height\":200,\
        \"rotation\":0,\"fillColor\":255,\"fillVisible\":false,\"fillTransparency\":0,\"lineColor\":0,\"lineVisible\":false,\"lineTransparency\":0,\
        \"shadow\":{\"visible\":0,\"color\":0,\"transparency\":0,\"blur\":0,\"offsetX\":0,\"offsetY\":0},\
        \"textFrame\":{\"marginLeft\":0,\"marginTop\":0,\"marginRight\":0,\"marginBottom\":0,\"paragraphSpacing\":0},\
        \"textBounds\":{\"width\":0,\"height\":0},\"font\":{\"name\":\"\",\"size\":0,\"bold\":0,\"italic\":0,\"color\":\"000000\"},\"runs\":null,\"chart\":null}";
    let slide = format!(
        "{{\"path\":\"/slide[1]\",\"index\":1,\"hidden\":false,\"layout\":{{\"index\":1,\"name\":\"Title Slide\"}},\
         \"background\":{{\"followMaster\":true,\"source\":\"layout\",\"color\":\"FFFFFF\"}},\"shapes\":[{picture}],\"notes\":\"\",\"comments\":[],\
         \"animations\":[],\"transition\":{{\"effect\":3849,\"advanceOnTime\":true,\"advanceTime\":3}}}}"
    );
    let expected = format!(
        "{{\"format\":\"pptx\",\"path\":\"C:\\\\decks\\\\a.pptx\",\"slideCount\":1,\"slideWidth\":960,\"slideHeight\":540,\"layoutCount\":2,\
         \"layouts\":[{{\"path\":\"/layout[1]\",\"index\":1,\"name\":\"Title Slide\"}},{{\"path\":\"/layout[2]\",\"index\":2,\"name\":\"Blank\"}}],\
         \"designCount\":0,\"designs\":[],\"slides\":[{slide}],\"theme\":\"Office Theme\",\
         \"pagination\":{{\"unit\":\"slide\",\"offset\":0,\"limit\":10,\"returned\":1,\"total\":1,\"nextOffset\":null}}}}"
    );
    assert_eq!(answer, expected);
    fake.finish();
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot-Selection.

/// The reads that start every pptx selection: the window, its selection, the slide on view and the selection's type.
fn window_and_type(log: &mut Log, slide: i32, selection_type: i32) {
    log.get(1, "Application", obj(2));
    log.get(2, "ActiveWindow", obj(3));
    log.get(3, "Selection", obj(4));
    log.get(3, "View", obj(5));
    log.get(5, "Slide", obj(6));
    log.get(6, "SlideIndex", i4(slide));
    log.get(4, "Type", i4(selection_type));
}

#[test]
fn a_deck_with_no_active_window_has_no_selection() {
    let mut log = Log::default();
    log.get(1, "Application", obj(2));
    log.get(2, "ActiveWindow", null());
    let fake = log.fake();
    assert_eq!(selection(&fake), "{\"available\":false,\"reason\":\"PowerPoint has no active window.\"}");
    fake.finish();
}

#[test]
fn a_selected_shape_is_found_by_its_id_among_the_shapes_of_the_slide() {
    let mut log = Log::default();
    window_and_type(&mut log, 2, 2);
    log.get(1, "Slides", obj(7));
    log.get_with(7, "Item", vec![i4(2)], obj(8));
    log.get(4, "ShapeRange", obj(9));
    log.next(9, obj(10));
    log.end_of_enumeration(9);
    for (index, shape, id) in [(1, 12, 5), (2, 13, 7)] {
        log.get(8, "Shapes", obj(11));
        log.get(11, "Count", i4(2));
        log.get(8, "Shapes", obj(11));
        log.get_with(11, "Item", vec![i4(index)], obj(shape));
        log.get(shape, "Id", i4(id));
        log.get(10, "Id", i4(7));
    }
    let fake = log.fake();
    assert_eq!(
        selection(&fake),
        "{\"available\":true,\"kind\":\"shapes\",\"target\":\"/slide[2]/shape[2]\",\"targets\":[\"/slide[2]/shape[2]\"],\
         \"key\":\"2:/slide[2]/shape[2]\",\"slide\":2,\"selectionType\":2}"
    );
    fake.finish();
}

#[test]
fn selected_slides_are_listed_in_order_and_a_failed_read_is_the_reason() {
    let mut log = Log::default();
    window_and_type(&mut log, 1, 1);
    log.get(4, "SlideRange", obj(7));
    log.next(7, obj(8));
    log.next(7, obj(9));
    log.end_of_enumeration(7);
    log.get(8, "SlideIndex", i4(1));
    log.get(9, "SlideIndex", i4(3));
    let fake = log.fake();
    assert_eq!(
        selection(&fake),
        "{\"available\":true,\"kind\":\"slides\",\"target\":\"/slide[1]\",\"targets\":[\"/slide[1]\",\"/slide[3]\"],\
         \"key\":\"1:/slide[1],/slide[3]\",\"slide\":1,\"selectionType\":1}"
    );
    fake.finish();

    let mut failing = Log::default();
    failing.get(1, "Application", obj(2));
    failing.push(json!({"obj": 2, "kind": "get", "member": "ActiveWindow", "flags": 2, "args": [],
        "error": {"hresult": -2_147_467_259_i64, "message": "Exception getting \"ActiveWindow\": \"no window\""}}));
    let fake = failing.fake();
    assert_eq!(selection(&fake), "{\"available\":false,\"reason\":\"Exception getting \\\"ActiveWindow\\\": \\\"no window\\\"\"}");
    fake.finish();
}

#[test]
fn nothing_selected_on_a_slide_targets_the_slide_and_none_on_no_slide_targets_the_root() {
    let mut log = Log::default();
    window_and_type(&mut log, 4, 0);
    let fake = log.fake();
    assert_eq!(
        selection(&fake),
        "{\"available\":true,\"kind\":\"none\",\"target\":\"/slide[4]\",\"targets\":[\"/slide[4]\"],\"key\":\"0:/slide[4]\",\"slide\":4,\"selectionType\":0}"
    );
    fake.finish();
    let mut log = Log::default();
    window_and_type(&mut log, 0, 0);
    let fake = log.fake();
    assert_eq!(
        selection(&fake),
        "{\"available\":true,\"kind\":\"none\",\"target\":\"/\",\"targets\":[],\"key\":\"0:\",\"slide\":0,\"selectionType\":0}"
    );
    fake.finish();
}

// ---------------------------------------------------------------------------------------------------------------------
// PowerPoint-NotesText.

#[test]
fn the_notes_are_the_text_of_the_body_placeholder_of_the_notes_page() {
    let mut log = Log::default();
    log.get(1, "NotesPage", obj(2));
    log.get(2, "Shapes", obj(3));
    log.next(3, obj(4));
    log.next(3, obj(5));
    log.end_of_enumeration(3);
    log.get(4, "PlaceholderFormat", obj(6));
    log.get(6, "Type", i4(1));
    log.get(5, "PlaceholderFormat", obj(7));
    log.get(7, "Type", i4(2));
    log.get(5, "HasTextFrame", b(true));
    log.get(5, "TextFrame", obj(8));
    log.get(8, "HasText", b(true));
    log.get(5, "TextFrame", obj(8));
    log.get(8, "TextRange", obj(9));
    log.get(9, "Text", s("Source: Model!B2"));
    let fake = log.fake();
    let slide = mixdog_office_com::com::Value::Dispatch(fake.object(1));
    assert_eq!(mixdog_office_com::ppt::snapshot::notes_text(&slide), "Source: Model!B2");
    fake.finish();
}

// ---------------------------------------------------------------------------------------------------------------------
// Issues-PowerPoint.

/// The reads of a one-slide deck up to the slide's shapes: the slides, the slide size, the shapes.
fn deck_with_one_slide(log: &mut Log) {
    log.get(1, "Slides", obj(2));
    log.next(2, obj(3));
    log.end_of_enumeration(2);
    log.get(1, "PageSetup", obj(4));
    log.get(4, "SlideWidth", r4(960.0));
    log.get(1, "PageSetup", obj(4));
    log.get(4, "SlideHeight", r4(540.0));
    log.get(3, "Shapes", obj(5));
}

#[test]
fn a_text_box_that_overflows_with_a_missing_font_and_no_contrast_is_reported_in_the_scripts_order() {
    let mut log = Log::default();
    deck_with_one_slide(&mut log);
    log.next(5, obj(6));
    log.end_of_enumeration(5);
    log.get(3, "SlideIndex", i4(1)); // the path
    log.get(6, "Type", i4(17)); // the visual-shape count
    log.get(6, "HasChart", b(false));
    log.get(6, "HasTable", b(false));
    log.get(6, "Type", i4(17)); // the picture check
    log.get(6, "Name", s("Title 1"));
    log.get(6, "HasTextFrame", b(true));
    log.get(6, "TextFrame", obj(7));
    log.get(7, "TextRange", obj(8));
    log.get(8, "Font", obj(9));
    log.get(6, "TextFrame2", obj(10));
    log.get(10, "TextRange", obj(11));
    log.get(6, "Fill", obj(12));
    for (member, value) in [("Left", 100.0), ("Top", 100.0), ("Width", 200.0), ("Height", 50.0)] {
        log.get(6, member, r4(value));
    }
    log.get(7, "HasText", b(true));
    log.get(11, "BoundWidth", r4(250.0));
    log.get(11, "BoundHeight", r4(30.0));
    log.get(6, "Rotation", r4(0.0));
    log.get(7, "WordWrap", i4(-1));
    log.get(9, "Size", r4(10.0)); // the run size
    log.get(9, "Name", s("Zapfino"));
    log.get(9, "Size", r4(10.0)); // the font size
    log.get(8, "Text", s("Hello"));
    log.get(12, "Visible", i4(-1));
    log.get(12, "ForeColor", obj(13));
    log.get(13, "RGB", i4(16_777_215));
    log.get(9, "Color", obj(14));
    log.get(14, "RGB", i4(16_777_215));
    log.get(6, "Type", i4(17)); // the placeholder check
    log.get(6, "HasChart", b(false)); // the chart check
    log.get(3, "SlideIndex", i4(1)); // the boundary slide check
    let fake = log.fake();
    let answer = issues(&fake, &["Calibri"], &json!({})).expect("the issues");
    assert_eq!(
        answer,
        "[{\"severity\":\"warning\",\"code\":\"text_overflow\",\"path\":\"/slide[1]/shape[1]\",\"message\":\"Text bounds exceed the containing shape.\"},\
         {\"severity\":\"warning\",\"code\":\"missing_font\",\"path\":\"/slide[1]/shape[1]\",\"message\":\"Font is not installed: Zapfino\"},\
         {\"severity\":\"warning\",\"code\":\"low_contrast\",\"path\":\"/slide[1]/shape[1]\",\"message\":\"Text-to-fill contrast ratio is 1:1.\"}]"
    );
    fake.finish();
}

#[test]
fn a_slide_the_pages_leave_out_is_not_inspected() {
    let mut log = Log::default();
    log.get(1, "Slides", obj(2));
    log.next(2, obj(3));
    log.end_of_enumeration(2);
    log.get(3, "SlideIndex", i4(1));
    let fake = log.fake();
    assert_eq!(issues(&fake, &[], &json!({"pages": [2]})).expect("the issues"), "[]");
    fake.finish();
}

#[test]
fn a_text_only_slide_between_the_first_and_the_last_is_reported_and_a_deck_of_three_is_checked_for_its_boundary() {
    // Slide 2 of 3 holds one text box and nothing else.
    let mut log = Log::default();
    log.get(1, "Slides", obj(2));
    log.next(2, obj(3));
    log.end_of_enumeration(2);
    log.get(1, "PageSetup", obj(4));
    log.get(4, "SlideWidth", r4(960.0));
    log.get(1, "PageSetup", obj(4));
    log.get(4, "SlideHeight", r4(540.0));
    log.get(3, "Shapes", obj(5));
    log.next(5, obj(6));
    log.end_of_enumeration(5);
    log.get(3, "SlideIndex", i4(2));
    log.get(6, "Type", i4(17));
    log.get(6, "HasChart", b(false));
    log.get(6, "HasTable", b(false));
    log.get(6, "Type", i4(17));
    log.get(6, "Name", s("Text"));
    log.get(6, "HasTextFrame", b(true));
    log.get(6, "TextFrame", obj(7));
    log.get(7, "TextRange", obj(8));
    log.get(8, "Font", obj(9));
    log.get(6, "TextFrame2", obj(10));
    log.get(10, "TextRange", obj(11));
    log.get(6, "Fill", obj(12));
    for (member, value) in [("Left", 100.0), ("Top", 100.0), ("Width", 400.0), ("Height", 50.0)] {
        log.get(6, member, r4(value));
    }
    log.get(7, "HasText", b(true));
    log.get(11, "BoundWidth", r4(100.0));
    log.get(11, "BoundHeight", r4(30.0));
    log.get(6, "Rotation", r4(0.0));
    log.get(7, "WordWrap", i4(-1));
    log.get(9, "Size", r4(24.0));
    log.get(9, "Name", s("Calibri"));
    log.get(9, "Size", r4(24.0));
    log.get(8, "Text", s("Plain"));
    log.get(12, "Visible", i4(0)); // no fill: no contrast
    log.get(9, "Color", obj(13));
    log.get(13, "RGB", i4(0));
    log.get(6, "Type", i4(17));
    log.get(6, "HasChart", b(false));
    log.get(3, "SlideIndex", i4(2)); // the first boundary term
    log.get(3, "SlideIndex", i4(2)); // the second
    log.get(1, "Slides", obj(14));
    log.get(14, "Count", i4(3));
    log.get(3, "SlideIndex", i4(2)); // the path of the issue
    let fake = log.fake();
    let answer = issues(&fake, &["Calibri"], &json!({})).expect("the issues");
    assert_eq!(
        answer,
        "[{\"severity\":\"warning\",\"code\":\"text_only_slide\",\"path\":\"/slide[2]\",\
         \"message\":\"Slide contains text but no visual shape, chart, table, diagram, or picture.\"}]"
    );
    fake.finish();
}

#[test]
fn issues_of_the_deck_come_back_through_the_shared_issue_document() {
    let mut log = Log::default();
    log.get(1, "Slides", obj(2));
    log.end_of_enumeration(2);
    let fake = log.fake();
    let world = World::new(&[]);
    let readers: [(&str, &dyn FormatReader); 1] = [("pptx", &Reader)];
    let drivers = Drivers::new(&readers, &[]);
    let answer = issues_document(&drivers, &world.env(), &fake.object(1), "pptx", None).expect("the issues");
    assert_eq!(text_of(&answer), "{\"ok\":true,\"format\":\"pptx\",\"issueCount\":0,\"issues\":[]}");
    fake.finish();
}
