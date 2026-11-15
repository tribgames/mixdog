//! `components/picker/use-picker-selection.mjs` and `use-picker-input.mjs`: the selected row, the confirm-bar focus and
//! the keys that move them, as a state that is stepped by events and tells the owner what to do.

use mixdog_term::input::KeyFlags;

use super::PickerItem;
use super::layout::clamp_item_index;

/// Two tab keys closer than this are one (a terminal that sends a tab twice).
const TAB_DEBOUNCE_MS: u64 = 120;

/// What the owner of the picker has to do after a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PickerAction {
    /// Nothing (the state may have changed: repaint).
    None,
    /// Enter on a list row: `onSelect(item.value, item)` for the item at this index.
    Select(usize),
    /// Escape: `onCancel()`.
    Cancel,
    /// `onLeft(item, index)` with the selected row.
    Left(usize),
    /// `onRight(item, index)` with the selected row.
    Right(usize),
    /// `onTab(item, index)` with the selected row.
    Tab(usize),
    /// Enter on a confirm button: `confirmBar.onConfirm(button, index)`.
    Confirm(usize),
    /// The sign-in copy key with a URL shown: copy the URL.
    CopyUrl,
    /// Any other key: `onKey(input, key, item, index)` with the selected row.
    Key(usize),
}

/// What the key handler needs to know about the picker beside its state.
#[derive(Clone, Copy, Debug, Default)]
pub struct PickerKeyContext {
    pub item_count: usize,
    /// The list rows that fit (`effectiveVisibleLimit`): the page size.
    pub effective_visible_limit: usize,
    pub confirm_buttons: usize,
    /// A sign-in URL is shown (the copy key is taken by the picker).
    pub has_detail: bool,
}

/// The selected row and the confirm-bar focus (-1 is list focus), with the memory that lets the selection follow an
/// item across a rebuilt list.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PickerState {
    pub selected_index: usize,
    pub confirm_focus: i64,
    last_tab_at: u64,
    memo_value: Option<String>,
    memo_initial: Option<usize>,
}

impl PickerState {
    /// The state at mount: the row of `initial_index`, then the effects that run once the picker is on screen.
    pub fn new(items: &[PickerItem], initial_index: Option<usize>) -> Self {
        let mut state = Self {
            selected_index: clamp_item_index(initial_index.unwrap_or(0), items.len()),
            confirm_focus: -1,
            last_tab_at: 0,
            memo_value: None,
            memo_initial: initial_index,
        };
        state.sync_items(items, initial_index);
        state
    }

    /// The effect that remembers the value of the selected item (it runs whenever the list or the selection changed).
    pub fn sync_selection(&mut self, items: &[PickerItem]) {
        if let Some(item) = items.get(self.selected_index) {
            self.memo_value = Some(item.value.clone());
        }
    }

    /// The effects that run when the item list or `initial_index` changed. Command pickers rebuild their list on every
    /// toggle, so the selection follows the previously selected item's value instead of snapping back to row 0; a row
    /// that no longer exists starts from the owner's `initial_index`; an `initial_index` that is new is honoured.
    pub fn sync_items(&mut self, items: &[PickerItem], initial_index: Option<usize>) {
        self.sync_selection(items);
        self.selected_index = match &self.memo_value {
            Some(value) => match items.iter().position(|item| &item.value == value) {
                Some(found) => found,
                None => {
                    self.memo_value = None;
                    clamp_item_index(initial_index.unwrap_or(0), items.len())
                }
            },
            None => self.selected_index.min(items.len().saturating_sub(1)),
        };
        match initial_index {
            None => self.memo_initial = None,
            Some(index) if self.memo_initial != Some(index) => {
                self.memo_initial = Some(index);
                self.selected_index = clamp_item_index(index, items.len());
            }
            Some(_) => {}
        }
    }

    /// The confirm bar changed shape or identity (a step switch): back to list focus.
    pub fn reset_confirm_focus(&mut self) {
        self.confirm_focus = -1;
    }

