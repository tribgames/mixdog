//! Writing the template index: what it holds for a small template set, that an unchanged set is not rewritten, and what a
//! damaged index or an unreadable template does.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_fsio::Unlaned;
use mixdog_office_design::library::core::{Environment, LibraryConfig, load_config};
use mixdog_office_design::templates::index_office_templates;
use ring::digest::{SHA256, digest};
use serde_json::{Value, json};

fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes).as_ref().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn executive() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/templates/mixdog-executive.pptx")
}

struct World {
    root: tempfile::TempDir,
    env: Environment,
    templates: PathBuf,
}

impl World {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("tempdir");
        let templates = root.path().join("mine");
        std::fs::create_dir_all(&templates).expect("folder");
        let env = Environment {
            library_config: String::new(),
            pack_url: String::new(),
            pack_key_id: String::new(),
            pack_public_key: String::new(),
            template_dirs: String::new(),
            windows: false,
            program_files: String::new(),
            program_files_x86: String::new(),
            app_data: String::new(),
            home: String::new(),
            cwd: root.path().to_path_buf(),
            bundled_templates: root.path().join("bundled"),
            now_ms: Arc::new(|| 1_700_000_000_000.0),
        };
        Self { root, env, templates }
    }

    fn data(&self) -> PathBuf {
        self.root.path().join("data")
    }

    fn index_file(&self) -> PathBuf {
        self.data().join("office").join("design-library").join("template-index.json")
    }

    fn config(&self) -> LibraryConfig {
        let source = json!({ "templateDirectories": [self.templates.to_string_lossy()], "discoverInstalledTemplates": false });
        load_config(&Unlaned, &self.env, &self.data(), Some(&source)).expect("a config")
    }

    fn index(&self) -> Result<Value, String> {
        index_office_templates(&Unlaned, &self.env, &self.data(), &self.config())
    }

    fn add(&self, name: &str) -> PathBuf {
        let path = self.templates.join(name);
        std::fs::copy(executive(), &path).expect("copy the deck");
        path
    }

    fn written(&self) -> String {
        std::fs::read_to_string(self.index_file()).expect("the index file")
    }
}

fn entry<'a>(index: &'a Value, id: &str) -> &'a Value {
    index["templates"].as_array().expect("templates").iter().find(|entry| entry["id"] == id).unwrap_or_else(|| panic!("no template {id} in {index}"))
}

#[test]
fn each_template_file_is_an_entry_with_its_digest_its_sidecar_and_what_the_inspector_read() {
    let world = World::new();
    let deck_a = world.add("a.pptx");
    std::fs::write(format!("{}.mixdog.json", deck_a.display()), r#"{ "id": "deck-a", "label": "Deck A", "version": "2.0.0" }"#).expect("sidecar");
    world.add("b.pptx");
    let bytes = std::fs::read(executive()).expect("deck");
    let digest = sha256_hex(&bytes);

    let index = world.index().expect("indexed");
    assert_eq!((index["count"].clone(), index["changed"].clone()), (json!(2), json!(true)));
    let ids: Vec<&str> = index["templates"].as_array().expect("templates").iter().map(|entry| entry["id"].as_str().expect("id")).collect();
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0], "deck-a");
    assert!(ids[1].starts_with("local-") && ids[1].len() == "local-".len() + 16, "an unnamed template is named after its path: {ids:?}");

    let named = entry(&index, "deck-a");
    assert_eq!(named["label"], "Deck A");
    assert_eq!((named["format"].clone(), named["fileKind"].clone(), named["source"].clone()), (json!("pptx"), json!("pptx"), json!("local-template")));
    assert_eq!(named["sha256"], json!(digest));
    assert_eq!(named["bytes"], json!(bytes.len()));
    assert_eq!(named["version"], json!(format!("2.0.0+{}", &digest[..12])), "the declared version carries the file's digest");
    assert_eq!(named["inspectionVersion"], 4);
    assert_eq!(named["inspectionWarning"], "");
    assert!(!named["sampleSlides"].as_array().expect("sample slides").is_empty(), "the inspector read the deck's slides");

    let plain = entry(&index, ids[1]);
    assert_eq!(plain["label"], "b.pptx", "a template with no label is known by its file name");
    assert_eq!(plain["version"], json!(&digest[..16]), "with no declared version it is the digest");
}

