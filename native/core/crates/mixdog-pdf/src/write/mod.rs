//! The writing half of the crate: a mutable document over the reader's object model, as pdf-lib 1.17.1's
//! `PDFDocument` is used by the office PDF code.
//!
//! * [`PdfDocument::load`] reads a file through [`crate::Xref`] (so it repairs what the reader repairs) and keeps
//!   every object in an [`ObjectStore`]. As the office code loads (`ignoreEncryption`, `updateMetadata: false`), an
//!   encrypted file is refused unless `ignore_encryption` is set; with it the strings and streams stay ciphered, as
//!   they are in the file, and the metadata is left alone.
//! * [`PdfDocument::create`] makes a document with a page tree and no page (`addDefaultPage: false`).
//! * The pages are read as pdf-lib reads them: the order of the page tree, the inherited `MediaBox`, `CropBox` and
//!   `Rotate`, the other boxes falling back to the crop box.
//! * [`info`]: the Info dictionary and `applyDocumentProperties`.
//! * [`PdfDocument::save`] rewrites the whole file, as `PDFDocument.save` does: with object streams and a
//!   cross-reference stream (`useObjectStreams: true`, the default) or in the classic form.
//!
//! Not carried over from `PDFDocument.save`: the update of form field appearances (forms are another module's) and
//! `addDefaultPage` (the office code always passes `false`).

pub mod info;
pub mod object_streams;
mod serialize;
pub mod store;

use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use crate::error::{Guard, PdfError};
use crate::object::{Dict, Obj, Ref};
use crate::repair::triggers_rebuild;
use crate::stream::{Decryptor, DecryptorFactory, StreamFilters};
use crate::write::store::ObjectStore;
use crate::xref::{Xref, XrefOptions};

pub use info::{DocumentProperties, decode_text_string, encode_text_string, pdf_date};
pub use object_streams::{deflate, flate_stream};
pub use store::{TrailerInfo, stream_object};

/// How deep a page tree may nest before the walk gives up (a tree that contains itself).
const MAX_PAGE_TREE_DEPTH: usize = 64;

/// Why a document could not be loaded, edited or read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteError {
    /// The reader failed (an invalid file, a cancelled or over-budget read).
    Pdf(PdfError),
    /// The file is encrypted and the load did not ask to ignore that (`EncryptedPDFError`).
    Encrypted,
    /// The structure is not what the operation needs.
    Invalid(String),
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteError::Pdf(error) => write!(f, "{error}"),
            WriteError::Encrypted => f.write_str(
                "Input document is encrypted: load it with ignore_encryption to read its structure",
            ),
            WriteError::Invalid(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for WriteError {}

impl From<PdfError> for WriteError {
    fn from(error: PdfError) -> Self {
        WriteError::Pdf(error)
    }
}

/// How a document is loaded (`PDFDocument.load` as the office code calls it).
#[derive(Clone)]
pub struct LoadOptions {
    /// `ignoreEncryption`: read an encrypted file's structure with its strings and streams left ciphered. Without
    /// it an encrypted file is [`WriteError::Encrypted`].
    pub ignore_encryption: bool,
    /// Decodes the filters of the streams the reader must open itself (cross-reference streams, object streams).
    pub filters: Arc<dyn StreamFilters>,
    /// Cancellation and budget of the read.
    pub guard: Arc<Guard>,
}

/// How a document is saved (`PDFDocument.save`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaveOptions {
    /// `useObjectStreams`: pack objects into object streams and write a cross-reference stream.
    pub use_object_streams: bool,
}

impl Default for SaveOptions {
    /// pdf-lib's default, and the office code's `SAVE_OPTIONS`.
    fn default() -> Self {
        SaveOptions {
            use_object_streams: true,
        }
    }
}

/// A rectangle as pdf-lib's `asRectangle` gives it: the lower left corner and the size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The decryptor of a load that ignores encryption: strings and streams are what the file holds.
struct CipheredAsStored;

impl Decryptor for CipheredAsStored {
    fn decrypt_string(&self, _num: i64, _generation: i64, data: &[u8], _xref: Option<&Xref>) -> crate::Result<Vec<u8>> {
        Ok(data.to_vec())
    }

    fn decrypt_stream(
        &self,
        _num: i64,
        _generation: i64,
        data: &[u8],
        _crypt_name: Option<&str>,
        _embedded_file: bool,
    ) -> crate::Result<Vec<u8>> {
        Ok(data.to_vec())
    }
}

