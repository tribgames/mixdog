//! The protocol boundary a core enforces on what a client sends: which methods a window-scoped connection may call
//! (`window_scope`), which params carry blob references (`blob_fields`) and the per-method input validators (`validate`).

pub mod blob_fields;
pub mod validate;
pub mod window_scope;

#[cfg(test)]
mod tests {
    use crate::methods::CLIENT_METHODS;

    /// Every method a boundary table names is a real client method.
    #[test]
    fn tables_name_real_methods() {
        let real = |name: &str| CLIENT_METHODS.iter().any(|spec| spec.method == name);
        for method in super::window_scope::table_methods() {
            assert!(real(method), "window_methods.json: `{method}` is not in CLIENT_METHODS");
        }
        for method in super::blob_fields::table_methods() {
            assert!(real(method), "blob_fields.json: `{method}` is not in CLIENT_METHODS");
        }
    }
}