    /// One key. `now_ms` is the clock the tab debounce reads.
    pub fn handle_key(&mut self, input: &str, key: &KeyFlags, context: &PickerKeyContext, now_ms: u64) -> PickerAction {
        let total = context.item_count as i64;
        let buttons = context.confirm_buttons as i64;
        let has_confirm = buttons > 0;
        let selected = self.selected_index as i64;
        if key.up_arrow {
            if has_confirm {
                if self.confirm_focus > 0 {
                    self.confirm_focus -= 1;
                } else if self.confirm_focus == 0 {
                    self.confirm_focus = -1;
                    self.selected_index = (total - 1).max(0) as usize;
                } else if total == 0 || selected == 0 {
                    self.confirm_focus = buttons - 1;
                } else {
                    self.selected_index -= 1;
                }
            } else if total > 0 {
                self.selected_index = ((selected - 1 + total) % total) as usize;
            } else {
                self.selected_index = 0;
            }
            return PickerAction::None;
        }
        if key.down_arrow {
            if has_confirm {
                if self.confirm_focus >= 0 {
                    if self.confirm_focus < buttons - 1 {
                        self.confirm_focus += 1;
                    } else {
                        self.confirm_focus = -1;
                        self.selected_index = 0;
                    }
                } else if total == 0 || selected == total - 1 {
                    self.confirm_focus = 0;
                } else {
                    self.selected_index += 1;
                }
            } else if total > 0 {
                self.selected_index = ((selected + 1) % total) as usize;
            } else {
                self.selected_index = 0;
            }
            return PickerAction::None;
        }
        if key.page_up {
            self.selected_index = self.selected_index.saturating_sub(context.effective_visible_limit);
            return PickerAction::None;
        }
        if key.page_down {
            self.selected_index = (self.selected_index + context.effective_visible_limit).min(context.item_count.saturating_sub(1));
            return PickerAction::None;
        }
        if key.home {
            self.selected_index = 0;
            return PickerAction::None;
        }
        if key.end {
            self.selected_index = context.item_count.saturating_sub(1);
            return PickerAction::None;
        }
        if key.left_arrow {
            if has_confirm {
                self.confirm_focus = if self.confirm_focus <= 0 { -1 } else { self.confirm_focus - 1 };
                return PickerAction::None;
            }
            return PickerAction::Left(self.selected_index);
        }
        if key.right_arrow {
            if has_confirm {
                self.confirm_focus = if self.confirm_focus < 0 { 0 } else { (buttons - 1).min(self.confirm_focus + 1) };
                return PickerAction::None;
            }
            return PickerAction::Right(self.selected_index);
        }
        if key.tab || input == "\t" {
            if now_ms.wrapping_sub(self.last_tab_at) < TAB_DEBOUNCE_MS {
                return PickerAction::None;
            }
            self.last_tab_at = now_ms;
            if has_confirm {
                self.confirm_focus = if self.confirm_focus < 0 {
                    0
                } else if self.confirm_focus + 1 > buttons - 1 {
                    -1
                } else {
                    self.confirm_focus + 1
                };
                return PickerAction::None;
            }
            return PickerAction::Tab(self.selected_index);
        }
        if key.return_key {
            if has_confirm && self.confirm_focus >= 0 {
                return if self.confirm_focus < buttons { PickerAction::Confirm(self.confirm_focus as usize) } else { PickerAction::None };
            }
            return if self.selected_index < context.item_count { PickerAction::Select(self.selected_index) } else { PickerAction::None };
        }
        if key.escape {
            return PickerAction::Cancel;
        }
        if key.ctrl && (input == "c" || input == "C") {
            return PickerAction::None;
        }
        if context.has_detail && crate::sign_in_url::is_sign_in_copy_key(input, key) {
            return PickerAction::CopyUrl;
        }
        PickerAction::Key(self.selected_index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(values: &[&str]) -> Vec<PickerItem> {
        values.iter().map(|value| PickerItem::new(value, value)).collect()
    }

    fn press(state: &mut PickerState, context: &PickerKeyContext, key: KeyFlags, now: u64) -> PickerAction {
        state.handle_key("", &key, context, now)
    }

    fn up() -> KeyFlags {
        KeyFlags { up_arrow: true, ..KeyFlags::default() }
    }

    fn down() -> KeyFlags {
        KeyFlags { down_arrow: true, ..KeyFlags::default() }
    }

    #[test]
    fn up_and_down_wrap_at_the_ends() {
        let list = items(&["a", "b", "c"]);
        let context = PickerKeyContext { item_count: 3, effective_visible_limit: 8, ..PickerKeyContext::default() };
        let mut state = PickerState::new(&list, None);
        press(&mut state, &context, up(), 1000);
        assert_eq!(state.selected_index, 2);
        press(&mut state, &context, down(), 1000);
        assert_eq!(state.selected_index, 0);
    }

    #[test]
    fn the_confirm_bar_joins_the_vertical_loop() {
        let list = items(&["a", "b"]);
        let context = PickerKeyContext { item_count: 2, effective_visible_limit: 8, confirm_buttons: 2, ..PickerKeyContext::default() };
        let mut state = PickerState::new(&list, Some(1));
        press(&mut state, &context, down(), 0);
        assert_eq!((state.selected_index, state.confirm_focus), (1, 0));
        press(&mut state, &context, down(), 0);
        press(&mut state, &context, down(), 0);
        assert_eq!((state.selected_index, state.confirm_focus), (0, -1));
        press(&mut state, &context, up(), 0);
        assert_eq!(state.confirm_focus, 1);
        press(&mut state, &context, up(), 0);
        press(&mut state, &context, up(), 0);
        assert_eq!((state.selected_index, state.confirm_focus), (1, -1));
        let enter = KeyFlags { return_key: true, ..KeyFlags::default() };
        state.confirm_focus = 1;
        assert_eq!(press(&mut state, &context, enter, 0), PickerAction::Confirm(1));
    }

    #[test]
    fn page_keys_home_and_end_clamp_and_enter_chooses_the_row() {
        let list = items(&["a", "b", "c", "d", "e"]);
        let context = PickerKeyContext { item_count: 5, effective_visible_limit: 2, ..PickerKeyContext::default() };
        let mut state = PickerState::new(&list, None);
        press(&mut state, &context, KeyFlags { page_down: true, ..KeyFlags::default() }, 0);
        press(&mut state, &context, KeyFlags { page_down: true, ..KeyFlags::default() }, 0);
        press(&mut state, &context, KeyFlags { page_down: true, ..KeyFlags::default() }, 0);
        assert_eq!(state.selected_index, 4);
        press(&mut state, &context, KeyFlags { home: true, ..KeyFlags::default() }, 0);
        assert_eq!(state.selected_index, 0);
        press(&mut state, &context, KeyFlags { end: true, ..KeyFlags::default() }, 0);
        assert_eq!(press(&mut state, &context, KeyFlags { return_key: true, ..KeyFlags::default() }, 0), PickerAction::Select(4));
        assert_eq!(press(&mut state, &context, KeyFlags { escape: true, ..KeyFlags::default() }, 0), PickerAction::Cancel);
    }

    #[test]
    fn a_second_tab_inside_the_debounce_is_dropped() {
        let list = items(&["a"]);
        let context = PickerKeyContext { item_count: 1, effective_visible_limit: 8, ..PickerKeyContext::default() };
        let mut state = PickerState::new(&list, None);
        let tab = KeyFlags { tab: true, ..KeyFlags::default() };
        assert_eq!(press(&mut state, &context, tab.clone(), 500), PickerAction::Tab(0));
        assert_eq!(press(&mut state, &context, tab.clone(), 560), PickerAction::None);
        assert_eq!(press(&mut state, &context, tab, 700), PickerAction::Tab(0));
    }

    #[test]
    fn the_selection_follows_its_value_when_the_rebuilt_list_no_longer_reaches_its_row() {
        let list = items(&["a", "b", "c"]);
        let mut state = PickerState::new(&list, None);
        let context = PickerKeyContext { item_count: 3, effective_visible_limit: 8, ..PickerKeyContext::default() };
        press(&mut state, &context, down(), 0);
        state.sync_selection(&list);
        // The list shrank past row 1: the remembered value "b" is now at row 0.
        state.sync_items(&items(&["b"]), None);
        assert_eq!(state.selected_index, 0);
        // A list of the same length keeps the row, whatever is on it.
        state.sync_items(&items(&["x", "y"]), None);
        assert_eq!(state.selected_index, 0);
        // The remembered row is gone from a shorter list: back to the owner's index.
        state.selected_index = 3;
        state.sync_items(&items(&["p", "q"]), Some(1));
        assert_eq!(state.selected_index, 1);
    }

    #[test]
    fn control_c_is_left_to_the_global_copy_and_other_keys_go_to_the_owner() {
        let list = items(&["a"]);
        let context = PickerKeyContext { item_count: 1, effective_visible_limit: 8, has_detail: true, ..PickerKeyContext::default() };
        let mut state = PickerState::new(&list, None);
        let ctrl = KeyFlags { ctrl: true, ..KeyFlags::default() };
        assert_eq!(state.handle_key("c", &ctrl, &context, 0), PickerAction::None);
        assert_eq!(state.handle_key("y", &ctrl, &context, 0), PickerAction::CopyUrl);
        assert_eq!(state.handle_key("x", &KeyFlags::default(), &context, 0), PickerAction::Key(0));
    }
}
