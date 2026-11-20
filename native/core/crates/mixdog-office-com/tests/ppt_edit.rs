//! The PowerPoint editor (`Apply-PowerPointOperation`, 46 operations) against the replaying fake dispatch object: an operation
//! must make the calls the script makes, in its order, and answer the record the script answers.
//!
//! The call logs below are written by hand from `office-com-host.ps1`.

use mixdog_office_com::com::Obj;
use mixdog_office_com::com::fake::Fake;
use mixdog_office_com::format::EditContext;
use mixdog_office_com::format::FormatEditor;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::ScriptedApplications;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::platform::FakeWindow;
use mixdog_office_com::ppt::edit::Editor;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::json::to_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::ChartExcel;
use serde_json::Value as Json;
use serde_json::json;

// ---------------------------------------------------------------------------------------------------------------------
// The call log of an operation.

fn s(text: &str) -> Json {
    json!({"t": "str", "v": text})
}

fn i4(number: i32) -> Json {
    json!({"t": "i4", "v": number})
}

fn r4(number: f64) -> Json {
    json!({"t": "r4", "v": number})
}

fn r8(number: f64) -> Json {
    json!({"t": "r8", "v": number})
}

fn b(flag: bool) -> Json {
    json!({"t": "bool", "v": flag})
}

fn obj(id: u64) -> Json {
    json!({"t": "obj", "v": id})
}

