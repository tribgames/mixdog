//! The Word editor (`Apply-WordOperation` and the 41 operations of `Invoke-WordOperation`) against a scripted Word object
//! model, and, when `tests/fixtures/word-edit/` holds recordings of the PowerShell host, against the replaying fake dispatch
//! object: the same call sequence and the same results.
//!
//! The scripted model answers what the editor asks and records every access (a read as `id.Member(args)`, a write as
//! `id.Member=value`), so a test states both what the operation answered and in which order Word was asked. It is written
//! from `office-com-host.ps1`; the recordings (`tests/scenarios/word-edit.json`, run on a PC with Microsoft Word) are the
//! reference the same editor is held to once they exist.

use std::any::Any;
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use mixdog_office_com::com::Call;
use mixdog_office_com::com::ComError;
use mixdog_office_com::com::ComObject;
use mixdog_office_com::com::ItemSource;
use mixdog_office_com::com::Kind;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::Value as Com;
use mixdog_office_com::format::EditContext;
use mixdog_office_com::format::FormatEditor;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::ScriptedApplications;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::json::to_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::ChartExcel;
use mixdog_office_com::word::Editor;

// ---------------------------------------------------------------------------------------------------------------------
// The scripted object model.

type Method = Rc<dyn Fn(&[Com]) -> Result<Com, ComError>>;

fn failure(message: &str, unknown_member: bool) -> ComError {
    ComError { hresult: -2_147_352_567, inner_hresult: -2_147_352_567, message: message.to_owned(), inner_message: message.to_owned(), unknown_member }
}

struct Mock {
    id: u64,
    log: Rc<RefCell<Vec<String>>>,
    members: RefCell<HashMap<String, Com>>,
    items: Option<Vec<Com>>,
    methods: HashMap<String, Method>,
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
        if call.kind == Kind::Put {
            let value = call.value.cloned().unwrap_or(Com::Null);
            self.log.borrow_mut().push(format!("{}.{}={value:?}", self.id, call.member));
            self.members.borrow_mut().insert(call.member.to_owned(), value);
            return Ok(Com::Null);
        }
        self.log.borrow_mut().push(format!("{}.{}{}", self.id, call.member, spelled(call.args)));
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
        self.members.borrow().get(call.member).cloned().ok_or_else(|| failure("unknown member", true))
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
        Builder { mock: Mock { id, log: self.log.clone(), members: RefCell::new(HashMap::new()), items: None, methods: HashMap::new() } }
    }

    fn accesses(&self) -> Vec<String> {
        self.log.borrow().clone()
    }

    fn clear(&self) {
        self.log.borrow_mut().clear();
    }
}

impl Builder {
    fn prop(self, name: &str, value: Com) -> Builder {
        self.mock.members.borrow_mut().insert(name.to_owned(), value);
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
        self.mock.methods.insert(name.to_owned(), Rc::new(body));
        self
    }

    fn build(self) -> Obj {
        Obj::new(Rc::new(self.mock))
    }
}

fn text(value: &str) -> Com {
    Com::Str(value.to_owned())
}

fn operate(document: &Obj, request: &str) -> Result<Value, String> {
    let op = payload::parse_payload(request).expect("an operation");
    let platform = FakePlatform::new();
    let applications = ScriptedApplications::new();
    let mut chart_excel = ChartExcel::default();
    let mut context = EditContext { env: Env { platform: &platform, applications: &applications }, chart_excel: &mut chart_excel };
    match Editor.apply_operation(&mut context, document, &op, false, false) {
        Ok(Some(result)) => Ok(result),
        Ok(None) => Err("no result".to_owned()),
        Err(error) => Err(error.message().to_owned()),
    }
}

fn json_of(result: &Value) -> String {
    to_json(result, 8)
}

/// A document that answers `members` and nothing else.
fn bare_document(world: &World, build: impl FnOnce(Builder) -> Builder) -> Obj {
    build(world.obj()).build()
}

// ---------------------------------------------------------------------------------------------------------------------
// The registry.

#[test]
fn the_editor_serves_exactly_the_docx_operations_of_the_registry() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("registry").join("operations.json");
    let registry: serde_json::Value = serde_json::from_str(&mixdog_testkit::read_string(path)).expect("the registry");
    let listed: Vec<&str> = registry["operations"]["docx"].as_array().expect("the docx list").iter().map(|name| name.as_str().expect("a name")).collect();
    assert_eq!(listed.len(), 41);
    assert_eq!(Editor.operation_names(), listed.as_slice());
}

