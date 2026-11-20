//! The project selector and its create, rename and enter flow (`project-picker.mjs` and `project-picker/{picker-state,
//! create-flow,project-service}.mjs`). The project registry and the path operations are store calls (`listProjects`,
//! `addProject`, `setCwd`); the terminal UI keeps only the OS-native folder chooser (`mixdog_term::os::pick_folder`, through
//! the host).

use mixdog_term::os::FolderPickOptions;
use mixdog_tui_widgets::picker::IndexMode;
use serde_json::{Value, json};

use super::Extensions;
use super::panel::{Action, ExtItem, ExtPanel, ExtensionsHost, Handler, claim, close_now, service_call};
use crate::slash::host::{PromptSurface, TextPrompt, Tone};
use crate::slash::notices::{project_name_from_path, truthy, value_text};

/// The row value of the trailing current-directory shortcut.
const USE_CURRENT: &str = "__use_current__";

fn picker_help(loading: bool, initial_entry: bool) -> &'static str {
    if loading {
        return "Waiting for the project service\u{2026}";
    }
    if initial_entry {
        "\u{2191}/\u{2193} Select \u{b7} Enter Open \u{b7} c Create \u{b7} r Rename"
    } else {
        "\u{2191}/\u{2193} Select \u{b7} Enter Open \u{b7} c Create \u{b7} r Rename \u{b7} Esc Back"
    }
}

/// The picker panel record: registered projects, the trailing current-path shortcut. While loading, no row shows.
fn picker_state(current_path: &str, initial_entry: bool, projects: &[Value], loading: bool, request_id: Option<u64>) -> ExtPanel {
    let mut items = Vec::new();
    if !loading {
        for project in projects {
            let Some(path) = project.get("path").filter(|path| truthy(path)).map(value_text) else { continue };
            let label = project.get("name").filter(|name| truthy(name)).map_or_else(|| path.clone(), value_text);
            let mut item = ExtItem::new(&path, &label, "", Action::Project(project.clone()));
            item.meta = path;
            items.push(item);
        }
        // Last row: the implicit current-directory shortcut (not persisted).
        let mut current = ExtItem::new(USE_CURRENT, "Current Path", "", Action::Current);
        current.meta = current_path.to_owned();
        items.push(current);
    }
    let handler = Handler::Project { initial_entry, current_path: current_path.to_owned() };
    let description = if loading { "Loading projects from the session\u{2026}" } else { "Choose a project." };
    ExtPanel {
        help: Some(picker_help(loading, initial_entry).to_owned()),
        index_mode: Some(IndexMode::Always),
        label_width: Some(18),
        meta_width: Some(40),
        request_id,
        initial_pending: loading && initial_entry,
        ..ExtPanel::new("Project", description, items, handler).with_kind("project").with_layout_kind("project")
    }
}

/// `buildProjectPickerState({ initialEntry: true, loading: true })`: the project list the first screen starts with when the
/// session is empty. The application then runs [`Extensions::open_project`] for it ([`ExtPanel::initial_pending`]).
pub fn initial_project_panel(cwd: &str) -> ExtPanel {
    picker_state(cwd, true, &[], true, None)
}

impl Extensions {
    /// `openProjectPicker({ initialEntry })`: the list always opens (even when empty and when the service fails) and lists the
    /// registered projects first, then the `Current Path` shortcut. Answers the projects read.
    pub fn open_project(&mut self, host: &mut dyn ExtensionsHost, initial_entry: bool) -> Vec<Value> {
        let mut own = claim(host);
        host.set_prompt(PromptSurface::Provider, None);
        host.set_prompt(PromptSurface::Settings, None);
        host.clear_context(&mut own);
        host.close_usage_panel();
        self.project_requests += 1;
        let request = self.project_requests;
        let current_path = host.cwd();
        host.paint(&mut own, Some(picker_state(&current_path, initial_entry, &[], true, Some(request))));
        let (projects, failure) = match service_call(host, "listProjects", json!([])) {
            Ok(Value::Array(projects)) => (projects, None),
            Ok(_) => (Vec::new(), None),
            Err(error) => (Vec::new(), Some(error)),
        };
        // The list paints only while the loading frame of this very request is still the picker on screen.
        if host.project_request() == Some(request) {
            host.paint(&mut own, Some(picker_state(&current_path, initial_entry, &projects, false, Some(request))));
        }
        if let Some(error) = failure {
            host.push_notice(&format!("project list failed: {error}"), Tone::Error);
        }
        projects
    }

    /// Enter on a project row: the current path is entered without being registered.
    pub(super) fn project_select(&mut self, host: &mut dyn ExtensionsHost, initial_entry: bool, current_path: &str, item: &ExtItem) {
        match &item.action {
            Action::Current => {
                self.enter_project(host, current_path, !initial_entry, false);
            }
            Action::Project(project) => {
                if let Some(path) = project.get("path").filter(|path| truthy(path)) {
                    self.enter_project(host, &value_text(path), !initial_entry, true);
                }
            }
            _ => {}
        }
    }

    /// `c` creates a project, `r` renames the highlighted registered project (not the current-dir shortcut).
    pub(super) fn project_key(&mut self, host: &mut dyn ExtensionsHost, ch: char, item: Option<&ExtItem>) {
        match ch {
            'c' | 'C' => self.begin_new_project(host),
            'r' | 'R' => {
                if let Some(Action::Project(project)) = item.map(|item| &item.action) {
                    begin_rename_project(host, project);
                }
            }
            _ => {}
        }
    }

