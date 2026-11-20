//! The workbook editor (`Apply-ExcelOperation`) against a scripted workbook: a tree of COM objects that log every access and
//! answer what a test tells them, in place of Excel.
//!
//! These tests pin what needs no Office: the registry
//! of operation names, every refusal text, the order and the VARIANT types of the calls of the operations whose contract is in
//! them (typed text kept as text, one array for a block, Single widths, Double zoom, the colour names of a Korean Excel, page
//! setup held off, freeze panes zoomed out, charts), and the records answered.

use std::any::Any;
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::rc::Rc;

use mixdog_office_com::com::Call;
use mixdog_office_com::com::ComError;
use mixdog_office_com::com::ComObject;
use mixdog_office_com::com::DISP_E_MEMBERNOTFOUND;
use mixdog_office_com::com::ItemSource;
use mixdog_office_com::com::Kind;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::Value as Com;
use mixdog_office_com::excel::edit::Editor;
use mixdog_office_com::format::EditContext;
use mixdog_office_com::format::FormatEditor;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::ScriptedApplications;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::ps::json::to_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::ChartExcel;

// ---------------------------------------------------------------------------------------------------------------------
// The scripted workbook.

type Answer = Box<dyn Fn(&str, &Call<'_>) -> Option<Result<Com, ComError>>>;

/// What every object of the tree shares: the log, the answers, how many items a collection holds.
struct Shared {
    log: RefCell<Vec<String>>,
    answer: Answer,
    items: HashMap<String, usize>,
    next_id: Cell<u64>,
}

struct Node {
    id: u64,
    path: String,
    shared: Rc<Shared>,
}

struct Items(VecDeque<Com>);

impl ItemSource for Items {
    fn next_item(&mut self) -> Result<Option<Com>, ComError> {
        Ok(self.0.pop_front())
    }
}

fn failure(message: &str) -> ComError {
    ComError { hresult: -2_146_827_284, inner_hresult: -2_146_827_284, message: message.to_owned(), inner_message: message.to_owned(), unknown_member: false }
}

fn child(shared: &Rc<Shared>, path: String) -> Com {
    let id = shared.next_id.get() + 1;
    shared.next_id.set(id);
    Com::Dispatch(Obj::new(Rc::new(Node { id, path, shared: shared.clone() })))
}

/// A value as a log line shows it.
fn show(value: &Com) -> String {
    match value {
        Com::Str(text) => format!("\"{text}\""),
        Com::I4(n) => format!("i4:{n}"),
        Com::R4(n) => format!("r4:{n}"),
        Com::R8(n) => format!("r8:{n}"),
        Com::Bool(flag) => flag.to_string(),
        Com::Null => "null".to_owned(),
        Com::Empty => "empty".to_owned(),
        Com::Missing => "missing".to_owned(),
        Com::Dispatch(object) => format!("<{}>", object.identity_key()),
        Com::Array(array) => match array.rows() {
            Some(rows) => {
                let lines: Vec<String> = rows.iter().map(|row| row.iter().map(|cell| show(cell)).collect::<Vec<_>>().join("|")).collect();
                format!("array[{}x{}]{{{}}}", rows.len(), rows.first().map_or(0, Vec::len), lines.join(";"))
            }
            None => "array".to_owned(),
        },
        other => format!("{other:?}"),
    }
}

impl ComObject for Node {
    fn invoke(&self, call: &Call<'_>) -> Result<Com, ComError> {
        let args: Vec<String> = call.args.iter().map(show).collect();
        let here = match call.kind {
            Kind::Call => format!("{}.{}({})", self.path, call.member, args.join(", ")),
            Kind::Get if !args.is_empty() => format!("{}.{}({})", self.path, call.member, args.join(", ")),
            _ => format!("{}.{}", self.path, call.member),
        };
        let line = match (call.kind, call.value) {
            (Kind::Put | Kind::PutRef, Some(value)) => format!("put {here} = {}", show(value)),
            (kind, _) => format!("{} {here}", kind.name()),
        };
        self.shared.log.borrow_mut().push(line);
        match (self.shared.answer)(&here, call) {
            Some(answer) => answer,
            None if matches!(call.kind, Kind::Put | Kind::PutRef) => Ok(Com::Empty),
            None => Ok(child(&self.shared, here)),
        }
    }

    fn enum_open(&self) -> Result<Box<dyn ItemSource>, ComError> {
        let count = self.shared.items.get(&self.path).copied().unwrap_or(0);
        Ok(Box::new(Items((0..count).map(|at| child(&self.shared, format!("{}[{at}]", self.path))).collect())))
    }

    fn same_object(&self, other: &dyn ComObject) -> bool {
        other.as_any().downcast_ref::<Node>().is_some_and(|node| node.id == self.id)
    }

    fn identity_key(&self) -> String {
        self.path.clone()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// A workbook whose objects answer through `answer` (`None` makes a child object of the path) and enumerate `items` entries.
struct Book {
    shared: Rc<Shared>,
    book: Obj,
}

impl Book {
    fn new(items: &[(&str, usize)], answer: impl Fn(&str, &Call<'_>) -> Option<Result<Com, ComError>> + 'static) -> Book {
        let shared = Rc::new(Shared {
            log: RefCell::new(Vec::new()),
            answer: Box::new(answer),
            items: items.iter().map(|(path, count)| ((*path).to_owned(), *count)).collect(),
            next_id: Cell::new(1),
        });
        let book = child(&shared, "Book".to_owned()).into_obj().expect("an object");
        Book { shared, book }
    }

    fn log(&self) -> Vec<String> {
        self.shared.log.borrow().clone()
    }

    /// Runs one operation: its record as the compact JSON the host writes, or its refusal.
    fn run(&self, op: &str) -> Result<String, String> {
        let platform = FakePlatform::new();
        let applications = ScriptedApplications::new();
        let mut chart_excel = ChartExcel::default();
        let mut context = EditContext { env: Env { platform: &platform, applications: &applications }, chart_excel: &mut chart_excel };
        let op = payload::parse_payload(op).expect("an operation");
        Editor
            .apply_operation(&mut context, &self.book, &op, false, false)
            .map(|record| to_json(&record.expect("the operation answers a record"), 6))
            .map_err(|error| error.message().to_owned())
    }
}

/// A workbook whose sheet is called `Data` and whose every other answer is a child object.
fn plain() -> Book {
    Book::new(&[], |path, _| (path == "Book.ActiveSheet.Name").then(|| Ok(Com::Str("Data".to_owned()))))
}

fn lines_with(log: &[String], needle: &str) -> Vec<String> {
    log.iter().filter(|line| line.contains(needle)).cloned().collect()
}

/// The calls alone: the reads and writes made on the object a call answered carry its whole path, needle included.
fn calls_with(log: &[String], needle: &str) -> Vec<String> {
    log.iter().filter(|line| line.starts_with("call ") && line.contains(needle)).cloned().collect()
}

// ---------------------------------------------------------------------------------------------------------------------
// The registry and the refusals that need no workbook.

#[test]
fn the_editor_serves_the_operations_of_the_registry_fixture() {
    let expected: Vec<String> = [
        "add_chart",
        "add_conditional_format",
        "add_image",
        "add_note",
        "add_pivot_table",
        "add_provenance",
        "add_sheet",
        "add_table",
        "add_validation",
        "append_row",
        "autofit_range",
        "clear_cell",
        "copy_sheet",
        "define_name",
        "delete_columns",
        "delete_conditional_formats",
        "delete_drawing",
        "delete_name",
        "delete_note",
        "delete_rows",
        "delete_sheet",
        "freeze_panes",
        "insert_columns",
        "insert_rows",
        "merge_cells",
        "protect_sheet",
        "rename_sheet",
        "replace_text",
        "set_autofilter",
        "set_cell",
        "set_column_visibility",
        "set_column_width",
        "set_drawing",
        "set_formula",
        "set_header_footer",
        "set_hyperlink",
        "set_page_setup",
        "set_range",
        "set_row_height",
        "set_row_visibility",
        "set_sheet_view",
        "set_sheet_visibility",
        "set_style",
        "sort_range",
        "unmerge_cells",
        "unprotect_sheet",
    ]
    .iter()
    .map(|name| (*name).to_owned())
    .collect();
    assert_eq!(expected.len(), 46);
    let served: Vec<String> = Editor.operation_names().iter().map(|name| (*name).to_owned()).collect();
    assert_eq!(served, expected);
}

#[test]
fn an_operation_nobody_serves_is_refused_by_name() {
    let book = plain();
    assert_eq!(book.run(r#"{"op":"frobnicate"}"#), Err("Unsupported XLSX operation: frobnicate".to_owned()));
    assert_eq!(book.run("{}"), Err("Unsupported XLSX operation: ".to_owned()));
    assert!(book.log().is_empty(), "{:?}", book.log());
}

#[test]
fn an_operation_name_is_matched_without_regard_to_case() {
    let book = plain();
    assert_eq!(book.run(r#"{"op":"CLEAR_CELL","cell":"A1"}"#), Ok(r#"{"op":"clear_cell","changed":true}"#.to_owned()));
}

#[test]
fn worksheet_names_are_refused_with_the_five_texts() {
    let book = plain();
    let long = "a".repeat(32);
    let cases: Vec<(String, String)> = vec![
        ("  ".to_owned(), "add_sheet requires name".to_owned()),
        (long, "Worksheet names are limited to 31 characters".to_owned()),
        ("a/b".to_owned(), "Worksheet names cannot contain : \\ / ? * [ ] \u{2014} \"a/b\" has /".to_owned()),
        ("'x".to_owned(), "Worksheet names cannot start or end with an apostrophe: 'x".to_owned()),
        ("History".to_owned(), "History is reserved by Excel and cannot name a worksheet".to_owned()),
    ];
    for (name, message) in cases {
        let op = serde_json::json!({"op": "add_sheet", "name": name}).to_string();
        assert_eq!(book.run(&op), Err(message), "{name}");
    }
    assert!(book.log().is_empty(), "no COM call before the name is accepted: {:?}", book.log());
}

#[test]
fn defined_names_are_refused_with_the_four_texts() {
    let book = plain();
    let cases = [
        ("my name", "Excel refuses the defined name \"my name\": it contains a space; use an underscore (my_name)."),
        ("1abc", "Excel refuses the defined name \"1abc\": it must start with a letter, underscore, or backslash."),
        ("a-b", "Excel refuses the defined name \"a-b\": use letters, digits, underscores, or periods."),
        ("AB12", "Excel refuses the defined name \"AB12\": Excel reads it as a cell reference, not a name."),
        ("r", "Excel refuses the defined name \"r\": Excel reads it as a cell reference, not a name."),
    ];
    for (name, message) in cases {
        let op = serde_json::json!({"op": "define_name", "name": name, "refersTo": "A1"}).to_string();
        assert_eq!(book.run(&op), Err(message.to_owned()), "{name}");
    }
    assert!(book.log().is_empty(), "{:?}", book.log());
}

#[test]
fn a_defined_name_takes_an_equals_sign_and_answers_what_excel_stored() {
    let book = Book::new(&[], |path, _| {
        if path.ends_with(".Name") {
            return Some(Ok(Com::Str("Total".to_owned())));
        }
        path.ends_with(".RefersTo").then(|| Ok(Com::Str("=Sheet1!$A$1".to_owned())))
    });
    let record = book.run(r#"{"op":"define_name","name":" Total ","refersTo":"Sheet1!$A$1"}"#).expect("the name is defined");
    assert_eq!(record, r#"{"op":"define_name","changed":true,"name":"Total","refersTo":"=Sheet1!$A$1"}"#);
    // The name Excel is given is the caller's, not the trimmed one the rules were checked on.
    assert_eq!(calls_with(&book.log(), "Names.Add"), vec![r#"call Book.Names.Add(" Total ", "=Sheet1!$A$1")"#.to_owned()]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Sheets.

#[test]
fn a_sheet_is_appended_after_the_last_one() {
    let book = Book::new(&[], |path, _| match path {
        "Book.Worksheets.Count" => Some(Ok(Com::I4(3))),
        p if p.contains("Worksheets.Add") && p.ends_with(".Name") => Some(Ok(Com::Str("Report".to_owned()))),
        _ => None,
    });
    let record = book.run(r#"{"op":"add_sheet","name":" Report "}"#).expect("the sheet is added");
    assert_eq!(record, r#"{"op":"add_sheet","changed":true,"sheet":"Report"}"#);
    let log = book.log();
    assert!(log.contains(&"call Book.Worksheets.Add(missing, <Book.Worksheets.Item(i4:3)>)".to_owned()), "{log:?}");
    assert!(log.iter().any(|line| line.ends_with(".Name = \"Report\"") && line.starts_with("put ")), "{log:?}");
}

#[test]
fn a_sheet_that_is_not_there_names_the_sheets_that_are() {
    let book = Book::new(&[("Book.Worksheets", 2)], |path, call| {
        if path.starts_with("Book.Worksheets.Item(") && call.kind == Kind::Get {
            return Some(Err(ComError {
                hresult: DISP_E_MEMBERNOTFOUND,
                inner_hresult: DISP_E_MEMBERNOTFOUND,
                message: "no such sheet".to_owned(),
                inner_message: String::new(),
                unknown_member: false,
            }));
        }
        match path {
            "Book.Worksheets[0].Name" => Some(Ok(Com::Str("Alpha".to_owned()))),
            "Book.Worksheets[1].Name" => Some(Ok(Com::Str("Beta".to_owned()))),
            _ => None,
        }
    });
    assert_eq!(
        book.run(r#"{"op":"clear_cell","sheet":"Gamma","cell":"A1"}"#),
        Err("Worksheet not found: Gamma. Available sheets: Alpha, Beta. Add it with add_sheet or target an existing sheet.".to_owned())
    );
}

#[test]
fn a_sheet_is_hidden_by_word_or_by_a_flag_and_a_missing_word_is_refused() {
    let book = plain();
    assert_eq!(
        book.run(r#"{"op":"set_sheet_visibility","visibility":"VeryHidden"}"#),
        Ok(r#"{"op":"set_sheet_visibility","changed":true,"sheet":"Data","visibility":"veryhidden"}"#.to_owned())
    );
    assert_eq!(
        book.run(r#"{"op":"set_sheet_visibility","visible":false}"#),
        Ok(r#"{"op":"set_sheet_visibility","changed":true,"sheet":"Data","visibility":"hidden"}"#.to_owned())
    );
    let states = lines_with(&book.log(), ".Visible = ");
    assert_eq!(states, vec!["put Book.ActiveSheet.Visible = i4:2".to_owned(), "put Book.ActiveSheet.Visible = i4:0".to_owned()]);
    assert_eq!(
        book.run(r#"{"op":"set_sheet_visibility"}"#),
        Err("set_sheet_visibility needs visibility: visible, hidden, or very_hidden (or visible: true/false)".to_owned())
    );
}

#[test]
fn a_protected_sheet_keeps_what_it_still_allows() {
    let book = plain();
    book.run(r#"{"op":"protect_sheet","password":"pw","allowFormattingCells":true,"allowSorting":true}"#).expect("protected");
    assert_eq!(
        lines_with(&book.log(), ".Protect("),
        vec!["call Book.ActiveSheet.Protect(\"pw\", true, true, true, false, true, false, false, false, false, false, false, false, true, false)".to_owned()]
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// Values.

#[test]
fn a_text_excel_would_type_as_a_date_is_put_back_as_text_under_the_old_format() {
    let book = Book::new(&[], |path, call| match path {
        "Book.ActiveSheet.Range(\"A1\").NumberFormat" if call.kind == Kind::Get => Some(Ok(Com::Str("General".to_owned()))),
        // Excel read "1-2" as the second of January.
        "Book.ActiveSheet.Range(\"A1\").Value2" if call.kind == Kind::Get => Some(Ok(Com::R8(46_024.0))),
        _ => None,
    });
    assert_eq!(book.run(r#"{"op":"set_cell","cell":"A1","value":"1-2"}"#), Ok(r#"{"op":"set_cell","changed":true}"#.to_owned()));
    let a1 = "Book.ActiveSheet.Range(\"A1\")";
    assert_eq!(
        book.log(),
        vec![
            "get Book.ActiveSheet".to_owned(),
            format!("get {a1}"),
            format!("get {a1}.NumberFormat"),
            format!("put {a1}.Value2 = array[1x1]{{\"1-2\"}}"),
            format!("get {a1}.Value2"),
            format!("put {a1}.NumberFormat = \"General\""),
            format!("put {a1}.Value2 = array[1x1]{{\"'1-2\"}}"),
        ]
    );
}

#[test]
fn a_text_that_stays_text_is_not_read_back_and_numbers_go_in_as_doubles() {
    let book = plain();
    book.run(r#"{"op":"set_cell","cell":"B2","value":"abc"}"#).expect("text");
    book.run(r#"{"op":"set_cell","cell":"B3","value":5}"#).expect("number");
    book.run(r#"{"op":"set_cell","cell":"B4","value":true}"#).expect("boolean");
    book.run(r#"{"op":"set_cell","cell":"B5"}"#).expect("cleared");
    let puts: Vec<String> = book.log().into_iter().filter(|line| line.contains("Value2") || line.contains("ClearContents")).collect();
    assert_eq!(
        puts,
        vec![
            "put Book.ActiveSheet.Range(\"B2\").Value2 = array[1x1]{\"abc\"}".to_owned(),
            "put Book.ActiveSheet.Range(\"B3\").Value2 = array[1x1]{r8:5}".to_owned(),
            "put Book.ActiveSheet.Range(\"B4\").Value2 = array[1x1]{true}".to_owned(),
            "call Book.ActiveSheet.Range(\"B5\").ClearContents()".to_owned(),
        ]
    );
    assert!(lines_with(&book.log(), "NumberFormat").is_empty());
}

#[test]
fn a_block_that_fills_its_range_goes_in_as_one_array() {
    let book = Book::new(&[], |path, _| {
        if path.ends_with(".Rows.Count") || path.ends_with(".Columns.Count") {
            return Some(Ok(Com::I4(2)));
        }
        None
    });
    let record = book.run(r#"{"op":"set_range","range":"A1:B2","values":[["a",1],["b",2]]}"#).expect("the block goes in");
    assert_eq!(record, r#"{"op":"set_range","changed":true}"#);
    assert_eq!(lines_with(&book.log(), "Value2"), vec!["put Book.ActiveSheet.Range(\"A1:B2\").Value2 = array[2x2]{\"a\"|r8:1;\"b\"|r8:2}".to_owned()]);
}

#[test]
fn rows_of_uneven_length_write_only_the_cells_they_name() {
    let book = Book::new(&[], |path, _| {
        if path.ends_with(".Rows.Count") || path.ends_with(".Columns.Count") {
            return Some(Ok(Com::I4(2)));
        }
        None
    });
    book.run(r#"{"op":"set_range","range":"A1:B2","values":[["a",1],["b"]]}"#).expect("the cells go in");
    let writes = lines_with(&book.log(), ".Value2 = ");
    assert_eq!(writes.len(), 3, "{writes:?}");
    assert!(writes[2].contains("Cells.Item(i4:2, i4:1)") && writes[2].ends_with("array[1x1]{\"b\"}"), "{writes:?}");
}

#[test]
fn a_block_of_more_than_500_cells_says_it_was_written_in_bulk() {
    let book = Book::new(&[], |path, _| {
        if path.ends_with(".Rows.Count") {
            return Some(Ok(Com::I4(501)));
        }
        path.ends_with(".Columns.Count").then(|| Ok(Com::I4(1)))
    });
    let rows: Vec<serde_json::Value> = (0..501).map(|n| serde_json::json!([n])).collect();
    let op = serde_json::json!({"op": "set_range", "range": "A1:A501", "values": rows}).to_string();
    assert_eq!(book.run(&op), Ok(r#"{"op":"set_range","changed":true,"bulk":true,"cells":501}"#.to_owned()));
}

#[test]
fn a_row_appended_to_an_empty_sheet_is_row_one_and_copies_no_format() {
    let book = Book::new(&[], |path, _| match path {
        "Book.ActiveSheet.UsedRange.Row" => Some(Ok(Com::I4(1))),
        "Book.ActiveSheet.UsedRange.Rows.Count" | "Book.ActiveSheet.UsedRange.Count" => Some(Ok(Com::I4(1))),
        "Book.ActiveSheet.UsedRange.Value2" => Some(Ok(Com::Empty)),
        _ => None,
    });
    assert_eq!(book.run(r#"{"op":"append_row","values":["x"]}"#), Ok(r#"{"op":"append_row","changed":true,"row":1}"#.to_owned()));
    assert!(lines_with(&book.log(), ".Copy(").is_empty());
}

#[test]
fn a_row_appended_below_data_takes_the_row_above_as_its_format() {
    let book = Book::new(&[], |path, _| match path {
        "Book.ActiveSheet.UsedRange.Row" => Some(Ok(Com::I4(1))),
        "Book.ActiveSheet.UsedRange.Rows.Count" => Some(Ok(Com::I4(4))),
        "Book.ActiveSheet.UsedRange.Count" => Some(Ok(Com::I4(8))),
        _ => None,
    });
    assert_eq!(book.run(r#"{"op":"append_row","values":[1,2]}"#), Ok(r#"{"op":"append_row","changed":true,"row":5}"#.to_owned()));
    let log = book.log();
    assert!(log.contains(&"call Book.ActiveSheet.Rows.Item(i4:4).Copy(<Book.ActiveSheet.Rows.Item(i4:5)>)".to_owned()), "{log:?}");
    assert!(log.contains(&"call Book.ActiveSheet.Rows.Item(i4:5).ClearContents()".to_owned()), "{log:?}");
}

// ---------------------------------------------------------------------------------------------------------------------
// Styles.

#[test]
fn a_colour_format_a_korean_excel_refuses_is_written_in_its_colour_names() {
    // The UI language is read once per thread, so the test runs on a thread of its own.
    std::thread::spawn(|| {
        let book = Book::new(&[], |path, call| {
            if let (Kind::Put, Some(Com::Str(format))) = (call.kind, call.value) {
                if path.ends_with(".NumberFormat") && format.contains("[Red]") {
                    return Some(Err(failure("Unable to set the NumberFormat property of the Range class")));
                }
            }
            path.ends_with("LanguageID(i4:2)").then(|| Ok(Com::I4(1042)))
        });
        book.run(r##"{"op":"set_style","cell":"A1","properties":{"numberFormat":"#,##0;[Red]-#,##0"}}"##).expect("the format is set");
        assert_eq!(
            lines_with(&book.log(), "NumberFormat"),
            vec![
                "put Book.ActiveSheet.Range(\"A1\").NumberFormat = \"#,##0;[Red]-#,##0\"".to_owned(),
                "put Book.ActiveSheet.Range(\"A1\").NumberFormat = \"#,##0;[\u{BE68}\u{AC15}]-#,##0\"".to_owned(),
            ]
        );
    })
    .join()
    .expect("the test body");
}

#[test]
fn a_format_nobody_accepts_keeps_its_figures_without_the_colour() {
    let book = Book::new(&[], |path, call| {
        if let (Kind::Put, Some(Com::Str(format))) = (call.kind, call.value) {
            if path.ends_with(".NumberFormat") && format.contains('[') {
                return Some(Err(failure("refused")));
            }
        }
        path.ends_with("LanguageID(i4:2)").then(|| Ok(Com::I4(1033)))
    });
    book.run(r#"{"op":"set_style","cell":"A1","properties":{"numberFormat":"0;[Blue]0"}}"#).expect("the format is set without its colour");
    let puts = lines_with(&book.log(), "NumberFormat = ");
    assert_eq!(puts.last().map(String::as_str), Some("put Book.ActiveSheet.Range(\"A1\").NumberFormat = \"0;0\""));
}

#[test]
fn a_format_refused_for_another_reason_is_the_failure() {
    let book = Book::new(&[], |path, call| (call.kind == Kind::Put && path.ends_with(".NumberFormat")).then(|| Err(failure("The number format is invalid"))));
    assert_eq!(book.run(r#"{"op":"set_style","cell":"A1","properties":{"numberFormat":"0.0"}}"#), Err("The number format is invalid".to_owned()));
}

#[test]
fn style_properties_go_in_as_the_script_sets_them() {
    let book = plain();
    let record = book
        .run(
            r##"{"op":"set_style","range":"A1:B2","properties":{"fontName":"Arial","fontSize":10.5,"bold":true,"color":"#FF8000","fillColor":null,"horizontalAlignment":"centre","locked":false}}"##,
        )
        .expect("the style is set");
    assert_eq!(record, r#"{"op":"set_style","changed":true}"#);
    let a = "Book.ActiveSheet.Range(\"A1:B2\")";
    let puts: Vec<String> = book.log().into_iter().filter(|line| line.starts_with("put ")).collect();
    assert_eq!(
        puts,
        vec![
            format!("put {a}.Font.Name = \"Arial\""),
            format!("put {a}.Font.Size = r4:10.5"),
            format!("put {a}.Font.Bold = true"),
            format!("put {a}.Font.Color = i4:33023"),
            format!("put {a}.Interior.ColorIndex = i4:-4142"),
            format!("put {a}.HorizontalAlignment = i4:-4108"),
            format!("put {a}.Locked = false"),
        ]
    );
}

#[test]
fn a_colour_that_is_not_six_digits_is_refused_with_the_scripts_text() {
    let book = plain();
    assert_eq!(book.run(r#"{"op":"set_style","cell":"A1","properties":{"color":"12"}}"#), Err("Invalid color '12'; expected RRGGBB".to_owned()));
}

#[test]
fn vertical_alignment_keeps_every_indent_of_a_range_whole_when_they_agree() {
    let book = Book::new(&[], |path, _| path.ends_with(".IndentLevel").then(|| Ok(Com::I4(1))));
    book.run(r#"{"op":"set_style","range":"A1:B2","properties":{"verticalAlignment":"middle","wrapText":true}}"#).expect("set");
    let puts: Vec<String> = book.log().into_iter().filter(|line| line.starts_with("put ")).collect();
    assert_eq!(
        puts,
        vec![
            "put Book.ActiveSheet.Range(\"A1:B2\").VerticalAlignment = i4:-4108".to_owned(),
            "put Book.ActiveSheet.Range(\"A1:B2\").WrapText = true".to_owned(),
        ]
    );
}

#[test]
fn vertical_alignment_walks_the_columns_of_a_range_of_mixed_indents() {
    let book = Book::new(&[("Book.ActiveSheet.Range(\"A1:B2\").Columns", 2)], |path, _| match path {
        "Book.ActiveSheet.Range(\"A1:B2\").IndentLevel" => Some(Ok(Com::Null)),
        "Book.ActiveSheet.Range(\"A1:B2\").Columns[0].IndentLevel" => Some(Ok(Com::I4(2))),
        _ => None,
    });
    let outcome = book.run(r#"{"op":"set_style","range":"A1:B2","properties":{"verticalAlignment":"top"}}"#);
    assert!(outcome.is_ok(), "{outcome:?}");
    let puts: Vec<String> = book.log().into_iter().filter(|line| line.starts_with("put ")).collect();
    // The first column is of one indent and is set whole; the second is of mixed indents and has no cells to walk here.
    assert_eq!(puts, vec!["put Book.ActiveSheet.Range(\"A1:B2\").Columns[0].VerticalAlignment = i4:-4160".to_owned()]);
}

#[test]
fn borders_rule_the_lines_between_cells_too_unless_one_side_is_cleared() {
    let book = Book::new(&[], |path, _| {
        if path.ends_with(".Columns.Count") || path.ends_with(".Rows.Count") {
            return Some(Ok(Com::I4(2)));
        }
        None
    });
    book.run(r#"{"op":"set_style","range":"A1:B2","properties":{"borders":{"left":"thin","top":{"style":"none"}}}}"#).expect("borders");
    let puts: Vec<String> = book.log().into_iter().filter(|line| line.starts_with("put ")).collect();
    // left: its edge and the inside vertical; top: cleared, its edge alone.
    assert_eq!(puts.len(), 5, "{puts:?}");
    assert!(puts[0].contains("Borders.Item(i4:7).LineStyle = i4:1"), "{puts:?}");
    assert!(puts[1].contains("Borders.Item(i4:7).Weight = i4:2"), "{puts:?}");
    assert!(puts[2].contains("Borders.Item(i4:11).LineStyle = i4:1"), "{puts:?}");
    assert!(puts[4].contains("Borders.Item(i4:8).LineStyle = i4:-4142"), "{puts:?}");
}

// ---------------------------------------------------------------------------------------------------------------------
// Rows and columns.

#[test]
fn rows_are_inserted_one_at_a_time_and_the_record_says_references_follow() {
    let book = plain();
    assert_eq!(
        book.run(r#"{"op":"insert_rows","row":3,"count":2}"#),
        Ok(r#"{"op":"insert_rows","changed":true,"row":3,"count":2,"referenceAware":true}"#.to_owned())
    );
    assert_eq!(lines_with(&book.log(), ".Insert("), vec!["call Book.ActiveSheet.Rows.Item(i4:3).Insert(i4:-4121)".to_owned(); 2]);
    book.run(r#"{"op":"delete_columns","column":2}"#).expect("deleted");
    assert!(book.log().contains(&"call Book.ActiveSheet.Columns.Item(i4:2).Delete()".to_owned()));
}

#[test]
fn a_row_height_is_a_single_and_is_refused_outside_its_range() {
    let book = plain();
    assert_eq!(book.run(r#"{"op":"set_row_height","row":2,"height":410}"#), Err("set_row_height requires height in points, 0-409".to_owned()));
    assert_eq!(book.run(r#"{"op":"set_row_height","row":0,"height":20}"#), Err("set_row_height requires row (1-based)".to_owned()));
    assert_eq!(book.run(r#"{"op":"set_row_height","row":2}"#), Err("set_row_height requires height in points, 0-409".to_owned()));
    let record = book.run(r#"{"op":"set_row_height","row":2,"height":20,"count":2}"#).expect("set");
    assert_eq!(record, r#"{"op":"set_row_height","changed":true,"sheet":"Data","rows":[2,3],"height":20}"#);
    assert_eq!(lines_with(&book.log(), ".RowHeight"), vec!["put Book.ActiveSheet.Rows(\"2:3\").RowHeight = r4:20".to_owned()]);
}

#[test]
fn a_column_width_names_its_column_by_letter_or_number_and_is_a_single() {
    let book = Book::new(&[], |path, _| match path {
        "Book.ActiveSheet.Columns(\"C\").Column" => Some(Ok(Com::I4(3))),
        "Book.ActiveSheet.Name" => Some(Ok(Com::Str("Data".to_owned()))),
        _ => None,
    });
    assert_eq!(book.run(r#"{"op":"set_column_width","column":"c","width":300}"#), Err("set_column_width requires width in characters, 0-255".to_owned()));
    assert_eq!(
        book.run(r#"{"op":"set_column_width","column":"c","width":12.5,"count":2}"#),
        Ok(r#"{"op":"set_column_width","changed":true,"sheet":"Data","columns":[3,4],"width":12.5}"#.to_owned())
    );
    assert_eq!(lines_with(&book.log(), "ColumnWidth = ").len(), 1);
    assert!(lines_with(&book.log(), "ColumnWidth = ")[0].ends_with(".EntireColumn.ColumnWidth = r4:12.5"));
    assert_eq!(
        book.run(r#"{"op":"set_column_width","column":"0","width":3}"#),
        Err("set_column_width requires column (a letter such as D, or a 1-based number)".to_owned())
    );
}

#[test]
fn visibility_needs_the_word_and_a_row_or_column() {
    let book = plain();
    assert_eq!(book.run(r#"{"op":"set_row_visibility","row":2}"#), Err("set_row_visibility requires visible: true or false".to_owned()));
    assert_eq!(book.run(r#"{"op":"set_row_visibility","row":0,"visible":true}"#), Err("set_row_visibility requires row (1-based)".to_owned()));
    assert_eq!(
        book.run(r#"{"op":"set_row_visibility","row":4,"visible":false,"count":3}"#),
        Ok(r#"{"op":"set_row_visibility","changed":true,"sheet":"Data","visible":false,"rows":[4,5,6]}"#.to_owned())
    );
    assert_eq!(lines_with(&book.log(), ".Hidden = "), vec!["put Book.ActiveSheet.Rows(\"4:6\").Hidden = true".to_owned()]);
    assert_eq!(book.run(r#"{"op":"set_column_visibility","column":"A"}"#), Err("set_column_visibility requires visible: true or false".to_owned()));
}

#[test]
fn a_citation_is_appended_to_the_note_and_a_blank_one_is_refused() {
    let book = Book::new(&[], |path, _| match path {
        "Book.ActiveSheet.Range(\"C3\").Comment.Text()" => Some(Ok(Com::Str("first".to_owned()))),
        "Book.ActiveSheet.Range(\"C3\").Address(false, false)" => Some(Ok(Com::Str("C3".to_owned()))),
        "Book.ActiveSheet.Name" => Some(Ok(Com::Str("Data".to_owned()))),
        _ => None,
    });
    let record = book.run(r#"{"op":"add_provenance","cell":"C3","citation":"10-K, p. 4"}"#).expect("a citation");
    assert_eq!(record, r#"{"op":"add_provenance","changed":true,"target":"/sheet[Data]/cell[C3]","citation":"10-K, p. 4"}"#);
    assert!(book.log().contains(&"call Book.ActiveSheet.Range(\"C3\").Comment.Text(\"first\n10-K, p. 4\")".to_owned()), "{:?}", book.log());
    assert_eq!(book.run(r#"{"op":"add_provenance","cell":"C3","citation":"  "}"#), Err("add_provenance requires source with a document or label".to_owned()));
}

// ---------------------------------------------------------------------------------------------------------------------
// Drawings and charts.

#[test]
fn a_drawing_is_found_by_position_or_by_name_and_its_absence_names_what_is_there() {
    let book = Book::new(&[("Book.ActiveSheet.Shapes", 2)], |path, _| match path {
        "Book.ActiveSheet.Shapes[0].Name" => Some(Ok(Com::Str("Picture 1".to_owned()))),
        "Book.ActiveSheet.Shapes[1].Name" => Some(Ok(Com::Str("Chart 2".to_owned()))),
        "Book.ActiveSheet.Name" => Some(Ok(Com::Str("Data".to_owned()))),
        _ => None,
    });
    assert_eq!(
        book.run(r#"{"op":"delete_drawing","drawing":"chart 2"}"#),
        Ok(r#"{"op":"delete_drawing","changed":true,"sheet":"Data","drawing":"Chart 2"}"#.to_owned())
    );
    assert!(book.log().contains(&"call Book.ActiveSheet.Shapes[1].Delete()".to_owned()));
    assert_eq!(
        book.run(r#"{"op":"delete_drawing","drawing":1}"#),
        Ok(r#"{"op":"delete_drawing","changed":true,"sheet":"Data","drawing":"Picture 1"}"#.to_owned())
    );
    assert_eq!(
        book.run(r#"{"op":"set_drawing","drawing":"Nope","left":1}"#),
        Err("Drawing not found: Nope. This sheet holds 1: Picture 1, 2: Chart 2.".to_owned())
    );
    assert_eq!(
        book.run(r#"{"op":"set_drawing"}"#),
        Err("set_drawing requires drawing: the name the snapshot reports, or its 1-based index on the sheet.".to_owned())
    );
    assert_eq!(book.run(r#"{"op":"set_drawing","drawing":2}"#), Err("set_drawing needs left, top, width, or height".to_owned()));
}

#[test]
fn a_picture_is_placed_by_its_cell_with_singles() {
    let book = Book::new(&[], |path, _| match path {
        "Book.ActiveSheet.Range(\"D2\").Left" => Some(Ok(Com::R8(120.0))),
        "Book.ActiveSheet.Range(\"D2\").Top" => Some(Ok(Com::R8(30.0))),
        _ => None,
    });
    book.run(r#"{"op":"add_image","path":"C:\\x.png","cell":"D2","width":100,"altText":"logo"}"#).expect("the picture is added");
    assert_eq!(
        calls_with(&book.log(), ".AddPicture("),
        vec!["call Book.ActiveSheet.Shapes.AddPicture(\"C:\\x.png\", false, true, r4:120, r4:30, r4:100, r4:240)".to_owned()]
    );
}

#[test]
fn a_chart_of_an_unknown_kind_is_refused_before_anything_is_drawn() {
    let book = plain();
    assert_eq!(
        book.run(r#"{"op":"add_chart","chartType":"radar"}"#),
        Err("Unknown chart type: radar; use one of column, bar, stacked_column, stacked_bar, line, area, pie, doughnut, scatter".to_owned())
    );
    assert_eq!(
        book.run(r#"{"op":"add_chart","chartType":"column","toColumn":"H"}"#),
        Err("XLSX add_chart toColumn ends a frame placed at cell; give cell as well".to_owned())
    );
    assert!(lines_with(&book.log(), "AddChart2").is_empty());
}

#[test]
fn a_bar_chart_is_drawn_top_down_with_its_title_and_the_codes_of_its_kind() {
    let book = Book::new(&[], |path, _| match path {
        p if p.ends_with(".SeriesCollection().Count") => Some(Ok(Com::I4(1))),
        p if p.ends_with(".Points().Count") => Some(Ok(Com::I4(3))),
        p if p.contains("AddChart2") && p.ends_with(").Name") => Some(Ok(Com::Str("Chart 1".to_owned()))),
        _ => None,
    });
    let record = book.run(r#"{"op":"add_chart","chartType":"bar","range":"A1:B4","title":"Sales","showValues":true}"#).expect("a chart");
    assert_eq!(record, r#"{"op":"add_chart","changed":true,"name":"Chart 1","series":1,"categories":3}"#);
    let log = book.log();
    assert!(log.contains(&"call Book.ActiveSheet.Shapes.AddChart2(i4:-1, i4:57, r4:300, r4:20, r4:480, r4:280)".to_owned()), "{log:?}");
    assert!(log.iter().any(|line| line.contains(".SetSourceData(<Book.ActiveSheet.Range(\"A1:B4\")>, i4:2)")), "{log:?}");
    assert!(log.iter().any(|line| line.ends_with(".ChartTitle.Text = \"Sales\"")), "{log:?}");
    assert!(log.iter().any(|line| line.ends_with(".Axes(i4:1).ReversePlotOrder = true")), "{log:?}");
    assert!(log.iter().any(|line| line.ends_with(".Axes(i4:1).Crosses = i4:2")), "{log:?}");
    assert!(log.iter().any(|line| line.ends_with(".HasLegend = false")), "{log:?}");
    assert!(log.iter().any(|line| line.ends_with(".ChartGroups(i4:1).GapWidth = i4:90")), "{log:?}");
}

#[test]
fn a_pie_takes_its_palette_a_slice_at_a_time_and_its_legend() {
    let book = Book::new(&[], |path, _| match path {
        p if p.ends_with(".SeriesCollection().Count") => Some(Ok(Com::I4(1))),
        p if p.ends_with(".Points().Count") => Some(Ok(Com::I4(3))),
        _ => None,
    });
    book.run(r#"{"op":"add_chart","chartType":"Pie","range":"A1:B4","seriesColors":["FF0000","00FF00"]}"#).expect("a chart");
    let colours = lines_with(&book.log(), ".Fill.ForeColor.RGB = ");
    assert_eq!(colours.len(), 3, "{colours:?}");
    assert!(colours[0].ends_with("= i4:255"), "{colours:?}");
    assert!(colours[1].ends_with("= i4:65280"), "{colours:?}");
    assert!(colours[2].ends_with("= i4:255"), "{colours:?}");
    assert!(book.log().iter().any(|line| line.ends_with(".HasLegend = true")));
}

// ---------------------------------------------------------------------------------------------------------------------
// Data.

fn sortable(hidden_row: Option<i32>, merged: bool) -> Book {
    Book::new(&[], move |path, _| {
        let target = "Book.ActiveSheet.Range(\"A1:B3\")";
        match path {
            p if p == format!("{target}.Columns.Count") => Some(Ok(Com::I4(2))),
            p if p == format!("{target}.Rows.Count") => Some(Ok(Com::I4(3))),
            p if p == format!("{target}.Column") => Some(Ok(Com::I4(1))),
            "Book.ActiveSheet.Columns(\"Z\").Column" => Some(Ok(Com::I4(26))),
            p if p.ends_with(".Hidden") => Some(Ok(Com::Bool(hidden_row.is_some_and(|row| p.contains(&format!("Rows(i4:{row})")))))),
            p if p.contains(".Rows(i4:") && p.ends_with(").Row") => Some(Ok(Com::I4(hidden_row.unwrap_or(0)))),
            p if p == format!("{target}.MergeCells") => Some(Ok(Com::Bool(merged))),
            _ => None,
        }
    })
}

#[test]
fn a_sort_is_refused_over_a_hidden_row_a_merged_cell_or_a_key_the_range_does_not_cover() {
    assert_eq!(
        sortable(Some(2), false).run(r#"{"op":"sort_range","range":"A1:B3"}"#),
        Err("XLSX sort_range would move values under hidden row 2, leaving a different record withheld. Show them first with set_row_visibility visible: true, or sort a range without them.".to_owned())
    );
    assert_eq!(
        sortable(None, true).run(r#"{"op":"sort_range","range":"A1:B3"}"#),
        Err("XLSX sort_range cannot move rows through a merged cell in A1:B3; Excel refuses the same sort. Unmerge them first with unmerge_cells.".to_owned())
    );
    assert_eq!(
        sortable(None, false).run(r#"{"op":"sort_range","range":"A1:B3","by":"Z"}"#),
        Err("XLSX sort_range by \"Z\" is outside A1:B3; name a column the range covers.".to_owned())
    );
}

#[test]
fn a_sort_passes_the_key_the_order_and_the_header_flag() {
    let book = sortable(None, false);
    assert_eq!(
        book.run(r#"{"op":"sort_range","range":"A1:B3","order":"Descending","hasHeader":false}"#),
        Ok(r#"{"op":"sort_range","changed":true,"range":"A1:B3","order":"desc"}"#.to_owned())
    );
    assert_eq!(
        lines_with(&book.log(), ".Sort("),
        vec![
            "call Book.ActiveSheet.Range(\"A1:B3\").Sort(<Book.ActiveSheet.Range(\"A1:B3\").Columns(i4:1)>, i4:2, null, null, i4:1, null, i4:1, i4:2)"
                .to_owned()
        ]
    );
}

#[test]
fn a_validation_list_is_passed_bare_and_a_range_of_cells_as_a_formula() {
    let book = plain();
    book.run(r#"{"op":"add_validation","range":"A1","formula1":"\"a,b,c\""}"#).expect("a list");
    book.run(r#"{"op":"add_validation","range":"A1","formula1":"$A$1:$A$9"}"#).expect("a range");
    book.run(r#"{"op":"add_validation","range":"A1","type":"whole","operator":"between","formula1":"1","formula2":"9"}"#).expect("a bound");
    book.run(r#"{"op":"add_validation","range":"A1","type":"custom","formula1":"A1>0"}"#).expect("a rule");
    let adds = lines_with(&book.log(), ".Validation.Add(");
    let tail = |line: &String| line.rsplit_once(".Validation.Add(").map(|(_, rest)| rest.to_owned()).unwrap_or_default();
    assert_eq!(
        adds.iter().map(tail).collect::<Vec<_>>(),
        vec![
            "i4:3, i4:1, i4:1, \"a,b,c\")".to_owned(),
            "i4:3, i4:1, i4:1, \"=$A$1:$A$9\")".to_owned(),
            "i4:1, i4:1, i4:1, \"1\", \"9\")".to_owned(),
            "i4:7, i4:1, i4:1, \"=A1>0\")".to_owned(),
        ]
    );
}

#[test]
fn a_conditional_format_takes_its_formula_with_an_equals_sign_and_reports_its_kind() {
    let book = plain();
    assert_eq!(
        book.run(r#"{"op":"add_conditional_format","range":"A1:A9","formula":"A1>5","fillColor":"FFFF00"}"#),
        Ok(r#"{"op":"add_conditional_format","changed":true,"type":"expression"}"#.to_owned())
    );
    assert_eq!(
        calls_with(&book.log(), "FormatConditions.Add("),
        vec!["call Book.ActiveSheet.Range(\"A1:A9\").FormatConditions.Add(i4:2, missing, \"=A1>5\")".to_owned()]
    );
    assert_eq!(
        book.run(r#"{"op":"add_conditional_format","range":"A1:A9","type":"colorScale","minColor":"FF0000","midColor":"FFFF00","maxColor":"00FF00"}"#),
        Ok(r#"{"op":"add_conditional_format","changed":true,"type":"colorScale"}"#.to_owned())
    );
    assert_eq!(calls_with(&book.log(), ".AddColorScale(").len(), 1);
    assert!(calls_with(&book.log(), ".AddColorScale(")[0].ends_with("AddColorScale(i4:3)"));
    assert!(lines_with(&book.log(), "ColorScaleCriteria(i4:3)").iter().any(|line| line.contains("FormatColor")));
}

#[test]
fn conditional_formats_deleted_are_counted() {
    let book = Book::new(&[], |path, _| path.ends_with("FormatConditions.Count").then(|| Ok(Com::I4(2))));
    assert_eq!(
        book.run(r#"{"op":"delete_conditional_formats","range":"A1:A9"}"#),
        Ok(r#"{"op":"delete_conditional_formats","changed":true,"count":2}"#.to_owned())
    );
}

#[test]
fn a_table_with_the_style_none_has_its_style_cleared() {
    let book = Book::new(&[], |path, _| path.ends_with(".Name").then(|| Ok(Com::Str("Sales".to_owned()))));
    assert_eq!(
        book.run(r#"{"op":"add_table","range":"A1:C9","name":"Sales","style":"None"}"#),
        Ok(r#"{"op":"add_table","changed":true,"name":"Sales"}"#.to_owned())
    );
    let log = book.log();
    assert!(log.iter().any(|line| line.contains("ListObjects.Add(i4:1, <Book.ActiveSheet.Range(\"A1:C9\")>, null, i4:1)")), "{log:?}");
    assert!(log.iter().any(|line| line.ends_with(".TableStyle = \"\"")), "{log:?}");
}

#[test]
fn a_pivot_field_that_is_not_there_names_the_fields_that_are() {
    let book = Book::new(&[("Book.ActiveSheet.PivotTables()", 0)], |path, _| match path {
        p if p.ends_with(".PivotFields().Count") => Some(Ok(Com::I4(2))),
        p if p.ends_with(".PivotFields().Item(i4:1).Name") => Some(Ok(Com::Str("Region".to_owned()))),
        p if p.ends_with(".PivotFields().Item(i4:2).Name") => Some(Ok(Com::Str("Sales".to_owned()))),
        p if p.ends_with("PivotTables().Count") => Some(Ok(Com::I4(0))),
        _ => None,
    });
    assert_eq!(
        book.run(r#"{"op":"add_pivot_table","source":"A1:B9","destination":"D1","rows":["Zone"]}"#),
        Err("Pivot field 'Zone' not found; available fields: Region, Sales".to_owned())
    );
    assert!(lines_with(&book.log(), "CreatePivotTable(").iter().any(|line| line.ends_with(", \"MixdogPivot1\")")), "{:?}", book.log());
}

#[test]
fn the_auto_filter_is_turned_off_by_enabled_false() {
    let book = plain();
    assert_eq!(
        book.run(r#"{"op":"set_autofilter","range":"A1:C3","enabled":false}"#),
        Ok(r#"{"op":"set_autofilter","changed":true,"enabled":false}"#.to_owned())
    );
    assert_eq!(lines_with(&book.log(), "AutoFilterMode"), vec!["put Book.ActiveSheet.AutoFilterMode = false".to_owned()]);
    assert_eq!(book.run(r#"{"op":"set_autofilter","range":"A1:C3"}"#), Ok(r#"{"op":"set_autofilter","changed":true,"enabled":true}"#.to_owned()));
}

// ---------------------------------------------------------------------------------------------------------------------
// The window.

fn visible_excel(split_row: i32) -> Book {
    Book::new(&[], move |path, call| match path {
        "Book.Application.Visible" => Some(Ok(Com::Bool(true))),
        "Book.Application.ScreenUpdating" => Some(Ok(Com::Bool(true))),
        "Book.Windows.Item(i4:1).View" => Some(Ok(Com::I4(1))),
        "Book.Windows.Item(i4:1).Width" => Some(Ok(Com::R8(800.0))),
        "Book.Windows.Item(i4:1).Height" => Some(Ok(Com::R8(600.0))),
        "Book.Windows.Item(i4:1).Zoom" => Some(Ok(Com::R8(100.0))),
        "Book.Windows.Item(i4:1).SplitRow" if call.kind == Kind::Get => Some(Ok(Com::I4(split_row))),
        "Book.Windows.Item(i4:1).SplitColumn" if call.kind == Kind::Get => Some(Ok(Com::I4(0))),
        _ => None,
    })
}

#[test]
fn panes_are_frozen_zoomed_out_and_the_zoom_comes_back() {
    let book = visible_excel(1);
    assert_eq!(book.run(r#"{"op":"freeze_panes","row":2}"#), Ok(r#"{"op":"freeze_panes","changed":true}"#.to_owned()));
    let window: Vec<String> = book.log().iter().filter_map(|line| line.strip_prefix("put Book.Windows.Item(i4:1).")).map(str::to_owned).collect();
    assert_eq!(
        window,
        vec![
            "FreezePanes = false",
            "SplitRow = i4:0",
            "SplitColumn = i4:0",
            "ScrollRow = i4:1",
            "ScrollColumn = i4:1",
            "Zoom = r8:10",
            "SplitRow = i4:1",
            "SplitColumn = i4:0",
            "FreezePanes = true",
            "Zoom = r8:100",
            "Width = r8:800",
            "Height = r8:600",
        ]
    );
    let updating: Vec<String> = lines_with(&book.log(), "ScreenUpdating = ");
    assert_eq!(updating, vec!["put Book.Application.ScreenUpdating = true".to_owned(); 2]);
}

#[test]
fn panes_that_froze_elsewhere_are_refused_with_where_they_froze() {
    let book = visible_excel(3);
    assert_eq!(book.run(r#"{"op":"freeze_panes","row":2}"#), Err("Excel froze panes at row=3 column=0 instead of row=1 column=0".to_owned()));
}

#[test]
fn freezing_nothing_only_clears_the_panes() {
    let book = visible_excel(0);
    assert_eq!(book.run(r#"{"op":"freeze_panes"}"#), Ok(r#"{"op":"freeze_panes","changed":true}"#.to_owned()));
    assert!(lines_with(&book.log(), "Zoom").is_empty());
}

#[test]
fn a_sheet_view_sets_its_zoom_as_a_double_between_10_and_400() {
    let book = visible_excel(0);
    book.run(r#"{"op":"set_sheet_view","showGridlines":false,"zoom":900}"#).expect("the view is set");
    let puts: Vec<String> = book.log().iter().filter_map(|line| line.strip_prefix("put Book.Windows.Item(i4:1).")).map(str::to_owned).collect();
    assert_eq!(puts, vec!["DisplayGridlines = false".to_owned(), "Zoom = r8:400".to_owned()]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Printing.

#[test]
fn page_setup_is_held_off_while_it_is_written_and_comes_back_on() {
    let book = Book::new(&[], |path, _| match path {
        "Book.ActiveSheet.PageSetup.PrintArea" => Some(Ok(Com::Str("$A$1:$D$4".to_owned()))),
        "Book.Application.InchesToPoints(r8:0.5)" => Some(Ok(Com::R8(36.0))),
        "Book.ActiveSheet.Name" => Some(Ok(Com::Str("Data".to_owned()))),
        _ => None,
    });
    let record = book
        .run(r#"{"op":"set_page_setup","orientation":"landscape","fitToPagesWide":1,"leftMargin":0.5,"printTitleRows":"$1:$2","centerHorizontally":true}"#)
        .expect("the page is set up");
    assert_eq!(record, r#"{"op":"set_page_setup","changed":true,"sheet":"Data","printArea":"$A$1:$D$4"}"#);
    let puts: Vec<String> = book.log().iter().filter(|line| line.starts_with("put ")).cloned().collect();
    assert_eq!(
        puts,
        vec![
            "put Book.Application.PrintCommunication = false",
            "put Book.ActiveSheet.PageSetup.Orientation = i4:2",
            "put Book.ActiveSheet.PageSetup.Zoom = false",
            "put Book.ActiveSheet.PageSetup.FitToPagesWide = i4:1",
            "put Book.ActiveSheet.PageSetup.FitToPagesTall = false",
            "put Book.ActiveSheet.PageSetup.CenterHorizontally = true",
            "put Book.ActiveSheet.PageSetup.LeftMargin = r8:36",
            "put Book.ActiveSheet.PageSetup.PrintTitleRows = \"$1:$2\"",
            "put Book.Application.PrintCommunication = true",
        ]
    );
}

#[test]
fn print_titles_that_are_not_rows_are_refused_and_the_page_comes_back_on() {
    let book = plain();
    assert_eq!(
        book.run(r#"{"op":"set_page_setup","printTitleRows":"4:3"}"#),
        Err("set_page_setup printTitleRows is a row or a span of rows such as \"1\" or \"4:5\", not \"4:3\"".to_owned())
    );
    assert_eq!(book.log().last().map(String::as_str), Some("put Book.Application.PrintCommunication = true"));
}

#[test]
fn headers_and_footers_become_field_codes_and_keep_the_callers_ampersand() {
    let book = plain();
    assert_eq!(
        book.run(r#"{"op":"set_header_footer","kind":"Footer","alignment":"right","text":"A & B {Page} of {PAGES} {date} {time} {sheet} {file}"}"#),
        Ok(r#"{"op":"set_header_footer","changed":true,"sheet":"Data","kind":"footer","alignment":"right"}"#.to_owned())
    );
    assert_eq!(lines_with(&book.log(), "RightFooter"), vec!["put Book.ActiveSheet.PageSetup.RightFooter = \"A && B &P of &N &D &T &A &F\"".to_owned()]);
    assert_eq!(book.run(r#"{"op":"set_header_footer","kind":"body"}"#), Err("set_header_footer kind must be header or footer".to_owned()));
    assert_eq!(
        book.run(r#"{"op":"set_header_footer","kind":"header","alignment":"top"}"#),
        Err("set_header_footer alignment must be left, center, or right".to_owned())
    );
}

#[test]
fn a_row_fit_does_not_fit_columns() {
    let book = plain();
    assert_eq!(book.run(r#"{"op":"autofit_range","range":"1:3","rows":true}"#), Ok(r#"{"op":"autofit_range","changed":true,"range":"1:3"}"#.to_owned()));
    assert!(lines_with(&book.log(), "Columns.AutoFit").is_empty(), "{:?}", book.log());
}

#[test]
fn a_column_fit_leaves_empty_columns_alone_and_pads_the_others_by_two() {
    let book = Book::new(&[("Book.ActiveSheet.Range(\"A:B\").Columns", 2)], |path, _| match path {
        "Book.ActiveSheet.Range(\"A:B\").Columns[0].ColumnWidth" => Some(Ok(Com::R8(10.0))),
        "Book.ActiveSheet.Range(\"A:B\").Columns[1].ColumnWidth" => Some(Ok(Com::R8(79.0))),
        p if p.contains("CountA(<Book.ActiveSheet.Range(\"A:B\").Columns[0]>)") => Some(Ok(Com::R8(4.0))),
        p if p.contains("CountA(<Book.ActiveSheet.Range(\"A:B\").Columns[1]>)") => Some(Ok(Com::R8(4.0))),
        "Book.ActiveSheet.Range(\"A:B\").Columns.Count" => Some(Ok(Com::I4(2))),
        _ => None,
    });
    let outcome = book.run(r#"{"op":"autofit_range","range":"A:B"}"#);
    assert_eq!(outcome, Ok(r#"{"op":"autofit_range","changed":true,"range":"A:B"}"#.to_owned()));
    let widths = lines_with(&book.log(), ".ColumnWidth = ");
    assert_eq!(
        widths,
        vec![
            "put Book.ActiveSheet.Range(\"A:B\").Columns[0].ColumnWidth = r4:12".to_owned(),
            "put Book.ActiveSheet.Range(\"A:B\").Columns[1].ColumnWidth = r4:80".to_owned(),
        ]
    );
}