#[test]
fn an_unknown_operation_is_refused_with_its_name() {
    let world = World::new();
    let document = bare_document(&world, |document| document);
    assert_eq!(operate(&document, r#"{"op":"set_run_text"}"#).unwrap_err(), "Unsupported DOCX operation: set_run_text");
    assert!(world.accesses().is_empty(), "the refusal asked Word nothing");
}

// ---------------------------------------------------------------------------------------------------------------------
// The author wrapper.

fn application(world: &World) -> (Obj, Obj) {
    let options = world.obj().prop("UseLocalUserInfo", Com::Bool(false)).build();
    let app = world.obj().prop("UserName", text("Owner")).prop("UserInitials", text("OW")).child("Options", options.clone()).build();
    (app, options)
}

#[test]
fn an_author_labels_the_operation_and_the_user_name_comes_back() {
    let world = World::new();
    let (app, _) = application(&world);
    let document = bare_document(&world, |document| document.child("Application", app.clone()).prop("TrackRevisions", Com::Bool(false)));
    let result = operate(&document, r#"{"op":"track_changes","enabled":true,"author":"Reviewer A","initials":"RA"}"#).expect("the operation");
    assert_eq!(json_of(&result), r#"{"op":"track_changes","changed":true,"enabled":true}"#);
    // Word's objects in the order they were made: the options 1, the application 2, the document 3. The owner's values are
    // read first, the author's are put, the operation runs, and every value goes back.
    assert_eq!(
        world.accesses(),
        [
            "3.Application",
            "2.UserName",
            "2.Options",
            "1.UseLocalUserInfo",
            "2.UserInitials",
            "2.UserName=Str(\"Reviewer A\")",
            "2.UserInitials=Str(\"RA\")",
            "2.Options",
            "1.UseLocalUserInfo=Bool(true)",
            "3.TrackRevisions=Bool(true)",
            "3.TrackRevisions",
            "2.UserName=Str(\"Owner\")",
            "2.UserInitials=Str(\"OW\")",
            "2.Options",
            "1.UseLocalUserInfo=Bool(false)",
        ]
    );
}

#[test]
fn the_user_name_comes_back_when_the_operation_fails() {
    let world = World::new();
    let (app, _) = application(&world);
    let document = bare_document(&world, |document| document.child("Application", app.clone()));
    let error = operate(&document, r#"{"op":"set_header_footer","kind":"sideways","author":"Reviewer A"}"#).unwrap_err();
    // The section is asked for first, and Word here has none: that is the failure, and the name still goes back.
    assert!(!error.is_empty());
    assert!(world.accesses().iter().any(|line| line.ends_with("UserName=Str(\"Owner\")")), "{:?}", world.accesses());
}

#[test]
fn no_author_asks_word_for_no_user_name() {
    let world = World::new();
    let (app, _) = application(&world);
    let document = bare_document(&world, |document| document.child("Application", app.clone()).prop("TrackRevisions", Com::Bool(false)));
    operate(&document, r#"{"op":"track_changes","enabled":true,"author":"  "}"#).expect("the operation");
    assert!(world.accesses().iter().all(|line| !line.contains("UserName")), "{:?}", world.accesses());
}

// ---------------------------------------------------------------------------------------------------------------------
// Operations.

#[test]
fn track_changes_sets_the_flag_and_reads_it_back() {
    let world = World::new();
    let document = bare_document(&world, |document| document.prop("TrackRevisions", Com::Bool(false)));
    let result = operate(&document, r#"{"op":"track_changes","enabled":true}"#).expect("the operation");
    assert_eq!(json_of(&result), r#"{"op":"track_changes","changed":true,"enabled":true}"#);
    assert_eq!(world.accesses(), ["1.TrackRevisions=Bool(true)", "1.TrackRevisions"]);
}

#[test]
fn normalize_runs_changes_nothing_and_says_why() {
    let world = World::new();
    let document = bare_document(&world, |document| document);
    let result = operate(&document, r#"{"op":"normalize_runs"}"#).expect("the operation");
    assert!(json_of(&result).starts_with(r#"{"op":"normalize_runs","changed":false,"merged":0,"note":"Word searches text"#));
    assert!(world.accesses().is_empty());
}

fn section(world: &World) -> Obj {
    world.obj().prop("Index", Com::I4(1)).child("PageSetup", world.obj().child("TextColumns", world.obj().prop("Count", Com::I4(1)).build()).build()).build()
}

#[test]
fn header_and_footer_kinds_are_checked_before_anything_is_written() {
    let world = World::new();
    let sections = world.obj().items(vec![section(&world)]).build();
    let document = bare_document(&world, |document| document.child("Sections", sections.clone()));
    assert_eq!(
        operate(&document, r#"{"op":"set_header_footer","kind":"sideways","text":"x"}"#).unwrap_err(),
        "set_header_footer kind must be header, footer, default, first, or even"
    );
    assert_eq!(
        operate(&document, r#"{"op":"set_header_footer","kind":"header","variant":"third","text":"x"}"#).unwrap_err(),
        "set_header_footer variant must be default, first, or even"
    );
    assert!(world.accesses().iter().all(|line| !line.contains('=')), "nothing was written: {:?}", world.accesses());
}

#[test]
fn a_page_of_thirteen_columns_is_refused_and_one_of_two_is_spaced_by_default() {
    let world = World::new();
    let columns = world.obj().prop("Count", Com::I4(2)).method("SetCount", |_| Ok(Com::Null)).build();
    let setup = world.obj().child("TextColumns", columns).build();
    let section = world.obj().prop("Index", Com::I4(1)).child("PageSetup", setup).build();
    let sections = world.obj().items(vec![section]).build();
    let document = bare_document(&world, |document| document.child("Sections", sections.clone()));
    assert_eq!(operate(&document, r#"{"op":"set_page","properties":{"columns":13}}"#).unwrap_err(), "set_page columns must be a whole number from 1 to 12");
    world.clear();
    let result = operate(&document, r#"{"op":"set_page","section":1,"properties":{"columns":2}}"#).expect("the operation");
    assert_eq!(json_of(&result), r#"{"op":"set_page","changed":true,"section":1,"columns":2}"#);
    let log = world.accesses();
    assert!(log.iter().any(|line| line.ends_with("EvenlySpaced=I4(-1)")), "{log:?}");
    assert!(log.iter().any(|line| line.ends_with("Spacing=R4(35.4)")), "{log:?}");
}

#[test]
fn a_phrase_that_is_not_found_is_refused_for_a_comment() {
    let world = World::new();
    let find = world.obj().method("Execute", |_| Ok(Com::Bool(false))).build();
    let range = world.obj().child("Find", find).build();
    let content = world.obj().child("Duplicate", range).build();
    let document = bare_document(&world, |document| document.child("Content", content.clone()));
    assert_eq!(operate(&document, r#"{"op":"add_comment","find":"absent","text":"x"}"#).unwrap_err(), "Comment target not found: absent");
}

#[test]
fn a_comment_index_outside_the_collection_is_refused() {
    let world = World::new();
    let comments = world.obj().items(vec![]).build();
    let document = bare_document(&world, |document| document.child("Comments", comments.clone()));
    assert_eq!(operate(&document, r#"{"op":"add_comment_reply","comment":2,"text":"x"}"#).unwrap_err(), "Comment index out of range: 2");
    assert_eq!(operate(&document, r#"{"op":"delete_comment","comment":0}"#).unwrap_err(), "Comment index out of range: 0");
}

#[test]
fn a_blank_citation_is_refused_after_the_range_is_taken() {
    let world = World::new();
    let range = world.obj().prop("Start", Com::I4(0)).prop("End", Com::I4(5)).build();
    let duplicate = world.obj().child("Duplicate", range).build();
    let paragraphs = world.obj().items(vec![world.obj().child("Range", duplicate).build()]).build();
    let document = bare_document(&world, |document| document.child("Paragraphs", paragraphs.clone()));
    assert_eq!(
        operate(&document, r#"{"op":"add_provenance","paragraph":1,"citation":" "}"#).unwrap_err(),
        "add_provenance requires source with a document or label"
    );
}

fn revision(world: &World, author: &str, settled: &Rc<RefCell<Vec<String>>>, label: &'static str) -> Obj {
    let accept = settled.clone();
    let reject = settled.clone();
    world
        .obj()
        .prop("Author", text(author))
        .method("Accept", move |_| {
            accept.borrow_mut().push(format!("accept {label}"));
            Ok(Com::Null)
        })
        .method("Reject", move |_| {
            reject.borrow_mut().push(format!("reject {label}"));
            Ok(Com::Null)
        })
        .build()
}

#[test]
fn revisions_of_one_author_are_settled_one_by_one_from_the_last() {
    let world = World::new();
    let settled = Rc::new(RefCell::new(Vec::new()));
    let revisions = world.obj().items(vec![revision(&world, "A", &settled, "one"), revision(&world, "B", &settled, "two"), revision(&world, "A", &settled, "three")]).build();
    let application = world.obj().prop("UserName", text("Owner")).build();
    let document = bare_document(&world, |document| document.child("Application", application.clone()).child("Revisions", revisions.clone()));
    let result = operate(&document, r#"{"op":"resolve_revisions","author":"a","resolution":"reject"}"#).expect("the operation");
    assert_eq!(json_of(&result), r#"{"op":"resolve_revisions","changed":true,"resolved":2,"author":"a","resolution":"reject"}"#);
    assert_eq!(*settled.borrow(), ["reject three", "reject one"]);
}

#[test]
fn an_author_that_matches_nobody_gets_the_reviewers_listed() {
    let world = World::new();
    let settled = Rc::new(RefCell::new(Vec::new()));
    let revisions = world.obj().items(vec![revision(&world, "A", &settled, "one"), revision(&world, "B", &settled, "two"), revision(&world, "a", &settled, "three")]).build();
    let application = world.obj().prop("UserName", text("Owner")).build();
    let document = bare_document(&world, |document| document.child("Application", application.clone()).child("Revisions", revisions.clone()));
    let result = operate(&document, r#"{"op":"resolve_revisions","author":"Zed"}"#).expect("the operation");
    assert_eq!(
        json_of(&result),
        r#"{"op":"resolve_revisions","changed":false,"resolved":0,"author":"Zed","resolution":"accept","note":"No revision by \"Zed\"; the tracked changes are by \"A\", \"B\"."}"#
    );
    assert!(settled.borrow().is_empty());
}

#[test]
fn every_revision_is_settled_at_once_without_an_author() {
    let world = World::new();
    let all = Rc::new(RefCell::new(0));
    let accepted = all.clone();
    let revisions = world.obj().items(vec![world.obj().build(), world.obj().build()]).build();
    let document = bare_document(&world, |document| {
        document.child("Revisions", revisions.clone()).method("AcceptAllRevisions", move |_| {
            *accepted.borrow_mut() += 1;
            Ok(Com::Null)
        })
    });
    let result = operate(&document, r#"{"op":"resolve_revisions","resolution":"accept"}"#).expect("the operation");
    assert_eq!(json_of(&result), r#"{"op":"resolve_revisions","changed":true,"resolved":2,"resolution":"accept"}"#);
    assert_eq!(*all.borrow(), 1);
}

// ---------------------------------------------------------------------------------------------------------------------
// replace_text.

#[test]
fn replace_text_rewrites_only_the_words_past_the_shared_edges_and_resumes_after_the_edit() {
    let world = World::new();
    // The document is "the old way": one match at 0..11, and the search resumed after the edit finds nothing more.
    let searches = Rc::new(Cell::new(0));
    let first_search = searches.clone();
    let find = world
        .obj()
        .method("Execute", move |args| {
            assert_eq!(args.len(), 8);
            first_search.set(first_search.get() + 1);
            Ok(Com::Bool(true))
        })
        .build();
    let range = world.obj().child("Find", find).prop("Start", Com::I4(0)).prop("End", Com::I4(11)).build();
    let content = world.obj().prop("End", Com::I4(11)).child("Duplicate", range).build();
    let last_search = searches.clone();
    let resumed_find = world
        .obj()
        .method("Execute", move |_| {
            last_search.set(last_search.get() + 10);
            Ok(Com::Bool(false))
        })
        .build();
    let resumed = world.obj().child("Find", resumed_find).build();
    let target = world.obj().build();
    let document = bare_document(&world, |document| {
        document.child("Content", content.clone()).prop("TrackRevisions", Com::Bool(false)).method("Range", move |args| match args.first() {
            Some(Com::I4(11)) => Ok(Com::Dispatch(resumed.clone())),
            _ => Ok(Com::Dispatch(target.clone())),
        })
    });
    let result = operate(&document, r#"{"op":"replace_text","find":"the old way","replace":"the new way"}"#).expect("the operation");
    assert_eq!(json_of(&result), r#"{"op":"replace_text","changed":true,"count":1}"#);
    let log = world.accesses();
    // The edit covers "old" alone: 4 characters in from the start and 4 from the end.
    assert!(log.iter().any(|line| line.ends_with("Range(I4(4),I4(7))")), "{log:?}");
    assert!(log.iter().any(|line| line.ends_with("Text=Str(\"new\")")), "{log:?}");
    // The search resumes where the edit ended: the tail of the document from offset 11.
    assert!(log.iter().any(|line| line.ends_with("Range(I4(11),I4(11))")), "{log:?}");
    assert_eq!(searches.get(), 11, "one match, then the resumed search that finds nothing");
}

#[test]
fn replace_text_needs_something_to_find() {
    let world = World::new();
    let document = bare_document(&world, |document| document);
    assert_eq!(operate(&document, r#"{"op":"replace_text","find":"","replace":"x"}"#).unwrap_err(), "replace_text requires non-empty find");
}

// ---------------------------------------------------------------------------------------------------------------------
// Tables.

fn table_of(world: &World, rows: i32, columns: i32, first_cell: &str) -> Obj {
    let cell = world.obj().child("Range", world.obj().prop("Text", text(first_cell)).build()).build();
    world
        .obj()
        .prop("Index", Com::I4(1))
        .child("Rows", world.obj().prop("Count", Com::I4(rows)).build())
        .child("Columns", world.obj().prop("Count", Com::I4(columns)).build())
        .method("Cell", move |_| Ok(Com::Dispatch(cell.clone())))
        .build()
}

#[test]
fn a_table_that_does_not_exist_is_listed_with_the_ones_that_do() {
    let world = World::new();
    let tables = world.obj().items(vec![table_of(&world, 2, 3, "Region\r\u{7}")]).build();
    let document = bare_document(&world, |document| document.child("Tables", tables.clone()));
    assert_eq!(
        operate(&document, r#"{"op":"set_table_cell","table":5,"row":1,"col":1,"text":"x"}"#).unwrap_err(),
        "DOCX table 5 not found: the document holds 1 table(s) (1: 2\u{D7}3 starting \"Region\")"
    );
}

#[test]
fn a_row_that_does_not_exist_is_named_with_the_tables_size() {
    let world = World::new();
    let tables = world.obj().items(vec![table_of(&world, 2, 2, "a\rb\u{7}")]).build();
    let document = bare_document(&world, |document| document.child("Tables", tables.clone()));
    assert_eq!(
        operate(&document, r#"{"op":"insert_table_row","table":1,"row":9}"#).unwrap_err(),
        "DOCX table 1 is 2\u{D7}2 starting \"a b\", so it has no row 9: insert_table_row row is the position the new row takes, 1 to 3 (3 adds it at the end)"
    );
    assert_eq!(
        operate(&document, r#"{"op":"delete_table_column","table":1,"column":3}"#).unwrap_err(),
        "DOCX table 1 is 2\u{D7}2 starting \"a b\", so it has no column 3"
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// Appended runs.

fn queue_of(texts: &[&str]) -> Vec<Value> {
    texts.iter().map(|body| payload::parse_payload(body).expect("an operation")).collect()
}

fn run_length(document: &Obj, queue: &[Value], position: usize) -> usize {
    let platform = FakePlatform::new();
    let applications = ScriptedApplications::new();
    let mut chart_excel = ChartExcel::default();
    let mut context = EditContext { env: Env { platform: &platform, applications: &applications }, chart_excel: &mut chart_excel };
    Editor.append_run_length(&mut context, document, queue, position).expect("a length")
}

#[test]
fn plain_appends_form_one_run_and_a_tracked_or_labelled_one_stands_alone() {
    let world = World::new();
    let untracked = bare_document(&world, |document| document.prop("TrackRevisions", Com::Bool(false)));
    let tracked = bare_document(&world, |document| document.prop("TrackRevisions", Com::Bool(true)));
    let queue = queue_of(&[
        r#"{"op":"append_text","text":"a"}"#,
        r#"{"op":"append_text","text":"b","style":"Quote"}"#,
        r#"{"op":"append_text","text":"c"}"#,
        r#"{"op":"append_text","text":"d","author":"X"}"#,
        r#"{"op":"append_text","text":"e"}"#,
    ]);
    assert_eq!(run_length(&untracked, &queue, 0), 3);
    assert_eq!(run_length(&untracked, &queue, 3), 1);
    assert_eq!(run_length(&untracked, &queue, 4), 1, "the last one has nothing after it");
    assert_eq!(run_length(&tracked, &queue, 0), 1);
    let breaking = queue_of(&[r#"{"op":"append_text","text":"a\nb"}"#, r#"{"op":"append_text","text":"c"}"#]);
    assert_eq!(run_length(&untracked, &breaking, 0), 1);
}

// ---------------------------------------------------------------------------------------------------------------------
// fill_template.

#[test]
fn a_template_is_filled_by_story_and_counted_by_matches() {
    let world = World::new();
    let find = world
        .obj()
        .method("Execute", |args| {
            assert_eq!(args.len(), 11);
            Ok(Com::Bool(true))
        })
        .build();
    let search = world.obj().child("Find", find).build();
    // The story's range never changes in this model, so the tokens still in it are the ones Word would not have replaced.
    let copy = world.obj().prop("Text", text("{{a}} and {{a}} and {{ b }}")).child("Duplicate", search).build();
    let story = world.obj().child("Duplicate", copy).prop("NextStoryRange", Com::Null).build();
    let story_ranges = world
        .obj()
        .method("Item", move |args| match args.first() {
            Some(Com::I4(1)) => Ok(Com::Dispatch(story.clone())),
            _ => Err(failure("This story does not exist.", false)),
        })
        .build();
    let document = bare_document(&world, |document| document.child("StoryRanges", story_ranges.clone()));
    let result = operate(&document, r#"{"op":"fill_template","tokens":{"a":"x"}}"#).expect("the operation");
    assert_eq!(json_of(&result), r#"{"op":"fill_template","changed":true,"filled":{"a":2},"unfilledTokens":["a","b"],"strict":false}"#);
}

#[test]
fn a_template_without_tokens_is_refused() {
    let world = World::new();
    let document = bare_document(&world, |document| document);
    assert_eq!(operate(&document, r#"{"op":"fill_template"}"#).unwrap_err(), "fill_template requires tokens as an object");
}

// ---------------------------------------------------------------------------------------------------------------------
// Content controls.

#[test]
fn a_locked_content_control_is_refused_and_an_absent_one_is_named() {
    let world = World::new();
    let locked = world.obj().prop("Tag", text("name")).prop("LockContents", Com::Bool(true)).build();
    let controls = world.obj().items(vec![locked]).build();
    let document = bare_document(&world, |document| document.child("ContentControls", controls.clone()));
    assert_eq!(operate(&document, r#"{"op":"set_content_control","tag":"NAME","text":"x"}"#).unwrap_err(), "DOCX content control NAME is locked for editing");
    assert_eq!(operate(&document, r#"{"op":"set_content_control","tag":"other","text":"x"}"#).unwrap_err(), "DOCX content control not found for tag: other");
    assert_eq!(operate(&document, r#"{"op":"set_content_control","control":4,"text":"x"}"#).unwrap_err(), "DOCX content control 4 not found");
}

// ---------------------------------------------------------------------------------------------------------------------
// The recordings of the PowerShell host.

#[test]
fn every_recorded_word_edit_fixture_is_listed_and_readable() {
    // `tests/fixtures/word-edit/<scenario>.json` is written by `recorder/record-office-com.mjs --area word-edit` on a PC with
    // Microsoft Word, and the manifest lists it; until that has been run the manifest lists none and this holds nothing.
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures");
    let manifest: serde_json::Value = serde_json::from_str(&mixdog_testkit::read_string(fixtures.join("MANIFEST.json"))).expect("the manifest");
    for entry in manifest["fixtures"].as_array().expect("fixtures").iter().filter(|entry| entry["area"] == "word-edit") {
        let path = fixtures.join(entry["path"].as_str().expect("a path"));
        let recording: serde_json::Value = serde_json::from_str(&mixdog_testkit::read_string(&path)).expect("a recording");
        assert!(recording["steps"].is_array(), "{}", path.display());
    }
}

#[test]
fn every_scenario_of_the_recorder_is_a_scenario_with_steps() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("scenarios").join("word-edit.json");
    let spec: serde_json::Value = serde_json::from_str(&mixdog_testkit::read_string(path)).expect("the scenario file");
    assert_eq!(spec["area"], "word-edit");
    let scenarios = spec["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() >= 10);
    for scenario in scenarios {
        assert!(scenario["id"].is_string() && scenario["steps"].as_array().is_some_and(|steps| !steps.is_empty()), "{scenario}");
    }
    // Each of the 41 operations is exercised by some scenario.
    let text = spec.to_string();
    let registry = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("registry").join("operations.json");
    let registry: serde_json::Value = serde_json::from_str(&mixdog_testkit::read_string(registry)).expect("the registry");
    for name in registry["operations"]["docx"].as_array().expect("the docx list") {
        let name = name.as_str().expect("a name");
        assert!(text.contains(&format!("\"op\":\"{name}\"")), "no scenario runs {name}");
    }
}