impl DecryptorFactory for CipheredAsStored {
    fn create(&self, _encrypt: &Dict, _file_id: &[u8], _xref: &Xref) -> crate::Result<Arc<dyn Decryptor>> {
        Ok(Arc::new(CipheredAsStored))
    }
}

/// A document under edit.
#[derive(Debug, Clone)]
pub struct PdfDocument {
    pub(crate) store: ObjectStore,
    encrypted: bool,
}

/// `Type /ObjStm` and `Type /XRef` streams hold the file's own bookkeeping: the objects of the first are read out
/// of it and the second is replaced on save, so neither is kept (pdf-lib drops them too).
fn is_bookkeeping_stream(obj: &Obj) -> bool {
    let Obj::Stream(stream) = obj else {
        return false;
    };
    matches!(
        stream.dict.get_raw("Type"),
        Some(Obj::Name(name)) if &**name == "ObjStm" || &**name == "XRef"
    )
}

/// Every object the table names, the bookkeeping streams left out. An object that cannot be read is left out and the
/// rest is read, as pdf-lib does; a fatal error, and one after which the table is rebuilt, end the read.
fn read_objects(xref: &Xref, guard: &Guard, recovered: bool) -> Result<ObjectStore, PdfError> {
    let mut store = ObjectStore::new();
    for num in 1..xref.entries_len() {
        guard.tick()?;
        let Some(entry) = xref.entry(num) else {
            continue;
        };
        let generation = if entry.uncompressed { entry.generation } else { 0 };
        match xref.fetch(Ref::new(num, generation), false) {
            Ok(obj) if is_bookkeeping_stream(&obj) => {}
            Ok(obj) => store.insert_loaded(Ref::new(num, generation), obj),
            Err(error) if error.is_fatal() || triggers_rebuild(&error, recovered) => return Err(error),
            Err(error) => tracing::warn!("object {num} {generation} is skipped: {error}"),
        }
    }
    Ok(store)
}

impl PdfDocument {
    /// `PDFDocument.load(bytes, { ignoreEncryption, updateMetadata: false })`.
    pub fn load(data: impl Into<Arc<[u8]>>, options: &LoadOptions) -> Result<PdfDocument, WriteError> {
        let xref = Xref::open(
            data.into(),
            XrefOptions {
                filters: options.filters.clone(),
                decryptor: Some(Arc::new(CipheredAsStored)),
                guard: options.guard.clone(),
            },
        )?;
        let encrypted = xref.is_encrypted();
        if encrypted && !options.ignore_encryption {
            return Err(WriteError::Encrypted);
        }
        // pdf-lib reads every object of the file whatever its cross-reference table says: an entry that leads to the
        // wrong object has the table rebuilt from the file (once, as the reader does) and the objects read again.
        let mut recovered = false;
        let mut store = loop {
            match read_objects(&xref, &options.guard, recovered) {
                Ok(store) => break store,
                Err(error) if triggers_rebuild(&error, recovered) => {
                    tracing::warn!("the cross-reference table is rebuilt: {error}");
                    xref.rebuild()?;
                    recovered = true;
                }
                Err(error) => return Err(error.into()),
            }
        };
        let trailer = xref
            .trailer()
            .ok_or_else(|| WriteError::Invalid("the file has no trailer".to_owned()))?;
        let mut referenced = |key: &str| -> Option<Ref> {
            match trailer.get_raw(key)? {
                Obj::Ref(r) => Some(*r),
                direct @ Obj::Dict(_) => {
                    let r = store.next_ref();
                    store.insert_loaded(r, direct.clone());
                    Some(r)
                }
                _ => None,
            }
        };
        let root = referenced("Root");
        let encrypt = referenced("Encrypt");
        let info = referenced("Info");
        let id = match xref.get(&trailer, "ID")? {
            array @ Obj::Array(_) => Some(array),
            _ => None,
        };
        store.trailer = TrailerInfo {
            root,
            encrypt,
            info,
            id,
        };
        Ok(PdfDocument { store, encrypted })
    }

