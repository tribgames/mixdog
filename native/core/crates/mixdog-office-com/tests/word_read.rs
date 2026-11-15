//! The Word reader (`Snapshot-Word`, the docx branch of `Snapshot-Selection`, `Issues-Word`) against a scripted Word object
//! model, and, when `tests/fixtures/word-read/` holds recordings of the PowerShell host, against the replaying fake dispatch
//! object: the same call sequence and the same answer.
//!
//! The scripted model answers what the reader asks and records every access, so a test states both what the record says and
//! in which order Word was asked. It is written from `office-com-host.ps1`; the recordings (`recorder/scenarios/word-read.json`,
//! run on a PC with Microsoft Word) are the reference the same reader is held to once they exist.

use std::any::Any;
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::HashSet;
use std::rc::Rc;

use mixdog_office_com::com::Call;
use mixdog_office_com::com::ComError;
use mixdog_office_com::com::ComObject;
use mixdog_office_com::com::ItemSource;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::Value as Com;
use mixdog_office_com::format::FormatReader;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::ScriptedApplications;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::platform::FontSet;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::payload;
use mixdog_office_com::word::Reader;

// ---------------------------------------------------------------------------------------------------------------------
// The scripted object model.

type Method = Box<dyn Fn(&[Com]) -> Result<Com, ComError>>;

fn failure(message: &str, unknown_member: bool) -> ComError {
    ComError { hresult: -2_147_352_567, inner_hresult: -2_147_352_567, message: message.to_owned(), inner_message: message.to_owned(), unknown_member }
}

struct Mock {
    id: u64,
    log: Rc<RefCell<Vec<String>>>,
    members: HashMap<String, Com>,
    items: Option<Vec<Com>>,
    methods: HashMap<String, Method>,
    broken: HashSet<String>,
}

struct Walk {
    items: Vec<Com>,
    at: usize,
}

impl ItemSource for Walk {
    fn next_item(&mut self) -> Result<Option<Com>, ComError> {
        let next = self.items.get(self.at).cloned();
        self.at += 1;
        Ok(next)
    }
}

fn spelled(args: &[Com]) -> String {
    let parts: Vec<String> = args.iter().map(|arg| format!("{arg:?}")).collect();
    if parts.is_empty() { String::new() } else { format!("({})", parts.join(",")) }
}

impl ComObject for Mock {
    fn invoke(&self, call: &Call<'_>) -> Result<Com, ComError> {
        self.log.borrow_mut().push(format!("{}.{}{}", self.id, call.member, spelled(call.args)));
        if self.broken.contains(call.member) {
            return Err(failure("The remote procedure call failed.", false));
        }
        if let Some(method) = self.methods.get(call.member) {
            return method(call.args);
        }
        if let Some(items) = &self.items {
            if call.member == "Count" && call.args.is_empty() {
                return Ok(Com::I4(items.len() as i32));
            }
            if call.member == "Item" {
                let at = match call.args.first() {
                    Some(Com::I4(number)) => i64::from(*number),
                    _ => 0,
                };
                return usize::try_from(at - 1)
                    .ok()
                    .and_then(|at| items.get(at))
                    .cloned()
                    .ok_or_else(|| failure("The requested member of the collection does not exist.", false));
            }
        }
        self.members.get(call.member).cloned().ok_or_else(|| failure("unknown member", true))
    }

    fn enum_open(&self) -> Result<Box<dyn ItemSource>, ComError> {
        self.log.borrow_mut().push(format!("{}.(enumerate)", self.id));
        Ok(Box::new(Walk { items: self.items.clone().unwrap_or_default(), at: 0 }))
    }

    fn same_object(&self, other: &dyn ComObject) -> bool {
        other.as_any().downcast_ref::<Mock>().is_some_and(|other| other.id == self.id)
    }

