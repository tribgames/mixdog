//! The rows of the main provider list (`provider-setup/provider-items.mjs` and `mainListItems` of
//! `provider-setup-picker.mjs`): the continue row, one row per provider in display rank then label order, and the client
//! refresh row.

use std::cmp::Ordering;

use mixdog_js::locale_compare_en_base;
use mixdog_tui_widgets::picker::PickerItem;
use serde_json::Value;

use super::ModelLabels;
use super::format::provider_status_label;
use super::panel::{PanelRow, ProviderRef, RowKind};
use crate::slash::notices::{truthy, value_text};

/// What the main list is built with (`options` of `openProviderSetupPicker`).
#[derive(Clone, Debug, Default)]
pub struct ListOptions {
    pub continue_label: String,
    pub continue_description: String,
    /// The wizard's confirm bar replaces the continue row.
    pub confirm_bar: bool,
}

fn array_of<'a>(setup: &'a Value, key: &str) -> &'a [Value] {
    setup
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn text_of(row: &Value, key: &str) -> String {
    row.get(key)
        .filter(|value| !value.is_null())
        .map(value_text)
        .unwrap_or_default()
}

/// `setup.managedByClient === true`.
pub fn managed_by_client(setup: &Value) -> bool {
    setup.get("managedByClient") == Some(&Value::Bool(true))
}

fn provider_row(prefix: &str, kind: RowKind, row: &Value) -> PanelRow {
    let id = text_of(row, "id");
    let name = text_of(row, "name");
    let mut item = PickerItem::new(&format!("{prefix}:{id}"), &name);
    item.meta = provider_status_label(row);
    let mut panel_row = PanelRow::new(item, kind);
    panel_row.provider = Some(ProviderRef {
        value: panel_row.item.value.clone(),
        id,
        name,
        row: row.clone(),
        authenticated: row.get("authenticated").is_some_and(truthy),
    });
    panel_row
}

