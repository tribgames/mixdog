//! Save and close for one Office session: Microsoft Office sessions go through the Office host, portable sessions persist through
//! the snapshot already on disk. Both refuse while a transaction is open (`core/office-finalize/session-save.mjs`).

use mixdog_js::value_to_string;
use mixdog_office_base::values::truthy;
use mixdog_office_design::library::Environment;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use crate::actions::{ComSessions, Host};
use crate::session::SessionHandle;
use crate::session::registry::{Registry, lock};
use crate::snapshot::ComHost;

/// What a call to the Office host failed with: its `error`, else the fallback.
fn failure(answer: &Value, fallback: &str) -> String {
    answer.get("error").filter(|error| truthy(error)).map_or_else(|| fallback.to_owned(), value_to_string)
}

/// `save(session)`.
pub async fn save_session<H: ComHost>(host: &H, handle: &SessionHandle) -> Result<Value, String> {
    let (id, format, mode, target, microsoft_office, signal) = {
        let session = lock(handle);
        if session.state.transaction().is_some() {
            return Err("Commit or roll back the active Office transaction before saving".to_owned());
        }
        (
            session.id.clone(),
            session.format.clone(),
            session.mode.as_str(),
            session.target.clone(),
            session.is_microsoft_office(),
            session.active_signal.clone(),
        )
    };
    if microsoft_office {
        let request = json!({ "action": "save", "session": id, "format": format, "mode": mode, "path": target });
        let answer = host.call(&request, signal.as_ref(), None).await;
        if !answer.get("ok").is_some_and(truthy) {
            return Err(failure(&answer, "Microsoft Office save failed"));
        }
    }
    Ok(json!({ "ok": true, "session": id, "saved": true, "path": target }))
}

/// `closeSession(session, { save, signal })`: the session saved when asked, its Office document closed, and the session released.
pub async fn close_session<H: Host>(
    host: &H,
    registry: &Registry,
    env: &Environment,
    handle: &SessionHandle,
    save: bool,
    signal: Option<&CancellationToken>,
) -> Result<Value, String> {
    let (id, microsoft_office) = {
        let session = lock(handle);
        if session.state.transaction().is_some() {
            return Err("Commit or roll back the active Office transaction before closing".to_owned());
        }
        (session.id.clone(), session.is_microsoft_office())
    };
    let mut cleanup: Option<Value> = None;
    let mut unconfirmed = String::new();
    if microsoft_office {
        let closed = ComSessions::close_session(host, &id, save, signal).await;
        let (ok, reaped) = (closed.get("ok").is_some_and(truthy), closed.get("reaped").is_some_and(truthy));
        // A session whose application already died cannot be closed through it. Release the record anyway and say the cleanup was
        // not confirmed; refusing would leave the session unusable and unclosable for the rest of the run.
        if !ok && !reaped {
            return Err(failure(&closed, "Microsoft Office session close failed"));
        }
        cleanup = closed.get("cleanup").filter(|cleanup| truthy(cleanup)).cloned();
        if !ok {
            unconfirmed =
                closed.get("error").filter(|error| truthy(error)).map_or_else(|| "Microsoft Office application was already gone.".to_owned(), value_to_string);
        }
    } else if save {
        save_session(host, handle).await?;
    }
    registry.release(env, handle);
    let (target, ownership) = {
        let session = lock(handle);
        (session.target.clone(), session.com.ownership.clone())
    };
    let mut result = Map::new();
    result.insert("ok".to_owned(), Value::Bool(true));
    result.insert("session".to_owned(), Value::String(id));
    result.insert("closed".to_owned(), Value::Bool(true));
    result.insert("path".to_owned(), Value::String(target));
    if let Some(ownership) = ownership {
        result.insert("ownership".to_owned(), Value::String(ownership));
    }
    if let Some(cleanup) = cleanup {
        result.insert("cleanup".to_owned(), cleanup);
    }
    if !unconfirmed.is_empty() {
        result.insert("reaped".to_owned(), Value::Bool(true));
        result.insert("warning".to_owned(), Value::String(unconfirmed));
    }
    Ok(Value::Object(result))
}
