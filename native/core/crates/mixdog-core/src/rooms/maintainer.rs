//! The room supervisor's model call: one tool-free request on the Maintainer's own route
//! (Node `room-supervisor-completion.mjs`), resolved through the compaction route plan.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_agent::compact::summary_run::{RouteResolver, RouteStep, SummaryCall};
use mixdog_agent::one_shot::CallShape;

use super::scheduler::{Maintained, Maintainer};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_TOKENS: u64 = 400;

/// [`Maintainer`] over a [`RouteResolver`] (`SummaryRoutes`).
///
/// The request is shaped as Node's step shapes it (`CallShape::room_supervisor`): the route's own
/// effort, no request kind, no 529 retry and no prompt cache.
pub struct RouteMaintainer {
    routes: Arc<dyn RouteResolver>,
    timeout: Duration,
}

impl RouteMaintainer {
    pub fn new(routes: Arc<dyn RouteResolver>) -> Self {
        Self { routes, timeout: TIMEOUT }
    }

    /// One deadline over route resolution (which brings the provider up) and the send, as
    /// Node's single `AbortSignal.timeout` covers `initProviders` and `provider.send`.
    async fn answer(&self, system: &str, user: &str) -> Maintained {
        // The Maintainer's own route only; without one the room is unmoderated.
        let route = match self.routes.resolve(RouteStep::Maintainer).await {
            Ok(Some(route)) => route,
            Ok(None) => return Maintained::Unmanaged,
            Err(_) => return Maintained::Failed,
        };
        let call = SummaryCall {
            model: route.model.clone(),
            max_output_tokens: MAX_OUTPUT_TOKENS,
            fast: route.fast,
            shape: CallShape::room_supervisor(route.effort.as_deref()),
        };
        match route.sender.send(system, user, &call).await {
            Ok(reply) if !reply.text.is_empty() => Maintained::Text(reply.text),
            _ => Maintained::Failed,
        }
    }
}

#[async_trait]
impl Maintainer for RouteMaintainer {
    async fn ask(&self, system: &str, user: &str) -> Maintained {
        tokio::time::timeout(self.timeout, self.answer(system, user)).await.unwrap_or(Maintained::Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_agent::compact::summary_run::{SummaryFailure, SummaryResponse, SummaryRoute, SummarySender};

    struct Echo;
    #[async_trait]
    impl SummarySender for Echo {
        async fn send(&self, system: &str, prompt: &str, call: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
            let text = if prompt == "silent" {
                String::new()
            } else {
                format!("{system}|{prompt}|{}|{}|{}|{}", call.model, call.max_output_tokens, call.fast, call.shape.effort)
            };
            if prompt == "boom" {
                return Err(SummaryFailure::Failed("x".into()));
            }
            Ok(SummaryResponse { text, tool_call: false, usage: None })
        }
    }

    struct Routes(Result<Option<()>, ()>, Option<&'static str>);
    #[async_trait]
    impl RouteResolver for Routes {
        async fn resolve(&self, step: RouteStep) -> Result<Option<SummaryRoute>, SummaryFailure> {
            assert_eq!(step, RouteStep::Maintainer);
            match &self.0 {
                Err(()) => Err(SummaryFailure::Failed("provider".into())),
                Ok(None) => Ok(None),
                Ok(Some(())) => Ok(Some(SummaryRoute {
                    step,
                    provider_name: "p".into(),
                    model: "m".into(),
                    context_window: 1,
                    calibration: 1.0,
                    fast: true,
                    effort: self.1.map(str::to_owned),
                    sender: Arc::new(Echo),
                })),
            }
        }
    }

    /// A resolution that never finishes (a provider that will not come up) ends at the deadline.
    struct Stuck;
    #[async_trait]
    impl RouteResolver for Stuck {
        async fn resolve(&self, _: RouteStep) -> Result<Option<SummaryRoute>, SummaryFailure> {
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn slow_provider_initialisation_times_out_too() {
        let maintainer = RouteMaintainer { routes: Arc::new(Stuck), timeout: Duration::from_millis(50) };
        assert!(matches!(maintainer.ask("S", "U").await, Maintained::Failed));
    }

    #[tokio::test]
    async fn a_route_without_effort_asks_low_and_a_blank_one_too() {
        for effort in [None, Some("  ")] {
            let reply = RouteMaintainer::new(Arc::new(Routes(Ok(Some(())), effort))).ask("S", "U").await;
            assert!(matches!(reply, Maintained::Text(t) if t == "S|U|m|400|true|low"));
        }
    }

    #[tokio::test]
    async fn the_maintainers_route_answers_and_failures_and_no_route_are_told_apart() {
        let ask = |r: Result<Option<()>, ()>, user: &'static str| async move {
            RouteMaintainer::new(Arc::new(Routes(r, Some(" high ")))).ask("S", user).await
        };
        assert!(matches!(ask(Ok(Some(())), "U").await, Maintained::Text(t) if t == "S|U|m|400|true|high"));
        assert!(matches!(ask(Ok(None), "U").await, Maintained::Unmanaged));
        assert!(matches!(ask(Err(()), "U").await, Maintained::Failed));
        assert!(matches!(ask(Ok(Some(())), "boom").await, Maintained::Failed));
        assert!(matches!(ask(Ok(Some(())), "silent").await, Maintained::Failed));
    }
}