//! Hugging Face search through the public catalog with a scripted upstream.

use std::sync::{Arc, Mutex};

use mixdog_services::local_provider::hugging_face::{HfError, HfHttp, HuggingFaceCatalog, RangeResponse};
use mixdog_services::local_provider::registered_models::RegisteredModels;
use serde_json::{Value, json};

struct Recording {
    asked: Arc<Mutex<Vec<String>>>,
    rows: Value,
}

#[async_trait::async_trait]
impl HfHttp for Recording {
    async fn get_json(&self, url: &str, _limit: usize) -> Result<Value, String> {
        self.asked.lock().unwrap().push(url.to_owned());
        Ok(self.rows.clone())
    }
    async fn get_range(&self, _url: &str, _end: u64) -> Result<RangeResponse, String> {
        Err("no ranges here".to_owned())
    }
}

fn catalog_of(rows: Value) -> (HuggingFaceCatalog, Arc<Mutex<Vec<String>>>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let registry = Arc::new(RegisteredModels::new(dir.path(), mixdog_rt::testing::tokens().durability_io));
    (HuggingFaceCatalog::new(Box::new(Recording { asked: asked.clone(), rows }), registry), asked, dir)
}

#[tokio::test]
async fn a_query_is_form_encoded_into_one_search_url() {
    let (catalog, asked, _dir) = catalog_of(json!([]));
    catalog.search(Some(&json!("  llama 3 é/ü*  "))).await.unwrap();
    assert_eq!(
        asked.lock().unwrap()[0],
        "https://huggingface.co/api/models?search=llama+3+%C3%A9%2F%C3%BC*&filter=gguf&limit=20&sort=downloads&direction=-1"
    );
}

#[tokio::test]
async fn a_query_of_two_hundred_characters_is_searched_and_one_more_is_refused() {
    let (catalog, asked, _dir) = catalog_of(json!([]));
    catalog.search(Some(&json!("a".repeat(200)))).await.unwrap();
    assert!(matches!(catalog.search(Some(&json!("a".repeat(201)))).await, Err(HfError::Invalid(_))));
    assert!(matches!(catalog.search(Some(&json!(5))).await, Err(HfError::Invalid(_))));
    assert_eq!(asked.lock().unwrap().len(), 1, "a refused query never reaches the upstream");
}

#[tokio::test]
async fn results_keep_twenty_valid_repositories_and_a_non_list_answer_fails() {
    let rows: Vec<Value> = (0..30).map(|i| json!({"id": format!("o/m{i}"), "downloads": "7"})).chain([json!({"id": "bad id"})]).collect();
    let (catalog, _, _dir) = catalog_of(Value::Array(rows));
    let found = catalog.search(Some(&json!("m"))).await.unwrap();
    let models = found["models"].as_array().unwrap();
    assert_eq!(models.len(), 20);
    assert_eq!(models[0], json!({"repository": "o/m0", "downloads": 7.0, "source": "https://huggingface.co/o/m0"}));
    let (broken, _, _dir) = catalog_of(json!({"error": "nope"}));
    assert!(matches!(broken.search(Some(&json!("m"))).await, Err(HfError::Failed(_))));
}