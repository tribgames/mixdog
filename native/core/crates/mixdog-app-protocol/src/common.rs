//! The method tables (P §2.2 `common`, SPEC R19): one row per method with
//! `name, params, result, scope (P §7.1), class (RL §4.1), mutation (P §9),
//! origins (DS §4.2)`. The macros below generate the typed message enums,
//! the static spec tables and the type visitors used by `export`.

use std::fmt;

use mixdog_protocol::OpId;
use mixdog_protocol::ThreadId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Request class (RL §4.1, SPEC §4.3): static per method, never derived at runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
pub enum RequestClass {
    /// Control: RT-C only, no serialization key.
    C0,
    /// Interactive read.
    C1,
    /// Interactive mutation.
    C2,
    /// Background request (job registry, deduplicated by key).
    C3,
}

pub use mixdog_protocol::Origin;

/// Owner scope of a mutation's op record (P §9.2). For a method whose
/// serialization scope resolves to a thread, the op scope is that thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum OpDomain {
    Core,
    Thread,
    Config,
    Account,
    Agent,
    Instructions,
    Connector,
    Project,
    ProjectFs,
    Transfer,
    Lsp,
    Document,
    Media,
    Channel,
    Import,
    Mcp,
    Skills,
    Plugins,
    LocalProvider,
    Terminal,
    Process,
    Git,
    Github,
    RemoteAccess,
    Notify,
    Room,
    Memory,
    Update,
    Voice,
    Diagnostics,
    Feedback,
    Approval,
    Host,
}

impl OpDomain {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Thread => "thread",
            Self::Config => "config",
            Self::Account => "account",
            Self::Agent => "agent",
            Self::Instructions => "instructions",
            Self::Connector => "connector",
            Self::Project => "project",
            Self::ProjectFs => "projectFs",
            Self::Transfer => "transfer",
            Self::Lsp => "lsp",
            Self::Document => "document",
            Self::Media => "media",
            Self::Channel => "channel",
            Self::Import => "import",
            Self::Mcp => "mcp",
            Self::Skills => "skills",
            Self::Plugins => "plugins",
            Self::LocalProvider => "localProvider",
            Self::Terminal => "terminal",
            Self::Process => "process",
            Self::Git => "git",
            Self::Github => "github",
            Self::RemoteAccess => "remoteAccess",
            Self::Notify => "notify",
            Self::Room => "room",
            Self::Memory => "memory",
            Self::Update => "update",
            Self::Voice => "voice",
            Self::Diagnostics => "diagnostics",
            Self::Feedback => "feedback",
            Self::Approval => "approval",
            Self::Host => "host",
        }
    }
}

/// Mutation column of a method row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", content = "domain", rename_all = "camelCase")]
pub enum Mutation {
    /// Reads, subscriptions, paging and C0 controls: no `opId`.
    None,
    /// Requires `params.opId`; one execution per `(scope, opId)`.
    Op(OpDomain),
}

/// Static description of a row's serialization scope (P §7.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScopeRule {
    /// Runs concurrently.
    None,
    /// Exclusive per domain key.
    Global {
        key: &'static str,
    },
    /// Concurrent reads ordered against `global(key)` writes.
    SharedRead {
        key: &'static str,
    },
    /// Exclusive per `params.threadId`.
    Thread {
        field: &'static str,
    },
    /// `thread(field)` when present, else `global(key)` (configure actions, P §12).
    ThreadOrGlobal {
        field: &'static str,
        key: &'static str,
    },
    /// None when `field` is present, else `sharedRead(key)` (read actions, P §12).
    ThreadOrSharedRead {
        field: &'static str,
        key: &'static str,
    },
    /// `thread(field)` when present, else concurrent.
    ThreadOrNone {
        field: &'static str,
    },
    /// Exclusive per `<namespace>:<params[field]>`.
    Keyed {
        namespace: &'static str,
        field: &'static str,
    },
    Process {
        field: &'static str,
    },
    Terminal {
        field: &'static str,
    },
    FsWatch {
        field: &'static str,
    },
    FuzzySession {
        field: &'static str,
    },
    McpOauth {
        field: &'static str,
    },
    /// Exclusive per repository root (`git:<root>`).
    Repo {
        field: &'static str,
    },
    /// `channel/call`: thread when `args.sessionId`, else `channel:<client name>`.
    ChannelCall,
}

