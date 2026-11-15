//! The sessions map and the document index of `core/office-core.mjs` (`sessions`, `documentSessions`,
//! `indexOfficeSession`, `officeSessionForDocument`, `releaseOfficeSession`, `registerOfficeSession`), and the worker's
//! pin rule (`sessionsByThread` of the ext-host's `office.run`).
//!
//! A session lives behind a [`SessionHandle`] shared by the map and by whoever is running an action on it, as Node's one
//! object is. The document index maps a document path (absolute; lower-cased on Windows, where two spellings are one
//! file) to the id of the session that holds it. Both tables keep insertion order, as a `Map` does. The tables' own
//! lock is never held while a session's lock is taken.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use indexmap::IndexMap;
use mixdog_office_design::library::{Context, Environment};
use mixdog_statefile::WriteLane;

use super::Session;
use super::design::persist_session_binding;

/// A session shared between the registry and the action running on it.
pub type SessionHandle = Arc<Mutex<Session>>;

/// The session behind a handle. A panic in an earlier action does not make the session unreadable.
pub fn lock(handle: &SessionHandle) -> MutexGuard<'_, Session> {
    handle.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `documentSessionKey(path)`: the absolute path, lower-cased on Windows.
pub fn document_session_key(env: &Environment, path: &str) -> String {
    let canonical = env.resolve(path).to_string_lossy().into_owned();
    if env.windows { mixdog_js::js_to_lowercase(&canonical) } else { canonical }
}

#[derive(Default)]
struct Tables {
    sessions: IndexMap<String, SessionHandle>,
    documents: IndexMap<String, String>,
}

/// The open sessions of the engine. Clones share the same tables.
#[derive(Clone, Default)]
pub struct Registry {
    tables: Arc<Mutex<Tables>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    fn tables(&self) -> MutexGuard<'_, Tables> {
        self.tables.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `registerOfficeSession(session)`: the session's design binding is persisted (a failure is said on the session's
    /// library and design, not raised) and the session is published.
    pub fn register<L: WriteLane>(&self, cx: &Context<'_, L>, session: Session) -> SessionHandle {
        let handle = Arc::new(Mutex::new(session));
        self.register_handle(cx, &handle);
        handle
    }

    /// [`Registry::register`] for a session that is already shared.
    pub fn register_handle<L: WriteLane>(&self, cx: &Context<'_, L>, handle: &SessionHandle) {
        persist_session_binding(cx, &mut lock(handle));
        self.index(cx.env, handle);
    }

    /// `indexOfficeSession(session)`: published under its id and its document path.
    pub fn index(&self, env: &Environment, handle: &SessionHandle) {
        let (id, target) = {
            let session = lock(handle);
            (session.id.clone(), session.target.clone())
        };
        let key = document_session_key(env, &target);
        let mut tables = self.tables();
        tables.sessions.insert(id.clone(), Arc::clone(handle));
        tables.documents.insert(key, id);
    }

    /// `officeSessionForDocument(target)`: the live session holding a document path.
    pub fn for_document(&self, env: &Environment, target: &str) -> Option<SessionHandle> {
        let key = document_session_key(env, target);
        let tables = self.tables();
        tables.documents.get(&key).and_then(|id| tables.sessions.get(id)).cloned()
    }

    /// `releaseOfficeSession(session)`: dropped from both tables. The document index releases the path only when this
    /// session still owns it, so a newer session keeps its claim.
    pub fn release(&self, env: &Environment, handle: &SessionHandle) {
        let (id, target) = {
            let session = lock(handle);
            (session.id.clone(), session.target.clone())
        };
        let key = document_session_key(env, &target);
        let mut tables = self.tables();
        tables.sessions.shift_remove(&id);
        if tables.documents.get(&key) == Some(&id) {
            tables.documents.shift_remove(&key);
        }
    }

