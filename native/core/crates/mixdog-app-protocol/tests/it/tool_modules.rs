//! `ToolModuleSettings` is the `toolModules` settings value: a value deserializes and serializes back to the same JSON, so a
//! field the type lacks, drops or renames fails here, and the distinction between a key written as `null` and a key left out
//! survives.

use mixdog_protocol::AutoEffortBase;
use mixdog_protocol::InstructionFilesMode;
use mixdog_protocol::LocalInference;
use mixdog_protocol::LocalInstallState;
use mixdog_protocol::LocalProviderModule;
use mixdog_protocol::ToolModuleSettings;
use serde_json::Value;
use serde_json::json;

fn model(extra: Value) -> Value {
    let mut model = json!({
        "id": "m", "name": "M", "description": "d", "sizeBytes": 10, "remainingDownloadBytes": 4, "estimatedVramBytes": 12,
        "minimumVramBytes": 8, "configuredContextWindow": null, "defaultContextWindow": 4096, "minContextWindow": 1024,
        "maxContextWindow": 8192, "contextWindow": 4096, "runtimeContextWindow": 4096, "supportsFunctionCalling": true,
        "supportsReasoning": null, "supportsImages": false, "supportsReasoningSettings": false, "architecture": null,
        "compatibility": "ok", "revision": null, "license": "MIT", "source": "s", "recommended": false, "compatible": true,
        "installed": false, "present": true
    });
    model.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    model
}

fn provider(installations: Value, models: Value) -> Value {
    json!({
        "platformSupported": true, "available": true,
        "runtime": { "installed": true, "version": "b1", "downloadBytes": 5, "source": "s", "license": "MIT", "backend": "cpu" },
        "hardware": { "platform": "linux", "arch": "x64", "gpu": null, "gpus": [], "supported": true, "checking": false, "checkedAt": 1700000000000i64, "error": null },
        "disk": { "availableBytes": null }, "models": models, "recommendation": null, "running": false, "starting": false,
        "activeModel": null, "gpu": null, "loadTimeMs": null, "lastExit": null, "lastError": null, "activeRequests": 0,
        "queuedRequests": 0, "idleTtlSeconds": 3600, "idleDeadline": null, "lastUnloadError": null, "installations": installations,
        "installationCommandError": null, "enabled": true, "installed": true
    })
}

fn settings(local_provider: Value) -> Value {
    json!({
        "instructionFiles": "off", "autoEffortBase": "medium", "webSearch": { "enabled": true },
        "memory": { "enabled": false, "installed": false, "semanticSearchSupported": true,
            "info": { "model": "e5", "dtype": null, "dimensions": 384, "device": "", "engine": "onnx", "supported": true } },
        "git": { "enabled": true, "installed": false }, "office": { "enabled": false, "installed": false },
        "tidy": { "enabled": false, "installed": false }, "visualize": { "enabled": true, "installed": true },
        "media": { "enabled": true, "installed": true }, "localProvider": local_provider,
        "autoEffort": { "supported": true, "enabled": true, "installed": true, "installing": false, "ready": false, "lastError": "",
            "info": { "model": "g", "quantization": "4-bit", "engine": "onnx", "device": "CPU", "modelBytes": 153062716u64, "ready": false } }
    })
}

/// Numbers compare as f64: a millisecond count written as 0 comes back as 0.0.
fn canon(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.iter().map(canon).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), canon(v))).collect()),
        other => other.clone(),
    }
}

fn round_trip(value: &Value) -> ToolModuleSettings {
    let typed: ToolModuleSettings = serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{error}\n{value}"));
    assert_eq!(canon(&serde_json::to_value(&typed).unwrap()), canon(value));
    typed
}

#[test]
fn a_settings_value_round_trips_with_its_modules_and_enums() {
    let typed = round_trip(&settings(provider(json!([]), json!([]))));
    assert_eq!(typed.instruction_files, InstructionFilesMode::Off);
    assert_eq!(typed.auto_effort_base, AutoEffortBase::Medium);
    assert!(typed.git.enabled && !typed.git.installed);
    assert_eq!(typed.auto_effort.info.model_bytes, 153_062_716);
}

