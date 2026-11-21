//! The panel the provider setup and the onboarding wizard paint: the props of the picker plus what each row means. Every panel names
//! its [`PanelOwner`] and every row its [`RowKind`], and the application answers a key by calling `provider::select`, `cancel`,
//! `highlight` or `confirm` with the row index, which is the one place the meaning of a row is decided.

use mixdog_tui_widgets::confirm_bar::ConfirmButton;
use mixdog_tui_widgets::picker::layout::FooterInput;
use mixdog_tui_widgets::picker::{Footer, IndexMode, PickerItem, PickerProps};
use serde_json::Value;

use super::format::provider_status_footer;

/// Who answers the keys of a panel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PanelOwner {
    /// The provider setup picker and its action, progress and result panels.
    ProviderSetup,
    /// Step 2 of the wizard (one row per routing slot).
    OnboardingModels,
    /// Step 2's model picker of one slot (`lead`, `webSearch` or an agent id).
    OnboardingRoleModel(String),
}

/// What a row of a panel is (`_type`, `_action`, `_default`, `_model`, `_target` of the Node rows).
#[derive(Clone, Debug, PartialEq)]
pub enum RowKind {
    /// The "Checking Providers" placeholder.
    Loading,
    /// The continue row of the main list.
    Continue,
    /// A provider row of the main list.
    ApiKey,
    OAuth,
    Local,
    RefreshClientProviders,
    SetKey,
    GetKey,
    ForgetKey,
    LoginOAuth,
    ForgetOAuth,
    /// The "Waiting for login" row and the Back row of the progress panel.
    Waiting,
    Back,
    /// The Success row of a finished login.
    Success,
    /// The two key types of Vertex AI.
    VertexServiceAccount,
    VertexApiKey,
    /// A routing slot of wizard Step 2 (`lead`, `webSearch` or an agent id).
    Slot(String),
    /// The "Default" row of a role picker.
    DefaultRoute,
    /// A model row of a role picker (the model record).
    Model(Value),
}

/// The provider a row stands for (`_providerId`, `_providerName`, `_provider`, `_authenticated`).
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderRef {
    /// The row value of the main list (`api:<id>`, `oauth:<id>`, `local:<id>`).
    pub value: String,
    pub id: String,
    pub name: String,
    /// The setup row as the store gave it.
    pub row: Value,
    pub authenticated: bool,
}

/// One row: what the picker draws and what it means.
#[derive(Clone, Debug, PartialEq)]
pub struct PanelRow {
    pub item: PickerItem,
    pub kind: RowKind,
    pub provider: Option<ProviderRef>,
}

impl PanelRow {
    pub fn new(item: PickerItem, kind: RowKind) -> Self {
        Self { item, kind, provider: None }
    }

    pub fn value(&self) -> &str {
        &self.item.value
    }
}

/// The footer of a panel.
#[derive(Clone, Debug, PartialEq)]
pub enum PanelFooter {
    None,
    /// The status footer of the highlighted provider row (the main list).
    HighlightedProvider,
    /// Fixed lines (a provider's status, the device-code warning).
    Lines(Vec<FooterInput>),
}

/// The confirm bar of a wizard step root screen.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfirmBar {
    pub buttons: Vec<ConfirmButton>,
}

/// A panel as painted. `picker_key` is the identity the surface compares to decide a handover.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderPanel {
    pub owner: PanelOwner,
    pub title: String,
    pub description: String,
    /// The sign-in URL drawn complete under the panel.
    pub detail: String,
    pub footer: PanelFooter,
    pub footer_gap_rows: Option<usize>,
    pub help: Option<String>,
    pub index_mode: IndexMode,
    pub label_width: Option<usize>,
    pub meta_width: Option<usize>,
    pub picker_key: String,
    pub initial_index: usize,
    pub items: Vec<PanelRow>,
    pub confirm_bar: Option<ConfirmBar>,
    /// A placeholder frame that reserves the geometry of the real list.
    pub loading: bool,
}

impl ProviderPanel {
    /// A panel of `owner` with the Node defaults (`indexMode` auto, `initialIndex` 0).
    pub fn new(owner: PanelOwner, title: &str, picker_key: &str, items: Vec<PanelRow>) -> Self {
        Self {
            owner,
            title: title.to_owned(),
            description: String::new(),
            detail: String::new(),
            footer: PanelFooter::None,
            footer_gap_rows: None,
            help: None,
            index_mode: IndexMode::Auto,
            label_width: None,
            meta_width: None,
            picker_key: picker_key.to_owned(),
            initial_index: 0,
            items,
            confirm_bar: None,
            loading: false,
        }
    }

    /// The footer lines for the row at `selected`.
    pub fn footer_lines(&self, selected: usize) -> Vec<FooterInput> {
        match &self.footer {
            PanelFooter::None => Vec::new(),
            PanelFooter::Lines(lines) => lines.clone(),
            PanelFooter::HighlightedProvider => provider_status_footer(self.items.get(selected).and_then(|row| row.provider.as_ref()).map(|p| &p.row)),
        }
    }

    /// The props the picker widget draws this panel from, with the footer of the row at `selected`.
    pub fn picker_props(&self, columns: usize, selected: usize) -> PickerProps {
        let mut props = PickerProps::new(self.items.iter().map(|row| row.item.clone()).collect(), &self.title);
        props.description.clone_from(&self.description);
        props.detail.clone_from(&self.detail);
        props.footer = Footer::Lines(self.footer_lines(selected));
        props.help.clone_from(&self.help);
        props.columns = columns;
        props.label_width = self.label_width;
        props.meta_width = self.meta_width;
        if let Some(rows) = self.footer_gap_rows {
            props.footer_gap_rows = rows;
        }
        props.index_mode = self.index_mode;
        props.loading = self.loading;
        props.confirm_buttons = self.confirm_bar.as_ref().map(|bar| bar.buttons.clone()).unwrap_or_default();
        props
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_main_list_footer_follows_the_highlighted_provider() {
        let mut row = PanelRow::new(PickerItem::new("api:a", "A"), RowKind::ApiKey);
        row.provider = Some(ProviderRef {
            value: "api:a".into(),
            id: "a".into(),
            name: "A".into(),
            row: json!({"authenticated": true, "type": "api-key"}),
            authenticated: true,
        });
        let mut panel = ProviderPanel::new(PanelOwner::ProviderSetup, "Providers", "k", vec![row, PanelRow::new(PickerItem::new("x", "X"), RowKind::Continue)]);
        panel.footer = PanelFooter::HighlightedProvider;
        assert_eq!(panel.footer_lines(0).len(), 1);
        assert!(panel.footer_lines(1).is_empty());
        assert!(panel.footer_lines(9).is_empty());
    }
}
