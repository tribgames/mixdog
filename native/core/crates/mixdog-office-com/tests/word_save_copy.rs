//! Word has no copy command, so its save-copy saves the document where it is and copies the file: the session stays on its own
//! target, and a later edit and save land there and not in the copy.

use std::any::Any;
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use mixdog_fsio::Unlaned;
use mixdog_office_com::actions::document::save_document_copy;
use mixdog_office_com::com::Call;
use mixdog_office_com::com::ComError;
use mixdog_office_com::com::ComObject;
use mixdog_office_com::com::ItemSource;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::Value as Com;

/// A Word document that lives in a file: `Save` writes what it holds there, `FullName` names the file.
struct Document {
    path: PathBuf,
    content: RefCell<String>,
    saves: RefCell<Vec<String>>,
}

impl ComObject for Document {
    fn invoke(&self, call: &Call<'_>) -> Result<Com, ComError> {
        match call.member {
            "Save" => {
                mixdog_fsio::write(&Unlaned, &self.path, self.content.borrow().as_bytes()).expect("the document file");
                self.saves.borrow_mut().push(self.content.borrow().clone());
                Ok(Com::Null)
            }
            "FullName" => Ok(Com::Str(self.path.display().to_string())),
            other => Err(ComError { hresult: -1, inner_hresult: -1, message: format!("unknown member {other}"), inner_message: String::new(), unknown_member: true }),
        }
    }

    fn enum_open(&self) -> Result<Box<dyn ItemSource>, ComError> {
        unreachable!("no collection")
    }

    fn same_object(&self, _other: &dyn ComObject) -> bool {
        false
    }

    fn identity_key(&self) -> String {
        "document".to_owned()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

fn text(path: &PathBuf) -> String {
    String::from_utf8(mixdog_fsio::read(&Unlaned, path).expect("a file")).expect("text")
}

#[test]
fn a_word_copy_is_the_saved_document_and_the_session_stays_on_its_own_file() {
    let folder = std::env::temp_dir().join(format!("mixdog-word-save-copy-{}", std::process::id()));
    mixdog_fsio::create_dir_all(&Unlaned, &folder).expect("folder");
    let (original, copy) = (folder.join("report.docx"), folder.join("report-copy.docx"));
    let document = Rc::new(Document { path: original.clone(), content: RefCell::new("first".to_owned()), saves: RefCell::new(Vec::new()) });
    let handle = Obj::new(document.clone());

    save_document_copy(&handle, "docx", &copy.display().to_string()).expect("the copy");
    assert_eq!((text(&copy), text(&original)), ("first".to_owned(), "first".to_owned()));

    // A later edit and save land in the session's own file; the copy is what it was.
    *document.content.borrow_mut() = "second".to_owned();
    handle.call("Save", &[]).expect("the session saves");
    assert_eq!((text(&original), text(&copy)), ("second".to_owned(), "first".to_owned()));
    assert_eq!(*document.saves.borrow(), ["first", "second"]);
    mixdog_fsio::remove_dir_all(&Unlaned, &folder).expect("clean up");
}
