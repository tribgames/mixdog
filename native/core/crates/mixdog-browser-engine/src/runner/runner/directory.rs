use super::*;
use crate::queue::key::QueueKeyHost;

/// One session's pages as the engine learned them from the host: the selected page and the named background pages (what the queue
/// key of a command with no page id is derived from).
#[derive(Default)]
pub(super) struct SessionPages {
    pub(super) current: Option<String>,
    pub(super) backgrounds: HashMap<String, String>,
    pub(super) names: HashMap<String, String>,
}

#[derive(Default)]
pub(super) struct Directory {
    pub(super) sessions: HashMap<String, SessionPages>,
}

impl Directory {
    /// A page the host described: a hidden one is known by its tab name, a visible one is the session's selected page.
    pub(super) fn observe_page(&mut self, session: &str, page: &PageDescriptor) {
        let held = self.sessions.entry(session.to_owned()).or_default();
        if page.background {
            held.backgrounds.insert(page.tab_id.clone(), page.page_id.clone());
            held.names.insert(page.page_id.clone(), page.tab_id.clone());
        } else {
            held.current = Some(page.page_id.clone());
        }
    }

    /// The session's whole list: what the host says is selected now replaces what was.
    pub(super) fn observe_list(&mut self, session: &str, pages: &[PageDescriptor], active: Option<&str>) {
        let held = self.sessions.entry(session.to_owned()).or_default();
        held.backgrounds.clear();
        held.names.clear();
        for page in pages.iter().filter(|page| page.background) {
            held.backgrounds.insert(page.tab_id.clone(), page.page_id.clone());
            held.names.insert(page.page_id.clone(), page.tab_id.clone());
        }
        held.current = active.map(str::to_owned);
    }

    pub(super) fn forget_page(&mut self, page_id: &str) {
        for held in self.sessions.values_mut() {
            if held.current.as_deref() == Some(page_id) {
                held.current = None;
            }
            if let Some(name) = held.names.remove(page_id) {
                held.backgrounds.remove(&name);
            }
        }
    }
}

impl QueueKeyHost for Directory {
    fn current_page_id(&self, session: &str) -> Option<String> {
        self.sessions.get(session)?.current.clone()
    }

    fn background_page_id(&self, session: &str, name: &str) -> Option<String> {
        self.sessions.get(session)?.backgrounds.get(name).cloned()
    }

    fn background_name_by_page_id(&self, session: &str, page_id: &str) -> Option<String> {
        self.sessions.get(session)?.names.get(page_id).cloned()
    }
}
