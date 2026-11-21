//! Copying pages between documents (pdf-lib 1.17.1's `PDFDocument.copyPages` over `PDFObjectCopier`) and the form
//! fields that come with the copied widgets (`registerCopiedFields` and `dropFieldsOffThePages` of
//! `pdf-batch-structure.mjs`), with the part of pdf-lib's form model they need.
//!
//! * [`PdfDocument::copy_pages`] copies each page dictionary with everything it references, into this document, as
//!   new objects. As `PDFObjectCopier` does: the inheritable entries (`Resources`, `MediaBox`, `CropBox`, `Rotate`)
//!   the page takes from its page-tree ancestors are written into the copy, `Parent` is dropped (so the donor's
//!   page tree is not copied), every reference met is copied once per call (the objects pages of one call share stay
//!   shared) and a reference that leads nowhere stays a reference to a new, empty number. A `Type /Page` reached from
//!   inside a page (a widget's `P`) is copied as one more page that no tree holds, as pdf-lib does.
//! * The copies are not in the page tree: [`PdfDocument::insert_page`] puts them there.
//! * The form: [`PdfDocument::form_fields`] lists the terminal fields `PDFForm.getFields` lists (type `Btn`, `Ch`,
//!   `Tx` or `Sig`, in the order of a depth-first walk of `AcroForm /Fields`), each with its fully qualified name as
//!   pdf-lib's `getName()` gives it (a part without a `T` reads `undefined`, as JavaScript's concatenation does).
//!   Like pdf-lib's `getForm()` and `getFields()`, [`PdfDocument::register_copied_fields`] and
//!   [`PdfDocument::drop_fields_off_the_pages`] make the form's `Fields` array when it is missing, and the first
//!   makes the form when there is none.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::object::{Dict, Obj, Ref};
use crate::write::pages::{edit_child_array, edit_child_dict, invalid, write_array};
use crate::write::store::ObjectStore;
use crate::write::{MAX_PAGE_TREE_DEPTH, PdfDocument, WriteError, decode_text_string, encode_text_string};

/// How deep a copy may nest (references and containers) before it gives up: a structure that deep would overflow
/// the stack of the copy.
const MAX_COPY_DEPTH: usize = 1000;

/// `PDFPageLeaf.InheritableEntries`.
const INHERITABLE_ENTRIES: [&str; 4] = ["Resources", "MediaBox", "CropBox", "Rotate"];

/// The state of one `PDFObjectCopier`: the objects copied so far, by the reference they had in the source.
struct Copier<'a> {
    source: &'a ObjectStore,
    dest: &'a mut ObjectStore,
    mapped: HashMap<Ref, Ref>,
    depth: usize,
}

fn is_page(dict: &Dict) -> bool {
    matches!(dict.get_raw("Type"), Some(Obj::Name(name)) if &**name == "Page")
}

