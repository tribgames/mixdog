use super::*;

pub(super) fn request(args: &[&str], limit: usize) -> ServeRequest {
    ServeRequest {
        id: 1,
        cwd: ".".to_string(),
        args: args.iter().map(|value| (*value).to_string()).collect(),
        offset: 0,
        limit,
        deadline_ms: None,
        keep_warm: false,
        keep_inventory: false,
        keep_inventory_ms: 0,
        bulk_hint: false,
        mtime_top_k: false,
        fuzzy: None,
        hidden: false,
        include_noise: false,
        max_depth: None,
        exclude: Vec::new(),
    }
}