#[test]
fn the_index_is_written_once_for_a_set_and_not_again_while_nothing_in_it_changes() {
    let world = World::new();
    world.add("a.pptx");
    let first = world.index().expect("indexed");
    let on_disk = world.written();
    let stored: Value = serde_json::from_str(&on_disk).expect("json");
    assert_eq!((stored["revision"].clone(), stored["templates"].clone()), (first["revision"].clone(), first["templates"].clone()));
    assert!(stored.get("changed").is_none() && stored.get("count").is_none(), "the answer's own fields are not stored");

    let second = world.index().expect("indexed again");
    assert_eq!((second["changed"].clone(), second["count"].clone(), second["revision"].clone()), (json!(false), json!(1), first["revision"].clone()));
    assert_eq!(second["templates"], first["templates"], "the entry is reused, not inspected again");
    assert_eq!(world.written(), on_disk, "an unchanged set leaves the file alone");

    world.add("c.pptx");
    let third = world.index().expect("with a third template");
    assert_eq!((third["changed"].clone(), third["count"].clone()), (json!(true), json!(2)));
    assert_ne!(third["revision"], first["revision"]);
    assert!(third["templates"].as_array().expect("templates").iter().any(|entry| first["templates"][0] == *entry), "the first template's entry is kept as it was");
}

#[test]
fn a_damaged_index_is_indexed_again_from_the_files_and_rewritten_whole() {
    let world = World::new();
    world.add("a.pptx");
    let first = world.index().expect("indexed");
    std::fs::write(world.index_file(), "{ this is not json").expect("damage");
    let again = world.index().expect("indexed again");
    assert_eq!(again["changed"], true);
    assert_eq!(again["templates"], first["templates"]);
    let stored: Value = serde_json::from_str(&world.written()).expect("a whole index again");
    assert_eq!(stored["revision"], first["revision"]);
}

#[test]
fn an_index_whose_shape_is_wrong_is_refused_with_the_reason_instead_of_being_overwritten() {
    let world = World::new();
    world.add("a.pptx");
    world.index().expect("indexed");
    std::fs::write(world.index_file(), r#"{ "revision": "x", "templates": 5 }"#).expect("damage");
    assert_eq!(world.index().unwrap_err(), "(previous.templates || []).map is not a function");
    std::fs::write(world.index_file(), r#"{ "revision": "x", "templates": [{}] }"#).expect("damage");
    assert_eq!(world.index().unwrap_err(), "The \"path\" argument must be of type string. Received undefined");
    assert!(world.written().contains("\"templates\": [{}]"), "a refused index call leaves the file as it found it");
}

#[test]
fn a_template_the_inspector_cannot_read_is_listed_with_a_warning_and_no_slides() {
    let world = World::new();
    std::fs::write(world.templates.join("broken.pptx"), "not a package").expect("a broken deck");
    let index = world.index().expect("indexed");
    assert_eq!(index["count"], 1);
    let broken = index["templates"][0].clone();
    assert_eq!(broken["label"], "broken.pptx");
    assert!(broken["inspectionWarning"].as_str().is_some_and(|warning| !warning.is_empty()), "{broken}");
    assert_eq!(broken["sampleSlides"], json!([]));
    assert_eq!(broken["sha256"], json!(sha256_hex(b"not a package")));
}

#[test]
fn a_folder_with_no_templates_gives_an_empty_index_and_a_missing_folder_is_not_an_error() {
    let world = World::new();
    let empty = world.index().expect("indexed");
    assert_eq!((empty["count"].clone(), empty["templates"].clone()), (json!(0), json!([])));
    std::fs::remove_dir_all(&world.templates).expect("remove the folder");
    assert_eq!(world.index().expect("indexed again")["count"], 0);
}