impl Copier<'_> {
    fn copy(&mut self, obj: &Obj) -> Result<Obj, WriteError> {
        if self.depth >= MAX_COPY_DEPTH {
            return Err(invalid("the object nests too deeply to copy"));
        }
        self.depth += 1;
        let copied = self.copy_value(obj);
        self.depth -= 1;
        copied
    }

    fn copy_value(&mut self, obj: &Obj) -> Result<Obj, WriteError> {
        match obj {
            Obj::Ref(r) => Ok(Obj::Ref(self.copy_ref(*r)?)),
            Obj::Dict(dict) if is_page(dict) => Ok(Obj::Dict(Arc::new(self.copy_page(dict)?))),
            Obj::Dict(dict) => Ok(Obj::Dict(Arc::new(self.copy_dict(dict)?))),
            Obj::Array(items) => {
                let mut copied = Vec::with_capacity(items.len());
                for item in items.iter() {
                    copied.push(self.copy(item)?);
                }
                Ok(Obj::Array(Arc::new(copied)))
            }
            Obj::Stream(stream) => {
                let mut clone = (**stream).clone();
                clone.dict = Arc::new(self.copy_dict(&stream.dict)?);
                Ok(Obj::Stream(Arc::new(clone)))
            }
            other => Ok(other.clone()),
        }
    }

    fn copy_dict(&mut self, dict: &Dict) -> Result<Dict, WriteError> {
        let mut copied = Dict::new();
        for (key, value) in dict.iter() {
            copied.set(key, self.copy(value)?);
        }
        Ok(copied)
    }

    /// `copyPDFIndirectObject`: a number is taken in the destination before the object is copied (so a reference
    /// back to it finds it), and an object the source does not have leaves that number empty.
    fn copy_ref(&mut self, r: Ref) -> Result<Ref, WriteError> {
        if let Some(mapped) = self.mapped.get(&r) {
            return Ok(*mapped);
        }
        let new_ref = self.dest.next_ref();
        self.mapped.insert(r, new_ref);
        let source = self.source;
        if let Some(value) = source.get(r) {
            let copied = self.copy(value)?;
            self.dest.assign(new_ref, copied);
        }
        Ok(new_ref)
    }

    /// The value `page` inherits for `key` from its page-tree ancestors, as it is written there (a reference stays
    /// one).
    fn inherited(&self, page: &Dict, key: &str) -> Option<Obj> {
        let mut ancestor = match self.source.lookup(page, "Parent") {
            Some(Obj::Dict(dict)) => Some(dict.clone()),
            _ => None,
        };
        for _ in 0..=MAX_PAGE_TREE_DEPTH {
            let node = ancestor?;
            if let Some(value) = node.get_raw(key) {
                return Some(value.clone());
            }
            ancestor = match self.source.lookup(&node, "Parent") {
                Some(Obj::Dict(dict)) => Some(dict.clone()),
                _ => None,
            };
        }
        None
    }

    /// `copyPDFPage`.
    fn copy_page(&mut self, page: &Dict) -> Result<Dict, WriteError> {
        let mut clone = page.clone();
        for key in INHERITABLE_ENTRIES {
            if !clone.has(key)
                && let Some(value) = self.inherited(page, key)
            {
                clone.set(key, value);
            }
        }
        clone.delete("Parent");
        self.copy_dict(&clone)
    }
}

/// A terminal form field that `PDFForm.getFields` lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormField {
    /// The field dictionary's reference.
    pub reference: Ref,
    /// `getName()`: the fully qualified name (empty when the field has no name at all).
    pub name: String,
    /// The field type: `Btn`, `Ch`, `Tx` or `Sig`.
    pub field_type: String,
    /// The inheritable `V` as text: a string decoded, a name, a number; anything else is `None`.
    pub value: Option<String>,
}

fn value_text(value: &Obj) -> Option<String> {
    match value {
        Obj::Str(bytes) => Some(decode_text_string(bytes)),
        Obj::Name(name) => Some(name.to_string()),
        Obj::Num(number) => Some(if number.fract() == 0.0 && number.abs() < 1e15 { format!("{}", *number as i64) } else { number.to_string() }),
        _ => None,
    }
}

impl PdfDocument {
    fn acro_form_dict(&self) -> Option<&Arc<Dict>> {
        let catalog = self.store.dict(self.store.trailer.root?)?;
        match self.store.lookup(catalog, "AcroForm")? {
            Obj::Dict(form) => Some(form),
            _ => None,
        }
    }

    /// `catalog.getAcroForm()` is defined: the document has a form.
    pub fn has_acro_form(&self) -> bool {
        self.acro_form_dict().is_some()
    }

    /// The annotations of a page (`page.node.Annots()`), as the page's array holds them.
    pub fn page_annotations(&self, page: Ref) -> Vec<Obj> {
        let Some(dict) = self.store.dict(page) else {
            return Vec::new();
        };
        match self.store.lookup(dict, "Annots") {
            Some(Obj::Array(items)) => (**items).clone(),
            _ => Vec::new(),
        }
    }

    /// `catalog.getOrCreateAcroForm()`: a form with an empty `Fields` array, made and named in the catalog when
    /// there is none.
    fn ensure_acro_form(&mut self) -> Result<(), WriteError> {
        if self.has_acro_form() {
            return Ok(());
        }
        let root = self.store.trailer.root.ok_or_else(|| invalid("the file has no catalog"))?;
        let mut form = Dict::new();
        form.set("Fields", Obj::Array(Arc::new(Vec::new())));
        let form_ref = self.store.register(Obj::Dict(Arc::new(form)));
        self.store.modify_dict(root, |catalog| catalog.set("AcroForm", Obj::Ref(form_ref))).ok_or_else(|| invalid("the catalog is not a dictionary"))
    }

