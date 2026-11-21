use super::*;

// the page facts and snapshots the engine keeps

/// The observation a snapshot answer made: its ref set (stamped with the document and revision) and where the page was scrolled.
pub(super) struct Observation {
    pub(super) refs: RefSet,
    /// The snapshot the refs were made of: a ref minted afterwards for a selector match joins it.
    pub(super) payload: BrowserSnapshotPayload,
    pub(super) scroll_y: f64,
}

/// What the host last said of every page: its facts (the highest `seq` wins) and its latest snapshot.
#[derive(Default)]
pub(super) struct FactsStore {
    pub(super) facts: Mutex<HashMap<String, PageFacts>>,
    pub(super) snapshots: Mutex<HashMap<String, Arc<Observation>>>,
}

impl FactsStore {
    pub(super) fn record(&self, facts: &PageFacts) {
        let mut held = locked(&self.facts);
        if held.get(&facts.page_id).is_some_and(|known| known.seq > facts.seq) {
            return;
        }
        held.insert(facts.page_id.clone(), facts.clone());
    }

    pub(super) fn record_snapshot(&self, result: &HostBrowserSnapshotResult) {
        let refs = RefSet::from_payload(&result.snapshot_id, &result.payload).with_document(&result.document_id, result.revision);
        locked(&self.snapshots)
            .insert(result.facts.page_id.clone(), Arc::new(Observation { refs, payload: result.payload.clone(), scroll_y: result.payload.scroll_y }));
    }

    /// Selector matches the snapshot did not list, given refs minted by the host (`registerCssRef`): they join the page's ref set of
    /// that snapshot, so the stale-ref recovery and the change reports know them as any listed ref. Nothing changes when the page's latest
    /// snapshot is another one or every element is already in it.
    pub(super) fn register_minted(&self, page_id: &str, snapshot_id: &str, minted: &[BrowserSnapshotElement]) {
        let mut snapshots = locked(&self.snapshots);
        let Some(held) = snapshots.get(page_id).filter(|observation| observation.refs.snapshot_id == snapshot_id) else { return };
        let mut payload = held.payload.clone();
        let before = payload.elements.len();
        for element in minted {
            if held.refs.get(&element.ref_id).is_none() && !payload.elements.iter().any(|known| known.ref_id == element.ref_id) {
                payload.elements.push(element.clone());
            }
        }
        if payload.elements.len() == before {
            return;
        }
        let mut refs = RefSet::from_payload(snapshot_id, &payload)
            .with_document(&held.refs.document_id, held.refs.revision.unwrap_or_default())
            .with_observation(held.refs.observation.as_deref());
        // The snapshot still covered what it covered: a minted match is not part of what the page's scan reported.
        refs.covered_elements = held.refs.covered_elements;
        let scroll_y = held.scroll_y;
        snapshots.insert(page_id.to_owned(), Arc::new(Observation { refs, payload, scroll_y }));
    }

    pub(super) fn get(&self, page_id: &str) -> Option<PageFacts> {
        locked(&self.facts).get(page_id).cloned()
    }

    pub(super) fn snapshot(&self, page_id: &str, snapshot_id: &str) -> Option<Arc<Observation>> {
        locked(&self.snapshots).get(page_id).filter(|observation| observation.refs.snapshot_id == snapshot_id).cloned()
    }

    pub(super) fn latest_snapshot_id(&self, page_id: &str) -> Option<String> {
        locked(&self.snapshots).get(page_id).map(|observation| observation.refs.snapshot_id.clone())
    }

    pub(super) fn forget(&self, page_id: &str) {
        locked(&self.facts).remove(page_id);
        locked(&self.snapshots).remove(page_id);
    }

    pub(super) fn clear(&self) {
        locked(&self.facts).clear();
        locked(&self.snapshots).clear();
    }
}

/// What a host answer says of the pages it names.
pub(super) trait Observed {
    fn observe(&self, store: &FactsStore);
}

