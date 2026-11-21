use std::sync::Arc;

use futures::future::BoxFuture;
use mixdog_ai::admission::Admission;
use mixdog_ai::catalog::ProviderReadiness;
use mixdog_core_config::config::Config;
use mixdog_rt::TaskClass;

use super::collaborators::AuthRefresh;
use super::dashboards::Dashboards;
use crate::domains::ai_admin::model_warmup::ModelWarmup;

/// The dependencies `createAuthRefresh` takes, plus `reloadFullConfig` for the account switch.
pub trait RefreshEffects: Send + Sync + 'static {
    /// `applyConfigChange`: reload the config and run the effects its diff names.
    fn apply_config_change(&self);
    /// `reloadFullConfig`.
    fn reload_config(&self);
    /// `invalidateProviderCaches`.
    fn invalidate_provider_caches(&self);
    /// `reg.disableProvider(id)`.
    fn disable_provider(&self, id: &str);
    /// `warmProviderModelCache`.
    fn warm_provider_model_cache(&self);
    /// `resetProviderAdmissionCooldowns()`.
    fn reset_admission_cooldowns(&self);
    /// `refreshProviderCatalogs({ force: true })`; `None` when the runtime has none. An error is
    /// swallowed by the caller, as Node's `.catch(() => {})`.
    fn refresh_provider_catalogs(&self) -> Option<BoxFuture<'static, Result<(), ()>>>;
}

pub struct AuthRefreshFlow<E: RefreshEffects> {
    effects: Arc<E>,
}

impl<E: RefreshEffects> AuthRefreshFlow<E> {
    pub fn new(effects: Arc<E>) -> Arc<Self> {
        Arc::new(Self { effects })
    }

    /// `refreshProviderCatalogsSoon`: a refresh that succeeds drops the caches and warms them
    /// again; one that fails changes nothing.
    fn refresh_catalogs_soon(&self) {
        let Some(refresh) = self.effects.refresh_provider_catalogs() else { return };
        let effects = self.effects.clone();
        mixdog_rt::spawn("auth-refresh-catalogs", TaskClass::Work, async move {
            if refresh.await.is_ok() {
                effects.invalidate_provider_caches();
                effects.warm_provider_model_cache();
            }
        });
    }
}

impl<E: RefreshEffects> AuthRefresh for AuthRefreshFlow<E> {
    /// The change step runs first, then the new credentials are adopted.
    fn after_credential_change(&self) {
        self.effects.apply_config_change();
        self.adopt_credentials();
    }

    fn custom_provider_removed(&self, id: &str) {
        self.effects.disable_provider(id);
    }

    /// New credentials are live: drop everything keyed to the old ones.
    fn adopt_credentials(&self) {
        self.effects.invalidate_provider_caches();
        self.effects.reset_admission_cooldowns();
        self.refresh_catalogs_soon();
        self.effects.warm_provider_model_cache();
    }

    /// Usage-dashboard credentials affect no admission lane or catalog.
    fn after_usage_auth_change(&self) {
        self.effects.apply_config_change();
        self.effects.invalidate_provider_caches();
    }

    fn release_admission_cooldowns(&self) {
        self.effects.reset_admission_cooldowns();
    }

    /// `accounts.mjs`: reload, drop the model caches, warm them again.
    fn account_selection_changed(&self) {
        self.effects.reload_config();
        self.effects.invalidate_provider_caches();
        self.effects.warm_provider_model_cache();
    }
}

/// The live services behind [`RefreshEffects`].
pub struct ProviderEffects {
    pub config: Config,
    pub readiness: Arc<ProviderReadiness>,
    pub admission: Arc<Admission>,
    pub dashboards: Arc<Dashboards>,
    /// The model cache's own warm: `warmProviderModelCache()` of the account flows is its load, the one every reader shares.
    pub models: Arc<ModelWarmup>,
}

impl ProviderEffects {
    pub fn new(
        config: Config,
        readiness: Arc<ProviderReadiness>,
        admission: Arc<Admission>,
        dashboards: Arc<Dashboards>,
        models: Arc<ModelWarmup>,
    ) -> Arc<Self> {
        Arc::new(Self { config, readiness, admission, dashboards, models })
    }

    /// The production `AuthRefresh`.
    pub fn auth_refresh(self: &Arc<Self>) -> Arc<dyn AuthRefresh> {
        AuthRefreshFlow::new(self.clone())
    }
}

impl RefreshEffects for ProviderEffects {
    fn apply_config_change(&self) {
        self.reload_config();
    }

    fn reload_config(&self) {
        let config = self.config.clone();
        mixdog_rt::spawn("auth-refresh-reload", TaskClass::Work, async move {
            let _ = config.reload().await;
        });
    }

    /// The catalog's consumers start a new revision (initialized providers stay) and the cached
    /// usage dashboard goes. The provider-setup cache has no Rust holder.
    fn invalidate_provider_caches(&self) {
        self.readiness.invalidate_provider_caches(true);
        self.dashboards.invalidate();
    }

    /// `warmProviderModelCache()`: Node's readiness and catalog refresh are the `prepare` of that one load, so they run
    /// inside it and nowhere else.
    fn warm_provider_model_cache(&self) {
        self.models.warm_now();
    }

    fn disable_provider(&self, id: &str) {
        self.readiness.disable_provider(id);
    }