    /// `PDFAcroForm.normalizedEntries`: `Fields` is an array afterwards.
    fn normalize_form_fields(&mut self) -> Result<(), WriteError> {
        self.edit_catalog(|store, catalog| {
            edit_child_dict(store, catalog, "AcroForm", false, |store, form| {
                if !matches!(store.lookup(form, "Fields"), Some(Obj::Array(_))) {
                    form.set("Fields", Obj::Array(Arc::new(Vec::new())));
                }
                Ok(())
            })
        })
    }

    /// `PDFAcroForm.addField`.
    fn add_form_field(&mut self, field: Ref) -> Result<(), WriteError> {
        self.edit_catalog(|store, catalog| {
            edit_child_dict(store, catalog, "AcroForm", false, |store, form| {
                if !matches!(store.lookup(form, "Fields"), Some(Obj::Array(_))) {
                    form.set("Fields", Obj::Array(Arc::new(Vec::new())));
                }
                edit_child_array(store, form, "Fields", false, |items| items.push(Obj::Ref(field)))
            })
        })
    }

    /// `lookupMaybe(Parent, PDFDict)`.
    fn parent_dict(&self, dict: &Dict) -> Option<Arc<Dict>> {
        match self.store.lookup(dict, "Parent") {
            Some(Obj::Dict(parent)) => Some(parent.clone()),
            _ => None,
        }
    }

    /// `getInheritableAttribute`: the first value for `key` from the field up its parents, as written.
    fn inheritable_raw(&self, dict: &Dict, key: &str) -> Option<Obj> {
        if let Some(value) = dict.get_raw(key) {
            return Some(value.clone());
        }
        let mut ancestor = self.parent_dict(dict);
        for _ in 0..=MAX_PAGE_TREE_DEPTH {
            let node = ancestor?;
            if let Some(value) = node.get_raw(key) {
                return Some(value.clone());
            }
            ancestor = self.parent_dict(&node);
        }
        None
    }

    /// `PDFAcroField.getParent`: the parent when the entry is a reference to a dictionary.
    fn parent_field(&self, dict: &Dict) -> Option<Ref> {
        let parent = dict.get_raw("Parent")?.as_ref_value()?;
        matches!(self.store.get(parent), Some(Obj::Dict(_))).then_some(parent)
    }

    fn partial_name(&self, dict: &Dict) -> Option<String> {
        match self.store.lookup(dict, "T") {
            Some(Obj::Str(bytes)) => Some(decode_text_string(bytes)),
            _ => None,
        }
    }

    /// `getFullyQualifiedName`: the names of the field and its parents joined by dots.
    fn fully_qualified_name(&self, field: Ref, depth: usize) -> Option<String> {
        if depth > MAX_PAGE_TREE_DEPTH {
            return None;
        }
        let dict = self.store.dict(field)?;
        let own = self.partial_name(dict);
        match self.parent_field(dict) {
            None => own,
            Some(parent) => {
                let parent_name = self.fully_qualified_name(parent, depth + 1);
                Some(format!("{}.{}", parent_name.as_deref().unwrap_or("undefined"), own.as_deref().unwrap_or("undefined")))
            }
        }
    }

    /// `isNonTerminalAcroField`: a kid that is a dictionary with a `T` makes the field a parent.
    fn is_non_terminal(&self, dict: &Dict) -> bool {
        let Some(Obj::Array(kids)) = self.store.lookup(dict, "Kids") else {
            return false;
        };
        kids.iter().any(|kid| matches!(self.store.resolve(kid), Some(Obj::Dict(kid)) if kid.has("T")))
    }

    fn collect_fields(&self, entries: &[Obj], depth: usize, out: &mut Vec<FormField>) {
        if depth > MAX_PAGE_TREE_DEPTH {
            return;
        }
        for entry in entries {
            let Obj::Ref(reference) = entry else {
                continue;
            };
            let Some(Obj::Dict(dict)) = self.store.get(*reference) else {
                continue;
            };
            if self.is_non_terminal(dict) {
                if let Some(Obj::Array(kids)) = self.store.lookup(dict, "Kids") {
                    self.collect_fields(kids, depth + 1, out);
                }
                continue;
            }
            let field_type = match self.inheritable_raw(dict, "FT").and_then(|raw| self.store.resolve(&raw).and_then(Obj::as_name).map(str::to_owned)) {
                Some(name) if matches!(name.as_str(), "Btn" | "Ch" | "Tx" | "Sig") => name,
                _ => continue,
            };
            let value = self.inheritable_raw(dict, "V").and_then(|raw| self.store.resolve(&raw).and_then(value_text));
            out.push(FormField { reference: *reference, name: self.fully_qualified_name(*reference, 0).unwrap_or_default(), field_type, value });
        }
    }