fn empty() -> Json {
    json!({"t": "empty"})
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

    fn get_fails(&mut self, id: u64, member: &str, message: &str) {
        let error = json!({"hresult": -2147352567_i64, "inner_hresult": -2147352567_i64, "message": message, "inner_message": message, "unknown_member": false});
        self.push(json!({"obj": id, "kind": "get", "member": member, "flags": 2, "args": [], "error": error}));
    }

    fn call(&mut self, id: u64, member: &str, args: Vec<Json>, result: Json) {
        self.push(json!({"obj": id, "kind": "call", "member": member, "flags": 3, "args": args, "result": result}));
    }

    fn put(&mut self, id: u64, member: &str, value: Json) {
        self.push(json!({"obj": id, "kind": "put", "member": member, "flags": 4, "args": [], "value": value, "result": empty()}));
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

    /// `$presentation.Slides.Item(slide)`: the slide is object `id`, the slides object 2.
    fn slide(&mut self, slide: i32, id: u64) {
        self.get(1, "Slides", obj(2));
        self.get_with(2, "Item", vec![i4(slide)], obj(id));
    }

    /// `$slide.Shapes.Item(shape)`: the shapes are object `shapes`, the shape object `id`.
    fn shape(&mut self, slide_id: u64, shape: i32, shapes: u64, id: u64) {
        self.get(slide_id, "Shapes", obj(shapes));
        self.get_with(shapes, "Item", vec![i4(shape)], obj(id));
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
    fn new() -> World {
        World { platform: FakePlatform::new(), applications: ScriptedApplications::new() }
    }

    fn env(&self) -> Env<'_> {
        Env { platform: &self.platform, applications: &self.applications }
    }
}

/// One operation through the editor over the fake: the record it answers as text, or the refusal's message.
fn apply_in(world: &World, document: &Obj, op: &Json, allow_ui_activation: bool) -> Result<String, String> {
    let mut chart_excel = ChartExcel::default();
    let mut context = EditContext { env: world.env(), chart_excel: &mut chart_excel };
    Editor
        .apply_operation(&mut context, document, &request(op), false, allow_ui_activation)
        .map(|record| record.map_or_else(String::new, |record| text_of(&record)))
        .map_err(|error| error.message().to_owned())
}

fn apply(fake: &Fake, op: &Json) -> Result<String, String> {
    apply_in(&World::new(), &fake.object(1), op, true)
}

// ---------------------------------------------------------------------------------------------------------------------
// The registry.

#[test]
fn the_editor_serves_the_pptx_operations_of_the_registry_fixture() {
    let listed: Vec<String> = [
        "add_animation", "add_chart", "add_comment", "add_image", "add_media", "add_provenance", "add_shape", "add_slide",
        "add_table", "add_textbox", "align_shapes", "apply_theme", "crop_image", "delete_comment", "delete_shape",
        "delete_slide", "distribute_shapes", "duplicate_slide", "fill_template", "fit_text", "group_shapes",
        "import_slides", "keep_slides", "move_slide", "replace_image", "replace_text", "set_chart_axis", "set_chart_data",
        "set_chart_data_labels", "set_chart_error_bars", "set_chart_series", "set_chart_trendline", "set_footer",
        "set_hyperlink", "set_layout", "set_notes", "set_shape", "set_slide_background", "set_slide_number",
        "set_slide_visibility", "set_table_cell_style", "set_table_data", "set_text", "set_transition", "ungroup_shape",
        "z_order",
    ]
    .iter()
    .map(|name| (*name).to_owned())
    .collect();
    let served: Vec<String> = Editor.operation_names().iter().map(|name| (*name).to_owned()).collect();
    assert_eq!(served.len(), 46);
    assert_eq!(served, listed);
}

#[test]
fn an_unknown_operation_is_refused_with_the_scripts_text_before_any_call() {
    let fake = Log::default().fake();
    assert_eq!(apply(&fake, &json!({"op": "rotate_slide"})), Err("Unsupported PPTX operation: rotate_slide".to_owned()));
    fake.finish();
}

#[test]
fn an_operation_name_is_matched_ignoring_case_as_a_switch_does() {
    let mut log = Log::default();
    log.slide(1, 3);
    log.shape(3, 2, 4, 5);
    log.get(5, "TextFrame", obj(6));
    log.get(6, "TextRange", obj(7));
    log.put(7, "Text", s("Hi"));
    let fake = log.fake();
    assert_eq!(apply(&fake, &json!({"op": "Set_Text", "slide": 1, "shape": 2, "text": "Hi"})), Ok("{\"op\":\"set_text\",\"changed\":true}".to_owned()));
    fake.finish();
}

// ---------------------------------------------------------------------------------------------------------------------
// Text.

#[test]
fn replace_text_rewrites_only_the_matched_characters_and_counts_shapes() {
    let mut log = Log::default();
    log.get(1, "Slides", obj(2));
    log.next(2, obj(3));
    log.end_of_enumeration(2);
    log.get(3, "HasNotesPage", b(false));
    log.get(3, "Shapes", obj(4));
    log.next(4, obj(5));
    log.end_of_enumeration(4);
    log.get(5, "HasTextFrame", b(true));
    log.get(5, "TextFrame", obj(6));
    log.get(6, "HasText", b(true));
    log.get(5, "TextFrame", obj(6));
    log.get(6, "TextRange", obj(7));
    log.get(7, "Text", s("Hello world, hello world"));
    // From the last match to the first: Characters(start + 1, length).
    log.call(7, "Characters", vec![i4(20), i4(5)], obj(8));
    log.put(8, "Text", s("there"));
    log.call(7, "Characters", vec![i4(7), i4(5)], obj(9));
    log.put(9, "Text", s("there"));
    let fake = log.fake();
    let answer = apply(&fake, &json!({"op": "replace_text", "find": "world", "replace": "there"}));
    assert_eq!(answer, Ok("{\"op\":\"replace_text\",\"changed\":true,\"count\":2,\"shapes\":1}".to_owned()));
    fake.finish();
}

#[test]
fn replace_text_needs_something_to_find() {
    let fake = Log::default().fake();
    assert_eq!(apply(&fake, &json!({"op": "replace_text", "find": "  "})), Err("replace_text requires non-empty find".to_owned()));
    fake.finish();
}

#[test]
fn z_order_refuses_an_unknown_command_after_reading_the_shape() {
    let mut log = Log::default();
    log.slide(1, 3);
    log.shape(3, 1, 4, 5);
    let fake = log.fake();
    assert_eq!(
        apply(&fake, &json!({"op": "z_order", "slide": 1, "shape": 1, "command": "sideways"})),
        Err("z_order command must be front, back, forward, or backward".to_owned())
    );
    fake.finish();
}

#[test]
fn set_slide_visibility_wants_a_visible_field() {
    let mut log = Log::default();
    log.slide(2, 3);
    let fake = log.fake();
    assert_eq!(
        apply(&fake, &json!({"op": "set_slide_visibility", "slide": 2})),
        Err("set_slide_visibility requires visible: true or false".to_owned())
    );
    fake.finish();
}

#[test]
fn a_chart_operation_on_a_shape_that_holds_no_chart_is_refused() {
    let mut log = Log::default();
    log.slide(1, 3);
    log.shape(3, 3, 4, 5);
    log.get(5, "HasChart", b(false));
    let fake = log.fake();
    assert_eq!(apply(&fake, &json!({"op": "set_chart_trendline", "slide": 1, "shape": 3})), Err("Shape 3 is not a chart".to_owned()));
    fake.finish();
}

// ---------------------------------------------------------------------------------------------------------------------
// Slides.

#[test]
fn add_slide_without_a_layout_follows_the_layout_of_the_slide_before_it() {
    let mut log = Log::default();
    log.get(1, "Slides", obj(2));
    log.get(2, "Count", i4(3));
    log.get(1, "Slides", obj(2));
    log.get(2, "Count", i4(3));
    log.get(1, "Slides", obj(2));
    log.get(1, "Slides", obj(2));
    log.get(2, "Count", i4(3));
    log.get_with(2, "Item", vec![i4(3)], obj(4));
    log.get(4, "Layout", i4(2));
    log.get(4, "CustomLayout", obj(5));
    log.get(1, "Slides", obj(2));
    log.call(2, "AddSlide", vec![i4(4), obj(5)], obj(6));
    log.get(6, "SlideIndex", i4(4));
    log.get(5, "Index", i4(2));
    log.get(5, "Name", s("Title and Content"));
    let fake = log.fake();
    assert_eq!(
        apply(&fake, &json!({"op": "add_slide"})),
        Ok("{\"op\":\"add_slide\",\"changed\":true,\"slide\":4,\"layout\":2,\"layoutName\":\"Title and Content\"}".to_owned())
    );
    fake.finish();
}

// ---------------------------------------------------------------------------------------------------------------------
// Footer.

#[test]
fn a_footer_the_layout_has_no_placeholder_for_is_placed_as_a_quiet_text_box() {
    let mut log = Log::default();
    log.slide(1, 3);
    // HeadersFooters refuses ("Invalid request") on a layout with no footer placeholder.
    log.get_fails(3, "HeadersFooters", "Invalid request");
    log.get(1, "PageSetup", obj(7));
    log.get(7, "SlideWidth", r4(960.0));
    log.get(1, "PageSetup", obj(7));
    log.get(7, "SlideHeight", r4(540.0));
    log.get(3, "Shapes", obj(4));
    log.call(4, "AddTextbox", vec![i4(1), r4(58.0), r8(500.0), r8(720.0), r4(24.0)], obj(8));
    log.get(8, "TextFrame", obj(9));
    log.get(9, "TextRange", obj(10));
    log.put(10, "Text", s("Confidential"));
    log.get(8, "TextFrame", obj(9));
    log.get(9, "TextRange", obj(10));
    log.get(10, "Font", obj(11));
    log.put(11, "Size", i4(10));
    log.get(8, "TextFrame", obj(9));
    log.put(9, "VerticalAnchor", i4(3));
    log.get(8, "TextFrame", obj(9));
    log.put(9, "WordWrap", i4(-1));
    log.get(8, "TextFrame", obj(9));
    log.put(9, "AutoSize", i4(0));
    log.put(8, "Height", r4(24.0));
    log.get(3, "Background", obj(12));
    log.get(12, "Fill", obj(13));
    log.get(13, "Type", i4(2));
    log.get(8, "TextFrame", obj(9));
    log.get(9, "TextRange", obj(10));
    log.get(10, "Font", obj(11));
    log.get(11, "Color", obj(14));
    // The quiet ink of a light slide, 6A7179, as the BGR integer.
    log.put(14, "RGB", i4(0x0079_716A));
    let fake = log.fake();
    assert_eq!(
        apply(&fake, &json!({"op": "set_footer", "slide": 1, "text": "Confidential"})),
        Ok("{\"op\":\"set_footer\",\"changed\":true,\"placed\":\"textbox\"}".to_owned())
    );
    fake.finish();
}

// ---------------------------------------------------------------------------------------------------------------------
// Charts.

#[test]
fn a_background_chart_without_a_window_handle_closes_its_window_and_is_refused() {
    let mut log = Log::default();
    log.slide(1, 3);
    log.get(1, "Windows", obj(4));
    log.get(4, "Count", i4(0));
    log.get(1, "Application", obj(5));
    for member in ["Left", "Top"] {
        log.put(5, member, i4(-32000));
    }
    log.put(5, "WindowState", i4(2));
    log.call(1, "NewWindow", vec![], obj(6));
    for member in ["Left", "Top"] {
        log.put(6, member, i4(-32000));
    }
    log.put(6, "WindowState", i4(2));
    // The application frame is the window that is hidden, so its handle is read first, then the window's.
    log.get(5, "HWND", i4(0));
    log.get(5, "Hwnd", i4(0));
    log.get(6, "HWND", i4(0));
    log.call(6, "Close", vec![], empty());
    let fake = log.fake();
    let answer = apply_in(&World::new(), &fake.object(1), &json!({"op": "add_chart", "slide": 1, "series": [{"name": "S", "values": [1]}]}), false);
    assert_eq!(answer, Err("Background PowerPoint chart creation could not establish a verifiably hidden document window.".to_owned()));
    fake.finish();
}

#[test]
fn a_background_chart_window_that_hides_lets_the_chart_be_made() {
    let world = World::new();
    world.platform.add_window(FakeWindow::new(77, 4000, "", ""));
    let mut log = Log::default();
    log.slide(1, 3);
    log.get(1, "Windows", obj(4));
    log.get(4, "Count", i4(0));
    log.get(1, "Application", obj(5));
    for member in ["Left", "Top"] {
        log.put(5, member, i4(-32000));
    }
    log.put(5, "WindowState", i4(2));
    log.call(1, "NewWindow", vec![], obj(6));
    for member in ["Left", "Top"] {
        log.put(6, member, i4(-32000));
    }
    log.put(6, "WindowState", i4(2));
    log.get(5, "HWND", i4(77));
    // The chart: AddChart2, no series asked for, no title (HasTitle is set and cleared), the plot's own settings and no data to close.
    log.get(3, "Shapes", obj(7));
    log.call(7, "AddChart2", vec![i4(-1), i4(51), r4(72.0), r4(72.0), r4(480.0), r4(280.0)], obj(8));
    log.get(8, "Chart", obj(9));
    log.put(9, "HasTitle", b(true));
    log.get(8, "Chart", obj(9));
    log.put(9, "HasTitle", b(false));
    log.get(8, "Chart", obj(9));
    log.get(9, "ChartArea", obj(10));
    log.get(10, "Format", obj(11));
    log.get(11, "Line", obj(12));
    log.put(12, "Visible", i4(0));
    log.get(9, "PlotArea", obj(13));
    log.get(13, "Format", obj(14));
    log.get(14, "Fill", obj(15));
    log.put(15, "Visible", i4(0));
    log.call(9, "Axes", vec![i4(2), i4(1)], obj(16));
    log.get(16, "MajorGridlines", obj(17));
    log.get(17, "Format", obj(18));
    log.get(18, "Line", obj(19));
    log.get(19, "ForeColor", obj(20));
    // D9E2DF as the BGR integer.
    log.put(20, "RGB", i4(0x00DF_E2D9));
    log.call(9, "ChartGroups", vec![i4(1)], obj(21));
    log.put(21, "GapWidth", i4(72));
    log.get(8, "Chart", obj(9));
    log.get(9, "ChartData", obj(22));
    log.get(22, "Workbook", json!({"t": "null"}));
    log.get(8, "Chart", obj(9));
    log.call(9, "SeriesCollection", vec![], obj(23));
    log.get(23, "Count", i4(1));
    log.get(8, "Chart", obj(9));
    log.call(9, "SeriesCollection", vec![], obj(23));
    log.get(23, "Count", i4(1));
    log.get(8, "Name", s("Chart 3"));
    let fake = log.fake();
    let answer = apply_in(&world, &fake.object(1), &json!({"op": "add_chart", "slide": 1}), false);
    assert_eq!(answer, Ok("{\"op\":\"add_chart\",\"changed\":true,\"shape\":\"Chart 3\",\"categories\":0,\"series\":1}".to_owned()));
    assert!(!world.platform.windows().iter().any(|window| window.hwnd == 77 && window.visible), "the window was hidden");
    fake.finish();
}
