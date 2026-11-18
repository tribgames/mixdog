//! The workbook reader against a scripted workbook: a tree of COM objects that answer by member name, in place of Excel.
//!
//! The recorded call logs of `tests/scenarios/excel-read.json` (taken from the PowerShell hosts against Microsoft Excel)
//! are held to the same reader once they exist on the migration PC; these tests pin the rules of the port that need no
//! Office: what a page of cells and a selection look like, the types the page's COM arguments go out with, the colour names
//! of a Korean Excel, and the financial-model audit.

use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::rc::Rc;

use mixdog_office_com::com::Call;
use mixdog_office_com::com::ComError;
use mixdog_office_com::com::ComObject;
use mixdog_office_com::com::DISP_E_MEMBERNOTFOUND;
use mixdog_office_com::com::ItemSource;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::SafeArray;
use mixdog_office_com::com::Value as Com;
use mixdog_office_com::drivers::Drivers;
use mixdog_office_com::excel::Reader;
use mixdog_office_com::format::FormatReader;
use mixdog_office_com::format::snapshot_document;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::ScriptedApplications;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::platform::FontSet;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::json::to_json;
use mixdog_office_com::ps::payload;

type Member = Box<dyn Fn(&[Com]) -> Com>;

/// A COM object that answers the members it was given and says the others do not exist.
struct Node {
    id: u64,
    members: HashMap<&'static str, Member>,
    items: Vec<Com>,
}

struct Items(VecDeque<Com>);

impl ItemSource for Items {
    fn next_item(&mut self) -> Result<Option<Com>, ComError> {
        Ok(self.0.pop_front())
    }
}

impl ComObject for Node {
    fn invoke(&self, call: &Call<'_>) -> Result<Com, ComError> {
        match self.members.get(call.member) {
            Some(member) => Ok(member(call.args)),
            None => Err(ComError {
                hresult: DISP_E_MEMBERNOTFOUND,
                inner_hresult: DISP_E_MEMBERNOTFOUND,
                message: format!("no member {}", call.member),
                inner_message: String::new(),
                unknown_member: true,
            }),
        }
    }

    fn enum_open(&self) -> Result<Box<dyn ItemSource>, ComError> {
        Ok(Box::new(Items(self.items.iter().cloned().collect())))
    }

    fn same_object(&self, other: &dyn ComObject) -> bool {
        other.as_any().downcast_ref::<Node>().is_some_and(|node| node.id == self.id)
    }