macro_rules! observed_facts {
    ($($result:ty),* $(,)?) => {$(
        impl Observed for $result {
            fn observe(&self, store: &FactsStore) {
                store.record(&self.facts);
            }
        }
    )*};
}

macro_rules! observed_nothing {
    ($($result:ty),* $(,)?) => {$(
        impl Observed for $result {
            fn observe(&self, _store: &FactsStore) {}
        }
    )*};
}

observed_facts!(
    HostBrowserPageNavigateResult,
    HostBrowserPageFactsResult,
    HostBrowserPageEvalResult,
    HostBrowserPageReadResult,
    HostBrowserPageRenderCheckpointResult,
    HostBrowserPageDomQuietResult,
    HostBrowserPageDialogAnswerResult,
    HostBrowserPageSyncResult,
    HostBrowserRefCallResult,
    HostBrowserInputBatchResult,
    HostBrowserScreenshotResult,
    HostBrowserCdpSendResult,
    HostBrowserCookiesResult,
    HostBrowserStorageResult,
    HostBrowserEmulationResult,
    HostBrowserUploadResult,
    HostBrowserUploadReceiverResult,
    HostBrowserCredentialsFillResult,
    HostBrowserRevisionResult,
);

impl Observed for HostBrowserRefMintResult {
    fn observe(&self, store: &FactsStore) {
        store.record(&self.facts);
        // A minted ref is `<snapshot>-t<n>`: the snapshot it belongs to is the page's latest when that prefix is its id.
        let Some(snapshot_id) = store.latest_snapshot_id(&self.facts.page_id) else { return };
        let prefix = format!("{snapshot_id}-t");
        let minted: Vec<BrowserSnapshotElement> = self
            .matches
            .iter()
            .filter(|found| found.ref_id.starts_with(&prefix))
            .map(|found| css_element(found.ref_id.clone(), found.role.clone(), found.name.clone()))
            .collect();
        store.register_minted(&self.facts.page_id, &snapshot_id, &minted);
    }
}
observed_nothing!(
    HostBrowserPagesCloseResult,
    HostBrowserInitScriptsResult,
    HostBrowserInterceptResult,
    HostBrowserPerformanceResult,
    HostBrowserDownloadsResult,
    HostBrowserTurnResult
);

impl Observed for HostBrowserSignInResult {
    fn observe(&self, store: &FactsStore) {
        if let Some(facts) = &self.facts {
            store.record(facts);
        }
    }
}

impl Observed for HostBrowserSnapshotResult {
    fn observe(&self, store: &FactsStore) {
        store.record(&self.facts);
        store.record_snapshot(self);
    }
}

impl Observed for HostBrowserPagesResolveResult {
    fn observe(&self, store: &FactsStore) {
        store.record(&self.page.facts);
    }
}

impl Observed for HostBrowserPagesListResult {
    fn observe(&self, store: &FactsStore) {
        for page in &self.pages {
            store.record(&page.facts);
        }
    }
}

impl Observed for HostBrowserPagesSurfaceResult {
    fn observe(&self, store: &FactsStore) {
        if let Some(facts) = &self.facts {
            store.record(facts);
        }
    }
}

/// The host lane with a memory: every answer that carries a page's facts (and a refused precondition, which carries them too) is
/// kept, so the engine reads a page's present state without asking.
pub(super) struct FactsHost {
    pub(super) inner: Arc<dyn BrowserHost>,
    pub(super) store: Arc<FactsStore>,
}

macro_rules! recording_host {
    ($($name:ident, $params:ty, $result:ty;)*) => {
        #[async_trait]
        impl BrowserHost for FactsHost {
            $(async fn $name(&self, params: $params, cancel: &CancellationToken) -> Result<$result, HostCallError> {
                let answer = self.inner.$name(params, cancel).await;
                match &answer {
                    Ok(result) => result.observe(&self.store),
                    Err(HostCallError::PreconditionFailed { facts, .. }) => self.store.record(facts),
                    Err(_) => {}
                }
                answer
            })*

            fn lease_release(&self, params: HostBrowserLeaseReleaseParams) -> Result<(), HostCallError> {
                self.inner.lease_release(params)
            }
        }
    };
}

