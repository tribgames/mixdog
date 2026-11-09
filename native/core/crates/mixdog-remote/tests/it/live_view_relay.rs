//! The live-view relay against Node's recorded scenarios (`fixtures/live-view/relay.json`, recorded
//! by driving the real `relay.ts` of b6f10295a with promises the scenario settles step by step).
//! Every dependency call, in order, and every settled operation must equal what Node recorded.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::task::Context;
use std::task::Poll;
use std::task::Waker;

use async_trait::async_trait;
use mixdog_remote::webrtc::config::IceServer;
use mixdog_remote::webrtc::relay::Origin;
use mixdog_remote::webrtc::relay::Relay;
use mixdog_remote::webrtc::relay::RelayDeps;
use mixdog_remote::webrtc::signal::ClientSignal;
use mixdog_remote::webrtc::signal::ice_servers_json;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

const RELAY: &str = include_str!("../../../../fixtures/live-view/relay.json");

type Settlement = Result<Value, String>;

struct Pending {
    kind: &'static str,
    index: usize,
    settle: Option<oneshot::Sender<Settlement>>,
}

#[derive(Default)]
struct Script {
    log: Vec<Value>,
    pending: Vec<Pending>,
    subscribed: Vec<(String, String)>,
    awaiting_fit: Vec<(String, String)>,
    origins: Vec<String>,
}

#[derive(Clone, Default)]
struct Deps(Arc<Mutex<Script>>);

impl Deps {
    fn script(&self) -> std::sync::MutexGuard<'_, Script> {
        self.0.lock().unwrap()
    }

    /// Logs the call and waits for the scenario to settle it.
    async fn deferred(&self, kind: &'static str, args: Vec<Value>) -> Settlement {
        let (settle, settled) = oneshot::channel();
        {
            let mut script = self.script();
            let index = script.pending.iter().filter(|p| p.kind == kind).count();
            script.pending.push(Pending { kind, index, settle: Some(settle) });
            let mut entry = vec![json!("call"), json!(kind), json!(index)];
            entry.extend(args);
            script.log.push(Value::Array(entry));
        }
        settled.await.expect("the scenario keeps its settlement")
    }

    fn origin_name(&self, origin: Origin) -> String {
        self.script().origins[origin as usize].clone()
    }
}

#[async_trait]
impl RelayDeps for Deps {
    fn subscribed(&self, client: &str, session: &str) -> bool {
        let answer = self.script().subscribed.contains(&(client.to_owned(), session.to_owned()));
        self.script().log.push(json!(["subscribed", client, session, answer]));
        answer
    }

    fn awaiting_fit(&self, client: &str, session: &str) -> bool {
        let answer = self.script().awaiting_fit.contains(&(client.to_owned(), session.to_owned()));
        self.script().log.push(json!(["awaitingFit", client, session, answer]));
        answer
    }

    async fn screen_authorized(&self, client: &str, origin: Origin) -> bool {
        let name = self.origin_name(origin);
        self.deferred("screenAuthorized", vec![json!(client), json!(name)]).await == Ok(json!(true))
    }

    fn set_images(&self, client: &str, session: &str, enabled: bool) {
        self.script().log.push(json!(["setImages", client, session, enabled]));
    }

    async fn resolve_ice_servers(&self) -> Result<Vec<IceServer>, String> {
        let servers = self.deferred("resolveIceServers", vec![]).await?;
        Ok(servers
            .as_array()
            .unwrap()
            .iter()
            .map(|server| IceServer {
                urls: match &server["urls"] {
                    Value::String(url) => vec![url.clone()],
                    urls => urls.as_array().unwrap().iter().map(|u| u.as_str().unwrap().to_owned()).collect(),
                },
                username: server["username"].as_str().map(str::to_owned),
                credential: server["credential"].as_str().map(str::to_owned),
            })
            .collect())
    }

    async fn forward(&self, client: &str, signal: &ClientSignal, ice_servers: Option<&[IceServer]>, origin: Origin) -> Result<(), String> {
        let name = self.origin_name(origin);
        let ice = ice_servers.map_or(Value::Null, ice_servers_json);
        self.deferred("forward", vec![json!(client), signal.to_json(), ice, json!(name)]).await.map(|_| ())
    }

    fn viewer_left(&self, client: &str, source_key: &str) {
        self.script().log.push(json!(["viewerLeft", client, source_key]));
    }

    async fn screen_displays(&self) -> Result<Value, String> {
        self.deferred("screenDisplays", vec![]).await
    }

    async fn send(&self, client: &str, payload: Value) -> Result<(), String> {
        self.script().log.push(json!(["send", client, payload]));
        Ok(())
    }
}

/// The step that started an operation, its id and the operation. Node records a settled operation on the
/// step that started it.
type Running<'a> = Vec<(usize, String, Pin<Box<dyn Future<Output = Settlement> + 'a>>)>;

fn pairs(list: &Value) -> Vec<(String, String)> {
    list.as_array().map_or_else(Vec::new, |pairs| pairs.iter().map(|p| (p[0].as_str().unwrap().to_owned(), p[1].as_str().unwrap().to_owned())).collect())
}

