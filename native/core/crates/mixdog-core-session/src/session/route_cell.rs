//! The live route of each thread (Node's `rt.route`, `boot/apis.mjs:591`): read by `getRoute`,
//! replaced whole by `setRouteState`. Node's runtime starts from the route its config resolves
//! to (`boot/config.mjs:23-27`, `resolveInitialConfigState`), or the route its creator passed,
//! and a resume replaces it with the resumed session's (`resume.mjs`); here a thread's route is
//! taken from the config the first time it is read, or from the route its creator or its record
//! names ([`RouteCell::boot`], again at each open for use until a route is set on it); a route
//! set on it is kept for the process's life, across the thread's unloads.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Mutex;

use mixdog_core_api::ids::ThreadId;

use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route_write::RouteCell;

/// `resolveRoute(getConfig(), request)` over the live config.
pub trait RouteResolve: Send + Sync {
    fn resolve(&self, request: &Route) -> Result<Route, String>;
}

impl<F> RouteResolve for F
where
    F: Fn(&Route) -> Result<Route, String> + Send + Sync,
{
    fn resolve(&self, request: &Route) -> Result<Route, String> {
        self(request)
    }
}

struct Cell {
    route: Route,
    generation: u64,
}

/// [`RouteCell`] per thread.
pub struct SessionRoutes {
    resolve: Box<dyn RouteResolve>,
    cells: Mutex<HashMap<ThreadId, Cell>>,
}

impl SessionRoutes {
    pub fn new(resolve: impl RouteResolve + 'static) -> Self {
        Self {
            resolve: Box::new(resolve),
            cells: Mutex::new(HashMap::new()),
        }
    }

    fn with<R>(&self, thread: &ThreadId, f: impl FnOnce(&mut Cell) -> R) -> R {
        let mut cells = self.cells.lock().unwrap_or_else(|e| e.into_inner());
        let cell = cells.entry(thread.clone()).or_insert_with(|| Cell {
            // A config that resolves no route leaves the runtime's route empty.
            route: self.resolve.resolve(&Route::new()).unwrap_or_default(),
            generation: 0,
        });
        f(cell)
    }
}

impl LiveRoute for SessionRoutes {
    fn route(&self, thread: &ThreadId) -> Route {
        self.with(thread, |cell| cell.route.clone())
    }

    /// `setRouteState(resolveRoute(getConfig(), held))` (`set-route.mjs:470`); a held pick the
    /// config no longer resolves throws there before anything is set, so the route stands.
    fn adopt_held(&self, thread: &ThreadId, held: &Route) {
        if let Ok(route) = self.resolve.resolve(held) {
            self.set_route_state(thread, route);
        }
    }
}

impl RouteCell for SessionRoutes {
    fn set_route_state(&self, thread: &ThreadId, route: Route) {
        self.with(thread, |cell| {
            cell.route = route;
            cell.generation += 1;
        });
    }

    fn route_generation(&self, thread: &ThreadId) -> u64 {
        self.with(thread, |cell| cell.generation)
    }