    /// `PDFDocument.create()` at the current time: a catalog and a page tree with no page, and the metadata a new
    /// document gets (`Producer`, `Creator`, `CreationDate`, `ModDate`).
    pub fn create() -> PdfDocument {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(0));
        PdfDocument::create_at(now)
    }

    /// [`PdfDocument::create`] with the time named (seconds since the Unix epoch).
    pub fn create_at(now_unix_seconds: i64) -> PdfDocument {
        let mut store = ObjectStore::new();
        let mut pages = Dict::new();
        pages.set("Type", Obj::name("Pages"));
        pages.set("Kids", Obj::Array(Arc::new(Vec::new())));
        pages.set("Count", Obj::Num(0.0));
        let pages_ref = store.register(Obj::Dict(Arc::new(pages)));
        let mut catalog = Dict::new();
        catalog.set("Type", Obj::name("Catalog"));
        catalog.set("Pages", Obj::Ref(pages_ref));
        let catalog_ref = store.register(Obj::Dict(Arc::new(catalog)));
        store.trailer.root = Some(catalog_ref);
        let mut document = PdfDocument {
            store,
            encrypted: false,
        };
        document.update_info_dict(now_unix_seconds);
        document
    }

    /// `PDFDocument.isEncrypted`: the file had an `Encrypt` dictionary (its strings and streams stay ciphered).
    pub fn is_encrypted(&self) -> bool {
        self.encrypted
    }

    pub fn store(&self) -> &ObjectStore {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut ObjectStore {
        &mut self.store
    }

    /// The catalog (`/Root`).
    pub fn catalog_ref(&self) -> Option<Ref> {
        self.store.trailer.root
    }

    /// `PDFDocument.save`: the whole file again.
    pub fn save(&self, options: SaveOptions) -> Vec<u8> {
        if options.use_object_streams {
            object_streams::save_with_object_streams(&self.store, self.encrypted)
        } else {
            serialize::save_classic(&self.store)
        }
    }

    /// The decoded data of the stream object `r` (decrypted data is not available here: an encrypted file's streams
    /// are ciphered, so this is meaningful for the streams of a plain file and the ones made by this crate).
    pub fn decode_stream(
        &self,
        r: Ref,
        filters: &dyn StreamFilters,
        guard: &Guard,
    ) -> Result<Vec<u8>, WriteError> {
        match self.store.get(r) {
            Some(Obj::Stream(stream)) => Ok(stream.decode(filters, guard)?),
            _ => Err(WriteError::Invalid(format!("{r} is not a stream"))),
        }
    }

    // ---- pages ---------------------------------------------------------------------------------------------------

    fn pages_root(&self) -> Option<Ref> {
        let catalog = self.store.dict(self.store.trailer.root?)?;
        catalog.get_raw("Pages")?.as_ref_value()
    }

    /// `getPages()`: the leaves of the page tree in document order (a `Type /Page` dictionary reached through
    /// references; a leaf written directly in `Kids` has no reference and is not listed).
    pub fn pages(&self) -> Vec<Ref> {
        let mut leaves = Vec::new();
        if let Some(root) = self.pages_root() {
            let mut seen = HashSet::new();
            self.collect_pages(root, &mut leaves, &mut seen, 0);
        }
        leaves
    }

    fn collect_pages(&self, node: Ref, leaves: &mut Vec<Ref>, seen: &mut HashSet<i64>, depth: usize) {
        if depth > MAX_PAGE_TREE_DEPTH || !seen.insert(node.num) {
            return;
        }
        let Some(dict) = self.store.dict(node) else {
            return;
        };
        let Some(Obj::Array(kids)) = self.store.lookup(dict, "Kids") else {
            return;
        };
        for kid in kids.iter() {
            let Obj::Ref(kid_ref) = kid else {
                continue;
            };
            let Some(kid_dict) = self.store.dict(*kid_ref) else {
                continue;
            };
            match self.store.lookup(kid_dict, "Type").and_then(Obj::as_name) {
                Some("Pages") => self.collect_pages(*kid_ref, leaves, seen, depth + 1),
                Some("Page") => leaves.push(*kid_ref),
                _ => {}
            }
        }
    }

    /// `getPageCount()`.
    pub fn page_count(&self) -> usize {
        self.pages().len()
    }

    /// `addPage([width, height])`: a page with an empty resource dictionary and the given `MediaBox`, appended to the
    /// root of the page tree.
    pub fn add_page(&mut self, width: f64, height: f64) -> Result<Ref, WriteError> {
        let root = self
            .pages_root()
            .ok_or_else(|| WriteError::Invalid("the document has no page tree".to_owned()))?;
        let mut page = Dict::new();
        page.set("Type", Obj::name("Page"));
        page.set("Parent", Obj::Ref(root));
        page.set("Resources", Obj::Dict(Arc::new(Dict::new())));
        page.set(
            "MediaBox",
            Obj::Array(Arc::new(vec![
                Obj::Num(0.0),
                Obj::Num(0.0),
                Obj::Num(width),
                Obj::Num(height),
            ])),
        );
        let page_ref = self.store.register(Obj::Dict(Arc::new(page)));
        let counted = self.page_count() + 1;
        let attached = self.store.modify_dict(root, |tree| {
            let mut kids = match tree.get_raw("Kids") {
                Some(Obj::Array(items)) => (**items).clone(),
                _ => Vec::new(),
            };
            kids.push(Obj::Ref(page_ref));
            tree.set("Kids", Obj::Array(Arc::new(kids)));
            tree.set("Count", Obj::Num(counted as f64));
        });
        if attached.is_none() {
            return Err(WriteError::Invalid("the page tree root is not a dictionary".to_owned()));
        }
        Ok(page_ref)
    }

    /// The value of an inheritable page attribute: the first node from the page up its `Parent` chain that has the
    /// key, references followed (`PDFPageLeaf.getInheritableAttribute`).
    fn inherited(&self, page: Ref, key: &str) -> Option<&Obj> {
        let mut current = page;
        for _ in 0..=MAX_PAGE_TREE_DEPTH {
            let dict = self.store.dict(current)?;
            if let Some(raw) = dict.get_raw(key) {
                return self.store.resolve(raw);
            }
            current = dict.get_raw("Parent")?.as_ref_value()?;
        }
        None
    }

    fn rectangle(&self, array: &Obj) -> Result<Rect, WriteError> {
        let Obj::Array(items) = array else {
            return Err(WriteError::Invalid("a page box is not an array".to_owned()));
        };
        if items.len() != 4 {
            return Err(WriteError::Invalid(format!(
                "Tried to convert a PDFArray of length {} to a rectangle",
                items.len()
            )));
        }
        let mut corner = [0.0f64; 4];
        for (slot, item) in corner.iter_mut().zip(items.iter()) {
            *slot = self
                .store
                .resolve(item)
                .and_then(Obj::as_num)
                .ok_or_else(|| WriteError::Invalid("a page box holds a value that is not a number".to_owned()))?;
        }
        Ok(Rect {
            x: corner[0],
            y: corner[1],
            width: corner[2] - corner[0],
            height: corner[3] - corner[1],
        })
    }

    fn own_box(&self, page: Ref, key: &str) -> Result<Option<Rect>, WriteError> {
        let Some(dict) = self.store.dict(page) else {
            return Err(WriteError::Invalid(format!("{page} is not a page")));
        };
        match self.store.lookup(dict, key) {
            None | Some(Obj::Null) => Ok(None),
            Some(array) => self.rectangle(array).map(Some),
        }
    }

    /// `getMediaBox()`; a page without one (also not in its ancestors) is an error.
    pub fn media_box(&self, page: Ref) -> Result<Rect, WriteError> {
        match self.inherited(page, "MediaBox") {
            None | Some(Obj::Null) => Err(WriteError::Invalid("the page has no MediaBox".to_owned())),
            Some(array) => self.rectangle(array),
        }
    }

    /// `getCropBox()`: the inherited `CropBox`, else the media box.
    pub fn crop_box(&self, page: Ref) -> Result<Rect, WriteError> {
        match self.inherited(page, "CropBox") {
            None | Some(Obj::Null) => self.media_box(page),
            Some(array) => self.rectangle(array),
        }
    }

    /// `getBleedBox()`: the page's `BleedBox`, else the crop box.
    pub fn bleed_box(&self, page: Ref) -> Result<Rect, WriteError> {
        match self.own_box(page, "BleedBox")? {
            Some(rect) => Ok(rect),
            None => self.crop_box(page),
        }
    }

    /// `getTrimBox()`: the page's `TrimBox`, else the crop box.
    pub fn trim_box(&self, page: Ref) -> Result<Rect, WriteError> {
        match self.own_box(page, "TrimBox")? {
            Some(rect) => Ok(rect),
            None => self.crop_box(page),
        }
    }

    /// `getArtBox()`: the page's `ArtBox`, else the crop box.
    pub fn art_box(&self, page: Ref) -> Result<Rect, WriteError> {
        match self.own_box(page, "ArtBox")? {
            Some(rect) => Ok(rect),
            None => self.crop_box(page),
        }
    }

    /// `getRotation().angle`: the inherited `Rotate`, 0 when there is none.
    pub fn rotation(&self, page: Ref) -> Result<f64, WriteError> {
        match self.inherited(page, "Rotate") {
            None | Some(Obj::Null) => Ok(0.0),
            Some(Obj::Num(angle)) => Ok(*angle),
            Some(_) => Err(WriteError::Invalid("the page's Rotate is not a number".to_owned())),
        }
    }
}
