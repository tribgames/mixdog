//! Page edits of a document under edit, as pdf-lib 1.17.1's `PDFDocument.insertPage` / `removePage` and its
//! `PDFPageTree.insertLeafNode` / `removeLeafNode` do them, the page setters of `PDFPage` the office code uses
//! (`setRotation`, `setMediaBox`, `setCropBox` and the other boxes), and the two compositions of
//! `pdf-batch-structure.mjs` built on them: `keepPagesInOrder` and `copyToNewDocument`.
//!
//! * A page is the reference of a `Type /Page` dictionary. [`PdfDocument::insert_page`] puts it into the tree at an
//!   index (every `Count` on the way up grows by one, the page's `Parent` becomes the node it landed in);
//!   [`PdfDocument::remove_page`] takes the leaf out (every `Count` shrinks, a page-tree node left without kids is
//!   pruned). A removed page stays in the object store, as it does in pdf-lib.
//! * pdf-lib keeps the list of the pages cached and `removePage` does not clear it, so the Node batch has to
//!   invalidate it by hand after each removal. [`PdfDocument::pages`] reads the tree every time: a removal is seen
//!   at once and there is nothing to invalidate.
//! * The helpers `edit_child_dict` and `edit_child_array` edit a dictionary or array that a detached parent
//!   dictionary holds, wherever it lives (indirect object or inline), and are what the attachment and form code use.

use std::collections::HashSet;
use std::sync::Arc;

use crate::object::{Dict, Obj, Ref};
use crate::write::store::ObjectStore;
use crate::write::{MAX_PAGE_TREE_DEPTH, PdfDocument, Rect, WriteError};

pub(super) fn invalid(message: impl Into<String>) -> WriteError {
    WriteError::Invalid(message.into())
}

/// pdf-lib's `UnexpectedObjectTypeError` for the value under `key`.
pub(super) fn not_a(kind: &str, key: &str) -> WriteError {
    invalid(format!("Expected instance of {kind}, but got another object under /{key}"))
}

/// pdf-lib's `assertRange(value, name, 0, max)` (a `max` below the minimum is the minimum).
pub(super) fn assert_range(value: usize, name: &str, max: usize) -> Result<(), WriteError> {
    if value > max {
        return Err(invalid(format!("`{name}` must be at least 0 and at most {max}, but was actually {value}")));
    }
    Ok(())
}

/// Runs `edit` on the dictionary that `parent` holds under `key`, wherever it lives: an indirect object is edited in
/// the store, an inline one inside `parent`. When the key is absent and `make` is set, an empty dictionary is put
/// there first. Nothing is changed when `edit` fails.
pub(super) fn edit_child_dict<T>(
    store: &mut ObjectStore,
    parent: &mut Dict,
    key: &str,
    make: bool,
    edit: impl FnOnce(&mut ObjectStore, &mut Dict) -> Result<T, WriteError>,
) -> Result<T, WriteError> {
    match parent.get_raw(key).cloned() {
        Some(Obj::Ref(r)) => {
            let mut child = store.dict(r).map(|dict| (**dict).clone()).ok_or_else(|| not_a("PDFDict", key))?;
            let out = edit(store, &mut child)?;
            store.modify_dict(r, |slot| *slot = child);
            Ok(out)
        }
        Some(Obj::Dict(dict)) => {
            let mut child = (*dict).clone();
            let out = edit(store, &mut child)?;
            parent.set(key, Obj::Dict(Arc::new(child)));
            Ok(out)
        }
        None if make => {
            let mut child = Dict::new();
            let out = edit(store, &mut child)?;
            parent.set(key, Obj::Dict(Arc::new(child)));
            Ok(out)
        }
        _ => Err(not_a("PDFDict", key)),
    }
}

/// [`edit_child_dict`] for an array.
pub(super) fn edit_child_array<T>(
    store: &mut ObjectStore,
    parent: &mut Dict,
    key: &str,
    make: bool,
    edit: impl FnOnce(&mut Vec<Obj>) -> T,
) -> Result<T, WriteError> {
    match parent.get_raw(key).cloned() {
        Some(Obj::Ref(r)) => {
            let existing = store.get(r).and_then(Obj::as_array).map(|items| (**items).clone());
            let mut items = existing.ok_or_else(|| not_a("PDFArray", key))?;
            let out = edit(&mut items);
            store.modify(r, |slot| *slot = Obj::Array(Arc::new(items)));
            Ok(out)
        }
        Some(Obj::Array(array)) => {
            let mut items = (*array).clone();
            let out = edit(&mut items);
            parent.set(key, Obj::Array(Arc::new(items)));
            Ok(out)
        }
        None if make => {
            let mut items = Vec::new();
            let out = edit(&mut items);
            parent.set(key, Obj::Array(Arc::new(items)));
            Ok(out)
        }
        _ => Err(not_a("PDFArray", key)),
    }
}