    /// `registerProject(path)`: registers a project in the picker list without switching this session's cwd.
    pub fn register_project(&mut self, host: &mut dyn ExtensionsHost, raw_path: &str) -> bool {
        let path = mixdog_js::js_trim(raw_path);
        if path.is_empty() {
            host.push_notice("project path is required", Tone::Warn);
            return false;
        }
        // Post-write delegation: the list reopen must still own the surface (the add can ack long after an Esc).
        let own = claim(host);
        match service_call(host, "addProject", json!([path])) {
            Ok(project) => {
                if let Some(name) = project.get("name").filter(|name| truthy(name)) {
                    host.push_notice(&format!("project added: {}", value_text(name)), Tone::Info);
                }
                if host.owns(own) {
                    self.open_project(host, false);
                }
                true
            }
            Err(error) => {
                host.push_notice(&format!("project add failed: {error}"), Tone::Error);
                false
            }
        }
    }

    /// `enterProject(path, { notice, register })`: switches the active working directory to a registered or created project
    /// path. The cwd is switched first and the project persisted only once the runtime accepts it, so an invalid or missing
    /// path can never be written to the project list.
    pub fn enter_project(&mut self, host: &mut dyn ExtensionsHost, raw_path: &str, notice: bool, register: bool) -> bool {
        let path = mixdog_js::js_trim(raw_path);
        if path.is_empty() {
            host.push_notice("project path is required", Tone::Warn);
            return false;
        }
        close_now(host);
        let options = json!({"notice": notice, "message": format!("Project set: {}", project_name_from_path(path))});
        let resolved = match service_call(host, "setCwd", json!([path, options])) {
            Ok(resolved) => resolved,
            Err(error) => {
                host.push_notice(&format!("project switch failed: {error}"), Tone::Error);
                return false;
            }
        };
        if register {
            let target = if truthy(&resolved) { value_text(&resolved) } else { path.to_owned() };
            if let Err(error) = service_call(host, "addProject", json!([target])) {
                host.push_notice(&format!("project switch failed: {error}"), Tone::Error);
                return false;
            }
        }
        true
    }

    /// `beginNewProject()`: opens the OS-native folder dialog. The project picker stays mounted (swapped to an inert
    /// `Opening folder picker...` panel) while the dialog is open, so the banner and the layout stay put and the prompt stays
    /// disabled. A chosen folder is registered, a cancel returns to the list, and when no dialog exists the path is typed.
    pub fn begin_new_project(&mut self, host: &mut dyn ExtensionsHost) {
        // The dialog can stay open for minutes: the claim taken here is what every branch below proves ownership with.
        let mut own = claim(host);
        host.set_prompt(PromptSurface::Provider, None);
        host.clear_context(&mut own);
        host.close_usage_panel();
        // An overlay stays up (`kind` project, so the banner and the height stay reserved; it has no `_kind`) but is inert: no selectable rows.
        let mut opening = ExtPanel::loading("Project", "Opening folder picker\u{2026} choose a folder in the dialog window.", Handler::ProjectOpening)
            .with_layout_kind("project");
        opening.help = Some("Waiting for the system folder dialog\u{2026}".to_owned());
        opening.index_mode = Some(IndexMode::Never);
        host.paint(&mut own, Some(opening));
        let options = FolderPickOptions { title: Some("Select a project folder".to_owned()), initial_path: host.cwd() };
        let result = host.pick_folder(&options);
        if !host.owns(own) {
            return;
        }
        if !result.available {
            // No native dialog on this system: manual typing.
            begin_new_project_manual(host, result.reason.as_deref().unwrap_or(""));
            return;
        }
        match result.path.filter(|path| !path.is_empty()) {
            // The user cancelled the dialog: back to the list.
            None => {
                self.open_project(host, false);
            }
            Some(path) => {
                self.register_project(host, &path);
            }
        }
    }
}

/// `beginNewProjectManual(reason)`: the manual path-entry flow, the fallback when no native folder dialog is available. The
/// user types a directory path; on submit it is registered (and offered to be created if missing).
pub fn begin_new_project_manual(host: &mut dyn ExtensionsHost, reason: &str) {
    let mut own = claim(host);
    host.clear_context(&mut own);
    host.close_claim(&mut own);
    host.set_prompt(PromptSurface::Provider, None);
    host.close_usage_panel();
    let lead = if reason.is_empty() { String::new() } else { format!("{reason} ") };
    let mut prompt = TextPrompt::new("project-new");
    prompt.label = "New project \u{b7} Path".to_owned();
    prompt.hint = format!("{lead}Type a directory path. The folder name becomes the project name.");
    host.set_prompt(PromptSurface::Settings, Some(prompt));
}

/// `beginRenameProject(project)`: opens a text prompt seeded with the current display name; submitting persists it through
/// `renameProject` and returns to the project picker. The path is never changed.
pub fn begin_rename_project(host: &mut dyn ExtensionsHost, project: &Value) {
    let Some(path) = project.get("path").filter(|path| truthy(path)).map(value_text) else { return };
    let mut own = claim(host);
    host.clear_context(&mut own);
    host.close_claim(&mut own);
    host.set_prompt(PromptSurface::Provider, None);
    host.close_usage_panel();
    let mut prompt = TextPrompt::new("project-rename");
    prompt.label = "Rename project".to_owned();
    prompt.hint = "Set a display name. Leave blank to reset to the folder name.".to_owned();
    prompt.fields.insert("projectPath".to_owned(), Value::String(path));
    prompt.initial_value = Some(project.get("name").filter(|name| truthy(name)).map(value_text).unwrap_or_default());
    host.set_prompt(PromptSurface::Settings, Some(prompt));
}