    /// `materializeWorkingCopy`'s index step: the document index drops the path the session held (when it still names this session),
    /// the session takes `target`, and the index names it under the new path. The session keeps its place in the sessions map.
    pub fn retarget(&self, env: &Environment, handle: &SessionHandle, target: String) {
        let (id, held) = {
            let session = lock(handle);
            (session.id.clone(), session.target.clone())
        };
        let (old_key, new_key) = (document_session_key(env, &held), document_session_key(env, &target));
        {
            let mut tables = self.tables();
            if tables.documents.get(&old_key) == Some(&id) {
                tables.documents.shift_remove(&old_key);
            }
            tables.documents.insert(new_key, id);
        }
        lock(handle).target = target;
    }

    /// `sessions.delete(id)`: the session leaves the map and the document index is left as it is (discarding a recovered
    /// transaction does this).
    pub fn remove(&self, id: &str) -> Option<SessionHandle> {
        self.tables().sessions.shift_remove(id)
    }

    /// `sessions.get(id)`.
    pub fn get(&self, id: &str) -> Option<SessionHandle> {
        self.tables().sessions.get(id).cloned()
    }

    /// The ids of the open sessions, oldest first (`sessions.keys()`).
    pub fn ids(&self) -> Vec<String> {
        self.tables().sessions.keys().cloned().collect()
    }

    /// The document index as `(key, session id)` pairs, oldest first.
    pub fn documents(&self) -> Vec<(String, String)> {
        self.tables().documents.iter().map(|(key, id)| (key.clone(), id.clone())).collect()
    }
}

/// `sessionsByThread` of the worker's `office.run`: the sessions each calling thread created and still has open. A
/// thread that owns one is pinned (its worker must stay alive between calls).
#[derive(Debug, Default)]
pub struct ThreadPins {
    owned: HashMap<String, HashSet<String>>,
}

impl ThreadPins {
    /// The ids open before a call starts (`new Set(sessions.keys())`).
    pub fn known(registry: &Registry) -> HashSet<String> {
        registry.ids().into_iter().collect()
    }

    /// What a call leaves behind: the sessions it created join the thread's, the closed ones leave. Answers whether the
    /// thread is pinned now.
    pub fn finish_call(&mut self, thread: &str, known: &HashSet<String>, registry: &Registry) -> bool {
        let live: HashSet<String> = registry.ids().into_iter().collect();
        let mut owned = self.owned.remove(thread).unwrap_or_default();
        owned.extend(live.iter().filter(|id| !known.contains(*id)).cloned());
        owned.retain(|id| live.contains(id));
        let pinned = !owned.is_empty();
        if pinned {
            self.owned.insert(thread.to_owned(), owned);
        }
        pinned
    }

