//! The panel the settings pickers paint: the data `own.paint({...})` took in Node, without the callbacks. The key handlers are
//! the methods of the picker that painted it ([`super::PickerController`]), which finds the row by its `value`.

use mixdog_tui_widgets::confirm_bar::ConfirmButton;
use mixdog_tui_widgets::picker::layout::FooterInput;
use mixdog_tui_widgets::picker::{IndexMode, PickerItem};
use serde_json::{Value, json};

use crate::surface::epoch::PanelValue;
use crate::surface::latch::IndexModePanel;

/// A picker panel (`{ title, description, help, indexMode, labelWidth, metaWidth, items, initialIndex, footer, confirmBar,
/// loading, pickerKey }`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Panel {
    pub title: String,
    pub description: String,
    pub help: Option<String>,
    pub index_mode: Option<IndexMode>,
    pub label_width: Option<usize>,
    pub meta_width: Option<usize>,
    pub items: Vec<PickerItem>,
    pub initial_index: Option<usize>,
    pub footer: Vec<FooterInput>,
    pub confirm_buttons: Vec<ConfirmButton>,
    pub loading: bool,
    pub picker_key: String,
}

impl PanelValue for Panel {
    /// The settings panels carry no `_kind`: the surface is known by its title.
    fn kind(&self) -> &str {
        ""
    }

    fn title(&self) -> &str {
        &self.title
    }
}

impl IndexModePanel for Panel {
    fn index_mode(&self) -> Option<IndexMode> {
        self.index_mode
    }

    fn with_index_mode(self, mode: IndexMode) -> Self {
        Self { index_mode: Some(mode), ..self }
    }
}

fn mode_name(mode: IndexMode) -> &'static str {
    match mode {
        IndexMode::Auto => "auto",
        IndexMode::Always => "always",
        IndexMode::Never => "never",
    }
}

impl Panel {
    /// The panel as the object a picker opened from this one receives (`handoffPanel`), in the member names Node used.
    pub fn to_json(&self) -> Value {
        let mut panel = json!({"title": self.title, "description": self.description});
        let map = panel.as_object_mut().expect("an object literal");
        if let Some(help) = &self.help {
            map.insert("help".into(), json!(help));
        }
        if let Some(mode) = self.index_mode {
            map.insert("indexMode".into(), json!(mode_name(mode)));
        }
        if !self.picker_key.is_empty() {
            map.insert("pickerKey".into(), json!(self.picker_key));
        }
        if self.loading {
            map.insert("loading".into(), json!(true));
        }
        map.insert("items".into(), Value::Array(self.items.iter().map(|item| json!({"value": item.value})).collect()));
        panel
    }

    /// The index `items.findIndex(value === focus)` clamped at 0, for a panel opened with a row to focus.
    pub fn focus_index(items: &[PickerItem], focus: Option<&str>) -> Option<usize> {
        focus.map(|focus| items.iter().position(|item| item.value == focus).unwrap_or(0))
    }
}
