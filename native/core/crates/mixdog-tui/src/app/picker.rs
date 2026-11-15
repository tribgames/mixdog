//! The one picker panel type of the surface: what the four picker families and the slash dispatch paint into the single bottom
//! picker slot (`setPicker(panel)`), with the props the view draws it from.

use mixdog_tui_style::{Key, theme_color};
use mixdog_tui_widgets::picker::layout::FooterInput;
use mixdog_tui_widgets::picker::{Footer, IndexMode, PickerItem, PickerProps};

use crate::pickers::common::PickerPanel;
use crate::pickers::extensions::ExtPanel;
use crate::pickers::provider::ProviderPanel;
use crate::pickers::settings::panel::Panel;
use crate::surface::SurfaceClaim;
use crate::surface::epoch::PanelValue;
use crate::surface::latch::IndexModePanel;

/// What a [`SlashPanel`] is: the `slash-loading:<command>` frame, or the `/stop` confirmation under its claim.
#[derive(Clone, Debug, PartialEq)]
pub enum SlashPanelKind {
    Loading,
    StopConfirm { claim: SurfaceClaim },
}

/// A panel the slash dispatch paints itself (`slash-panel.mjs`, the `stop` command).
#[derive(Clone, Debug, PartialEq)]
pub struct SlashPanel {
    pub kind: SlashPanelKind,
    /// `_kind`: `slash-loading:<command>` for the loading frame, none for the confirmation.
    pub identity: String,
    pub title: String,
    pub description: String,
    pub items: Vec<PickerItem>,
    pub footer: Vec<FooterInput>,
}

impl SlashPanel {
    /// `slash-loading:<command>`: `Loading <title>...` with `Esc Close`.
    pub fn loading(command: &str, title: &str) -> Self {
        Self {
            kind: SlashPanelKind::Loading,
            identity: format!("slash-loading:{command}"),
            title: title.to_owned(),
            description: format!("Loading {}...", title.to_lowercase()),
            items: Vec::new(),
            footer: Vec::new(),
        }
    }

    /// The `/stop` confirmation: Cancel and Stop, the shell commands as its footer.
    pub fn stop_confirm(claim: SurfaceClaim, title: &str, commands: &[String]) -> Self {
        Self {
            kind: SlashPanelKind::StopConfirm { claim },
            identity: String::new(),
            title: title.to_owned(),
            description: String::new(),
            items: vec![PickerItem::new(crate::slash::STOP_CANCEL, "Cancel"), PickerItem::new(crate::slash::STOP_CONFIRM, "Stop")],
            footer: commands
                .iter()
                .map(|command| FooterInput::Object { glyph: "\u{b7}".to_owned(), color: Some(theme_color(Key::Warning)), text: command.clone() })
                .collect(),
        }
    }

    fn props(&self, columns: usize) -> PickerProps {
        let mut props = PickerProps::new(self.items.clone(), &self.title);
        props.description.clone_from(&self.description);
        props.columns = columns;
        match &self.kind {
            SlashPanelKind::Loading => {
                props.help = Some("Esc Close".to_owned());
                props.index_mode = IndexMode::Never;
                props.loading = true;
            }
            SlashPanelKind::StopConfirm { .. } => {
                props.index_mode = IndexMode::Always;
                props.label_width = Some(12);
                props.footer = Footer::Lines(self.footer.clone());
            }
        }
        props
    }
}

/// The picker on the surface.
#[derive(Clone, Debug)]
pub enum AppPicker {
    /// The model, web search, agents, workflow, output style, theme and effort pickers.
    Model(PickerPanel),
    /// The settings, auto-clear, profile, update and developer pickers.
    Settings(Panel),
    /// The provider setup picker and the onboarding wizard's panels.
    Provider(ProviderPanel),
    /// The MCP, skills, plugins, memory, project, resume and message-selector pickers.
    Ext(ExtPanel),
    /// The loading frame and the `/stop` confirmation.
    Slash(SlashPanel),
}

