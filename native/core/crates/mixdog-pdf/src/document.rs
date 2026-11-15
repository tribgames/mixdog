//! pdf.js's `PDFDocument` and `Catalog` as far as the read path needs them: opening a file (header, `startxref`,
//! cross-reference data, decryption, the first and the last page checked as `checkFirstPage` and `checkLastPage`
//! do, with the rebuild of the table when an entry leads nowhere), the page count (the `/Count` of the page tree, the
//! linearization's `N`, or what a walk of the whole tree found when `/Count` is wrong) and the page tree itself:
//! `Kids` walked with a cache of the page counts below each node, loop detection, and the page dictionaries
//! [`Document::page`] turns into a [`Page`].

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::codec_glue::{CodecDecryptorFactory, CodecFilters};
use crate::error::{Budget, CancelCheck, Guard, PdfError, Result};
use crate::object::{Dict, Obj, Ref};
use crate::page::Page;
use crate::xref::{Xref, XrefOptions};

/// What [`Document::open`] is given besides the bytes: the password, the cancellation and the bounds, and the options
/// of the reference configuration (pdf.js's `useSystemFonts: true`, `disableFontFace: true`, `ignoreErrors`, which is
/// pdf.js's default). The cMaps and the standard font data are always available (the font tasks embed them).
#[derive(Clone)]
pub struct OpenOptions {
    /// The password of an encrypted file. Without one (or with an empty one) the empty user password is tried; a
    /// password that is given is the only one tried, as in pdf.js (a wrong one is `Incorrect Password`).
    pub password: Option<String>,
    pub cancel: Option<CancelCheck>,
    pub budget: Budget,
    /// pdf.js's `ignoreErrors` (`!stopAtErrors`): a damaged sub-stream of a page's contents is skipped, the first
    /// page of a rebuilt document is replaced by an empty one when it cannot be read.
    pub ignore_errors: bool,
    pub use_system_fonts: bool,
    pub disable_font_face: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions {
            password: None,
            cancel: None,
            budget: Budget::default(),
            ignore_errors: true,
            use_system_fonts: true,
            disable_font_face: true,
        }
    }
}

/// The exception pdf.js's worker reports for a failure (`wrapReason`): `PasswordException` and
/// `InvalidPDFException` keep their name, `AbortException` too, everything else is an `UnknownErrorException`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exception {
    pub name: &'static str,
    /// The `PasswordException` code (1 `No password given`, 2 `Incorrect Password`).
    pub code: Option<u8>,
    pub message: String,
}

/// `wrapReason`.
pub fn wrap_reason(error: &PdfError) -> Exception {
    let (name, code) = match error {
        PdfError::Password { code, .. } => ("PasswordException", Some(*code)),
        PdfError::InvalidPdf(_) => ("InvalidPDFException", None),
        PdfError::Cancelled => ("AbortException", None),
        _ => ("UnknownErrorException", None),
    };
    Exception {
        name,
        code,
        message: error.message().to_owned(),
    }
}

/// Where a page's dictionary was found: the dictionary and, when it was reached by a reference, that reference.
#[derive(Debug, Clone)]
struct PageSource {
    dict: Arc<Dict>,
    reference: Option<Ref>,
}

type Slot = Result<PageSource>;

/// The `Catalog` caches and the pages found so far (`#pagePromises`, including the failures).
#[derive(Default)]
struct State {
    pages: HashMap<usize, Slot>,
    /// `#actualNumPages`: set by `checkLastPage` after a walk of the whole tree.
    actual_num_pages: Option<i64>,
    /// `pageKidsCountCache`: the number of pages below a node, by `ref.toString()`.
    kids_count: HashMap<String, i64>,
}

/// An open PDF file.
pub struct Document {
    xref: Xref,
    options: OpenOptions,
    state: RefCell<State>,
    num_pages: i64,
    doc_id: String,
}