/// Byte length of the wire spelling of a Rust field name (`thread_id` → `threadId`).
#[doc(hidden)]
pub const fn wire_path_len(rust: &str) -> usize {
    let bytes = rust.as_bytes();
    let mut len = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'_' {
            len += 1;
        }
        i += 1;
    }
    len
}

/// The wire spelling of a Rust field name, built at compile time for the static tables.
#[doc(hidden)]
pub const fn wire_path<const N: usize>(rust: &str) -> [u8; N] {
    let bytes = rust.as_bytes();
    let mut out = [0u8; N];
    let mut upper = false;
    let (mut i, mut o) = (0, 0);
    while i < bytes.len() {
        if bytes[i] == b'_' {
            upper = true;
        } else {
            out[o] = if upper {
                bytes[i].to_ascii_uppercase()
            } else {
                bytes[i]
            };
            upper = false;
            o += 1;
        }
        i += 1;
    }
    out
}

/// A resolved serialization key of one request (P §7.1).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SerializationScope {
    Global(&'static str),
    GlobalSharedRead(&'static str),
    Thread {
        thread_id: ThreadId,
    },
    /// Key `<namespace>:<key>`, one resource of a domain.
    Keyed {
        namespace: &'static str,
        key: String,
    },
    Process {
        process_handle: String,
    },
    Terminal {
        tab_id: String,
    },
    FsWatch {
        watch_id: String,
    },
    FuzzySession {
        session_id: String,
    },
    McpOauth {
        server_name: String,
    },
    /// Key `git:<root>`: the root as given; the server canonicalizes before keying.
    Repo {
        root: String,
    },
    /// Key `channel:<client name>` of the calling connection.
    ChannelClient,
}

/// Owner scope of an op record: `thread:<id>` or a domain name (P §9.2).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum OpScope {
    Thread(ThreadId),
    Domain(OpDomain),
}

impl fmt::Display for OpScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Thread(id) => write!(f, "thread:{id}"),
            Self::Domain(domain) => f.write_str(domain.wire()),
        }
    }
}

/// How a row's op scope is derived (P §9.2), exported so clients build
/// their per-method bookkeeping from the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpScopeRule {
    /// Not a mutation.
    None,
    /// Always the domain scope.
    Domain { domain: OpDomain },
    /// `thread:<params[field]>`.
    Thread { field: &'static str },
    /// `thread:<params[field]>` when present, else the domain scope.
    ThreadOrDomain {
        field: &'static str,
        domain: OpDomain,
    },
}

impl OpScopeRule {
    /// Derives the rule from the scope and mutation columns.
    pub const fn derive(scope: ScopeRule, mutation: Mutation) -> Self {
        match mutation {
            Mutation::None => Self::None,
            Mutation::Op(domain) => match scope {
                ScopeRule::Thread { field } => Self::Thread { field },
                ScopeRule::ThreadOrGlobal { field, .. }
                | ScopeRule::ThreadOrSharedRead { field, .. }
                | ScopeRule::ThreadOrNone { field } => Self::ThreadOrDomain { field, domain },
                ScopeRule::ChannelCall => Self::ThreadOrDomain {
                    field: "args.sessionId",
                    domain,
                },
                _ => Self::Domain { domain },
            },
        }
    }
}

/// Params of every mutation carry the op id.
pub trait HasOpId {
    fn op_id(&self) -> &OpId;
}

/// One row of the client request table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodSpec {
    pub method: &'static str,
    pub params: &'static str,
    pub result: &'static str,
    pub scope: ScopeRule,
    pub class: RequestClass,
    pub mutation: Mutation,
    pub op_scope: OpScopeRule,
    pub origins: &'static [Origin],
}

impl MethodSpec {
    pub fn allows(&self, origin: Origin) -> bool {
        self.origins.contains(&origin)
    }
}

