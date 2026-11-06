//! Generation of the golden files: JSON Schema under `schema/` and the
//! TypeScript types and method table of `packages/protocol/src/index.ts`. Both are derived
//! from the Rust types and tables of this crate only.

use std::any::TypeId;
use std::collections::BTreeMap;
use std::collections::HashSet;

use schemars::JsonSchema;
use schemars::r#gen::SchemaGenerator;
use schemars::r#gen::SchemaSettings;
use serde_json::Value;
use serde_json::json;
use ts_rs::TS;
use ts_rs::TypeVisitor;

use crate::common::MethodTypeVisitor;
use crate::common::NotificationTypeVisitor;
use crate::error;
use crate::inventory::INVENTORY;
use crate::limits::CloseCode;
use crate::limits::Limits;

/// One generated file: path relative to the crate's `schema/` directory or
/// `packages/protocol/src/` (see `GeneratedFile::kind`), and its content.
pub struct GeneratedFile {
    pub kind: FileKind,
    pub name: &'static str,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Schema,
    TypeScript,
}

/// Object keys in sorted order, so a golden does not depend on whether
/// `serde_json/preserve_order` is enabled somewhere in the workspace.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let ordered: BTreeMap<_, _> = map.iter().map(|(k, v)| (k.clone(), sorted(v))).collect();
            Value::Object(ordered.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

fn pretty(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(&sorted(value)).expect("schema serializes");
    text.push('\n');
    text
}

fn generator() -> SchemaGenerator {
    SchemaSettings::draft07().into_generator()
}

fn root<T: JsonSchema>() -> String {
    pretty(&serde_json::to_value(generator().into_root_schema_for::<T>()).expect("schema"))
}

struct SchemaPairs<'a> {
    generator: &'a mut SchemaGenerator,
    rows: BTreeMap<&'static str, Value>,
}

impl MethodTypeVisitor for SchemaPairs<'_> {
    fn visit<P, R>(&mut self, method: &'static str)
    where
        P: JsonSchema + TS + 'static,
        R: JsonSchema + TS + 'static,
    {
        let params = self.generator.subschema_for::<P>();
        let result = self.generator.subschema_for::<R>();
        self.rows
            .insert(method, json!({ "params": params, "result": result }));
    }
}

fn method_pairs(visit: impl FnOnce(&mut SchemaPairs<'_>)) -> String {
    let mut generator = generator();
    let mut pairs = SchemaPairs {
        generator: &mut generator,
        rows: BTreeMap::new(),
    };
    visit(&mut pairs);
    let rows = pairs.rows;
    let definitions = generator.definitions().clone();
    pretty(&json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "methods": rows,
        "definitions": definitions,
    }))
}

fn tables() -> Value {
    json!({
        "clientMethods": crate::methods::CLIENT_METHODS,
        "serverRequests": crate::server_requests::SERVER_REQUESTS,
        "serverNotifications": crate::notifications::SERVER_NOTIFICATIONS,
        "clientNotifications": crate::notifications::CLIENT_NOTIFICATIONS,
    })
}

fn operations_map() -> String {
    let rows: Vec<Value> = INVENTORY
        .iter()
        .map(|(list, name, target)| json!({ "list": list, "name": name, "target": target }))
        .collect();
    pretty(&json!({ "inventory": rows }))
}

fn constants() -> String {
    let sections: Vec<Value> = mixdog_protocol::SectionName::ALL
        .iter()
        .map(|name| {
            json!({
                "section": name.wire(),
                "notification": name.notification_method(),
                "feed": name.feed(),
                "keyed": name.keyed(),
            })
        })
        .collect();
    let close: Vec<Value> = CloseCode::ALL
        .iter()
        .map(|code| json!({ "code": code.code(), "reason": code.reason() }))
        .collect();
    pretty(&json!({
        "limits": Limits::default(),
        "inlineMax": mixdog_protocol::INLINE_MAX,
        "maxBlobBytes": mixdog_protocol::MAX_BLOB_BYTES,
        "errorCodes": {
            "invalidRequest": error::INVALID_REQUEST,
            "methodNotFound": error::METHOD_NOT_FOUND,
            "invalidParams": error::INVALID_PARAMS,
            "internalError": error::INTERNAL_ERROR,
            "overloaded": error::OVERLOADED,
        },
        "closeCodes": close,
        "mediaFrame": crate::media::layout_description(),
        "sections": sections,
        "appFeedId": crate::v2::feed::APP_FEED_ID,
    }))
}

/// Collects TypeScript declarations of every reachable named type.
#[derive(Default)]
struct TsCollector {
    seen: HashSet<TypeId>,
    decls: BTreeMap<String, String>,
}

impl TypeVisitor for TsCollector {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if !self.seen.insert(TypeId::of::<T>()) {
            return;
        }
        if <T as TS>::output_path().is_some() {
            let mut decl = String::new();
            if let Some(docs) = <T as TS>::docs() {
                decl.push_str(&docs);
                if !docs.ends_with('\n') {
                    decl.push('\n');
                }
            }
            decl.push_str("export ");
            decl.push_str(&<T::WithoutGenerics as TS>::decl());
            let ident = <T as TS>::ident();
            // Two Rust types exporting one TS name would silently shadow each other.
            if let Some(existing) = self.decls.get(&ident) {
                assert_eq!(existing, &decl, "two types export the TS name {ident}");
            }
            self.decls.insert(ident, decl);
        }
        <T as TS>::visit_dependencies(self);
        <T as TS>::visit_generics(self);
    }
}

struct TsMethodMap<'a> {
    collector: &'a mut TsCollector,
    lines: Vec<String>,
}