    /// `PDFForm.getFields`: the terminal fields of the form, depth first.
    pub fn form_fields(&self) -> Vec<FormField> {
        let mut fields = Vec::new();
        if let Some(form) = self.acro_form_dict()
            && let Some(Obj::Array(entries)) = self.store.lookup(form, "Fields")
        {
            self.collect_fields(entries, 0, &mut fields);
        }
        fields
    }

    /// `PDFAcroTerminal.getWidgets` as references: the kids of the field, or the field itself when it is its own
    /// widget. A kid that is not an indirect object has no reference (`None`).
    fn field_widgets(&self, field: Ref) -> Vec<Option<Ref>> {
        let Some(dict) = self.store.dict(field) else {
            return Vec::new();
        };
        match self.store.lookup(dict, "Kids") {
            Some(Obj::Array(kids)) => kids.iter().map(Obj::as_ref_value).collect(),
            _ => vec![Some(field)],
        }
    }

    /// `PDFAcroForm.removeField`: the field leaves its parent's `Kids` (or the form's `Fields`), and a parent left
    /// without kids leaves with it.
    fn remove_form_field(&mut self, field: Ref, depth: usize) -> Result<(), WriteError> {
        if depth > MAX_PAGE_TREE_DEPTH {
            return Err(invalid("the form fields nest too deeply"));
        }
        let missing = |document: &PdfDocument| {
            let name = document.fully_qualified_name(field, 0);
            invalid(format!("Tried to remove inexistent field {}", name.as_deref().unwrap_or("undefined")))
        };
        let holds = move |item: &Obj| matches!(item, Obj::Ref(r) if *r == field);
        let parent = self.store.dict(field).and_then(|dict| self.parent_field(dict));
        let Some(parent) = parent else {
            let removed = self.edit_catalog(|store, catalog| {
                edit_child_dict(store, catalog, "AcroForm", false, |store, form| {
                    if !matches!(store.lookup(form, "Fields"), Some(Obj::Array(_))) {
                        form.set("Fields", Obj::Array(Arc::new(Vec::new())));
                    }
                    edit_child_array(store, form, "Fields", false, |items| {
                        let at = items.iter().position(holds);
                        at.map(|at| items.remove(at)).is_some()
                    })
                })
            })?;
            return if removed { Ok(()) } else { Err(missing(self)) };
        };
        let kids = self.store.dict(parent).and_then(|dict| self.store.lookup(dict, "Kids")).and_then(Obj::as_array).map(|items| (**items).clone());
        let Some(mut kids) = kids else {
            return Err(missing(self));
        };
        let Some(at) = kids.iter().position(holds) else {
            return Err(missing(self));
        };
        kids.remove(at);
        let emptied = kids.is_empty();
        write_array(&mut self.store, parent, "Kids", kids);
        if emptied {
            self.remove_form_field(parent, depth + 1)?;
        }
        Ok(())
    }

    /// `registerCopiedFields` of `pdf-batch-structure.mjs`: the top fields of the widgets on the copied pages join
    /// the document's form. A name the form already holds takes a numbered suffix (`name_2`, `name_3`, ...) so two
    /// copies of one form stay two sets of fields. The number of fields joined is returned.
    pub fn register_copied_fields(&mut self, pages: &[Ref]) -> Result<usize, WriteError> {
        self.ensure_acro_form()?;
        self.normalize_form_fields()?;
        let mut names: HashSet<String> = self.form_fields().into_iter().map(|field| field.name).collect();
        let roots = self.widget_field_roots(pages);
        for field_ref in &roots {
            let title = self.store.dict(*field_ref).and_then(|dict| dict.get_raw("T")).and_then(Obj::as_str).map(decode_text_string);
            let mut name = title.unwrap_or_default();
            if !name.is_empty() && names.contains(&name) {
                let mut suffix = 2;
                while names.contains(&format!("{name}_{suffix}")) {
                    suffix += 1;
                }
                name = format!("{name}_{suffix}");
                let text = Obj::Str(Arc::from(encode_text_string(&name)));
                self.store.modify_dict(*field_ref, |dict| dict.set("T", text));
            }
            if !name.is_empty() {
                names.insert(name);
            }
            self.add_form_field(*field_ref)?;
        }
        Ok(roots.len())
    }

