//! The credential files and loaders against Node's (fixtures/oauth-credentials/golden.json): the
//! file each provider reads, the document it loads from a seeded file, and the description of it.

use std::path::Path;

use mixdog_rt::LaneToken as _;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::oauth_credentials::credential_file;
use super::oauth_credentials::load_oauth_credentials;
use super::oauth_status::describe_oauth;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/oauth-credentials/golden.json")).unwrap()
}

/// Strings the way the recorder wrote them: the data folder as `{dataDir}`, `/` as separator.
fn normalized(value: &Value, dir: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace(dir, "{dataDir}").replace('\\', "/")),
        Value::Array(items) => Value::Array(items.iter().map(|item| normalized(item, dir)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), normalized(item, dir))).collect()),
        other => other.clone(),
    }
}

async fn seed(path: &Path, bytes: Vec<u8>) {
    let path = path.to_path_buf();
    mixdog_rt::testing::tokens()
        .durability_io
        .submit(&CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &path, &bytes, &mixdog_statefile::Opts::default()))
        .unwrap()
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn every_seeded_file_loads_and_is_described_as_node_does() {
    let golden = golden();
    let now = golden["now"].as_i64().unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 40);
    for scenario in scenarios {
        let provider = scenario["provider"].as_str().unwrap();
        let name = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let dir_text = dir.path().to_string_lossy().into_owned();
        let path = credential_file(provider, &|_| None, dir.path(), dir.path()).unwrap();
        match &scenario["raw"] {
            Value::Null => {}
            Value::String(text) => seed(&path, text.clone().into_bytes()).await,
            raw => seed(&path, serde_json::to_vec(raw).unwrap()).await,
        }
        let env_token = scenario["env"]["CURSOR_ACCESS_TOKEN"].as_str();
        let loaded = load_oauth_credentials(provider, &path, now, env_token);
        if scenario["loadedRecorded"] == true {
            let got = loaded.as_ref().map_or(Value::Null, |loaded| normalized(loaded, &dir_text));
            assert_eq!(got, scenario["loaded"], "loaded: {provider}: {name}");
        }
        let described = describe_oauth(provider, loaded.as_ref(), now).unwrap();
        assert_eq!(
            serde_json::to_string(&normalized(&described, &dir_text)).unwrap(),
            serde_json::to_string(&scenario["described"]).unwrap(),
            "described: {provider}: {name}"
        );
    }
}

#[test]
fn the_credential_file_is_the_default_one_or_the_one_a_variable_names() {
    let golden = golden();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let cwd = dir.path().join("cwd");
    let env_names = [
        ("openai-oauth", "OPENAI_OAUTH_CREDENTIALS_PATH"),
        ("grok-oauth", "GROK_OAUTH_CREDENTIALS_PATH"),
        ("muse-code-oauth", "MUSE_CODE_OAUTH_CREDENTIALS_PATH"),
        ("command-code-oauth", "COMMAND_CODE_OAUTH_CREDENTIALS_PATH"),
        ("opencode-go-oauth", "OPENCODE_GO_OAUTH_CREDENTIALS_PATH"),
        ("mimo-oauth", "MIMO_OAUTH_CREDENTIALS_PATH"),
        ("antigravity-oauth", "ANTIGRAVITY_OAUTH_CREDENTIALS_PATH"),
    ];
    let rows = golden["paths"].as_array().unwrap();
    assert_eq!(rows.len(), env_names.len());
    for row in rows {
        let provider = row["provider"].as_str().unwrap();
        // `{dataDir}/<file>` in the recording.
        let file = row["default"].as_str().unwrap().strip_prefix("{dataDir}/").unwrap();
        assert_eq!(credential_file(provider, &|_| None, &cwd, &data), Some(data.join(file)), "default: {provider}");
        let variable = env_names.iter().find(|(id, _)| *id == provider).map(|(_, name)| *name).unwrap();
        let elsewhere = dir.path().join("elsewhere").join(format!("{provider}.json"));
        let absolute = elsewhere.to_string_lossy().into_owned();
        assert_eq!(credential_file(provider, &|name| (name == variable).then(|| absolute.clone()), &cwd, &data), Some(elsewhere), "absolute: {provider}");
        let relative = format!("relative/{provider}.json");
        let resolved = credential_file(provider, &|name| (name == variable).then(|| relative.clone()), &cwd, &data);
        assert_eq!(resolved, Some(cwd.join(&relative)), "relative: {provider}");
        // The recording resolved the relative name against its working folder.
        assert_eq!(row["relative"], format!("{{dataDir}}/{relative}"));
    }
    assert_eq!(credential_file("unknown", &|_| None, &cwd, &data), None);
}
