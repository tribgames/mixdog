//! `form.flatten()` of pdf-lib: every widget's appearance is painted into its page as a form XObject at the widget's
//! rectangle, and the field is removed from the form and from the document; the widgets' pages lose the field's own
//! reference from their `Annots` (a separate widget kid stays listed, pointing at nothing, as pdf-lib leaves it).
//!
//! The appearances are brought up to date first (with the default font), so a field that was never drawn is flattened
//! as it would be shown. A page's own content is wrapped in `q` ... `Q` the first time it is drawn on, as for every
//! other mark of the batch ([`PageInk`]).

use std::sync::Arc;

use mixdog_pdf::write::PdfDocument;
use mixdog_pdf::write::store::ObjectStore;
use mixdog_pdf::{Obj, Ref};

use crate::content_ops::{PageInk, Wrapped, form_error, plain};
use crate::document::AnalysisError;
use crate::forms::{
    Field, FieldKind, PdfForm, Widget, button_value, field_name, widget_rectangle, widgets_of,
};

/// The page a widget is on: the one its `P` names, else the one whose annotations list it.
fn widget_page(document: &PdfDocument, widget: &Widget) -> Result<Ref, AnalysisError> {
    let pages = document.pages();
    if let Some(Obj::Ref(page)) = widget.dict.get_raw("P") {
        if pages.contains(page) {
            return Ok(*page);
        }
    }
    let Some(reference) = widget.reference else {
        return Err(plain("Could not find PDFRef for PDFObject"));
    };
    pages
        .into_iter()
        .find(|page| document.page_annotations(*page).iter().any(|annotation| annotation.as_ref_value() == Some(reference)))
        .ok_or_else(|| plain(format!("Could not find page for PDFRef {reference}")))
}

/// The appearance stream a widget shows now: its normal appearance, and for a check box or a radio button the stream of
/// the state the field is in (`Off` when it has none).
fn widget_appearance(store: &ObjectStore, field: &Field, widget: &Widget) -> Result<Ref, AnalysisError> {
    let normal = match store.lookup(&widget.dict, "AP") {
        Some(Obj::Dict(ap)) => ap.get_raw("N").cloned(),
        _ => None,
    };
    let chosen = match normal {
        Some(Obj::Dict(mapping)) if matches!(field.kind, FieldKind::Checkbox | FieldKind::Radio) => {
            let value = button_value(store, field.reference);
            mapping.get_raw(&value).or_else(|| mapping.get_raw("Off")).cloned()
        }
        Some(other) => Some(other),
        None => None,
    };
    match chosen {
        Some(Obj::Ref(reference)) => Ok(reference),
        _ => Err(plain(format!("Failed to extract appearance ref for: {}", field_name(store, field.reference)))),
    }
}

/// Takes `target` out of the array under `key` of `owner` (the array object itself when the entry is a reference to
/// one). Whether it was there.
fn remove_ref(store: &mut ObjectStore, owner: Ref, key: &str, target: Ref) -> bool {
    let indirect = store
        .dict(owner)
        .and_then(|dict| dict.get_raw(key))
        .and_then(Obj::as_ref_value)
        .filter(|reference| matches!(store.get(*reference), Some(Obj::Array(_))));
    let strip = |items: &mut Vec<Obj>| match items.iter().position(|item| item.as_ref_value() == Some(target)) {
        Some(at) => {
            items.remove(at);
            true
        }
        None => false,
    };
    if let Some(reference) = indirect {
        return store
            .modify(reference, |slot| match slot {
                Obj::Array(items) => strip(Arc::make_mut(items)),
                _ => false,
            })
            .unwrap_or(false);
    }
    let current = store.dict(owner).and_then(|dict| dict.get_raw(key)).cloned();
    let Some(Obj::Array(items)) = current else {
        return false;
    };
    let mut items = (*items).clone();
    let found = strip(&mut items);
    if found {
        store.modify_dict(owner, |dict| dict.set(key, Obj::Array(Arc::new(items))));
    }
    found
}

/// How many entries the array under `key` of `owner` has.
fn array_len(store: &ObjectStore, owner: Ref, key: &str) -> usize {
    match store.dict(owner).and_then(|dict| store.lookup(dict, key)) {
        Some(Obj::Array(items)) => items.len(),
        _ => 0,
    }
}