    /// `sessionsByThread.has(thread)`.
    pub fn is_pinned(&self, thread: &str) -> bool {
        self.owned.contains_key(thread)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::session::{Backend, DesignState, Mode, SessionInit};

    fn environment(windows: bool) -> Environment {
        Environment {
            library_config: String::new(),
            pack_url: String::new(),
            pack_key_id: String::new(),
            pack_public_key: String::new(),
            template_dirs: String::new(),
            windows,
            program_files: String::new(),
            program_files_x86: String::new(),
            app_data: String::new(),
            home: String::new(),
            cwd: std::env::temp_dir(),
            bundled_templates: PathBuf::new(),
            now_ms: Arc::new(|| 0.0),
        }
    }

    fn session(id: &str, target: &str) -> SessionHandle {
        Arc::new(Mutex::new(Session::new(SessionInit {
            id: id.to_owned(),
            source: target.to_owned(),
            target: target.to_owned(),
            file_kind: "docx".to_owned(),
            format: "docx".to_owned(),
            mode: Mode::Portable,
            backend: Backend::MixdogOoxml,
            opened_at: String::new(),
            data_dir: PathBuf::new(),
            created: false,
            created_new_file: None,
            design_state: DesignState::default(),
        })))
    }

    #[test]
    fn two_spellings_of_a_path_are_one_document_on_windows_only() {
        let (windows, other) = (environment(true), environment(false));
        assert_eq!(document_session_key(&windows, "Report.DOCX"), document_session_key(&windows, "report.docx"));
        assert_ne!(document_session_key(&other, "Report.DOCX"), document_session_key(&other, "report.docx"));
    }

    #[test]
    fn a_published_session_is_found_by_id_and_by_document() {
        let (registry, env) = (Registry::new(), environment(true));
        let first = session("office_1", "Work.docx");
        registry.index(&env, &first);
        assert!(Arc::ptr_eq(&registry.for_document(&env, "WORK.docx").expect("by document"), &first));
        assert!(Arc::ptr_eq(&registry.get("office_1").expect("by id"), &first));
        assert!(registry.for_document(&env, "other.docx").is_none());
        assert_eq!(registry.ids(), vec!["office_1".to_owned()]);
    }

    #[test]
    fn releasing_an_older_session_keeps_the_claim_of_a_newer_one() {
        let (registry, env) = (Registry::new(), environment(true));
        let (older, newer) = (session("office_1", "a.docx"), session("office_2", "a.docx"));
        registry.index(&env, &older);
        registry.index(&env, &newer);
        registry.release(&env, &older);
        assert!(Arc::ptr_eq(&registry.for_document(&env, "a.docx").expect("newer holds"), &newer));
        assert_eq!(registry.ids(), vec!["office_2".to_owned()]);
        registry.release(&env, &newer);
        assert!(registry.for_document(&env, "a.docx").is_none());
        assert!(registry.documents().is_empty());
    }

    #[test]
    fn re_indexing_a_session_keeps_its_place() {
        let (registry, env) = (Registry::new(), environment(true));
        let (one, two) = (session("office_1", "a.docx"), session("office_2", "b.docx"));
        registry.index(&env, &one);
        registry.index(&env, &two);
        registry.index(&env, &one);
        assert_eq!(registry.ids(), vec!["office_1".to_owned(), "office_2".to_owned()]);
    }

    #[test]
    fn retargeting_a_session_keeps_its_place_and_moves_its_document_key() {
        let (registry, env) = (Registry::new(), environment(true));
        let (one, two) = (session("office_1", "a.docx"), session("office_2", "b.docx"));
        registry.index(&env, &one);
        registry.index(&env, &two);
        registry.retarget(&env, &one, "c.docx".to_owned());
        assert_eq!(registry.ids(), vec!["office_1".to_owned(), "office_2".to_owned()]);
        assert!(registry.for_document(&env, "a.docx").is_none());
        assert!(Arc::ptr_eq(&registry.for_document(&env, "c.docx").expect("moved"), &one));
        let newer = session("office_3", "c.docx");
        registry.index(&env, &newer);
        registry.retarget(&env, &one, "d.docx".to_owned());
        assert!(Arc::ptr_eq(&registry.for_document(&env, "c.docx").expect("newer keeps"), &newer));
        assert!(Arc::ptr_eq(&registry.for_document(&env, "d.docx").expect("moved"), &one));
    }

    #[test]
    fn removing_by_id_leaves_the_document_index() {
        let (registry, env) = (Registry::new(), environment(true));
        registry.index(&env, &session("office_1", "a.docx"));
        assert!(registry.remove("office_1").is_some());
        assert!(registry.for_document(&env, "a.docx").is_none());
        assert_eq!(registry.documents().len(), 1);
    }

    #[test]
    fn a_thread_is_pinned_while_a_session_it_created_is_open() {
        let (registry, env, mut pins) = (Registry::new(), environment(true), ThreadPins::default());
        let before = ThreadPins::known(&registry);
        let mine = session("office_1", "a.docx");
        registry.index(&env, &mine);
        assert!(pins.finish_call("thread-1", &before, &registry));
        assert!(pins.is_pinned("thread-1") && !pins.is_pinned("thread-2"));
        // Another thread's call claims only the session it created; a call that creates nothing keeps its thread's pin.
        let known = ThreadPins::known(&registry);
        registry.index(&env, &session("office_2", "b.docx"));
        assert!(pins.finish_call("thread-2", &known, &registry));
        let known = ThreadPins::known(&registry);
        assert!(pins.finish_call("thread-1", &known, &registry) && pins.is_pinned("thread-1"));
        registry.release(&env, &mine);
        registry.remove("office_2");
        let known = ThreadPins::known(&registry);
        assert!(!pins.finish_call("thread-1", &known, &registry));
        assert!(!pins.is_pinned("thread-1"));
    }
}