impl AppPicker {
    /// The widget props of the panel at `columns`; `selected` is the highlighted row (the provider panel's footer follows it).
    pub fn props(&self, columns: usize, selected: usize) -> PickerProps {
        match self {
            AppPicker::Model(panel) => panel.props(columns),
            AppPicker::Provider(panel) => panel.picker_props(columns, selected),
            AppPicker::Ext(panel) => panel.to_props(columns),
            AppPicker::Slash(panel) => panel.props(columns),
            AppPicker::Settings(panel) => {
                let mut props = PickerProps::new(panel.items.clone(), &panel.title);
                props.description.clone_from(&panel.description);
                props.help.clone_from(&panel.help);
                props.columns = columns;
                props.label_width = panel.label_width;
                props.meta_width = panel.meta_width;
                props.index_mode = panel.index_mode.unwrap_or_default();
                props.loading = panel.loading;
                props.confirm_buttons.clone_from(&panel.confirm_buttons);
                props.footer = Footer::Lines(panel.footer.clone());
                props
            }
        }
    }

    /// The row the panel opens highlighted on.
    pub fn initial_index(&self) -> usize {
        match self {
            AppPicker::Model(panel) => panel.initial_index.unwrap_or(0),
            AppPicker::Settings(panel) => panel.initial_index.unwrap_or(0),
            AppPicker::Provider(panel) => panel.initial_index,
            AppPicker::Ext(panel) => panel.initial_index,
            AppPicker::Slash(_) => 0,
        }
    }

    /// `pickerKey`: a new key resets the selection state of the view (the identity otherwise).
    pub fn picker_key(&self) -> String {
        match self {
            AppPicker::Model(panel) => panel.picker_key.clone().unwrap_or_default(),
            AppPicker::Settings(panel) => panel.picker_key.clone(),
            AppPicker::Provider(panel) => panel.picker_key.clone(),
            AppPicker::Ext(_) => String::new(),
            AppPicker::Slash(panel) => panel.identity.clone(),
        }
    }

    /// `picker.kind` of the shell layout (`PickerLayout.kind`): what the layout keeps the banner and height reserved for.
    pub fn layout_kind(&self) -> String {
        match self {
            AppPicker::Ext(panel) => panel.layout_kind.clone(),
            other => other.kind().to_owned(),
        }
    }

    /// The panel as the project list that still waits for its opener (`_projectInitialPending`).
    pub fn initial_pending(&self) -> bool {
        matches!(self, AppPicker::Ext(panel) if panel.initial_pending)
    }

    /// The request id of the project list on screen (`_projectRequestId`).
    pub fn project_request(&self) -> Option<u64> {
        match self {
            AppPicker::Ext(panel) if panel.kind == "project" => panel.request_id,
            _ => None,
        }
    }
}

impl PanelValue for AppPicker {
    fn kind(&self) -> &str {
        match self {
            AppPicker::Model(panel) => panel.kind(),
            AppPicker::Settings(panel) => panel.kind(),
            AppPicker::Provider(_) => "",
            AppPicker::Ext(panel) => panel.kind(),
            AppPicker::Slash(panel) => &panel.identity,
        }
    }

    fn title(&self) -> &str {
        match self {
            AppPicker::Model(panel) => panel.title(),
            AppPicker::Settings(panel) => panel.title(),
            AppPicker::Provider(panel) => &panel.title,
            AppPicker::Ext(panel) => panel.title(),
            AppPicker::Slash(panel) => &panel.title,
        }
    }
}

impl IndexModePanel for AppPicker {
    fn index_mode(&self) -> Option<IndexMode> {
        match self {
            AppPicker::Model(panel) => panel.index_mode(),
            AppPicker::Settings(panel) => panel.index_mode(),
            AppPicker::Provider(panel) => Some(panel.index_mode),
            AppPicker::Ext(panel) => panel.index_mode(),
            AppPicker::Slash(panel) => match panel.kind {
                SlashPanelKind::Loading => Some(IndexMode::Never),
                SlashPanelKind::StopConfirm { .. } => Some(IndexMode::Always),
            },
        }
    }

    fn with_index_mode(self, mode: IndexMode) -> Self {
        match self {
            AppPicker::Model(panel) => AppPicker::Model(panel.with_index_mode(mode)),
            AppPicker::Settings(panel) => AppPicker::Settings(panel.with_index_mode(mode)),
            AppPicker::Provider(panel) => AppPicker::Provider(ProviderPanel { index_mode: mode, ..panel }),
            AppPicker::Ext(panel) => AppPicker::Ext(panel.with_index_mode(mode)),
            slash @ AppPicker::Slash(_) => slash,
        }
    }
}