/// The array under `key` of the dictionary `owner` is written back to where it lives: its own indirect object when
/// the entry is a reference to an array, else inline in `owner`.
pub(super) fn write_array(store: &mut ObjectStore, owner: Ref, key: &str, items: Vec<Obj>) {
    let array = Obj::Array(Arc::new(items));
    let indirect = store.dict(owner).and_then(|dict| dict.get_raw(key)).and_then(Obj::as_ref_value).filter(|r| matches!(store.get(*r), Some(Obj::Array(_))));
    match indirect {
        Some(r) => {
            store.modify(r, |slot| *slot = array);
        }
        None => {
            store.modify_dict(owner, |dict| dict.set(key, array));
        }
    }
}

/// What a kid of a page-tree node is, as pdf-lib's parser would have made it from its `Type`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum NodeKind {
    Tree,
    Leaf,
    Other,
}

fn corrupt_tree(target: i64, operation: &str) -> WriteError {
    invalid(format!("Failed to {operation} at targetIndex={target} due to corrupt page tree: It is likely that one or more 'Count' entries are invalid"))
}

impl PdfDocument {
    /// Runs `edit` on a detached copy of the catalog, which is written back afterwards; what `edit` changes
    /// under a key that holds an indirect object goes to the store at once.
    pub(super) fn edit_catalog<T>(&mut self, edit: impl FnOnce(&mut ObjectStore, &mut Dict) -> Result<T, WriteError>) -> Result<T, WriteError> {
        let root = self.store.trailer.root.ok_or_else(|| invalid("the file has no catalog"))?;
        let mut catalog = self.store.dict(root).map(|dict| (**dict).clone()).ok_or_else(|| not_a("PDFDict", "Root"))?;
        let out = edit(&mut self.store, &mut catalog)?;
        self.store.modify_dict(root, |slot| *slot = catalog);
        Ok(out)
    }

    fn node_kind(&self, obj: &Obj) -> NodeKind {
        let Some(Obj::Dict(dict)) = self.store.resolve(obj) else {
            return NodeKind::Other;
        };
        match self.store.lookup(dict, "Type").and_then(Obj::as_name) {
            Some("Pages") => NodeKind::Tree,
            Some("Page") => NodeKind::Leaf,
            _ => NodeKind::Other,
        }
    }

    /// `Count().asNumber()` of a page-tree node.
    fn tree_count(&self, node: Ref) -> Result<i64, WriteError> {
        let dict = self.store.dict(node).ok_or_else(|| not_a("PDFDict", "Pages"))?;
        match self.store.lookup(dict, "Count").and_then(Obj::as_num) {
            Some(count) => Ok(count as i64),
            None => Err(not_a("PDFNumber", "Count")),
        }
    }

    /// `Kids()` of a page-tree node.
    fn tree_kids(&self, node: Ref) -> Result<Arc<Vec<Obj>>, WriteError> {
        let dict = self.store.dict(node).ok_or_else(|| not_a("PDFDict", "Pages"))?;
        match self.store.lookup(dict, "Kids") {
            Some(Obj::Array(kids)) => Ok(kids.clone()),
            _ => Err(not_a("PDFArray", "Kids")),
        }
    }

    /// Adds `delta` to the `Count` of `from` and of every node above it (`PDFPageTree.ascend`).
    fn ascend_count(&mut self, from: Ref, delta: i64) -> Result<(), WriteError> {
        let mut current = Some(from);
        for _ in 0..=MAX_PAGE_TREE_DEPTH {
            let Some(node) = current else {
                return Ok(());
            };
            let count = self.tree_count(node)?;
            self.store.modify_dict(node, |dict| dict.set("Count", Obj::Num((count + delta) as f64)));
            current = self.store.dict(node).and_then(|dict| dict.get_raw("Parent")).and_then(Obj::as_ref_value);
        }
        Err(invalid("the page tree nests too deeply"))
    }

    /// `PDFPageTree.insertLeafKid`.
    fn insert_leaf_kid(&mut self, node: Ref, at: usize, leaf: Ref) -> Result<(), WriteError> {
        self.ascend_count(node, 1)?;
        let mut kids = (*self.tree_kids(node)?).clone();
        kids.insert(at.min(kids.len()), Obj::Ref(leaf));
        write_array(&mut self.store, node, "Kids", kids);
        Ok(())
    }

    /// `PDFPageTree.removeKid`: a leaf takes one off every `Count` above it.
    fn remove_kid(&mut self, node: Ref, at: usize) -> Result<(), WriteError> {
        let mut kids = (*self.tree_kids(node)?).clone();
        let Some(kid) = kids.get(at) else {
            return Ok(());
        };
        if self.node_kind(kid) == NodeKind::Leaf {
            self.ascend_count(node, -1)?;
        }
        kids.remove(at);
        write_array(&mut self.store, node, "Kids", kids);
        Ok(())
    }