/// Feed a server notification travels on (P §6, DS §2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    /// A thread feed (`feed.id = threadId`).
    Thread,
    /// The app feed.
    App,
    /// A scoped feed of the named kind.
    Scoped(crate::v2::feed::ScopedFeedKind),
    /// Every scoped feed (`feed/snapshot`).
    AnyScoped,
    /// Connection-scoped: no `feed` stamp.
    Connection,
}

/// One row of a notification table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSpec {
    pub method: &'static str,
    pub params: &'static str,
    /// Where it is delivered; `None` for client notifications.
    pub delivery: Option<Delivery>,
}

/// One row of the server request table (core → client).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRequestSpec {
    pub method: &'static str,
    pub params: &'static str,
    pub result: &'static str,
    /// Delivered to connections that declared this initialize capability
    /// (`host`, `modelProxy`) or to every eligible connection (`None`).
    pub requires: Option<&'static str>,
}

/// Visits the params and result types of every row (schema and TS export).
pub trait MethodTypeVisitor {
    fn visit<P, R>(&mut self, method: &'static str)
    where
        P: JsonSchema + TS + 'static,
        R: JsonSchema + TS + 'static;
}

/// Visits the params type of every notification row.
pub trait NotificationTypeVisitor {
    fn visit<P>(&mut self, method: &'static str)
    where
        P: JsonSchema + TS + 'static;
}

/// Why a JSON-RPC request did not decode into a typed request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestDecodeError {
    /// `-32601 methodNotFound`.
    MethodNotFound(String),
    /// `-32602 invalidParams`.
    InvalidParams {
        method: &'static str,
        detail: String,
    },
}

impl RequestDecodeError {
    pub fn into_error_data(self) -> crate::error::ErrorData {
        match self {
            Self::MethodNotFound(method) => crate::error::ErrorData::MethodNotFound { method },
            Self::InvalidParams { method, detail } => crate::error::ErrorData::InvalidParams {
                path: format!("{method}.params"),
                expected: detail,
            },
        }
    }
}

#[doc(hidden)]
#[macro_export]
macro_rules! __wire_path {
    ($field:ident) => {{
        const BYTES: [u8; $crate::common::wire_path_len(stringify!($field))] =
            $crate::common::wire_path(stringify!($field));
        const PATH: &str = match ::core::str::from_utf8(&BYTES) {
            Ok(path) => path,
            Err(_) => panic!("field names are ASCII"),
        };
        PATH
    }};
}

#[doc(hidden)]
#[macro_export]
macro_rules! __scope_rule {
    (none) => {
        $crate::common::ScopeRule::None
    };
    (global($key:literal)) => {
        $crate::common::ScopeRule::Global { key: $key }
    };
    (shared_read($key:literal)) => {
        $crate::common::ScopeRule::SharedRead { key: $key }
    };
    (thread($field:ident)) => {
        $crate::common::ScopeRule::Thread {
            field: $crate::__wire_path!($field),
        }
    };
    (thread_or_global($field:ident, $key:literal)) => {
        $crate::common::ScopeRule::ThreadOrGlobal {
            field: $crate::__wire_path!($field),
            key: $key,
        }
    };
    (thread_or_shared_read($field:ident, $key:literal)) => {
        $crate::common::ScopeRule::ThreadOrSharedRead {
            field: $crate::__wire_path!($field),
            key: $key,
        }
    };
    (thread_or_none($field:ident)) => {
        $crate::common::ScopeRule::ThreadOrNone {
            field: $crate::__wire_path!($field),
        }
    };
    (keyed($namespace:literal, $field:ident)) => {
        $crate::common::ScopeRule::Keyed {
            namespace: $namespace,
            field: $crate::__wire_path!($field),
        }
    };
    (process($field:ident)) => {
        $crate::common::ScopeRule::Process {
            field: $crate::__wire_path!($field),
        }
    };
    (terminal($field:ident)) => {
        $crate::common::ScopeRule::Terminal {
            field: $crate::__wire_path!($field),
        }
    };
    (fs_watch($field:ident)) => {
        $crate::common::ScopeRule::FsWatch {
            field: $crate::__wire_path!($field),
        }
    };
    (fuzzy($field:ident)) => {
        $crate::common::ScopeRule::FuzzySession {
            field: $crate::__wire_path!($field),
        }
    };
    (mcp_oauth($field:ident)) => {
        $crate::common::ScopeRule::McpOauth {
            field: $crate::__wire_path!($field),
        }
    };
    (repo($field:ident)) => {
        $crate::common::ScopeRule::Repo {
            field: $crate::__wire_path!($field),
        }
    };
    (channel_call) => {
        $crate::common::ScopeRule::ChannelCall
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __scope_expr {
    ($p:ident, none) => {
        None
    };
    ($p:ident, global($key:literal)) => {
        Some($crate::common::SerializationScope::Global($key))
    };
    ($p:ident, shared_read($key:literal)) => {
        Some($crate::common::SerializationScope::GlobalSharedRead($key))
    };
    ($p:ident, thread($field:ident)) => {
        Some($crate::common::SerializationScope::Thread {
            thread_id: $p.$field.clone(),
        })
    };
    ($p:ident, thread_or_global($field:ident, $key:literal)) => {
        Some(match &$p.$field {
            Some(thread_id) => $crate::common::SerializationScope::Thread {
                thread_id: thread_id.clone(),
            },
            None => $crate::common::SerializationScope::Global($key),
        })
    };
    ($p:ident, thread_or_shared_read($field:ident, $key:literal)) => {
        match &$p.$field {
            Some(_) => None,
            None => Some($crate::common::SerializationScope::GlobalSharedRead($key)),
        }
    };
    ($p:ident, thread_or_none($field:ident)) => {
        $p.$field
            .as_ref()
            .map(|thread_id| $crate::common::SerializationScope::Thread {
                thread_id: thread_id.clone(),
            })
    };
    ($p:ident, keyed($namespace:literal, $field:ident)) => {
        Some($crate::common::SerializationScope::Keyed {
            namespace: $namespace,
            key: $p.$field.to_string(),
        })
    };
    ($p:ident, process($field:ident)) => {
        Some($crate::common::SerializationScope::Process {
            process_handle: $p.$field.to_string(),
        })
    };
    ($p:ident, terminal($field:ident)) => {
        Some($crate::common::SerializationScope::Terminal {
            tab_id: $p.$field.to_string(),
        })
    };
    ($p:ident, fs_watch($field:ident)) => {
        Some($crate::common::SerializationScope::FsWatch {
            watch_id: $p.$field.to_string(),
        })
    };
    ($p:ident, fuzzy($field:ident)) => {
        Some($crate::common::SerializationScope::FuzzySession {
            session_id: $p.$field.to_string(),
        })
    };
    ($p:ident, mcp_oauth($field:ident)) => {
        Some($crate::common::SerializationScope::McpOauth {
            server_name: $p.$field.to_string(),
        })
    };
    ($p:ident, repo($field:ident)) => {
        Some($crate::common::SerializationScope::Repo {
            root: $p.$field.to_string(),
        })
    };
    ($p:ident, channel_call) => {
        Some(match $p.thread_id() {
            Some(thread_id) => $crate::common::SerializationScope::Thread { thread_id },
            None => $crate::common::SerializationScope::ChannelClient,
        })
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __mutation {
    (none) => {
        $crate::common::Mutation::None
    };
    (op($domain:ident)) => {
        $crate::common::Mutation::Op($crate::common::OpDomain::$domain)
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __op_expr {
    ($p:ident, $scope:expr, none) => {{
        let _ = $scope;
        None
    }};
    ($p:ident, $scope:expr, op($domain:ident)) => {{
        let op_id = $crate::common::HasOpId::op_id($p);
        let scope = match $scope {
            Some($crate::common::SerializationScope::Thread { thread_id }) => {
                $crate::common::OpScope::Thread(thread_id)
            }
            _ => $crate::common::OpScope::Domain($crate::common::OpDomain::$domain),
        };
        Some((scope, op_id))
    }};
}

/// Generates `ClientRequest`, `CLIENT_METHODS` and the client-method helpers.
#[macro_export]
macro_rules! client_request_definitions {
    ($(
        $(#[doc = $doc:literal])*
        $variant:ident => $wire:literal {
            params: $params:ty,
            result: $result:ty,
            scope: $scope_kind:ident $( ( $($scope_args:tt)* ) )?,
            class: $class:ident,
            mutation: $mut_kind:ident $( ( $mut_domain:ident ) )?,
            origins: [$($origin:ident),*],
        }
    ),* $(,)?) => {
        /// Request from a client to the core.
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, schemars::JsonSchema, ts_rs::TS)]
        #[allow(clippy::large_enum_variant)]
        #[serde(tag = "method")]
        pub enum ClientRequest {
            $(
                $(#[doc = $doc])*
                #[serde(rename = $wire)]
                #[ts(rename = $wire)]
                $variant {
                    #[serde(rename = "id")]
                    request_id: $crate::rpc::RequestId,
                    params: $params,
                },
            )*
        }

        /// Every client method, in table order.
        pub static CLIENT_METHODS: &[$crate::common::MethodSpec] = &[
            $(
                $crate::common::MethodSpec {
                    method: $wire,
                    params: stringify!($params),
                    result: stringify!($result),
                    scope: $crate::__scope_rule!($scope_kind $( ( $($scope_args)* ) )?),
                    class: $crate::common::RequestClass::$class,
                    mutation: $crate::__mutation!($mut_kind $( ( $mut_domain ) )?),
                    op_scope: $crate::common::OpScopeRule::derive(
                        $crate::__scope_rule!($scope_kind $( ( $($scope_args)* ) )?),
                        $crate::__mutation!($mut_kind $( ( $mut_domain ) )?),
                    ),
                    origins: &[$($crate::common::Origin::$origin),*],
                },
            )*
        ];

        /// The row of a client method.
        pub fn client_method_spec(method: &str) -> Option<&'static $crate::common::MethodSpec> {
            CLIENT_METHODS.iter().find(|spec| spec.method == method)
        }

        impl ClientRequest {
            pub fn id(&self) -> &$crate::rpc::RequestId {
                match self { $(Self::$variant { request_id, .. } => request_id,)* }
            }

            pub fn method(&self) -> &'static str {
                match self { $(Self::$variant { .. } => $wire,)* }
            }

            pub fn spec(&self) -> &'static $crate::common::MethodSpec {
                client_method_spec(self.method()).expect("every variant has a row")
            }

            /// The serialization key of this request (P §7.1); `None` runs concurrently.
            pub fn serialization_scope(&self) -> Option<$crate::common::SerializationScope> {
                match self {
                    $(
                        Self::$variant { params, .. } => {
                            let _ = params;
                            $crate::__scope_expr!(params, $scope_kind $( ( $($scope_args)* ) )?)
                        }
                    )*
                }
            }

            /// Op scope and op id of a mutation (P §9); `None` for non-mutations.
            pub fn op(&self) -> Option<($crate::common::OpScope, &mixdog_protocol::OpId)> {
                match self {
                    $(
                        Self::$variant { params, .. } => {
                            let _ = params;
                            $crate::__op_expr!(params, self.serialization_scope(), $mut_kind $( ( $mut_domain ) )?)
                        }
                    )*
                }
            }

            /// Typed decode of a JSON-RPC request: unknown method → `methodNotFound`,
            /// schema violation → `invalidParams`.
            pub fn from_jsonrpc(
                request: $crate::rpc::JsonRpcRequest,
            ) -> Result<Self, $crate::common::RequestDecodeError> {
                let Some(spec) = client_method_spec(&request.method) else {
                    return Err($crate::common::RequestDecodeError::MethodNotFound(request.method));
                };
                let mut object = serde_json::Map::new();
                object.insert("id".to_owned(), serde_json::to_value(&request.id).expect("id serializes"));
                object.insert("method".to_owned(), serde_json::Value::String(request.method));
                if let Some(params) = request.params {
                    object.insert("params".to_owned(), params);
                }
                serde_json::from_value(serde_json::Value::Object(object)).map_err(|error| {
                    $crate::common::RequestDecodeError::InvalidParams {
                        method: spec.method,
                        detail: error.to_string(),
                    }
                })
            }
        }

        /// Visits params and result types of every client method.
        pub fn visit_client_methods(visitor: &mut impl $crate::common::MethodTypeVisitor) {
            $( visitor.visit::<$params, $result>($wire); )*
        }
    };
}

/// Generates a notification enum, its spec table and type visitor.
#[macro_export]
macro_rules! notification_definitions {
    (
        enum $enum_name:ident;
        table $table:ident;
        visit $visit_fn:ident;
        $(
            $(#[doc = $doc:literal])*
            $variant:ident => $wire:literal ($params:ty) $(@ $delivery:ident $( ( $kind:ident ) )?)?
        ),* $(,)?
    ) => {
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, schemars::JsonSchema, ts_rs::TS)]
        #[allow(clippy::large_enum_variant)]
        #[serde(tag = "method", content = "params")]
        pub enum $enum_name {
            $(
                $(#[doc = $doc])*
                #[serde(rename = $wire)]
                #[ts(rename = $wire)]
                $variant($params),
            )*
        }

        pub static $table: &[$crate::common::NotificationSpec] = &[
            $(
                $crate::common::NotificationSpec {
                    method: $wire,
                    params: stringify!($params),
                    delivery: $crate::__delivery!($( $delivery $( ( $kind ) )? )?),
                },
            )*
        ];

        impl $enum_name {
            pub fn method(&self) -> &'static str {
                match self { $(Self::$variant(_) => $wire,)* }
            }
        }

        pub fn $visit_fn(visitor: &mut impl $crate::common::NotificationTypeVisitor) {
            $( visitor.visit::<$params>($wire); )*
        }
    };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __delivery {
    () => {
        None
    };
    (thread) => {
        Some($crate::common::Delivery::Thread)
    };
    (app) => {
        Some($crate::common::Delivery::App)
    };
    (connection) => {
        Some($crate::common::Delivery::Connection)
    };
    (scoped(Any)) => {
        Some($crate::common::Delivery::AnyScoped)
    };
    (scoped($kind:ident)) => {
        Some($crate::common::Delivery::Scoped(
            $crate::v2::feed::ScopedFeedKind::$kind,
        ))
    };
}

/// Generates `ServerRequest` (core → client), its spec table and visitor.
#[macro_export]
macro_rules! server_request_definitions {
    ($(
        $(#[doc = $doc:literal])*
        $variant:ident => $wire:literal {
            params: $params:ty,
            result: $result:ty,
            requires: $requires:expr,
        }
    ),* $(,)?) => {
        /// Request from the core to a client.
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, schemars::JsonSchema, ts_rs::TS)]
        #[allow(clippy::large_enum_variant)]
        #[serde(tag = "method")]
        pub enum ServerRequest {
            $(
                $(#[doc = $doc])*
                #[serde(rename = $wire)]
                #[ts(rename = $wire)]
                $variant {
                    #[serde(rename = "id")]
                    request_id: $crate::rpc::RequestId,
                    params: $params,
                },
            )*
        }

        pub static SERVER_REQUESTS: &[$crate::common::ServerRequestSpec] = &[
            $(
                $crate::common::ServerRequestSpec {
                    method: $wire,
                    params: stringify!($params),
                    result: stringify!($result),
                    requires: $requires,
                },
            )*
        ];

        impl ServerRequest {
            pub fn id(&self) -> &$crate::rpc::RequestId {
                match self { $(Self::$variant { request_id, .. } => request_id,)* }
            }

            pub fn method(&self) -> &'static str {
                match self { $(Self::$variant { .. } => $wire,)* }
            }
        }

        pub fn visit_server_requests(visitor: &mut impl $crate::common::MethodTypeVisitor) {
            $( visitor.visit::<$params, $result>($wire); )*
        }
    };
}