    fn identity_key(&self) -> String {
        format!("mock:{}", self.id)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[derive(Clone)]
struct World {
    log: Rc<RefCell<Vec<String>>>,
    ids: Rc<Cell<u64>>,
}

struct Builder {
    mock: Mock,
}

impl World {
    fn new() -> World {
        World { log: Rc::new(RefCell::new(Vec::new())), ids: Rc::new(Cell::new(1)) }
    }

    fn obj(&self) -> Builder {
        let id = self.ids.get();
        self.ids.set(id + 1);
        Builder { mock: Mock { id, log: self.log.clone(), members: HashMap::new(), items: None, methods: HashMap::new(), broken: HashSet::new() } }
    }

    fn accesses(&self) -> Vec<String> {
        self.log.borrow().clone()
    }
}

impl Builder {
    fn prop(mut self, name: &str, value: Com) -> Builder {
        self.mock.members.insert(name.to_owned(), value);
        self
    }

    fn child(self, name: &str, object: Obj) -> Builder {
        self.prop(name, Com::Dispatch(object))
    }

    fn items(mut self, items: Vec<Obj>) -> Builder {
        self.mock.items = Some(items.into_iter().map(Com::Dispatch).collect());
        self
    }

    fn method(mut self, name: &str, body: impl Fn(&[Com]) -> Result<Com, ComError> + 'static) -> Builder {
        self.mock.methods.insert(name.to_owned(), Box::new(body));
        self
    }

    fn broken(mut self, name: &str) -> Builder {
        self.mock.broken.insert(name.to_owned());
        self
    }

    fn build(self) -> Obj {
        Obj::new(Rc::new(self.mock))
    }
}

fn text(value: &str) -> Com {
    Com::Str(value.to_owned())
}

/// A range of `document_text` with its offsets and its text.
fn range(world: &World, document_text: &str, start: i32, end: i32) -> Obj {
    let slice: String = document_text.chars().skip(start as usize).take((end - start).max(0) as usize).collect();
    let paragraphs = slice.matches('\r').count() as i32 + i32::from(!slice.ends_with('\r'));
    world
        .obj()
        .prop("Start", Com::I4(start))
        .prop("End", Com::I4(end))
        .prop("Text", Com::Str(slice))
        .child("Paragraphs", world.obj().prop("Count", Com::I4(paragraphs.max(1))).build())
        .child("Tables", world.obj().prop("Count", Com::I4(0)).build())
        .method("Information", |_| Ok(Com::Bool(false)))
        .build()
}

// ---------------------------------------------------------------------------------------------------------------------
// A document.

struct ParagraphSpec {
    start: i32,
    end: i32,
    style: &'static str,
    /// (custom, position)
    tab_stops: Vec<(bool, f64)>,
    list_type: i32,
    number_format: &'static str,
    font_size: f32,
}

impl ParagraphSpec {
    fn new(start: i32, end: i32) -> ParagraphSpec {
        ParagraphSpec { start, end, style: "Normal", tab_stops: Vec::new(), list_type: 0, number_format: "%1.", font_size: 11.0 }
    }
}

struct Revision {
    start: i32,
    end: i32,
    kind: i32,
    author: &'static str,
}

struct DocumentSpec {
    text: &'static str,
    paragraphs: Vec<ParagraphSpec>,
    revisions: Vec<Revision>,
    tables: Vec<Obj>,
}

fn paragraph(world: &World, document_text: &str, spec: &ParagraphSpec, next: Com) -> Obj {
    let tab_stops: Vec<Obj> = spec
        .tab_stops
        .iter()
        .map(|(custom, position)| {
            world
                .obj()
                .prop("CustomTab", Com::Bool(*custom))
                .prop("Position", Com::R4(*position as f32))
                .prop("Alignment", Com::I4(0))
                .prop("Leader", Com::I4(0))
                .build()
        })
        .collect();
    let level = world.obj().prop("NumberStyle", Com::I4(0)).prop("NumberFormat", text(spec.number_format)).build();
    let font = world
        .obj()
        .prop("Size", Com::R4(spec.font_size))
        .prop("Name", text("Calibri"))
        .prop("Bold", Com::I4(-1))
        .prop("Color", Com::I4(255))
        .prop("AllCaps", Com::I4(0))
        .prop("SmallCaps", Com::I4(0))
        .prop("Spacing", Com::R4(0.0))
        .prop("Hidden", Com::I4(0))
        .build();
    let list_format = world
        .obj()
        .prop("ListType", Com::I4(spec.list_type))
        .prop("ListLevelNumber", Com::I4(1))
        .child("ListTemplate", world.obj().child("ListLevels", world.obj().items(vec![level]).build()).build())
        .build();
    let range = world
        .obj()
        .prop("Start", Com::I4(spec.start))
        .prop("End", Com::I4(spec.end))
        .prop("Text", Com::Str(document_text.chars().skip(spec.start as usize).take((spec.end - spec.start) as usize).collect()))
        .child("Font", font)
        .child("ListFormat", list_format)
        .build();
    let format = world
        .obj()
        .prop("Alignment", Com::I4(1))
        .prop("SpaceBefore", Com::R4(0.0))
        .prop("SpaceAfter", Com::R4(8.0))
        .prop("LineSpacing", Com::R4(12.0))
        .prop("KeepWithNext", Com::I4(0))
        .prop("PageBreakBefore", Com::I4(0))
        .build();
    world
        .obj()
        .child("Range", range)
        .child("Style", world.obj().prop("NameLocal", text(spec.style)).build())
        .child("Format", format)
        .child("TabStops", world.obj().items(tab_stops).build())
        .method("Next", move |_| Ok(next.clone()))
        .build()
}

fn section(world: &World) -> Obj {
    let story = || world.obj().prop("Exists", Com::Bool(false)).build();
    let setup = world
        .obj()
        .prop("Orientation", Com::I4(0))
        .prop("TopMargin", Com::R4(72.0))
        .prop("BottomMargin", Com::R4(72.0))
        .prop("LeftMargin", Com::R4(72.0))
        .prop("RightMargin", Com::R4(72.0))
        .prop("PageWidth", Com::R4(612.0))
        .child("TextColumns", world.obj().prop("Count", Com::I4(1)).build())
        .build();
    let stories = |count: usize| world.obj().items((0..count).map(|_| story()).collect()).build();
    world.obj().child("PageSetup", setup).child("Headers", stories(3)).child("Footers", stories(3)).build()
}

/// A document of the spec: paragraphs chained through `Next`, one page, one section, no comments or notes.
fn document(world: &World, spec: &DocumentSpec) -> Obj {
    let mut next = Com::Null;
    let mut paragraphs: Vec<Obj> = Vec::new();
    for paragraph_spec in spec.paragraphs.iter().rev() {
        let built = paragraph(world, spec.text, paragraph_spec, next);
        next = Com::Dispatch(built.clone());
        paragraphs.push(built);
    }
    paragraphs.reverse();
    let revisions: Vec<Obj> = spec
        .revisions
        .iter()
        .map(|revision| {
            world
                .obj()
                .prop("Type", Com::I4(revision.kind))
                .prop("Author", text(revision.author))
                .child("Range", range(world, spec.text, revision.start, revision.end))
                .build()
        })
        .collect();
    let document_text = spec.text;
    let ranges = world.clone();
    let go_to = world.clone();
    let styles = world
        .obj()
        .method("Item", {
            let world = world.clone();
            move |args| match args.first() {
                Some(Com::I4(-2)) => Ok(Com::Dispatch(world.obj().prop("NameLocal", text("제목 1")).build())),
                Some(Com::I4(-1)) => Ok(Com::Dispatch(world.obj().prop("NameLocal", text("표준")).build())),
                _ => Err(failure("The requested member of the collection does not exist.", false)),
            }
        })
        .build();
    world
        .obj()
        .method("Repaginate", |_| Ok(Com::Null))
        .child("Revisions", world.obj().items(revisions).build())
        .child("InlineShapes", world.obj().items(Vec::new()).build())
        .child("Tables", world.obj().items(spec.tables.clone()).build())
        .child("Content", world.obj().prop("End", Com::I4(document_text.chars().count() as i32)).method("Information", |_| Ok(Com::I4(1))).build())
        .method("GoTo", move |_| Ok(Com::Dispatch(range(&go_to, document_text, 0, 0))))
        .method("Range", move |args| match (args.first(), args.get(1)) {
            (Some(Com::I4(start)), Some(Com::I4(end))) => Ok(Com::Dispatch(range(&ranges, document_text, *start, *end))),
            _ => Err(failure("bad range", false)),
        })
        .child("Paragraphs", world.obj().items(paragraphs).build())
        .child("Sections", world.obj().items(vec![section(world)]).build())
        .child("Comments", world.obj().items(Vec::new()).build())
        .child("Footnotes", world.obj().items(Vec::new()).build())
        .child("Endnotes", world.obj().items(Vec::new()).build())
        .child("ContentControls", world.obj().items(Vec::new()).build())
        .child("Styles", styles)
        .prop("FullName", text("C:\\work\\report.docx"))
        .prop("TrackRevisions", Com::Bool(true))
        .build()
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what the reader answers.

static NULL: Value = Value::Null;

/// `a.b.0.c`: properties of objects and positions in arrays.
fn at<'a>(value: &'a Value, path: &str) -> &'a Value {
    let mut here = value;
    for segment in path.split('.') {
        here = match here {
            Value::Object(object) => object.get(segment).unwrap_or(&NULL),
            Value::Array(items) => segment.parse::<usize>().ok().and_then(|position| items.get(position)).unwrap_or(&NULL),
            _ => &NULL,
        };
    }
    here
}

fn string_of(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn with_env<T>(body: impl FnOnce(&Env<'_>) -> T) -> T {
    let platform = FakePlatform::new();
    let applications = ScriptedApplications::new();
    body(&Env { platform: &platform, applications: &applications })
}

fn snapshot(document: &Obj, request: &str) -> Value {
    let payload = payload::parse_payload(request).expect("a request");
    with_env(|env| Reader.snapshot(env, document, &payload)).expect("a snapshot")
}

fn plain() -> DocumentSpec {
    let mut title = ParagraphSpec::new(0, 11);
    title.style = "제목 1";
    title.font_size = 24.0;
    let mut item = ParagraphSpec::new(11, 20);
    item.tab_stops = vec![(false, 36.0), (true, 72.0)];
    item.list_type = 2;
    item.number_format = "\u{2022}";
    DocumentSpec {
        text: "Title line\rA\tb here\r\r",
        paragraphs: vec![title, item, ParagraphSpec::new(20, 21)],
        revisions: Vec::new(),
        tables: Vec::new(),
    }
}

#[test]
fn a_plain_document_is_read_into_the_record() {
    let world = World::new();
    let value = snapshot(&document(&world, &plain()), "{}");
    assert_eq!(at(&value, "format"), &string_of("docx"));
    assert_eq!(at(&value, "path"), &string_of("C:\\work\\report.docx"));
    assert_eq!(at(&value, "paragraphCount"), &Value::Int(3));
    assert_eq!(at(&value, "trackChanges"), &Value::Bool(true));
    // The Korean names of built-in styles are the identifiers the writer accepts.
    assert_eq!(at(&value, "paragraphs.0.style"), &string_of("Heading1"));
    assert_eq!(at(&value, "paragraphs.1.style"), &string_of("Normal"));
    assert_eq!(at(&value, "paragraphs.0.text"), &string_of("Title line"));
    assert_eq!(at(&value, "paragraphs.0.path"), &string_of("/body/p[1]"));
    assert_eq!(at(&value, "paragraphs.0.pageStart"), &Value::Int(1));
    assert_eq!(at(&value, "paragraphs.0.font.size"), &Value::Double(24.0));
    assert_eq!(at(&value, "paragraphs.0.font.color"), &string_of("FF0000"));
    assert_eq!(at(&value, "paragraphs.0.font.bold"), &Value::Bool(true));
    assert_eq!(at(&value, "paragraphs.0.format.spacingAfter"), &Value::Double(8.0));
    // A line holds a tab: only the paragraph's own stop is listed. A line with no tab reads none.
    assert_eq!(at(&value, "paragraphs.1.format.tabStops.0.position"), &Value::Double(72.0));
    assert_eq!(at(&value, "paragraphs.1.format.tabStops.1"), &Value::Null);
    assert_eq!(at(&value, "paragraphs.0.format.tabStops"), &Value::Array(Vec::new()));
    // A literal mark with no placeholder is a bullet.
    assert_eq!(at(&value, "paragraphs.1.list.kind"), &string_of("bullet"));
    assert_eq!(at(&value, "paragraphs.1.list.level"), &Value::Int(0));
    assert_eq!(at(&value, "paragraphs.0.list"), &Value::Null);
    // An empty body paragraph is listed.
    assert_eq!(at(&value, "paragraphs.2.text"), &string_of(""));
    assert_eq!(at(&value, "blockOrder.2.path"), &string_of("/body/p[3]"));
    assert_eq!(at(&value, "sections.0.columns"), &Value::Int(1));
    assert_eq!(at(&value, "sections.0.stories"), &Value::Array(Vec::new()));
    assert_eq!(at(&value, "pagination"), &Value::Null);
}

#[test]
fn the_context_is_read_once_and_the_paragraphs_are_walked_with_next() {
    let world = World::new();
    let document = document(&world, &plain());
    snapshot(&document, "{}");
    let accesses = world.accesses();
    let position = |needle: &str| accesses.iter().position(|line| line.contains(needle)).unwrap_or_else(|| panic!("no access {needle}"));
    // The reading context: the revisions, the pictures, the tables, then the page count and each page's start.
    assert!(position(".Revisions") < position(".InlineShapes"));
    assert!(position(".InlineShapes") < position(".Tables"));
    assert!(position("Information(I4(4))") < position("GoTo(I4(1),I4(1),I4(1))"));
    // The paragraphs are reached by one Item(1) and then Next(), once after each of the three (the last answers nothing).
    assert!(accesses.iter().any(|line| line.ends_with(".Item(I4(1))")));
    assert_eq!(accesses.iter().filter(|line| line.ends_with(".Next")).count(), 3);
    // The map of local style names is read once however many paragraphs ask for a style.
    assert_eq!(accesses.iter().filter(|line| line.ends_with(".Item(I4(-2))")).count(), 1);
}

#[test]
fn a_paged_read_starts_at_the_offset_and_names_the_next_one() {
    let world = World::new();
    let document = document(&world, &plain());
    let value = snapshot(&document, "{\"paged\":true,\"offset\":1,\"limit\":1}");
    assert_eq!(at(&value, "paragraphs.0.index"), &Value::Int(2));
    assert_eq!(at(&value, "paragraphs.1"), &Value::Null);
    assert_eq!(at(&value, "pagination.offset"), &Value::Int(1));
    assert_eq!(at(&value, "pagination.returned"), &Value::Int(1));
    assert_eq!(at(&value, "pagination.total"), &Value::Int(3));
    assert_eq!(at(&value, "pagination.nextOffset"), &Value::Int(2));
    assert_eq!(at(&value, "pagination.unit"), &string_of("paragraph"));
    assert!(world.accesses().iter().any(|line| line.ends_with(".Item(I4(2))")));
}

#[test]
fn a_paragraph_target_reads_that_paragraph_alone() {
    let world = World::new();
    let document = document(&world, &plain());
    let value = snapshot(&document, "{\"paged\":true,\"limit\":9,\"target\":\"/BODY/p[3]/r[1]\"}");
    assert_eq!(at(&value, "paragraphs.0.index"), &Value::Int(3));
    assert_eq!(at(&value, "pagination.limit"), &Value::Int(1));
    assert_eq!(at(&value, "pagination.nextOffset"), &Value::Null);
}

#[test]
fn a_tracked_deletion_is_left_out_of_the_accepted_text() {
    let world = World::new();
    let spec = DocumentSpec {
        text: "one two three\r",
        paragraphs: vec![ParagraphSpec::new(0, 14)],
        revisions: vec![
            Revision { start: 4, end: 7, kind: 2, author: "Bob" },
            Revision { start: 8, end: 13, kind: 1, author: "bob" },
            Revision { start: 0, end: 3, kind: 3, author: "Ann" },
        ],
        tables: Vec::new(),
    };
    let value = snapshot(&document(&world, &spec), "{}");
    assert_eq!(at(&value, "paragraphs.0.text"), &string_of("one  three"));
    assert_eq!(at(&value, "paragraphs.0.deletedText"), &string_of("two"));
    assert_eq!(at(&value, "paragraphs.0.tracked"), &Value::Bool(true));
    assert_eq!(at(&value, "paragraphs.0.revisions"), &Value::Array(vec![Value::Int(1), Value::Int(2), Value::Int(3)]));
    assert_eq!(at(&value, "revisionCount"), &Value::Int(3));
    assert_eq!(at(&value, "revisions.0.type"), &string_of("deletion"));
    assert_eq!(at(&value, "revisions.0.at"), &string_of("/body/p[1]"));
    assert_eq!(at(&value, "revisions.2.type"), &string_of("property"));
    // A formatting revision is counted apart; authors differing only in case are one author, named as first seen.
    assert_eq!(at(&value, "propertyChangeCount"), &Value::Int(1));
    assert_eq!(at(&value, "revisionAuthors.0.author"), &string_of("Bob"));
    assert_eq!(at(&value, "revisionAuthors.0.insertions"), &Value::Int(1));
    assert_eq!(at(&value, "revisionAuthors.0.deletions"), &Value::Int(1));
    assert_eq!(at(&value, "revisionAuthors.1"), &Value::Null);
}

#[test]
fn a_table_is_read_cell_by_cell_and_its_widths_fall_back_to_the_first_row() {
    let world = World::new();
    let text_of_document = "Intro\rA\u{7}B\u{7}\r\u{7}";
    let cell = |start: i32, end: i32, size: f32| {
        world
            .obj()
            .child(
                "Range",
                world
                    .obj()
                    .prop("Start", Com::I4(start))
                    .prop("End", Com::I4(end))
                    .prop("Text", Com::Str(text_of_document.chars().skip(start as usize).take((end - start) as usize).collect()))
                    .child("Font", world.obj().prop("Size", Com::R4(size)).prop("Bold", Com::I4(0)).build())
                    .build(),
            )
            .prop("Width", Com::R4(if size > 11.0 { 144.0 } else { 72.0 }))
            .build()
    };
    let cells = [cell(6, 8, 11.0), cell(8, 10, 14.0)];
    let first_row = world.obj().child("Cells", world.obj().items(cells.to_vec()).build()).build();
    let table = world
        .obj()
        .child("Range", range(&world, text_of_document, 6, 12))
        .child("Rows", world.obj().prop("Alignment", Com::I4(1)).items(vec![first_row]).build())
        .child("Columns", world.obj().prop("Count", Com::I4(2)).broken("Item").build())
        .child("Style", world.obj().prop("NameLocal", text("표 구분선")).build())
        .method("Cell", {
            let cells = cells.clone();
            move |args| match args {
                [Com::I4(1), Com::I4(column)] => Ok(Com::Dispatch(cells[(*column - 1) as usize].clone())),
                _ => Err(failure("no such cell", false)),
            }
        })
        .build();
    let mut intro = ParagraphSpec::new(0, 6);
    intro.style = "표준";
    let (mut a, mut b, mut mark) = (ParagraphSpec::new(6, 8), ParagraphSpec::new(8, 10), ParagraphSpec::new(10, 12));
    a.style = "표준";
    b.style = "표준";
    mark.style = "표준";
    let spec = DocumentSpec { text: text_of_document, paragraphs: vec![intro, a, b, mark], revisions: Vec::new(), tables: vec![table] };
    let value = snapshot(&document(&world, &spec), "{}");
    // The cells' paragraphs are listed, as in the table; the row's end mark is not.
    assert_eq!(at(&value, "paragraphs.1.inTable"), &Value::Bool(true));
    assert_eq!(at(&value, "paragraphs.3"), &Value::Null);
    assert_eq!(at(&value, "tableCount"), &Value::Int(1));
    assert_eq!(at(&value, "tables.0.rows.0.cells.0.text"), &string_of("A"));
    assert_eq!(at(&value, "tables.0.rows.0.cells.1.text"), &string_of("B"));
    assert_eq!(at(&value, "tables.0.rows.0.cells.1.path"), &string_of("/body/tbl[1]/row[1]/cell[2]"));
    assert_eq!(at(&value, "tables.0.rows.0.cells.1.font.size"), &Value::Double(14.0));
    assert_eq!(at(&value, "tables.0.rows.0.cells.1.font.bold"), &Value::Bool(false));
    assert_eq!(at(&value, "tables.0.columnWidths"), &Value::Array(vec![Value::Double(72.0), Value::Double(144.0)]));
    assert_eq!(at(&value, "tables.0.alignment"), &Value::Int(1));
    // The table's style is a local name nobody mapped; it stays as it is. The one block order entry per block is sorted by start.
    assert_eq!(at(&value, "tables.0.style"), &string_of("표 구분선"));
    assert_eq!(at(&value, "blockOrder.0.type"), &string_of("paragraph"));
    assert_eq!(at(&value, "blockOrder.1.type"), &string_of("table"));
    assert_eq!(at(&value, "blockOrder.2"), &Value::Null);
}

#[test]
fn one_block_is_not_an_array_and_none_is_null() {
    // `@(...) | Sort-Object` hands one object over as itself and none as nothing.
    let world = World::new();
    let one = DocumentSpec { text: "x\r", paragraphs: vec![ParagraphSpec::new(0, 2)], revisions: Vec::new(), tables: Vec::new() };
    let value = snapshot(&document(&world, &one), "{}");
    assert_eq!(at(&value, "blockOrder.path"), &string_of("/body/p[1]"));
    assert!(matches!(at(&value, "blockOrder"), Value::Object(_)));
    let none = DocumentSpec { text: "", paragraphs: Vec::new(), revisions: Vec::new(), tables: Vec::new() };
    assert_eq!(at(&snapshot(&document(&world, &none), "{}"), "blockOrder"), &Value::Null);
}

#[test]
fn a_failure_outside_a_try_ends_the_snapshot() {
    // Repaginate and the reading context are tried and their failures dropped (this model has none of their members); a
    // paragraph whose range cannot be read is not.
    let world = World::new();
    let broken_paragraph = world.obj().broken("Range").build();
    let broken = world.obj().child("Paragraphs", world.obj().items(vec![broken_paragraph]).build()).build();
    let payload = payload::parse_payload("{}").expect("a request");
    assert!(with_env(|env| Reader.snapshot(env, &broken, &payload)).is_err());
}

// ---------------------------------------------------------------------------------------------------------------------
// The selection.

fn selection_document(world: &World, selection_name: &str, start: i32, end: i32) -> Obj {
    let selection = world
        .obj()
        .child("Document", world.obj().prop("FullName", text(selection_name)).build())
        .child("Range", range(world, "abc def\rghi\r", start, end))
        .build();
    let ranges = world.clone();
    world
        .obj()
        .prop("FullName", text("C:\\work\\report.docx"))
        .child("Application", world.obj().child("Selection", selection).build())
        .method("Range", move |args| match (args.first(), args.get(1)) {
            (Some(Com::I4(start)), Some(Com::I4(end))) => Ok(Com::Dispatch(range(&ranges, "abc def\rghi\r", *start, *end))),
            _ => Err(failure("bad range", false)),
        })
        .build()
}

#[test]
fn the_selection_of_another_document_is_unavailable() {
    let world = World::new();
    let document = selection_document(&world, "C:\\work\\other.docx", 0, 3);
    let value = with_env(|env| Reader.selection(env, &document)).expect("an answer");
    assert_eq!(at(&value, "available"), &Value::Bool(false));
    assert_eq!(at(&value, "reason"), &string_of("The active Word selection belongs to another document."));
}

#[test]
fn a_selection_is_text_or_an_insertion_point_in_a_paragraph() {
    let world = World::new();
    let document = selection_document(&world, "c:\\WORK\\Report.docx", 9, 11);
    let value = with_env(|env| Reader.selection(env, &document)).expect("an answer");
    assert_eq!(at(&value, "available"), &Value::Bool(true));
    assert_eq!(at(&value, "kind"), &string_of("text"));
    assert_eq!(at(&value, "target"), &string_of("/body/p[2]"));
    assert_eq!(at(&value, "key"), &string_of("/body/p[2]:9-11"));
    assert_eq!(at(&value, "text"), &string_of("hi"));
    let caret = selection_document(&world, "C:\\work\\report.docx", 2, 2);
    let value = with_env(|env| Reader.selection(env, &caret)).expect("an answer");
    assert_eq!(at(&value, "kind"), &string_of("insertion-point"));
    assert_eq!(at(&value, "target"), &string_of("/body/p[1]"));
}

// ---------------------------------------------------------------------------------------------------------------------
// The issues.

fn issues_document(world: &World) -> Obj {
    let long_text: String = "x".repeat(181);
    let font = world.obj().prop("Name", text("Zapfino")).prop("Size", Com::R4(20.0)).build();
    let range = world.obj().child("Font", font).prop("Text", Com::Str(format!("{long_text}\r"))).build();
    let paragraph = world.obj().child("Range", range).method("Next", |_| Ok(Com::Null)).build();
    let column = |width: f32| world.obj().prop("Width", Com::R4(width)).build();
    let page = world
        .obj()
        .prop("PageWidth", Com::R4(612.0))
        .prop("LeftMargin", Com::R4(72.0))
        .prop("RightMargin", Com::R4(72.0))
        .build();
    let section = world.obj().child("PageSetup", page).build();
    let table = world
        .obj()
        .child("Columns", world.obj().items(vec![column(500.0), column(100.5)]).build())
        .child("Range", world.obj().child("Sections", world.obj().items(vec![section]).build()).build())
        .build();
    let field = world.obj().child("Result", world.obj().prop("Text", text(" Error! Reference source not found. ")).build()).build();
    let fine = world.obj().child("Result", world.obj().prop("Text", text("12")).build()).build();
    world
        .obj()
        .child("Revisions", world.obj().prop("Count", Com::I4(2)).build())
        .child("Comments", world.obj().prop("Count", Com::I4(0)).build())
        .child("Fields", world.obj().items(vec![fine, field]).build())
        .child("Paragraphs", world.obj().prop("First", Com::Dispatch(paragraph)).build())
        .child("Tables", world.obj().items(vec![table]).build())
        .build()
}

#[test]
fn issues_name_what_the_author_has_to_resolve() {
    let world = World::new();
    let document = issues_document(&world);
    let platform = FakePlatform::new();
    let mut fonts = FontSet::default();
    fonts.insert("Calibri");
    platform.set_fonts(fonts);
    let applications = ScriptedApplications::new();
    let value = Reader
        .issues(&Env { platform: &platform, applications: &applications }, &document, &payload::parse_payload("{}").expect("a request"))
        .expect("issues");
    let codes: Vec<&Value> = (0..6).map(|at_| at(&value, &format!("{at_}.code"))).collect();
    assert_eq!(
        codes,
        vec![
            &string_of("unresolved_revisions"),
            &string_of("field_error"),
            &string_of("missing_font"),
            &string_of("oversized_heading_text"),
            &string_of("table_width"),
            &Value::Null,
        ]
    );
    assert_eq!(at(&value, "0.message"), &string_of("2 tracked revision(s) remain unresolved."));
    assert_eq!(at(&value, "1.path"), &string_of("/body/field[2]"));
    assert_eq!(at(&value, "1.message"), &string_of("Error! Reference source not found."));
    assert_eq!(at(&value, "2.message"), &string_of("Font is not installed: Zapfino"));
    assert_eq!(at(&value, "4.message"), &string_of("Table width 600.5pt exceeds available page width 468pt."));
}

// ---------------------------------------------------------------------------------------------------------------------
// The recordings of the PowerShell host.

#[test]
fn every_recorded_word_read_fixture_is_listed_and_readable() {
    // `tests/fixtures/word-read/<scenario>.json` is written by `recorder/record-office-com.mjs --area word-read` on a PC with
    // Microsoft Word, and the manifest lists it; until that has been run the manifest lists none and this holds nothing.
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures");
    let manifest: serde_json::Value = serde_json::from_str(&mixdog_testkit::read_string(fixtures.join("MANIFEST.json"))).expect("the manifest");
    for entry in manifest["fixtures"].as_array().expect("fixtures").iter().filter(|entry| entry["area"] == "word-read") {
        let path = fixtures.join(entry["path"].as_str().expect("a path"));
        let recording: serde_json::Value = serde_json::from_str(&mixdog_testkit::read_string(&path)).expect("a recording");
        assert!(recording["steps"].is_array(), "{}", path.display());
    }
}