/// Polls every running operation until a pass changes nothing, recording those that settle.
fn flush(deps: &Deps, running: &mut Running<'_>, done: &mut [Vec<Value>]) {

    let mut cx = Context::from_waker(Waker::noop());
    loop {
        let before = (deps.script().log.len(), running.len());
        let mut index = 0;
        while index < running.len() {
            match running[index].2.as_mut().poll(&mut cx) {
                Poll::Ready(outcome) => {
                    let (step, id, _) = running.remove(index);
                    done[step].push(match outcome {
                        Ok(value) => json!({ "id": id, "ok": true, "value": value }),
                        Err(error) => json!({ "id": id, "ok": false, "error": error }),
                    });
                }
                Poll::Pending => index += 1,
            }
        }
        if before == (deps.script().log.len(), running.len()) {
            return;
        }
    }
}

fn run_scenario(scenario: &Value) {
    let name = scenario["name"].as_str().unwrap();
    let deps = Deps::default();
    let relay = Relay::new(deps.clone());
    let mut running: Running<'_> = Vec::new();
    let mut done = vec![Vec::new(); scenario["steps"].as_array().unwrap().len()];
    let steps = scenario["steps"].as_array().unwrap();
    let recorded = scenario["recorded"].as_array().unwrap();
    assert_eq!(steps.len(), recorded.len(), "{name}");
    for (number, (step, want)) in steps.iter().zip(recorded).enumerate() {
        let what = format!("{name} step {number} {}", step["op"]);
        let before = deps.script().log.len();
        let client = step["client"].as_str().unwrap_or_default().to_owned();
        let mut result = None;
        let origin = |deps: &Deps| -> Origin {
            let wanted = step["origin"].as_str().unwrap().to_owned();
            let mut script = deps.script();
            let at = script.origins.iter().position(|o| *o == wanted).unwrap_or_else(|| {
                script.origins.push(wanted);
                script.origins.len() - 1
            });
            at as Origin
        };
        let id = step["id"].as_str().unwrap_or_default().to_owned();
        match step["op"].as_str().unwrap() {
            "set" => {
                deps.script().subscribed = pairs(&step["subscribed"]);
                deps.script().awaiting_fit = pairs(&step["awaitingFit"]);
            }
            "accept" => {
                result = Some(match relay.accept(&client, &step["raw"]) {
                    Ok(signal) => json!({ "ok": true, "value": signal.to_json() }),
                    Err(error) => json!({ "ok": false, "error": error }),
                });
            }
            "forward" => {
                let signal = ClientSignal::parse(&step["raw"]).unwrap();
                let origin = origin(&deps);
                let relay = &relay;
                running.push((number, id, Box::pin(async move { relay.forward(&client, &signal, origin).await.map(|()| Value::Null) })));
            }
            "screenDisplays" => {
                let origin = origin(&deps);
                let relay = &relay;
                running.push((number, id, Box::pin(async move { relay.screen_displays(&client, origin).await })));
            }
            "send" => {
                let relay = &relay;
                let raw = step["raw"].clone();
                running.push((number, id, Box::pin(async move { relay.send(&client, &raw).await.map(|()| Value::Null) })));
            }
            "resolve" | "reject" => {
                let kind = step["kind"].as_str().unwrap();
                let index = step["index"].as_u64().unwrap() as usize;
                // Settled calls stay listed: a call's index counts every call of its kind so far.
                let settle = deps
                    .script()
                    .pending
                    .iter_mut()
                    .find(|p| p.kind == kind && p.index == index)
                    .and_then(|p| p.settle.take())
                    .expect("something pending");
                let settlement = if step["op"] == "resolve" { Ok(step["value"].clone()) } else { Err(step["message"].as_str().unwrap().to_owned()) };
                settle.send(settlement).ok();
            }
            "relayInputAllowed" => {
                result = Some(json!({ "ok": true, "value": relay.relay_input_allowed(&client, step["session"].as_str().unwrap()) }));
            }
            "connectionRemoved" => relay.connection_removed(&client),
            "viewerLeft" => relay.viewer_left(&client, step["session"].as_str().unwrap()),
            other => panic!("unknown relay op {other}"),
        }
        flush(&deps, &mut running, &mut done);
        let log: Vec<Value> = deps.script().log[before..].to_vec();
        assert_eq!(want.get("result"), result.as_ref(), "{what}: result");
        assert_eq!(json!(log), want["log"], "{what}: dependency calls");
    }
    for (number, want) in recorded.iter().enumerate() {
        assert_eq!(json!(done[number]), want["done"], "{name} step {number}: settled operations");
    }
}

#[test]
fn the_relay_behaves_as_nodes_did_in_every_recorded_scenario() {
    let recorded: Value = serde_json::from_str(RELAY).unwrap();
    let scenarios = recorded["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 17);
    for scenario in scenarios {
        run_scenario(scenario);
    }
}