    fn reset_admission_cooldowns(&self) {
        self.admission.reset_cooldowns(None);
    }

    /// `ensureProvidersReady(config.providers).then(refreshCatalogs({ force: true }))`.
    fn refresh_provider_catalogs(&self) -> Option<BoxFuture<'static, Result<(), ()>>> {
        let readiness = self.readiness.clone();
        Some(Box::pin(async move {
            readiness.ensure_providers_ready(None).await.map_err(|_| ())?;
            readiness.refresh_catalogs().await;
            Ok(())
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A recording stand-in for the runtime: the calls in order, and the lane's cooldown, which
    /// a release clears.
    struct Recording {
        calls: Mutex<Vec<String>>,
        cooldown: Mutex<bool>,
        refresh: &'static str,
    }

    impl Recording {
        fn note(&self, call: &str) {
            self.calls.lock().unwrap().push(call.to_owned());
        }
    }

    impl RefreshEffects for Recording {
        fn apply_config_change(&self) {
            self.note("applyConfigChange");
        }

        fn reload_config(&self) {
            self.note("reloadFullConfig");
        }

        fn invalidate_provider_caches(&self) {
            self.note("invalidateProviderCaches");
        }

        fn warm_provider_model_cache(&self) {
            self.note("warmProviderModelCache");
        }

        fn disable_provider(&self, id: &str) {
            self.note(&format!("disableProvider:{id}"));
        }

        fn reset_admission_cooldowns(&self) {
            *self.cooldown.lock().unwrap() = false;
        }

        fn refresh_provider_catalogs(&self) -> Option<BoxFuture<'static, Result<(), ()>>> {
            if self.refresh == "absent" {
                return None;
            }
            self.note("refreshProviderCatalogs:{\"force\":true}");
            let ok = self.refresh == "resolves";
            Some(Box::pin(async move { if ok { Ok(()) } else { Err(()) } }))
        }
    }

    /// A removed custom provider leaves the registry before any refresh runs (`onCustomProviderRemoved`).
    #[test]
    fn a_removed_custom_provider_is_disabled_at_once() {
        let effects = Arc::new(Recording { calls: Mutex::default(), cooldown: Mutex::new(true), refresh: "absent" });
        AuthRefreshFlow::new(effects.clone()).custom_provider_removed("mine");
        assert_eq!(*effects.calls.lock().unwrap(), ["disableProvider:mine"]);
    }

    /// The switch's own sequence (`accounts.mjs`): reload, drop the model caches, warm them.
    #[test]
    fn an_account_switch_reloads_drops_the_caches_and_warms() {
        let effects = Arc::new(Recording { calls: Mutex::default(), cooldown: Mutex::new(true), refresh: "absent" });
        AuthRefreshFlow::new(effects.clone()).account_selection_changed();
        assert_eq!(*effects.calls.lock().unwrap(), ["reloadFullConfig", "invalidateProviderCaches", "warmProviderModelCache"]);
    }

    const REFRESH: &str = "refreshProviderCatalogs:{\"force\":true}";

    /// What each entry point does, in order, once its refresh has settled, and whether the lane's cooldown is still held:
    /// a credential change or adoption refreshes the catalogs (forced) when it can and warms the caches again only when that
    /// refresh succeeded; a usage-auth change drops the caches and leaves the cooldown held; a release only lifts the cooldown.
    #[tokio::test(start_paused = true)]
    async fn every_entry_point_makes_its_calls_and_settles_the_cooldown() {
        mixdog_rt::testing::tokens();
        let (apply, inv, warm) = ("applyConfigChange", "invalidateProviderCaches", "warmProviderModelCache");
        let entries: [(&str, [Vec<&str>; 4], bool); 4] = [
            // refresh: resolves, rejects, throws, absent
            (
                "afterCredentialChange",
                [vec![apply, inv, REFRESH, warm, inv, warm], vec![apply, inv, REFRESH, warm], vec![apply, inv, REFRESH, warm], vec![apply, inv, warm]],
                false,
            ),
            ("adoptCredentials", [vec![inv, REFRESH, warm, inv, warm], vec![inv, REFRESH, warm], vec![inv, REFRESH, warm], vec![inv, warm]], false),
            ("afterUsageAuthChange", [vec![apply, inv], vec![apply, inv], vec![apply, inv], vec![apply, inv]], true),
            ("releaseAdmissionCooldowns", [vec![], vec![], vec![], vec![]], false),
        ];
        for (entry, settled, held_after) in entries {
            for (refresh, expected) in ["resolves", "rejects", "throws", "absent"].into_iter().zip(settled) {
                let label = format!("{entry}/{refresh}");
                let effects = Arc::new(Recording { calls: Mutex::default(), cooldown: Mutex::new(true), refresh });
                let flow = AuthRefreshFlow::new(effects.clone());
                match entry {
                    "afterCredentialChange" => flow.after_credential_change(),
                    "adoptCredentials" => flow.adopt_credentials(),
                    "afterUsageAuthChange" => flow.after_usage_auth_change(),
                    _ => flow.release_admission_cooldowns(),
                }
                mixdog_rt::time::sleep(std::time::Duration::from_millis(40)).await;
                assert_eq!(effects.calls.lock().unwrap().clone(), expected, "{label}: calls settled");
                assert_eq!(*effects.cooldown.lock().unwrap(), held_after, "{label}: cooldown");
            }
        }
    }
}