/// `acroForm.removeField(field)`: out of its parent's `Kids`, or out of the form's `Fields`; a parent left with no kids
/// goes too.
fn remove_from_form(form: &PdfForm, document: &mut PdfDocument, field: Ref) -> Result<(), AnalysisError> {
    let parent = document
        .store()
        .dict(field)
        .and_then(|dict| dict.get_raw("Parent"))
        .and_then(Obj::as_ref_value)
        .filter(|parent| document.store().dict(*parent).is_some());
    let removed = match parent {
        Some(parent) => remove_ref(document.store_mut(), parent, "Kids", field),
        None => {
            let acro = form.acro_form(document).map_err(form_error)?;
            remove_ref(document.store_mut(), acro, "Fields", field)
        }
    };
    if !removed {
        return Err(plain(format!("Tried to remove inexistent field {}", field_name(document.store(), field))));
    }
    if let Some(parent) = parent {
        if array_len(document.store(), parent, "Kids") == 0 {
            remove_from_form(form, document, parent)?;
        }
    }
    Ok(())
}

/// `form.flatten()`.
pub(crate) fn flatten_form(form: &mut PdfForm, document: &mut PdfDocument, wrapped: &Wrapped) -> Result<(), AnalysisError> {
    form.update_field_appearances(document, None).map_err(form_error)?;
    let mut rng = mixdog_pdf::embed::SuffixRng::default();
    for field in form.fields(document).map_err(form_error)? {
        let widgets = widgets_of(document.store(), field.reference).map_err(form_error)?;
        let mut pages: Vec<Ref> = Vec::new();
        let mut appearances: Vec<(Ref, Ref)> = Vec::new();
        for widget in &widgets {
            let page = widget_page(document, widget)?;
            let appearance = widget_appearance(document.store(), &field, widget)?;
            appearances.push((page, appearance));
            if !pages.contains(&page) {
                pages.push(page);
            }
            let rectangle = widget_rectangle(document.store(), widget).map_err(form_error)?;
            let mut ink = PageInk::new(document, page);
            let name = ink.xobject(&mut rng, "FlatWidget", appearance);
            ink.push(&format!(
                "q\n1 0 0 1 {} {} cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n/{name} Do\nQ\n",
                crate::forms::pdf_number(rectangle.x),
                crate::forms::pdf_number(rectangle.y),
            ));
            ink.commit(document, wrapped);
        }
        // `removeField`: each widget's page is asked to drop the widget's appearance reference (not normally in its
        // `Annots`, so a separate widget kid stays listed, pointing at nothing: the recording holds `null` for each), then
        // the widgets' pages drop the field's own reference (a field merged with its widget leaves the list).
        for (page, appearance) in appearances {
            remove_ref(document.store_mut(), page, "Annots", appearance);
        }
        for page in pages {
            remove_ref(document.store_mut(), page, "Annots", field.reference);
        }
        remove_from_form(form, document, field.reference)?;
        for widget in widgets.iter().filter_map(|widget| widget.reference).filter(|widget| *widget != field.reference) {
            document.store_mut().delete(widget);
        }
        document.store_mut().delete(field.reference);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_pdf::Dict;

    #[test]
    fn a_reference_is_taken_out_of_a_direct_and_an_indirect_array() {
        let mut store = ObjectStore::new();
        let (a, b) = (store.next_ref(), store.next_ref());
        let list = store.register(Obj::Array(Arc::new(vec![Obj::Ref(a), Obj::Ref(b)])));
        let mut dict = Dict::new();
        dict.set("Direct", Obj::Array(Arc::new(vec![Obj::Ref(a), Obj::Ref(b)])));
        dict.set("Indirect", Obj::Ref(list));
        let owner = store.register(Obj::Dict(Arc::new(dict)));
        assert!(remove_ref(&mut store, owner, "Direct", a));
        assert_eq!(array_len(&store, owner, "Direct"), 1);
        assert!(!remove_ref(&mut store, owner, "Direct", a));
        assert!(remove_ref(&mut store, owner, "Indirect", b));
        assert_eq!(array_len(&store, owner, "Indirect"), 1);
        assert!(!remove_ref(&mut store, owner, "Missing", a));
    }
}