    /// The topmost ancestor dictionary of every widget annotation on `pages`, each once, in order of appearance.
    fn widget_field_roots(&self, pages: &[Ref]) -> Vec<Ref> {
        let mut roots: Vec<Ref> = Vec::new();
        for page in pages {
            for entry in self.page_annotations(*page) {
                let Obj::Ref(widget_ref) = entry else {
                    continue;
                };
                let is_widget = matches!(
                    self.store.get(widget_ref),
                    Some(Obj::Dict(widget)) if matches!(widget.get_raw("Subtype"), Some(Obj::Name(kind)) if &**kind == "Widget")
                );
                if !is_widget {
                    continue;
                }
                let mut field_ref = widget_ref;
                for _ in 0..=MAX_PAGE_TREE_DEPTH {
                    let Some(Obj::Dict(dict)) = self.store.get(field_ref) else {
                        break;
                    };
                    let Some(Obj::Ref(parent)) = dict.get_raw("Parent") else {
                        break;
                    };
                    if !matches!(self.store.get(*parent), Some(Obj::Dict(_))) {
                        break;
                    }
                    field_ref = *parent;
                }
                if !roots.contains(&field_ref) {
                    roots.push(field_ref);
                }
            }
        }
        roots
    }

    /// `dropFieldsOffThePages` of `pdf-batch-structure.mjs`: a field whose widgets sat only on removed pages leaves
    /// the form with them, and a widget on a removed page leaves its field.
    pub fn drop_fields_off_the_pages(&mut self) -> Result<(), WriteError> {
        if !self.has_acro_form() {
            return Ok(());
        }
        self.normalize_form_fields()?;
        let mut placed: HashSet<Ref> = HashSet::new();
        for page in self.pages() {
            placed.extend(self.page_annotations(page).iter().filter_map(Obj::as_ref_value));
        }
        for field in self.form_fields() {
            let widgets = self.field_widgets(field.reference);
            let gone: Vec<Ref> = widgets.iter().flatten().filter(|widget| !placed.contains(*widget)).copied().collect();
            if gone.is_empty() {
                continue;
            }
            if gone.len() == widgets.len() {
                self.remove_form_field(field.reference, 0)?;
                continue;
            }
            let kids = self.store.dict(field.reference).and_then(|dict| self.store.lookup(dict, "Kids")).and_then(Obj::as_array).map(|items| (**items).clone());
            let Some(mut kids) = kids else {
                continue;
            };
            for widget in gone {
                if let Some(at) = kids.iter().position(|kid| matches!(kid, Obj::Ref(r) if *r == widget)) {
                    kids.remove(at);
                }
            }
            write_array(&mut self.store, field.reference, "Kids", kids);
        }
        Ok(())
    }

    /// `copyPages(srcDoc, indices)`: the pages of `source` named by `indices` (a page may be named twice), copied
    /// into this document as new, parentless page objects, in that order.
    pub fn copy_pages(&mut self, source: &PdfDocument, indices: &[usize]) -> Result<Vec<Ref>, WriteError> {
        let source_pages = source.pages();
        for index in indices {
            if *index >= source_pages.len() {
                return Err(invalid(format!("PDF page out of range: {}", index + 1)));
            }
        }
        let mut copier = Copier { source: &source.store, dest: &mut self.store, mapped: HashMap::new(), depth: 0 };
        let mut copied = Vec::with_capacity(indices.len());
        for index in indices {
            let Some(page) = source_pages.get(*index).and_then(|page| source.store.dict(*page)) else {
                return Err(invalid(format!("PDF page out of range: {}", index + 1)));
            };
            let clone = copier.copy_page(page)?;
            copied.push(copier.dest.register(Obj::Dict(Arc::new(clone))));
        }
        Ok(copied)
    }
}