    fn boot(&self, thread: &ThreadId, request: &Route) {
        let Ok(route) = self.resolve.resolve(request) else { return };
        let mut cells = self.cells.lock().unwrap_or_else(|e| e.into_inner());
        match cells.entry(thread.clone()) {
            Entry::Vacant(slot) => {
                slot.insert(Cell { route, generation: 0 });
            }
            // A route set in this process (a selection, a held pick adopted, a refresh) is the runtime's and stands.
            Entry::Occupied(mut held) if held.get().generation == 0 => held.get_mut().route = route,
            Entry::Occupied(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use serde_json::Value;
    use serde_json::json;

    use super::*;

    fn route(value: Value) -> Route {
        value.as_object().cloned().expect("object")
    }

    /// `resolveRoute` over a config whose main model is `main`: a request naming a model keeps
    /// it, an unknown provider throws.
    fn resolver(main: Arc<Mutex<&'static str>>, calls: Arc<AtomicUsize>) -> impl RouteResolve {
        move |request: &Route| {
            calls.fetch_add(1, Ordering::SeqCst);
            match request.get("provider").and_then(Value::as_str) {
                Some("gone") => Err("Unknown provider: gone".to_owned()),
                Some(provider) => Ok(route(json!({ "provider": provider, "model": request["model"] }))),
                None => Ok(route(json!({ "provider": "openai", "model": *main.lock().unwrap() }))),
            }
        }
    }

    #[test]
    fn a_threads_route_starts_from_the_config_and_keeps_it_when_the_config_moves() {
        let main = Arc::new(Mutex::new("gpt-5"));
        let calls = Arc::new(AtomicUsize::new(0));
        let routes = SessionRoutes::new(resolver(main.clone(), calls.clone()));
        let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
        assert_eq!(routes.route(&a), route(json!({ "provider": "openai", "model": "gpt-5" })));
        assert_eq!(routes.route_generation(&a), 0, "the boot route is no setRouteState");
        *main.lock().unwrap() = "gpt-5-mini";
        assert_eq!(routes.route(&a)["model"], "gpt-5", "the runtime's route is not re-resolved");
        assert_eq!(routes.route(&b)["model"], "gpt-5-mini", "another thread starts from today's config");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn every_set_replaces_the_route_whole_and_advances_only_its_threads_generation() {
        let routes = SessionRoutes::new(resolver(Arc::new(Mutex::new("gpt-5")), Arc::default()));
        let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
        routes.set_route_state(&a, route(json!({ "provider": "anthropic", "model": "opus", "fast": true })));
        let same = routes.route(&a);
        routes.set_route_state(&a, same.clone());
        assert_eq!(routes.route_generation(&a), 2, "an identical route is still a new setRouteState");
        routes.set_route_state(&a, route(json!({ "provider": "anthropic", "model": "sonnet" })));
        assert_eq!(routes.route(&a), route(json!({ "provider": "anthropic", "model": "sonnet" })));
        assert_eq!(routes.route_generation(&a), 3);
        assert_eq!(routes.route_generation(&b), 0);
        assert_eq!(routes.route(&b)["model"], "gpt-5");
    }

    /// A thread created on its creator's route, or opened from its record, boots on that route instead of the config's,
    /// with no `setRouteState`; a route set on the thread in this process stands, and an unresolvable one leaves it.
    #[test]
    fn a_thread_boots_on_the_route_it_names_until_a_route_is_set_on_it() {
        let routes = SessionRoutes::new(resolver(Arc::new(Mutex::new("gpt-5")), Arc::default()));
        let (a, b) = (ThreadId::from("sess_a"), ThreadId::from("sess_b"));
        routes.boot(&a, &route(json!({ "provider": "anthropic", "model": "opus" })));
        assert_eq!(routes.route(&a), route(json!({ "provider": "anthropic", "model": "opus" })));
        assert_eq!(routes.route_generation(&a), 0, "a boot is no setRouteState");
        assert_eq!(routes.route(&b)["model"], "gpt-5");
        routes.boot(&b, &route(json!({ "provider": "anthropic", "model": "sonnet" })));
        assert_eq!(routes.route(&b)["model"], "sonnet", "a route only read from the config is replaced");
        routes.boot(&b, &route(json!({ "provider": "gone", "model": "x" })));
        assert_eq!(routes.route(&b)["model"], "sonnet");
        routes.set_route_state(&a, route(json!({ "provider": "openai", "model": "gpt-5-mini" })));
        routes.boot(&a, &route(json!({ "provider": "anthropic", "model": "opus" })));
        assert_eq!(routes.route(&a)["model"], "gpt-5-mini", "a route set in this process stands");
        assert_eq!(routes.route_generation(&a), 1);
    }

    #[test]
    fn a_held_pick_is_resolved_into_the_live_route_and_an_unresolvable_one_leaves_it() {
        let routes = SessionRoutes::new(resolver(Arc::new(Mutex::new("gpt-5")), Arc::default()));
        let a = ThreadId::from("sess_a");
        routes.adopt_held(&a, &route(json!({ "provider": "anthropic", "model": "opus" })));
        assert_eq!(routes.route(&a), route(json!({ "provider": "anthropic", "model": "opus" })));
        assert_eq!(routes.route_generation(&a), 1);
        routes.adopt_held(&a, &route(json!({ "provider": "gone", "model": "x" })));
        assert_eq!(routes.route(&a)["model"], "opus");
        assert_eq!(routes.route_generation(&a), 1);
    }
}