    /// `PDFPageTree.insertLeafNode`: the node the leaf was put into when that is not `node` itself.
    fn insert_leaf_node(&mut self, node: Ref, leaf: Ref, target: i64, depth: usize) -> Result<Option<Ref>, WriteError> {
        if depth > MAX_PAGE_TREE_DEPTH {
            return Err(corrupt_tree(target, "insertLeafNode"));
        }
        let kids = self.tree_kids(node)?;
        let count = self.tree_count(node)?;
        if target > count {
            return Err(invalid(format!("Invalid targetIndex specified: targetIndex={target} must be less than Count={count}")));
        }
        let mut remaining = target;
        for (at, kid) in kids.iter().enumerate() {
            if remaining == 0 {
                self.insert_leaf_kid(node, at, leaf)?;
                return Ok(None);
            }
            match (self.node_kind(kid), kid) {
                (NodeKind::Tree, Obj::Ref(kid_ref)) => {
                    let kid_count = self.tree_count(*kid_ref)?;
                    if kid_count > remaining {
                        let inner = self.insert_leaf_node(*kid_ref, leaf, remaining, depth + 1)?;
                        return Ok(Some(inner.unwrap_or(*kid_ref)));
                    }
                    remaining -= kid_count;
                }
                (NodeKind::Leaf, _) => remaining -= 1,
                _ => {}
            }
        }
        if remaining == 0 {
            self.insert_leaf_kid(node, kids.len(), leaf)?;
            return Ok(None);
        }
        Err(corrupt_tree(target, "insertLeafNode"))
    }

    /// `PDFPageTree.removeLeafNode` with `prune`.
    fn remove_leaf_node(&mut self, node: Ref, target: i64, depth: usize) -> Result<(), WriteError> {
        if depth > MAX_PAGE_TREE_DEPTH {
            return Err(corrupt_tree(target, "removeLeafNode"));
        }
        let kids = self.tree_kids(node)?;
        let count = self.tree_count(node)?;
        if target >= count {
            return Err(invalid(format!("Invalid targetIndex specified: targetIndex={target} must be less than Count={count}")));
        }
        let mut remaining = target;
        for (at, kid) in kids.iter().enumerate() {
            match (self.node_kind(kid), kid) {
                (NodeKind::Tree, Obj::Ref(kid_ref)) => {
                    let kid_count = self.tree_count(*kid_ref)?;
                    if kid_count > remaining {
                        self.remove_leaf_node(*kid_ref, remaining, depth + 1)?;
                        if self.tree_kids(*kid_ref)?.is_empty() {
                            let mut current = (*self.tree_kids(node)?).clone();
                            if at < current.len() {
                                current.remove(at);
                            }
                            write_array(&mut self.store, node, "Kids", current);
                        }
                        return Ok(());
                    }
                    remaining -= kid_count;
                }
                (NodeKind::Leaf, _) => {
                    if remaining == 0 {
                        return self.remove_kid(node, at);
                    }
                    remaining -= 1;
                }
                _ => {}
            }
        }
        Err(corrupt_tree(target, "removeLeafNode"))
    }

    /// `insertPage(index, page)` for a page that is already an object of this document (a new one from
    /// [`PdfDocument::copy_pages`], or one taken out by [`PdfDocument::remove_page`]).
    pub fn insert_page(&mut self, index: usize, page: Ref) -> Result<(), WriteError> {
        assert_range(index, "index", self.page_count())?;
        if self.node_kind(&Obj::Ref(page)) != NodeKind::Leaf {
            return Err(invalid(format!("{page} is not a page")));
        }
        let root = self.pages_root().ok_or_else(|| invalid("the document has no page tree"))?;
        let parent = self.insert_leaf_node(root, page, index as i64, 0)?.unwrap_or(root);
        self.store.modify_dict(page, |dict| dict.set("Parent", Obj::Ref(parent)));
        Ok(())
    }

    /// `addPage(page)`: the page goes to the end.
    pub fn append_page(&mut self, page: Ref) -> Result<(), WriteError> {
        self.insert_page(self.page_count(), page)
    }

    /// `removePage(index)`: the page leaves the tree and its reference is returned (the object stays in the store).
    pub fn remove_page(&mut self, index: usize) -> Result<Ref, WriteError> {
        let pages = self.pages();
        assert_range(index, "index", pages.len().saturating_sub(1))?;
        let root = self.pages_root().ok_or_else(|| invalid("the document has no page tree"))?;
        self.remove_leaf_node(root, index as i64, 0)?;
        pages.get(index).copied().ok_or_else(|| corrupt_tree(index as i64, "removeLeafNode"))
    }