impl MethodTypeVisitor for TsMethodMap<'_> {
    fn visit<P, R>(&mut self, method: &'static str)
    where
        P: JsonSchema + TS + 'static,
        R: JsonSchema + TS + 'static,
    {
        self.collector.visit::<P>();
        self.collector.visit::<R>();
        self.lines.push(format!(
            "  \"{method}\": {{ params: {}; result: {} }};",
            P::name(),
            R::name()
        ));
    }
}

impl NotificationTypeVisitor for TsMethodMap<'_> {
    fn visit<P>(&mut self, method: &'static str)
    where
        P: JsonSchema + TS + 'static,
    {
        self.collector.visit::<P>();
        self.lines.push(format!("  \"{method}\": {};", P::name()));
    }
}

fn typescript() -> String {
    let mut collector = TsCollector::default();
    collector.visit::<crate::rpc::JsonRpcMessage>();
    collector.visit::<crate::methods::ClientRequest>();
    collector.visit::<crate::server_requests::ServerRequest>();
    collector.visit::<crate::notifications::ServerNotification>();
    collector.visit::<crate::notifications::ClientNotification>();
    collector.visit::<crate::error::ErrorData>();
    collector.visit::<crate::limits::CloseCode>();
    collector.visit::<crate::media::MediaFrameHeader>();
    collector.visit::<crate::common::RequestClass>();
    collector.visit::<crate::common::Mutation>();
    collector.visit::<crate::common::Delivery>();
    collector.visit::<crate::common::Origin>();
    collector.visit::<mixdog_protocol::ComputerSection>();
    collector.visit::<mixdog_protocol::ToolCallId>();
    collector.visit::<mixdog_protocol::ProviderId>();
    collector.visit::<mixdog_protocol::NotificationPreferences>();
    collector.visit::<mixdog_protocol::RemotePairCode>();
    collector.visit::<mixdog_protocol::ToolModuleSettings>();
    // The error data of a failed `model/proxy/*` call; no method result reaches it.
    collector.visit::<crate::v2::model_proxy::ProxyFailure>();

    let mut client = TsMethodMap {
        collector: &mut collector,
        lines: Vec::new(),
    };
    crate::methods::visit_client_methods(&mut client);
    let client_lines = client.lines;
    let mut server = TsMethodMap {
        collector: &mut collector,
        lines: Vec::new(),
    };
    crate::server_requests::visit_server_requests(&mut server);
    let server_lines = server.lines;
    let mut notes = TsMethodMap {
        collector: &mut collector,
        lines: Vec::new(),
    };
    crate::notifications::visit_server_notifications(&mut notes);
    let note_lines = notes.lines;

    let mut out = String::from(
        "// Generated from the Rust crates mixdog-protocol and mixdog-app-protocol\n\
         // (cargo test -p mixdog-app-protocol with MIXDOG_UPDATE_PROTOCOL_GOLDEN=1). Do not edit.\n\n",
    );
    for decl in collector.decls.values() {
        out.push_str(decl);
        out.push_str("\n\n");
    }
    out.push_str(
        "/** Params and result of every client method. */\nexport type ClientMethods = {\n",
    );
    out.push_str(&client_lines.join("\n"));
    out.push_str("\n};\n\nexport type ClientMethod = keyof ClientMethods;\n\n");
    out.push_str("/** Params and result of every server request (core → client). */\nexport type ServerRequestMethods = {\n");
    out.push_str(&server_lines.join("\n"));
    out.push_str("\n};\n\n/** Params of every server notification. */\nexport type ServerNotificationMethods = {\n");
    out.push_str(&note_lines.join("\n"));
    out.push_str("\n};\n\n");
    out.push_str(
        "/** The method tables (same content as `schema/method_table.json`): per client\n \
         * method its scope, class, mutation, opScope and origins, with wire field paths. */\n\
         export const methodTable = ",
    );
    out.push_str(pretty(&tables()).trim_end());
    out.push_str(
        " as const;\n\nexport type MethodTable = typeof methodTable;\n\
         export type MethodSpec = MethodTable[\"clientMethods\"][number];\n",
    );
    out
}

/// Every golden file, in a fixed order.
pub fn generate() -> Vec<GeneratedFile> {
    let schema = |name, content| GeneratedFile {
        kind: FileKind::Schema,
        name,
        content,
    };
    vec![
        schema("jsonrpc.json", root::<crate::rpc::JsonRpcMessage>()),
        schema(
            "client_request.json",
            root::<crate::methods::ClientRequest>(),
        ),
        schema(
            "client_notification.json",
            root::<crate::notifications::ClientNotification>(),
        ),
        schema(
            "server_request.json",
            root::<crate::server_requests::ServerRequest>(),
        ),
        schema(
            "server_notification.json",
            root::<crate::notifications::ServerNotification>(),
        ),
        schema("error_data.json", root::<crate::error::ErrorData>()),
        schema(
            "notification_preferences.json",
            root::<mixdog_protocol::NotificationPreferences>(),
        ),
        schema("initialize.json", root::<crate::v1::InitializeResponse>()),
        schema(
            "client_methods.json",
            method_pairs(|v| crate::methods::visit_client_methods(v)),
        ),
        schema(
            "server_request_methods.json",
            method_pairs(|v| crate::server_requests::visit_server_requests(v)),
        ),
        schema("method_table.json", pretty(&tables())),
        schema("operations_map.json", operations_map()),
        schema("constants.json", constants()),
        GeneratedFile {
            kind: FileKind::TypeScript,
            name: "index.ts",
            content: typescript(),
        },
    ]
}
