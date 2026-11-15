//! The workbook reader against a scripted workbook: a tree of COM objects that answer by member name, in place of Excel.
//!
//! The recorded call logs of `recorder/scenarios/excel-read.json` (taken from the PowerShell hosts against Microsoft Excel)
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
use mixdog_office_com::excel::Reader;
use mixdog_office_com::format::FormatReader;
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

fn workbook(sheet: &Com, application: Com) -> Obj {
    let normal = obj(vec![("Font", konst(obj(vec![("Name", text("Calibri")), ("Size", konst(Com::R8(11.0)))])))]);
    let styles = obj(vec![("Item", konst(normal))]);
    make(
        vec![
            ("FullName", text("C:\\work\\book.xlsx")),
            ("ActiveSheet", konst(sheet.clone())),
            ("Worksheets", konst(Com::Dispatch(make(vec![("Count", konst(Com::I4(1))), ("Item", konst(sheet.clone()))], vec![sheet.clone()])))),
            ("Styles", konst(styles)),
            ("Application", konst(application)),
        ],
        Vec::new(),
    )
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

/// A 2 x 2 sheet `Data`: `1`, `=A1*2` over `t`, `3`, whose used range and blocks are scripted. The log holds the types the
/// arguments of `Cells.Item` of the used range were passed with.
fn data_sheet(log: Rc<RefCell<Vec<String>>>, number_format: &'static str) -> Com {
    let cell = |formula: &'static str, has_formula: bool| {
        obj(vec![
            ("HasFormula", konst(Com::Bool(has_formula))),
            ("Formula", text(formula)),
            ("NumberFormat", text(number_format)),
            ("Font", konst(obj(vec![
                ("Name", text("Calibri")),
                ("Size", konst(Com::R8(11.0))),
                ("Bold", konst(Com::Bool(false))),
                ("Italic", konst(Com::Bool(false))),
                ("Color", konst(Com::R8(0.0))),
            ]))),
            ("Interior", konst(obj(vec![("Color", konst(Com::R8(16_777_215.0)))]))),
            ("HorizontalAlignment", konst(Com::I4(-4152))),
            (
                "Application",
                konst(obj(vec![("LanguageSettings", konst(obj(vec![("LanguageID", konst(Com::I4(1042)))])))])),
            ),
        ])
    };
    let cells = [cell("1", false), cell("=A1*2", true), cell("t", false), cell("3", false)];
    let block = obj(vec![
        ("Value2", konst(matrix(vec![vec![Com::R8(1.0), Com::R8(2.0)], vec![Com::Str("t".to_owned()), Com::R8(3.0)]]))),
        ("Formula", konst(matrix(vec![vec![Com::Str("1".to_owned()), Com::Str("=A1*2".to_owned())], vec![Com::Str("t".to_owned()), Com::Str("3".to_owned())]]))),
        ("Rows", count(2)),
        ("Columns", count(2)),
        ("Row", konst(Com::I4(1))),
        ("Column", konst(Com::I4(1))),
        (
            "Cells",
            konst(obj(vec![(
                "Item",
                func(move |args| match (&args[0], &args[1]) {
                    (Com::I4(row), Com::I4(column)) => cells[((row - 1) * 2 + (column - 1)) as usize].clone(),
                    _ => Com::Empty,
                }),
            )])),
        ),
    ]);
    let used = obj(vec![
        ("Rows", count(2)),
        ("Columns", count(2)),
        (
            "Cells",
            konst(obj(vec![(
                "Item",
                func(move |args| {
                    log.borrow_mut().push(args.iter().map(Com::type_tag).collect::<Vec<_>>().join(","));
                    Com::Empty
                }),
            )])),
        ),
        ("Address", text("A1:B2")),
    ]);
    obj(vec![
        ("Name", text("Data")),
        ("UsedRange", konst(used)),
        ("Range", konst(block)),
    ])
}

#[test]
fn a_page_of_cells_carries_formulas_lineage_and_the_pagination_record() {
    let log = Rc::new(RefCell::new(Vec::new()));
    let sheet = data_sheet(log.clone(), "General");
    let book = workbook(&sheet, Com::Empty);
    let answer = Reader.snapshot_page(&World::new().env(), &book, &request("{\"paged\":true,\"limit\":100}")).expect("a page");
    let json = to_json(&answer, 12);
    assert!(json.contains("\"representation\":\"cells\""), "{json}");
    assert!(json.contains("{\"path\":\"/sheet[Data]/cell[B1]\",\"ref\":\"B1\",\"value\":2,\"formula\":\"=A1*2\"}"), "{json}");
    assert!(json.contains("{\"path\":\"/sheet[Data]/cell[A2]\",\"ref\":\"A2\",\"value\":\"t\",\"formula\":null}"), "{json}");
    assert!(
        json.contains("\"formulaLineage\":[{\"path\":\"/sheet[Data]/cell[B1]/lineage\",\"from\":\"/sheet[Data]/cell[B1]\",\"formula\":\"=A1*2\",\"precedents\":[{\"sheet\":\"Data\",\"ref\":\"A1\",\"path\":\"/sheet[Data]/cell[A1]\"}]}]"),
        "{json}"
    );
    assert!(json.contains("\"truncated\":false"), "{json}");
    assert!(
        json.contains("\"pagination\":{\"unit\":\"cell\",\"scope\":\"Data!A1:B2\",\"offset\":0,\"limit\":100,\"returned\":4,\"scanned\":4,\"total\":4,\"nextOffset\":null}"),
        "{json}"
    );
    // A page that starts on a row boundary asks for its rows as Decimals (the floor of a whole number) and the column as an Int.
    assert_eq!(*log.borrow(), ["decimal,i4", "decimal,i4"]);
}

#[test]
fn a_page_with_styles_reads_the_colour_names_of_a_korean_excel_back_in_english() {
    let log = Rc::new(RefCell::new(Vec::new()));
    let sheet = data_sheet(log, "#,##0;[\u{BE68}\u{AC15}]-#,##0");
    let book = workbook(&sheet, Com::Empty);
    let answer =
        Reader.snapshot_page(&World::new().env(), &book, &request("{\"paged\":true,\"limit\":100,\"includeStyles\":true}")).expect("a page");
    let json = to_json(&answer, 12);
    assert!(json.contains("\"numberFormat\":\"#,##0;[Red]-#,##0\""), "{json}");
    assert!(json.contains("\"horizontalAlignment\":\"right\""), "{json}");
    assert!(json.contains("\"defaultStyle\":{\"fontName\":\"Calibri\",\"fontSize\":11}"), "{json}");
}

#[test]
fn a_page_past_the_end_is_empty_and_says_so() {
    let sheet = data_sheet(Rc::new(RefCell::new(Vec::new())), "General");
    let book = workbook(&sheet, Com::Empty);
    let answer = Reader.snapshot_page(&World::new().env(), &book, &request("{\"paged\":true,\"limit\":10,\"offset\":99}")).expect("a page");
    let json = to_json(&answer, 12);
    assert!(json.contains("\"offset\":4,\"limit\":10,\"returned\":0,\"scanned\":0,\"total\":4,\"nextOffset\":null"), "{json}");
    assert!(json.contains("\"cells\":[]"), "{json}");
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