    fn set_page_entry(&mut self, page: Ref, key: &str, value: Obj) -> Result<(), WriteError> {
        self.store.modify_dict(page, |dict| dict.set(key, value)).ok_or_else(|| invalid(format!("{page} is not a page")))
    }

    /// `setRotation(degrees(angle))`: `Rotate` of the page itself; the angle must be a multiple of 90.
    pub fn set_rotation(&mut self, page: Ref, angle: f64) -> Result<(), WriteError> {
        if !angle.is_finite() || angle % 90.0 != 0.0 {
            return Err(invalid(format!("`degreesAngle` must be a multiple of 90, but was actually {angle}")));
        }
        self.set_page_entry(page, "Rotate", Obj::Num(angle))
    }

    fn set_box(&mut self, page: Ref, key: &str, rect: Rect) -> Result<(), WriteError> {
        let corners = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
        let array = Obj::Array(Arc::new(corners.into_iter().map(Obj::Num).collect()));
        self.set_page_entry(page, key, array)
    }

    /// `setMediaBox(x, y, width, height)`.
    pub fn set_media_box(&mut self, page: Ref, rect: Rect) -> Result<(), WriteError> {
        self.set_box(page, "MediaBox", rect)
    }

    /// `setCropBox(x, y, width, height)`.
    pub fn set_crop_box(&mut self, page: Ref, rect: Rect) -> Result<(), WriteError> {
        self.set_box(page, "CropBox", rect)
    }

    /// `setBleedBox(x, y, width, height)`.
    pub fn set_bleed_box(&mut self, page: Ref, rect: Rect) -> Result<(), WriteError> {
        self.set_box(page, "BleedBox", rect)
    }

    /// `setTrimBox(x, y, width, height)`.
    pub fn set_trim_box(&mut self, page: Ref, rect: Rect) -> Result<(), WriteError> {
        self.set_box(page, "TrimBox", rect)
    }

    /// `setArtBox(x, y, width, height)`.
    pub fn set_art_box(&mut self, page: Ref, rect: Rect) -> Result<(), WriteError> {
        self.set_box(page, "ArtBox", rect)
    }

    /// `keepPagesInOrder` of `pdf-batch-structure.mjs`: the document keeps its own pages, in the order asked for (a
    /// page named twice is copied), so its form, attachments, outline and metadata stay with it. Pages not named
    /// leave the tree; the widgets and fields that sat on them leave the form; the copies' fields join it.
    pub fn keep_pages_in_order(&mut self, indexes: &[usize]) -> Result<(), WriteError> {
        let originals = self.pages();
        for index in indexes {
            if *index >= originals.len() {
                return Err(invalid(format!("PDF page out of range: {}", index + 1)));
            }
        }
        let mut kept = HashSet::new();
        let mut repeated = Vec::new();
        for index in indexes {
            if !kept.insert(*index) {
                repeated.push(*index);
            }
        }
        // `copyPages(document, [index])` once per repeated mention: each copy is a set of objects of its own (one
        // call would have two copies of a page share their widgets). The source is the document before the copies,
        // which none of its pages reach.
        let mut copies = Vec::with_capacity(repeated.len());
        if !repeated.is_empty() {
            let source = self.clone();
            for index in &repeated {
                copies.extend(self.copy_pages(&source, &[*index])?);
            }
        }
        let mut copy_iter = copies.iter();
        let mut seen = HashSet::new();
        let mut wanted = Vec::with_capacity(indexes.len());
        for index in indexes {
            if seen.insert(*index) {
                wanted.push(originals[*index]);
            } else if let Some(copy) = copy_iter.next() {
                wanted.push(*copy);
            }
        }
        for index in (0..originals.len()).rev() {
            if !kept.contains(&index) {
                self.remove_page(index)?;
            }
        }
        for (position, page) in wanted.iter().enumerate() {
            let current = self.pages().iter().position(|candidate| candidate == page);
            if current == Some(position) {
                continue;
            }
            if let Some(current) = current {
                self.remove_page(current)?;
            }
            self.insert_page(position, *page)?;
        }
        if !copies.is_empty() {
            self.register_copied_fields(&copies)?;
        }
        self.drop_fields_off_the_pages()
    }

    /// `copyToNewDocument`: a document of its own for the pages named, its widgets joining the new file's form.
    pub fn copy_to_new_document(&self, indexes: &[usize]) -> Result<PdfDocument, WriteError> {
        let mut next = PdfDocument::create();
        let copied = next.copy_pages(self, indexes)?;
        for page in &copied {
            next.append_page(*page)?;
        }
        if self.has_acro_form() {
            next.register_copied_fields(&copied)?;
        }
        Ok(next)
    }
}
