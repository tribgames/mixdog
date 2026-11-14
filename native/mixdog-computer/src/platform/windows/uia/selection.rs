//! An item-scoped value write made exclusive first (Select-OwningItemAlone).

use super::element::UiaElement;
use std::time::Duration;
use windows::Win32::UI::Accessibility::*;

const SETTLE_ATTEMPTS: u32 = 10;
const SETTLE_MS: u64 = 20;
const UNREAD: &str = "selection could not be read";

/// An item of a selection container, as the exclusivity rule reads it.
trait Item {
    /// Whether the container holds several selected items; `None` when it
    /// reports no selection.
    fn container_multiple(&self) -> Result<Option<bool>, String>;
    fn selected(&self) -> Result<bool, String>;
    fn selected_count(&self) -> Result<usize, String>;
    fn select(&self) -> Result<(), String>;
}

/// Makes `item` the only selected one when its container can hold several,
/// polling for the selection to settle; the error says why it did not
/// (Select-OwningItemAlone's tail).
fn make_alone(item: &dyn Item, pause: &dyn Fn()) -> Result<(), String> {
    match item.container_multiple().map_err(|_| UNREAD)? {
        None => return Err("its container does not report the selection".into()),
        // A radio group or a single-select list keeps its state untouched.
        Some(false) => return Ok(()),
        Some(true) => {}
    }
    let alone = || -> Result<bool, String> { Ok(item.selected()? && item.selected_count()? == 1) };
    if alone().map_err(|_| UNREAD)? {
        return Ok(());
    }
    item.select().map_err(|_| UNREAD)?;
    for _ in 0..SETTLE_ATTEMPTS {
        if alone().map_err(|_| UNREAD)? {
            return Ok(());
        }
        pause();
    }
    let count = item.selected_count().map_err(|_| UNREAD)?;
    Err(format!("{count} items stay selected"))
}

struct UiaItem<'a> {
    owner: &'a UiaElement,
    pattern: IUIAutomationSelectionItemPattern,
}

impl UiaItem<'_> {
    /// The selection pattern of the item's container.
    fn container(&self) -> Result<Option<IUIAutomationSelectionPattern>, String> {
        // SAFETY: plain property and pattern reads on live elements.
        let Ok(container) = (unsafe { self.pattern.CurrentSelectionContainer() }) else {
            return Ok(None);
        };
        Ok(unsafe { container.GetCurrentPatternAs::<IUIAutomationSelectionPattern>(UIA_SelectionPatternId) }.ok())
    }
}

impl Item for UiaItem<'_> {
    fn container_multiple(&self) -> Result<Option<bool>, String> {
        let Some(selection) = self.container()? else {
            return Ok(None);
        };
        // SAFETY: a plain property read.
        unsafe { selection.CurrentCanSelectMultiple() }
            .map(|flag| Some(flag.as_bool()))
            .map_err(|error| error.message())
    }
    fn selected(&self) -> Result<bool, String> {
        // SAFETY: a plain property read.
        unsafe { self.pattern.CurrentIsSelected() }
            .map(|flag| flag.as_bool())
            .map_err(|error| error.message())
    }
    fn selected_count(&self) -> Result<usize, String> {
        let selection = self.container()?.ok_or(UNREAD)?;
        // SAFETY: plain reads of the container's current selection.
        unsafe { selection.GetCurrentSelection().and_then(|items| items.Length()) }
            .map(|length| length.max(0) as usize)
            .map_err(|error| error.message())
    }
    fn select(&self) -> Result<(), String> {
        self.owner.held(|| unsafe { self.pattern.Select() })
    }
}

/// The element's own selection item, else its parent's: a field inside a
/// selectable item (File Explorer's name cell) edits the selection, not the
/// item it sits in.
fn owning_item(element: &UiaElement) -> Option<IUIAutomationSelectionItemPattern> {
    // SAFETY: plain pattern queries and a tree-walker read on live elements.
    unsafe {
        if let Ok(pattern) = element.element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            return Some(pattern);
        }
        let parent = element.automation.ControlViewWalker().ok()?.GetParentElement(&element.element).ok()?;
        parent.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId).ok()
    }
}

/// Leaves the element's item the only one selected in its container, so a
/// value write cannot reach the other selected items.
pub(super) fn exclusive(element: &UiaElement) -> Result<(), String> {
    let Some(pattern) = owning_item(element) else {
        return Ok(());
    };
    make_alone(&UiaItem { owner: element, pattern }, &|| std::thread::sleep(Duration::from_millis(SETTLE_MS)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A container whose selected items are a count, and whose item is
    /// selected or not; `select` narrows to the item unless it is stuck.
    struct Fake {
        multiple: Option<bool>,
        selected: Cell<bool>,
        count: Cell<usize>,
        stuck: bool,
        calls: RefCell<Vec<&'static str>>,
    }

    impl Fake {
        fn new(multiple: Option<bool>, selected: bool, count: usize) -> Fake {
            Fake { multiple, selected: Cell::new(selected), count: Cell::new(count), stuck: false, calls: RefCell::new(Vec::new()) }
        }
    }

    impl Item for Fake {
        fn container_multiple(&self) -> Result<Option<bool>, String> {
            Ok(self.multiple)
        }
        fn selected(&self) -> Result<bool, String> {
            Ok(self.selected.get())
        }
        fn selected_count(&self) -> Result<usize, String> {
            Ok(self.count.get())
        }
        fn select(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("select");
            if !self.stuck {
                self.selected.set(true);
                self.count.set(1);
            }
            Ok(())
        }
    }

    #[test]
    fn a_single_selection_is_left_untouched() {
        let alone = Fake::new(Some(true), true, 1);
        assert_eq!(make_alone(&alone, &|| {}), Ok(()));
        let radio = Fake::new(Some(false), false, 1);
        assert_eq!(make_alone(&radio, &|| {}), Ok(()));
        assert!(alone.calls.borrow().is_empty() && radio.calls.borrow().is_empty());
    }

    #[test]
    fn a_multi_selection_is_narrowed_to_the_item() {
        let several = Fake::new(Some(true), true, 3);
        assert_eq!(make_alone(&several, &|| {}), Ok(()));
        assert_eq!(*several.calls.borrow(), ["select"]);
        assert_eq!(several.count.get(), 1);
    }

    #[test]
    fn a_selection_that_stays_wide_names_how_many_items_stay() {
        let stuck = Fake { stuck: true, ..Fake::new(Some(true), true, 2) };
        let pauses = Cell::new(0);
        let outcome = make_alone(&stuck, &|| pauses.set(pauses.get() + 1));
        assert_eq!(outcome, Err("2 items stay selected".into()));
        assert_eq!(pauses.get(), SETTLE_ATTEMPTS);
    }

    #[test]
    fn a_container_without_a_selection_refuses() {
        let outcome = make_alone(&Fake::new(None, true, 1), &|| {});
        assert_eq!(outcome, Err("its container does not report the selection".into()));
    }
}