recording_host! {
    pages_resolve, HostBrowserPagesResolveParams, HostBrowserPagesResolveResult;
    pages_list, HostBrowserPagesListParams, HostBrowserPagesListResult;
    pages_close, HostBrowserPagesCloseParams, HostBrowserPagesCloseResult;
    pages_surface, HostBrowserPagesSurfaceParams, HostBrowserPagesSurfaceResult;
    page_navigate, HostBrowserPageNavigateParams, HostBrowserPageNavigateResult;
    page_stop, HostBrowserPageStopParams, HostBrowserPageFactsResult;
    page_eval, HostBrowserPageEvalParams, HostBrowserPageEvalResult;
    page_read, HostBrowserPageReadParams, HostBrowserPageReadResult;
    page_render_checkpoint, HostBrowserPageRenderCheckpointParams, HostBrowserPageRenderCheckpointResult;
    page_dom_quiet, HostBrowserPageDomQuietParams, HostBrowserPageDomQuietResult;
    page_dialog_answer, HostBrowserPageDialogAnswerParams, HostBrowserPageDialogAnswerResult;
    page_sync, HostBrowserPageSyncParams, HostBrowserPageSyncResult;
    snapshot, HostBrowserSnapshotParams, HostBrowserSnapshotResult;
    revision, HostBrowserRevisionParams, HostBrowserRevisionResult;
    ref_call, HostBrowserRefCallParams, HostBrowserRefCallResult;
    input_batch, HostBrowserInputBatchParams, HostBrowserInputBatchResult;
    screenshot, HostBrowserScreenshotParams, HostBrowserScreenshotResult;
    cdp_send, HostBrowserCdpSendParams, HostBrowserCdpSendResult;
    cookies, HostBrowserCookiesParams, HostBrowserCookiesResult;
    storage, HostBrowserStorageParams, HostBrowserStorageResult;
    init_scripts, HostBrowserInitScriptsParams, HostBrowserInitScriptsResult;
    intercept, HostBrowserInterceptParams, HostBrowserInterceptResult;
    performance, HostBrowserPerformanceParams, HostBrowserPerformanceResult;
    emulation, HostBrowserEmulationParams, HostBrowserEmulationResult;
    downloads, HostBrowserDownloadsParams, HostBrowserDownloadsResult;
    upload, HostBrowserUploadParams, HostBrowserUploadResult;
    upload_receiver, HostBrowserUploadReceiverParams, HostBrowserUploadReceiverResult;
    ref_mint, HostBrowserRefMintParams, HostBrowserRefMintResult;
    sign_in, HostBrowserSignInParams, HostBrowserSignInResult;
    credentials_fill, HostBrowserCredentialsFillParams, HostBrowserCredentialsFillResult;
    turn, HostBrowserTurnParams, HostBrowserTurnResult;
}

/// What the host pushes, on its way to the lane's sink: the pushed facts are kept here too, and the end of the host's claim forgets
/// every page.
pub(super) struct FactsSink {
    pub(super) inner: Arc<dyn EngineSink>,
    pub(super) store: Arc<FactsStore>,
}

impl EngineSink for FactsSink {
    fn events(&self, params: HostBrowserEventsParams) {
        self.inner.events(params);
    }

    fn facts(&self, params: HostBrowserPageFactsParams) {
        self.store.record(&params.facts);
        self.inner.facts(params);
    }

    fn user_input(&self, params: HostBrowserUserInputParams) {
        self.inner.user_input(params);
    }

    fn host_gone(&self) {
        self.store.clear();
        self.inner.host_gone();
    }
}