/// `buildProviderItems(setup)`: the API-key and OAuth rows together (and the local rows when the client manages providers) in
/// display rank, then label order.
pub fn build_provider_items(setup: &Value, labels: &dyn ModelLabels) -> Vec<PanelRow> {
    let mut rows: Vec<PanelRow> = Vec::new();
    rows.extend(
        array_of(setup, "api")
            .iter()
            .map(|row| provider_row("api", RowKind::ApiKey, row)),
    );
    rows.extend(
        array_of(setup, "oauth")
            .iter()
            .map(|row| provider_row("oauth", RowKind::OAuth, row)),
    );
    if managed_by_client(setup) {
        rows.extend(
            array_of(setup, "local")
                .iter()
                .map(|row| provider_row("local", RowKind::Local, row)),
        );
    }
    let rank = |row: &PanelRow| -> f64 {
        match &row.provider {
            Some(provider) if !provider.id.is_empty() => labels.provider_display_rank(&provider.id),
            _ => labels.provider_display_rank(&row.item.value),
        }
    };
    rows.sort_by(|a, b| {
        let by_rank = rank(a) - rank(b);
        if by_rank != 0.0 && !by_rank.is_nan() {
            return if by_rank < 0.0 {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        locale_compare_en_base(&a.item.label, &b.item.label)
    });
    rows
}

/// `mainListItems(setup, options, canContinue)`: the continue row, the provider rows and the client refresh row.
pub fn main_list_items(
    setup: &Value,
    options: &ListOptions,
    can_continue: bool,
    labels: &dyn ModelLabels,
) -> Vec<PanelRow> {
    let mut rows = Vec::new();
    if can_continue && !options.confirm_bar {
        let label = if options.continue_label.is_empty() {
            "Continue setup"
        } else {
            &options.continue_label
        };
        let description = if options.continue_description.is_empty() {
            "return to setup"
        } else {
            &options.continue_description
        };
        let mut item = PickerItem::new("continue-setup", label);
        item.description = description.to_owned();
        rows.push(PanelRow::new(item, RowKind::Continue));
    }
    rows.extend(build_provider_items(setup, labels));
    if managed_by_client(setup) {
        rows.push(PanelRow::new(
            PickerItem::new("refresh-client-providers", "Refresh"),
            RowKind::RefreshClientProviders,
        ));
    }
    rows
}

/// `providerMainInitialIndex(items, value)`: the remembered provider row, or the top when none is remembered.
pub fn provider_main_initial_index(rows: &[PanelRow], value: &str) -> usize {
    if value.is_empty() {
        return 0;
    }
    rows.iter()
        .position(|row| row.item.value == value)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::pickers::provider::tests::FakeLabels;

    fn setup() -> Value {
        json!({
            "api": [
                {"id": "openai", "name": "OpenAI", "authenticated": true, "stored": true, "envName": "OPENAI_API_KEY"},
                {"id": "opencode-go", "name": "OpenCode Go", "authenticated": false, "url": "https://opencode.ai/keys"},
            ],
            "oauth": [{"id": "anthropic-oauth", "name": "Anthropic", "authenticated": false}],
            "local": [],
        })
    }

    #[test]
    fn the_main_list_is_the_continue_row_then_the_providers_in_rank_order() {
        let rows = main_list_items(&setup(), &ListOptions::default(), true, &FakeLabels);
        let values: Vec<&str> = rows.iter().map(PanelRow::value).collect();
        assert_eq!(
            values,
            [
                "continue-setup",
                "oauth:anthropic-oauth",
                "api:openai",
                "api:opencode-go"
            ]
        );
        assert_eq!(rows[0].item.label, "Continue setup");
        assert_eq!(rows[0].item.description, "return to setup");
        assert_eq!(rows[2].kind, RowKind::ApiKey);
        assert_eq!(rows[1].kind, RowKind::OAuth);
        assert_eq!(rows[2].item.meta, "Set");
    }

    #[test]
    fn the_confirm_bar_replaces_the_continue_row_and_labels_are_overridable() {
        let bar = ListOptions {
            confirm_bar: true,
            ..ListOptions::default()
        };
        assert_eq!(
            main_list_items(&setup(), &bar, true, &FakeLabels)[0].value(),
            "oauth:anthropic-oauth"
        );
        let custom = ListOptions {
            continue_label: "Back".into(),
            continue_description: "to the model".into(),
            confirm_bar: false,
        };
        let rows = main_list_items(&setup(), &custom, true, &FakeLabels);
        assert_eq!(
            (
                rows[0].item.label.as_str(),
                rows[0].item.description.as_str()
            ),
            ("Back", "to the model")
        );
        assert_ne!(
            main_list_items(&setup(), &custom, false, &FakeLabels)[0].value(),
            "continue-setup"
        );
    }

    #[test]
    fn a_client_managed_setup_lists_local_rows_and_a_refresh_row() {
        let managed = json!({
            "managedByClient": true, "api": [], "oauth": [],
            "local": [{"id": "mixdog-local", "name": "Local Provider", "detected": true, "enabled": true, "usable": true}],
        });
        let rows = main_list_items(&managed, &ListOptions::default(), false, &FakeLabels);
        let values: Vec<&str> = rows.iter().map(PanelRow::value).collect();
        assert_eq!(values, ["local:mixdog-local", "refresh-client-providers"]);
        assert_eq!(rows[0].kind, RowKind::Local);
        assert!(
            build_provider_items(&json!({"local": [{"id": "x", "name": "X"}]}), &FakeLabels)
                .is_empty()
        );
    }

    #[test]
    fn equal_ranks_fall_back_to_the_label_ignoring_case() {
        let setup = json!({"api": [{"id": "zz", "name": "banana"}, {"id": "yy", "name": "Apple"}]});
        let rows = build_provider_items(&setup, &FakeLabels);
        assert_eq!(
            rows.iter().map(PanelRow::value).collect::<Vec<_>>(),
            ["api:yy", "api:zz"]
        );
    }

    #[test]
    fn the_remembered_row_sets_the_initial_index() {
        let rows = main_list_items(&setup(), &ListOptions::default(), false, &FakeLabels);
        assert_eq!(provider_main_initial_index(&rows, ""), 0);
        assert_eq!(provider_main_initial_index(&rows, "api:opencode-go"), 2);
        assert_eq!(provider_main_initial_index(&rows, "api:gone"), 0);
    }
}