    fn identity_key(&self) -> String {
        format!("rcw:{}", self.id)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

thread_local! {
    static NEXT_ID: RefCell<u64> = const { RefCell::new(1) };
}

fn make(members: Vec<(&'static str, Member)>, items: Vec<Com>) -> Obj {
    let id = NEXT_ID.with(|next| {
        let mut next = next.borrow_mut();
        *next += 1;
        *next
    });
    Obj::new(Rc::new(Node { id, members: members.into_iter().collect(), items }))
}

fn obj(members: Vec<(&'static str, Member)>) -> Com {
    Com::Dispatch(make(members, Vec::new()))
}

fn konst(value: Com) -> Member {
    Box::new(move |_| value.clone())
}

fn func(body: impl Fn(&[Com]) -> Com + 'static) -> Member {
    Box::new(body)
}

fn text(value: &str) -> Member {
    konst(Com::Str(value.to_owned()))
}

fn count(value: i32) -> Member {
    konst(obj(vec![("Count", konst(Com::I4(value)))]))
}

fn matrix(rows: Vec<Vec<Com>>) -> Com {
    Com::Array(SafeArray::from_rows((1, 1), rows).expect("a rectangular array"))
}

struct World {
    platform: FakePlatform,
    apps: ScriptedApplications,
}

impl World {
    fn new() -> Self {
        Self { platform: FakePlatform::new(), apps: ScriptedApplications::new() }
    }

    fn env(&self) -> Env<'_> {
        Env { platform: &self.platform, applications: &self.apps }
    }
}

fn request(json: &str) -> Value {
    payload::parse_payload(json).expect("a request")
}

#[test]
fn a_selection_names_the_sheet_the_range_and_the_active_cell() {
    let owner = obj(vec![("FullName", text("C:\\work\\book.xlsx"))]);
    let sheet = obj(vec![("Name", text("Data")), ("Parent", konst(owner))]);
    let selection = obj(vec![
        ("Parent", konst(sheet)),
        ("Address", text("B2:C3")),
        ("Rows", count(2)),
        ("Columns", count(2)),
    ]);
    let application = obj(vec![("Selection", konst(selection)), ("ActiveCell", konst(obj(vec![("Address", text("B2"))])))]);
    let book = make(vec![("FullName", text("C:\\work\\book.xlsx")), ("Application", konst(application))], Vec::new());
    let world = World::new();
    let answer = Reader.selection(&world.env(), &book).expect("a selection");
    assert_eq!(
        to_json(&answer, 4),
        "{\"available\":true,\"kind\":\"range\",\"target\":\"/sheet[Data]/range[B2:C3]\",\"key\":\"Data!B2:C3@B2\",\"sheet\":\"Data\",\"address\":\"B2:C3\",\"activeCell\":\"B2\",\"rows\":2,\"columns\":2}"
    );
}

#[test]
fn a_selection_in_another_workbook_is_unavailable() {
    let owner = obj(vec![("FullName", text("C:\\work\\other.xlsx"))]);
    let sheet = obj(vec![("Name", text("Data")), ("Parent", konst(owner))]);
    let application = obj(vec![("Selection", konst(obj(vec![("Parent", konst(sheet))])))]);
    let book = make(vec![("FullName", text("C:\\work\\book.xlsx")), ("Application", konst(application))], Vec::new());
    let answer = Reader.selection(&World::new().env(), &book).expect("an answer");
    assert_eq!(to_json(&answer, 4), "{\"available\":false,\"reason\":\"The active Excel selection belongs to another workbook.\"}");
}

// ---------------------------------------------------------------------------------------------------------------------
// A workbook of grids: sheets whose cells are given by address, answering the members the reader asks of a range.

type Grid = Rc<std::collections::BTreeMap<(i32, i32), (Com, String)>>;

fn letters(mut column: i32) -> String {
    let mut out = String::new();
    while column > 0 {
        out.insert(0, (b'A' + ((column - 1) % 26) as u8) as char);
        column = (column - 1) / 26;
    }
    out
}

/// `B12` as (row, column).
fn position(address: &str) -> (i32, i32) {
    let split = address.find(|c: char| c.is_ascii_digit()).expect("a cell address");
    let column = address[..split].bytes().fold(0, |sum, byte| sum * 26 + i32::from(byte - b'A') + 1);
    (address[split..].parse().expect("a row"), column)
}

fn int_arg(value: &Com) -> i32 {
    match value {
        Com::I4(n) => *n,
        Com::I8(n) => *n as i32,
        Com::R8(n) => *n as i32,
        other => panic!("not a count: {other:?}"),
    }
}

/// A range of `rows` x `cols` cells from (`row0`, `col0`) over the grid.
fn range_of(grid: &Grid, row0: i32, col0: i32, rows: i32, cols: i32, number_format: &'static str, language: i32) -> Com {
    let value = |r: i32, c: i32| grid.get(&(row0 + r, col0 + c)).map_or(Com::Empty, |(value, _)| value.clone());
    let formula = |r: i32, c: i32| match grid.get(&(row0 + r, col0 + c)) {
        Some((_, formula)) if !formula.is_empty() => Com::Str(formula.clone()),
        Some((Com::Str(text), _)) => Com::Str(text.clone()),
        Some((Com::R8(number), _)) => Com::Str(number.to_string()),
        _ => Com::Str(String::new()),
    };
    let values = matrix((0..rows).map(|r| (0..cols).map(|c| value(r, c)).collect()).collect());
    let formulas = matrix((0..rows).map(|r| (0..cols).map(|c| formula(r, c)).collect()).collect());
    let address = if rows == 1 && cols == 1 { format!("{}{row0}", letters(col0)) } else { format!("{}{row0}:{}{}", letters(col0), letters(col0 + cols - 1), row0 + rows - 1) };
    let (cells_grid, resize_grid) = (grid.clone(), grid.clone());
    let has_formula = grid.get(&(row0, col0)).is_some_and(|(_, formula)| formula.starts_with('='));
    obj(vec![
        ("Rows", count(rows)),
        ("Columns", count(cols)),
        ("Row", konst(Com::I4(row0))),
        ("Column", konst(Com::I4(col0))),
        ("Address", text(&address)),
        ("Value2", konst(values)),
        ("Formula", konst(formulas)),
        ("HasFormula", konst(Com::Bool(has_formula))),
        ("MergeCells", konst(Com::Bool(false))),
        ("NumberFormat", text(number_format)),
        ("Font", konst(obj(vec![("Name", text("Calibri")), ("Size", konst(Com::R8(11.0))), ("Bold", konst(Com::Bool(false))), ("Italic", konst(Com::Bool(false))), ("Color", konst(Com::R8(0.0)))]))),
        ("Interior", konst(obj(vec![("Color", konst(Com::R8(16_777_215.0)))]))),
        ("HorizontalAlignment", konst(Com::I4(1))),
        ("Application", konst(obj(vec![("LanguageSettings", konst(obj(vec![("LanguageID", konst(Com::I4(language)))])))]))),
        (
            "Cells",
            konst(obj(vec![(
                "Item",
                func(move |args| range_of(&cells_grid, row0 + int_arg(&args[0]) - 1, col0 + int_arg(&args[1]) - 1, 1, 1, number_format, language)),
            )])),
        ),
        ("Resize", func(move |args| range_of(&resize_grid, row0, col0, int_arg(&args[0]), int_arg(&args[1]), number_format, language))),
    ])
}

/// A worksheet holding `cells` (`(address, value, formula)`), its used range their bounding box (A1 when it holds none).
fn grid_sheet(name: &'static str, cells: &[(&str, Com, &str)], number_format: &'static str, language: i32) -> Com {
    let grid: Grid = Rc::new(cells.iter().map(|(address, value, formula)| (position(address), (value.clone(), (*formula).to_owned()))).collect());
    let (rows, columns): (Vec<i32>, Vec<i32>) = grid.keys().copied().unzip();
    let (top, left) = (rows.iter().copied().min().unwrap_or(1), columns.iter().copied().min().unwrap_or(1));
    let (bottom, right) = (rows.iter().copied().max().unwrap_or(1), columns.iter().copied().max().unwrap_or(1));
    let used = range_of(&grid, top, left, bottom - top + 1, right - left + 1, number_format, language);
    let by_address = grid.clone();
    obj(vec![
        ("Name", text(name)),
        ("Visible", konst(Com::I4(-1))),
        ("UsedRange", konst(used)),
        ("ListObjects", konst(obj(vec![("Count", konst(Com::I4(0)))]))),
        ("ChartObjects", func(|_| obj(vec![("Count", konst(Com::I4(0)))]))),
        ("Shapes", konst(Com::Dispatch(make(Vec::new(), Vec::new())))),
        ("PivotTables", func(|_| obj(vec![("Count", konst(Com::I4(0)))]))),
        ("ProtectContents", konst(Com::Bool(false))),
        (
            "Range",
            func(move |args| {
                let Com::Str(address) = &args[0] else { panic!("an address") };
                let (first, last) = address.split_once(':').map_or((address.as_str(), address.as_str()), |pair| pair);
                let ((r0, c0), (r1, c1)) = (position(first), position(last));
                range_of(&by_address, r0, c0, r1 - r0 + 1, c1 - c0 + 1, number_format, language)
            }),
        ),
    ])
}

/// A workbook of `sheets` in order, `active` the one the user has on screen.
fn grid_book(sheets: &[Com], active: usize) -> Obj {
    let normal = obj(vec![("Font", konst(obj(vec![("Name", text("Calibri")), ("Size", konst(Com::R8(11.0)))])))]);
    let listed = sheets.to_vec();
    let named = sheets.to_vec();
    let worksheets = make(
        vec![
            ("Count", konst(Com::I4(sheets.len() as i32))),
            (
                "Item",
                func(move |args| match &args[0] {
                    Com::Str(wanted) => named
                        .iter()
                        .find(|sheet| matches!(sheet.as_obj().and_then(|o| o.get("Name").ok()), Some(Com::Str(name)) if &name == wanted))
                        .cloned()
                        .unwrap_or(Com::Empty),
                    other => named[int_arg(other) as usize - 1].clone(),
                }),
            ),
        ],
        listed,
    );
    make(
        vec![
            ("FullName", text("C:\\work\\book.xlsx")),
            ("ActiveSheet", konst(sheets[active].clone())),
            ("Worksheets", konst(Com::Dispatch(worksheets))),
            ("Names", konst(obj(vec![("Count", konst(Com::I4(0)))]))),
            ("Styles", konst(obj(vec![("Item", konst(normal))]))),
            ("Application", konst(Com::Empty)),
        ],
        Vec::new(),
    )
}

fn number(value: f64) -> Com {
    Com::R8(value)
}

fn word(value: &str) -> Com {
    Com::Str(value.to_owned())
}

fn read(book: &Obj, request_json: &str) -> Value {
    let world = World::new();
    let readers: &[(&str, &dyn FormatReader)] = &[("xlsx", &Reader)];
    snapshot_document(&Drivers::new(readers, &[]), &world.env(), book, "xlsx", &request(request_json)).expect("a page")
}

fn field(value: &Value, path: &[&str]) -> Value {
    path.iter().fold(value.clone(), |at, key| payload::property(&at, key))
}

/// The cells of the page the answer holds: `sheet!ref=value`.
fn page_cells(answer: &Value) -> Vec<String> {
    let sheets = field(answer, &["sheets"]);
    let Value::Array(sheets) = sheets else { return Vec::new() };
    sheets
        .iter()
        .flat_map(|sheet| {
            let name = convert_text(&field(sheet, &["name"]));
            match field(sheet, &["cells"]) {
                Value::Array(cells) => cells.iter().map(|cell| format!("{name}!{}={}", convert_text(&field(cell, &["ref"])), convert_text(&field(cell, &["value"])))).collect(),
                _ => Vec::new(),
            }
        })
        .collect()
}

fn convert_text(value: &Value) -> String {
    mixdog_office_com::ps::convert::to_ps_string(value)
}

fn whole(value: &Value) -> i64 {
    mixdog_office_com::ps::convert::to_int64(value).expect("a number")
}

/// One page of a walk: the cells it holds and the pagination it answers.
struct Page {
    cells: Vec<String>,
    offset: i64,
    returned: i64,
    total: i64,
    next_offset: Option<i64>,
    next_sheet: Option<i64>,
}

/// Walks the workbook by the cursor the pagination of each page gives (`limits` cycle from page to page), the way the dispatcher does:
/// the next page is the same sheet at `nextOffset`, else the sheet `nextSheetOffset` from offset 0.
fn walk(book: &Obj, extra: &str, limits: &[i64]) -> Vec<Page> {
    let (mut offset, mut sheet_offset, mut pages) = (0, 0, Vec::new());
    loop {
        let limit = limits[pages.len() % limits.len()];
        let answer = read(book, &format!("{{\"paged\":true,\"limit\":{limit},\"offset\":{offset},\"sheetOffset\":{sheet_offset}{extra}}}"));
        let pagination = field(&answer, &["pagination"]);
        let optional = |key: &str| Some(field(&pagination, &[key])).filter(|value| !matches!(value, Value::Null)).map(|value| whole(&value));
        let page = Page {
            cells: page_cells(&answer),
            offset: whole(&field(&pagination, &["offset"])),
            returned: whole(&field(&pagination, &["returned"])),
            total: whole(&field(&pagination, &["total"])),
            next_offset: optional("nextOffset"),
            next_sheet: optional("nextSheetOffset"),
        };
        assert_eq!(whole(&field(&pagination, &["limit"])), limit, "the page says the limit it was asked");
        assert_eq!(page.returned as usize, page.cells.len(), "returned is the page's length");
        (offset, sheet_offset) = match (page.next_offset, page.next_sheet) {
            (Some(next), _) => (next, sheet_offset),
            (None, Some(sheet)) => (0, sheet),
            (None, None) => {
                pages.push(page);
                return pages;
            }
        };
        pages.push(page);
        assert!(pages.len() < 200, "the walk does not end");
    }
}

/// Three sheets, the one on screen the last: a sparse `Notes`, an empty `Hollow`, and `Data` with a formula.
fn sparse_book() -> (Obj, Vec<String>) {
    let notes = grid_sheet("Notes", &[("A1", word("title"), ""), ("C3", number(3.0), ""), ("E9", word("far"), ""), ("B4", number(4.0), "")], "General", 1033);
    let hollow = grid_sheet("Hollow", &[], "General", 1033);
    let data = grid_sheet("Data", &[("A1", number(1.0), ""), ("A2", number(2.0), "=A1*2"), ("B2", word("t"), "")], "General", 1033);
    let expected = ["Notes!A1=title", "Notes!C3=3", "Notes!B4=4", "Notes!E9=far", "Data!A1=1", "Data!A2=2", "Data!B2=t"];
    (grid_book(&[notes, hollow, data.clone()], 2), expected.map(str::to_owned).to_vec())
}

#[test]
fn a_walk_of_a_sparse_workbook_reads_each_cell_once_from_the_first_sheet_over_an_empty_sheet_whatever_the_limit() {
    let (book, expected) = sparse_book();
    // Row-major within a sheet, so the sparse cells come in the order of their rows; the active sheet is the last, and the walk starts at the first.
    let in_sheet_order = ["Notes!A1=title", "Notes!C3=3", "Notes!B4=4", "Notes!E9=far", "Data!A1=1", "Data!A2=2", "Data!B2=t"];
    assert_eq!(expected, in_sheet_order);
    for limits in [&[1][..], &[2], &[3], &[100], &[1, 3, 2]] {
        let pages = walk(&book, "", limits);
        let all: Vec<String> = pages.iter().flat_map(|page| page.cells.clone()).collect();
        assert_eq!(all, expected, "limits {limits:?}");
    }
}

#[test]
fn every_page_says_a_true_total_and_continues_from_where_it_ended() {
    let (book, _) = sparse_book();
    let pages = walk(&book, "", &[3]);
    // Notes: 4 cells in pages of 3 (3, 1); Hollow: empty; Data: 3 cells (3).
    let shape: Vec<(i64, i64, i64, Option<i64>, Option<i64>)> = pages.iter().map(|p| (p.offset, p.returned, p.total, p.next_offset, p.next_sheet)).collect();
    assert_eq!(
        shape,
        [
            (0, 3, 4, Some(3), None),    // first page of Notes: more cells in this sheet
            (3, 1, 4, None, Some(1)),    // last page of Notes: the walk goes on into the next sheet
            (0, 0, 0, None, Some(2)),    // the empty sheet is a page, and the walk continues
            (0, 3, 3, None, None),       // the last cells of the last sheet end the walk
        ]
    );
}

#[test]
fn styles_a_limit_and_a_shrinking_budget_change_the_size_of_a_page_and_never_what_the_walk_reads() {
    let (book, expected) = sparse_book();
    // A budget that has to shrink the page again and again reads the same walk: only the limits of its pages change.
    let shrinking = walk(&book, "", &[4, 2, 1, 1, 3]);
    assert_eq!(shrinking.iter().flat_map(|page| page.cells.clone()).collect::<Vec<_>>(), expected);
    let styled = walk(&book, ",\"includeStyles\":true", &[2]);
    assert_eq!(styled.iter().flat_map(|page| page.cells.clone()).collect::<Vec<_>>(), expected);
}

#[test]
fn a_named_sheet_and_a_range_are_walked_alone() {
    let (book, _) = sparse_book();
    let data = walk(&book, ",\"sheet\":\"Data\"", &[2]);
    assert_eq!(data.iter().flat_map(|page| page.cells.clone()).collect::<Vec<_>>(), ["Data!A1=1", "Data!A2=2", "Data!B2=t"]);
    assert!(data.iter().all(|page| page.next_sheet.is_none() && page.total == 3), "a named sheet is the whole walk");
    // A range counts and emits only the cells inside it.
    let ranged = walk(&book, ",\"sheet\":\"Notes\",\"range\":\"A1:C4\"", &[2]);
    assert_eq!(ranged.iter().flat_map(|page| page.cells.clone()).collect::<Vec<_>>(), ["Notes!A1=title", "Notes!C3=3", "Notes!B4=4"]);
    assert!(ranged.iter().all(|page| page.total == 3 && page.next_sheet.is_none()));
}

#[test]
fn a_sheet_past_five_hundred_cells_is_read_by_the_same_offsets() {
    let cells: Vec<(String, Com, String)> = (1..=620).map(|row| (format!("A{row}"), number(f64::from(row)), String::new())).collect();
    let refs: Vec<(&str, Com, &str)> = cells.iter().map(|(address, value, formula)| (address.as_str(), value.clone(), formula.as_str())).collect();
    let book = grid_book(&[grid_sheet("Long", &refs, "General", 1033)], 0);
    let page = read(&book, "{\"paged\":true,\"limit\":100,\"offset\":550}");
    let shown = page_cells(&page);
    assert_eq!(shown.len(), 70);
    assert_eq!((shown[0].as_str(), shown[69].as_str()), ("Long!A551=551", "Long!A620=620"));
    assert_eq!(whole(&field(&page, &["pagination", "total"])), 620);
    assert!(matches!(field(&page, &["pagination", "nextOffset"]), Value::Null));
}

#[test]
fn a_cell_with_a_korean_number_format_reads_its_colour_names_back_in_english() {
    let sheet = grid_sheet("Data", &[("A1", number(1.0), "")], "#,##0;[\u{BE68}\u{AC15}]-#,##0", 1042);
    let answer = read(&grid_book(&[sheet], 0), "{\"paged\":true,\"limit\":100,\"includeStyles\":true}");
    let json = to_json(&answer, 12);
    assert!(json.contains("\"numberFormat\":\"#,##0;[Red]-#,##0\""), "{json}");
    assert!(json.contains("\"defaultStyle\":{\"fontName\":\"Calibri\",\"fontSize\":11}"), "{json}");
}

/// The recorded departure of the Excel walk from the PowerShell host is on file, with its reason and the scenario it concerns.
#[test]
fn the_excel_walk_departure_names_a_recorded_scenario_and_says_why() {
    let departures: serde_json::Value = serde_json::from_str(include_str!("scenarios/excel-read.departures.json")).expect("departures parse");
    let recorded: serde_json::Value = serde_json::from_str(include_str!("scenarios/excel-read.json")).expect("the recording parses");
    for entry in departures["departures"].as_array().expect("a list") {
        assert!(recorded["scenarios"].as_array().expect("scenarios").iter().any(|s| s["id"] == entry["scenario"]), "no scenario {}", entry["scenario"]);
        assert!(entry["reason"].as_str().is_some_and(|reason| reason.len() > 60));
    }
}
/// A workbook of one sheet named `Checks` whose only cell is FALSE.
fn checks_book() -> Obj {
    let cell = obj(vec![("Text", text("FALSE")), ("Font", konst(obj(vec![("Name", text("Calibri"))])))]);
    let chunk = obj(vec![
        ("Value2", konst(Com::Bool(false))),
        ("FormulaR1C1", konst(Com::Str(String::new()))),
        ("Cells", konst(obj(vec![("Item", konst(cell))]))),
    ]);
    let used = obj(vec![
        ("Rows", count(1)),
        ("Columns", count(1)),
        ("Row", konst(Com::I4(1))),
        ("Column", konst(Com::I4(1))),
        ("Address", text("A1")),
        ("Cells", konst(obj(vec![("Item", konst(obj(vec![("Resize", konst(chunk))])))]))),
    ]);
    let sheet = obj(vec![
        ("Name", text("Checks")),
        ("UsedRange", konst(used)),
        ("Shapes", konst(Com::Dispatch(make(Vec::new(), Vec::new())))),
        ("ChartObjects", konst(obj(vec![("Count", konst(Com::I4(0)))]))),
    ]);
    make(vec![("Worksheets", konst(Com::Dispatch(make(Vec::new(), vec![sheet]))))], Vec::new())
}

#[test]
fn the_financial_audit_reads_a_false_check_and_reports_full_coverage() {
    let world = World::new();
    let mut fonts = FontSet::default();
    fonts.insert("Calibri");
    world.platform.set_fonts(fonts);
    let answer = Reader.issues(&world.env(), &checks_book(), &request("{\"auditProfile\":\"financial-model\"}")).expect("issues");
    let json = to_json(&answer, 12);
    assert!(
        json.contains("{\"severity\":\"error\",\"code\":\"failed_check\",\"path\":\"/sheet[Checks]/cell[A1]\",\"message\":\"A formula or explicit check on the Checks sheet evaluates to FALSE.\"}"),
        "{json}"
    );
    assert!(!json.contains("missing_checks_sheet"), "{json}");
    assert!(
        json.contains("\"auditCoverage\":{\"mode\":\"full\",\"complete\":true,\"totalCells\":1,\"scannedCells\":1,\"sheets\":[{\"sheet\":\"Checks\",\"range\":\"A1\",\"rows\":1,\"columns\":1,\"totalCells\":1,\"scannedCells\":1,\"chunks\":1,\"complete\":true}]}"),
        "{json}"
    );
}

#[test]
fn a_financial_audit_of_a_workbook_without_a_checks_sheet_says_so() {
    let sheet = obj(vec![
        ("Name", text("Model")),
        ("UsedRange", konst(obj(vec![("Rows", count(0)), ("Columns", count(0)), ("Address", text("A1"))]))),
        ("Shapes", konst(Com::Dispatch(make(Vec::new(), Vec::new())))),
        ("ChartObjects", konst(obj(vec![("Count", konst(Com::I4(0)))]))),
    ]);
    let book = make(vec![("Worksheets", konst(Com::Dispatch(make(Vec::new(), vec![sheet]))))], Vec::new());
    let answer = Reader.issues(&World::new().env(), &book, &request("{\"auditProfile\":\"financial-model\"}")).expect("issues");
    let json = to_json(&answer, 12);
    assert!(json.contains("\"code\":\"missing_checks_sheet\",\"path\":\"/\""), "{json}");
}