/// pdf.js's `getDocument` numbering of the documents of a process (`d0`, `d1`, ...): the loaded name of a font is made
/// from it (`g_d1_f2`), so what a document names its fonts depends on how many were opened before it.
static NEXT_DOCUMENT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl Document {
    /// This document's id: `d` and its number among the documents opened by the process.
    pub fn doc_id(&self) -> &str {
        &self.doc_id
    }

    /// Opens `bytes`: the header and the cross-reference data, the decryption with `options.password`, then the
    /// checks of the first and last page (`PDFManager.initDocument`). A table that cannot be used, or an entry
    /// that leads to another object, makes the reader index the whole file and check again (`loadDocument(true)`).
    /// Failures are pdf.js's exceptions: [`wrap_reason`] gives their name, code and message.
    pub fn open(bytes: impl Into<Arc<[u8]>>, options: &OpenOptions) -> Result<Document> {
        let doc_id = format!("d{}", NEXT_DOCUMENT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let guard = Guard::new(options.cancel.clone(), options.budget);
        let xref = Xref::open(
            bytes.into(),
            XrefOptions {
                filters: Arc::new(CodecFilters),
                decryptor: Some(Arc::new(CodecDecryptorFactory::new(
                    options.password.clone(),
                    options.budget.max_bytes,
                ))),
                guard,
            },
        )?;
        let mut document = Document {
            xref,
            options: options.clone(),
            state: RefCell::new(State::default()),
            num_pages: 0,
            doc_id,
        };
        match document.init(false) {
            Ok(()) => {}
            Err(PdfError::XRefParse) => {
                document.xref.rebuild()?;
                document.init(true)?;
            }
            Err(e) => return Err(e),
        }
        document.num_pages = document.count_pages()?;
        Ok(document)
    }

    /// `numPages`.
    pub fn num_pages(&self) -> i64 {
        self.num_pages
    }

    /// The page at `index` (0-based). A failure is the one pdf.js's `getPage` has: the page tree is circular, a
    /// kid is no dictionary, the index is not in the tree. The same failure comes back on every call.
    pub fn page(&self, index: usize) -> Result<Page> {
        let source = self.page_source(index)?;
        Page::new(self, index, source.dict, source.reference)
    }

    /// The cross-reference table and the object fetching of this document.
    pub fn xref(&self) -> &Xref {
        &self.xref
    }

    pub fn options(&self) -> &OpenOptions {
        &self.options
    }

    /// The cancellation and bounds of this document's reader.
    pub fn guard(&self) -> &Arc<Guard> {
        self.xref.guard()
    }

    // ---- opening ------------------------------------------------------------------------------------------------

    /// `initDocument` after the cross-reference data is read.
    fn init(&self, recovery_mode: bool) -> Result<()> {
        self.check_first_page(recovery_mode)?;
        self.check_last_page(recovery_mode)
    }

    /// `PDFDocument.numPages`.
    fn count_pages(&self) -> Result<i64> {
        if let Some(actual) = self.state.borrow().actual_num_pages {
            return Ok(actual);
        }
        if let Some(linearization) = self.xref.linearization() {
            return Ok(linearization.num_pages);
        }
        self.pages_count()
    }

    /// `checkFirstPage`.
    fn check_first_page(&self, recovery_mode: bool) -> Result<()> {
        if recovery_mode {
            return Ok(());
        }
        match self.page_source(0) {
            Err(PdfError::XRefEntry(_)) => {
                self.state.borrow_mut().pages.remove(&0);
                self.cleanup();
                Err(PdfError::XRefParse)
            }
            Err(e) if e.is_fatal() => Err(e),
            _ => Ok(()),
        }
    }

    /// `checkLastPage`: reads the last page the count promises; when that fails the whole tree is walked and the
    /// pages found are what the document has.
    fn check_last_page(&self, recovery_mode: bool) -> Result<()> {
        self.state.borrow_mut().actual_num_pages = None;
        let mut last = None;
        let attempt = self.read_last_page(&mut last);
        let Err(reason) = attempt else {
            return Ok(());
        };
        if reason.is_fatal() {
            return Err(reason);
        }
        if let Some(last) = last {
            self.state
                .borrow_mut()
                .pages
                .remove(&usize::try_from(last).unwrap_or(usize::MAX));
        }
        self.cleanup();
        if matches!(reason, PdfError::XRefEntry(_)) && !recovery_mode {
            return Err(PdfError::XRefParse);
        }
        tracing::warn!(
            "checkLastPage - invalid /Pages tree /Count: {}.",
            last.map_or_else(|| "undefined".to_owned(), |n| (n + 1).to_string())
        );
        let pages = match self.all_page_dicts(recovery_mode) {
            Ok(pages) => pages,
            Err(e) if e.is_fatal() => return Err(e),
            Err(PdfError::XRefEntry(_)) if !recovery_mode => return Err(PdfError::XRefParse),
            Err(_) => {
                self.state.borrow_mut().actual_num_pages = Some(1);
                return Ok(());
            }
        };
        let mut state = self.state.borrow_mut();
        state.actual_num_pages = Some(i64::try_from(pages.len()).unwrap_or(i64::MAX));
        for (index, slot) in pages.into_iter().enumerate() {
            state.pages.insert(index, slot);
        }
        Ok(())
    }

    /// The `try` of `checkLastPage`: `last` is the index of the page the count promises, once it is known.
    fn read_last_page(&self, last: &mut Option<i64>) -> Result<()> {
        let counted = self.pages_count()?;
        let num_pages = match self.xref.linearization() {
            Some(linearization) => linearization.num_pages,
            None => counted,
        };
        if num_pages <= 1 {
            return Ok(());
        }
        *last = Some(num_pages - 1);
        self.page_source(usize::try_from(num_pages - 1).unwrap_or(usize::MAX))
            .map(|_| ())
    }

    /// `Catalog.cleanup`, the part that matters here.
    fn cleanup(&self) {
        self.state.borrow_mut().kids_count.clear();
    }

    // ---- the catalog --------------------------------------------------------------------------------------------

    /// The catalog dictionary (`xref.getCatalogObj()`).
    fn root(&self) -> Result<Arc<Dict>> {
        self.xref
            .root()
            .ok_or_else(|| PdfError::format("Catalog object is not a dictionary."))
    }

    /// `toplevelPagesDict`.
    fn toplevel_pages_dict(&self) -> Result<Arc<Dict>> {
        let root = self.root()?;
        match self.xref.get(&root, "Pages")? {
            Obj::Dict(pages) => Ok(pages),
            _ => Err(PdfError::format("Invalid top-level pages dictionary.")),
        }
    }

    /// `_pagesCount`: the `/Count` of the top-level pages dictionary.
    fn pages_count(&self) -> Result<i64> {
        let pages = self.toplevel_pages_dict()?;
        self.xref
            .get(&pages, "Count")?
            .as_int()
            .ok_or_else(|| {
                PdfError::format("Page count in top-level pages dictionary is not an integer.")
            })
    }

    /// `fetchIfRef` of a raw dictionary value; a missing key is `null`.
    fn resolve(&self, raw: Option<&Obj>) -> Result<Obj> {
        match raw {
            Some(Obj::Ref(r)) => self.xref.fetch(*r, false),
            Some(other) => Ok(other.clone()),
            None => Ok(Obj::Null),
        }
    }

    /// `isName(type, "Page") || !node.has("Kids")`: whether `node` is a page and not an inner node of the tree.
    fn is_page(&self, node: &Dict) -> Result<bool> {
        Ok(self.resolve(node.get_raw("Type"))?.is_name("Page") || !node.has("Kids"))
    }

    // ---- pages --------------------------------------------------------------------------------------------------

    /// `getPage`: the page's dictionary, found once and kept (a failure too).
    fn page_source(&self, index: usize) -> Slot {
        if let Some(slot) = self.state.borrow().pages.get(&index) {
            return slot.clone();
        }
        let found = self.find_page(index);
        if !matches!(&found, Err(e) if e.is_fatal()) {
            self.state.borrow_mut().pages.insert(index, found.clone());
        }
        found
    }

    fn find_page(&self, index: usize) -> Slot {
        if let Some(linearization) = self.xref.linearization()
            && usize::try_from(linearization.page_first) == Ok(index)
        {
            return self.linearization_page(index, linearization.object_number_first);
        }
        self.page_dict(i64::try_from(index).unwrap_or(i64::MAX))
    }

    /// `#getLinearizationPage`: the first page is the object the linearization dictionary names.
    fn linearization_page(&self, index: usize, object_number_first: i64) -> Slot {
        let reference = Ref::new(object_number_first, 0);
        match self.read_linearization_page(reference) {
            Err(e) if !e.is_fatal() => {
                tracing::warn!("_getLinearizationPage: \"{}\".", e.message());
                self.page_dict(i64::try_from(index).unwrap_or(i64::MAX))
            }
            other => other,
        }
    }

    /// The `try` of `#getLinearizationPage`.
    fn read_linearization_page(&self, reference: Ref) -> Slot {
        if let Obj::Dict(dict) = self.xref.fetch(reference, false)? {
            let is_page = self.resolve(dict.get_raw("Type"))?.is_name("Page")
                || (!dict.has("Type") && !dict.has("Kids") && dict.has("Contents"));
            if is_page {
                self.state
                    .borrow_mut()
                    .kids_count
                    .entry(reference.to_string())
                    .or_insert(1);
                return Ok(PageSource {
                    dict,
                    reference: Some(reference),
                });
            }
        }
        Err(PdfError::format(
            "The Linearization dictionary doesn't point to a valid Page dictionary.",
        ))
    }

    /// `Catalog.getPageDict`: walks the tree to the page at `index`, skipping the subtrees whose page count is
    /// known and lies before it.
    fn page_dict(&self, index: i64) -> Slot {
        let top = self.toplevel_pages_dict()?;
        let root = self.root()?;
        let mut visited: HashSet<String> = HashSet::new();
        if let Some(Obj::Ref(pages)) = root.get_raw("Pages") {
            visited.insert(pages.to_string());
        }
        let mut nodes: Vec<Obj> = vec![Obj::Dict(top)];
        let mut current: i64 = 0;
        while let Some(node) = nodes.pop() {
            self.xref.guard().tick()?;
            match node {
                Obj::Ref(reference) => {
                    let key = reference.to_string();
                    let known = self.state.borrow().kids_count.get(&key).copied();
                    if let Some(count) = known
                        && count >= 0
                        && current.saturating_add(count) <= index
                    {
                        current = current.saturating_add(count);
                        continue;
                    }
                    if !visited.insert(key.clone()) {
                        return Err(PdfError::format("Pages tree contains circular reference."));
                    }
                    let obj = self.xref.fetch(reference, false)?;
                    if let Obj::Dict(dict) = &obj
                        && self.is_page(dict)?
                    {
                        self.state
                            .borrow_mut()
                            .kids_count
                            .entry(key)
                            .or_insert(1);
                        if current == index {
                            return Ok(PageSource {
                                dict: dict.clone(),
                                reference: Some(reference),
                            });
                        }
                        current += 1;
                        continue;
                    }
                    nodes.push(obj);
                }
                Obj::Dict(dict) => {
                    let count = self.resolve(dict.get_raw("Count"))?;
                    if let Some(count) = count.as_int()
                        && count >= 0
                    {
                        if let Some(id) = &dict.obj_id {
                            self.state
                                .borrow_mut()
                                .kids_count
                                .entry(id.clone())
                                .or_insert(count);
                        }
                        if current.saturating_add(count) <= index {
                            current = current.saturating_add(count);
                            continue;
                        }
                    }
                    let Obj::Array(kids) = self.resolve(dict.get_raw("Kids"))? else {
                        if self.is_page(&dict)? {
                            if current == index {
                                return Ok(PageSource {
                                    dict,
                                    reference: None,
                                });
                            }
                            current += 1;
                            continue;
                        }
                        return Err(PdfError::format(
                            "Page dictionary kids object is not an array.",
                        ));
                    };
                    nodes.extend(kids.iter().rev().cloned());
                }
                _ => {
                    return Err(PdfError::format(
                        "Page dictionary kid reference points to wrong type of object.",
                    ));
                }
            }
        }
        Err(PdfError::Unknown(format!("Page index {index} not found.")))
    }

    /// `Catalog.getAllPageDicts`: every page of the tree in order, each a dictionary or the failure that met the
    /// walk there; the walk stops at the first failure. An entry that leads nowhere
    /// ([`PdfError::XRefEntry`]) outside recovery mode is an error of the whole walk (the file is indexed again).
    fn all_page_dicts(&self, recovery_mode: bool) -> Result<Vec<Slot>> {
        let ignore_errors = self.options.ignore_errors;
        let add_error = |map: &mut Vec<Slot>, error: PdfError| -> Result<()> {
            if error.is_fatal() || (matches!(error, PdfError::XRefEntry(_)) && !recovery_mode) {
                return Err(error);
            }
            if recovery_mode && ignore_errors && map.is_empty() {
                tracing::warn!("getAllPageDicts - Skipping invalid first page: \"{error}\".");
                map.push(Ok(PageSource {
                    dict: Arc::new(Dict::new()),
                    reference: None,
                }));
            } else {
                map.push(Err(error));
            }
            Ok(())
        };
        let root = self.root()?;
        let mut visited: HashSet<String> = HashSet::new();
        if let Some(Obj::Ref(pages)) = root.get_raw("Pages") {
            visited.insert(pages.to_string());
        }
        let mut map: Vec<Slot> = Vec::new();
        let mut queue: Vec<(Arc<Dict>, usize)> = vec![(self.toplevel_pages_dict()?, 0)];
        while let Some((node, position)) = queue.last().cloned() {
            self.xref.guard().tick()?;
            let item = queue.len() - 1;
            let kids = match self.resolve(node.get_raw("Kids")) {
                Ok(kids) => kids,
                Err(e) => {
                    add_error(&mut map, e)?;
                    break;
                }
            };
            let Obj::Array(kids) = kids else {
                match self.is_page(&node) {
                    Ok(true) => map.push(Ok(PageSource {
                        dict: node,
                        reference: None,
                    })),
                    Ok(false) => add_error(
                        &mut map,
                        PdfError::format("Page dictionary kids object is not an array."),
                    )?,
                    Err(e) => add_error(&mut map, e)?,
                }
                break;
            };
            let Some(kid) = kids.get(position) else {
                queue.pop();
                continue;
            };
            let obj = if let Obj::Ref(reference) = kid {
                if !visited.insert(reference.to_string()) {
                    add_error(
                        &mut map,
                        PdfError::format("Pages tree contains circular reference."),
                    )?;
                    break;
                }
                match self.xref.fetch(*reference, false) {
                    Ok(obj) => obj,
                    Err(e) => {
                        add_error(&mut map, e)?;
                        break;
                    }
                }
            } else {
                kid.clone()
            };
            let Obj::Dict(dict) = obj else {
                add_error(
                    &mut map,
                    PdfError::format("Page dictionary kid reference points to wrong type of object."),
                )?;
                break;
            };
            match self.is_page(&dict) {
                Ok(true) => map.push(Ok(PageSource {
                    dict,
                    reference: kid.as_ref_value(),
                })),
                Ok(false) => {
                    queue[item].1 += 1;
                    queue.push((dict, 0));
                    continue;
                }
                Err(e) => {
                    add_error(&mut map, e)?;
                    break;
                }
            }
            queue[item].1 += 1;
        }
        Ok(map)
    }
}