#[test]
fn an_unknown_instruction_files_mode_is_refused() {
    let mut value = settings(provider(json!([]), json!([])));
    value["instructionFiles"] = json!("everything");
    assert!(serde_json::from_value::<ToolModuleSettings>(value).is_err());
}

#[test]
fn a_model_keeps_null_and_absent_optional_members_apart() {
    let absent = model(json!({}));
    let explicit_null = model(json!({ "loadTimeMs": null }));
    let set = model(json!({ "loadTimeMs": 10, "verification": { "valid": true, "sizeBytes": 123, "sha256": "ab", "at": "2026-01-01T00:00:00.000Z" } }));
    let typed = round_trip(&settings(provider(json!([]), json!([absent.clone(), explicit_null.clone(), set.clone()]))));
    let models = typed.local_provider.models;
    assert_eq!(models[0].load_time_ms, None);
    assert_eq!(models[1].load_time_ms, Some(None));
    assert_eq!(models[2].load_time_ms, Some(Some(10.0)));
    assert!(models[2].verification.as_ref().unwrap().valid);
}

#[test]
fn a_models_latest_request_is_running_complete_or_failed() {
    let end = |state: &str, error: Value| {
        json!({ "state": state, "at": "2026-01-01T00:00:00.000Z", "queueWaitMs": 0, "durationMs": 5, "firstResponseMs": null,
            "outputTokens": null, "inputTokens": null, "tokensPerSecond": null, "error": error })
    };
    let models = json!([
        model(json!({ "inference": { "state": "running", "queueWaitMs": 3 } })),
        model(json!({ "inference": end("complete", Value::Null) })),
        model(json!({ "inference": end("failed", json!("boom")) })),
    ]);
    let typed = round_trip(&settings(provider(json!([]), models)));
    let inference: Vec<_> = typed.local_provider.models.into_iter().map(|m| m.inference.unwrap()).collect();
    assert!(matches!(inference[0], LocalInference::Running { queue_wait_ms } if queue_wait_ms == 3.0));
    assert!(matches!(inference[1], LocalInference::Complete(_)));
    assert!(matches!(&inference[2], LocalInference::Failed(end) if end.error.as_deref() == Some("boom")));
}

#[test]
fn installations_keep_their_state_job_id_and_paused_byte_counts() {
    let installations = json!([
        { "jobId": "j1", "phase": "runtime", "modelId": null, "state": "complete", "stage": "complete", "percent": 100, "updatedAt": 5 },
        { "jobId": "j2", "phase": "model", "modelId": "x", "state": "failed", "stage": "preparing", "percent": null, "updatedAt": 6, "error": "download failed" },
        { "phase": "model", "modelId": "y", "state": "paused", "stage": "paused", "percent": 40.5, "receivedBytes": 4, "totalBytes": 10 },
    ]);
    let typed = round_trip(&settings(provider(installations, json!([]))));
    let jobs = typed.local_provider.installations;
    assert_eq!(jobs[0].model_id, Some(None), "a modelId written as null stays null");
    assert_eq!(jobs[1].state, LocalInstallState::Failed);
    assert_eq!(jobs[2].job_id, None, "a paused partial download found on disk has no job");
    assert_eq!((jobs[2].received_bytes, jobs[2].total_bytes), (Some(4), Some(10)));
}

#[test]
fn a_server_that_exited_reports_how_it_ended() {
    let mut value = provider(json!([]), json!([]));
    value["lastExit"] = json!({ "at": "2026-01-01T00:00:00.000Z", "modelId": "m", "exitCode": null, "signal": "SIGKILL", "expected": false, "log": "tail" });
    value["gpu"] = json!({ "vendor": "NVIDIA", "name": "g", "memoryBytes": 100, "index": 0, "uuid": "u", "freeMemoryBytes": 50 });
    let typed: LocalProviderModule = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(canon(&serde_json::to_value(&typed).unwrap()), canon(&value));
    assert_eq!(typed.last_exit.unwrap().signal.as_deref(), Some("SIGKILL"));
}
