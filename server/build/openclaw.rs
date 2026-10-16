//! openclaw's gateway protocol types from the vendored
//! `vendor/openclaw/protocol.schema.json` (`docs/openclaw.md`, 2.3).
//!
//! the schema holds 1050 definitions, every one written out inline (no
//! `$ref`), so only the roots boxbox reads or writes are handed to typify;
//! each is self-contained. before typify runs, the loader makes decode
//! tolerant and the output plain:
//!
//! - `additionalProperties: false` is dropped. typify would turn it into
//!   `deny_unknown_fields`, and openclaw adds fields without moving the
//!   protocol, so an additive gateway release would become unreadable.
//!   outbound params are built only from these structs, so boxbox still
//!   cannot send a field the schema lacks.
//! - string and array bounds, `pattern`, `uniqueItems`, `not`, `contains`,
//!   `propertyNames` and `additionalItems` are dropped: they would become
//!   validating newtypes (and a regex engine) on fields boxbox mostly only
//!   reads. the allowlist (`src/openclaw/wire.rs`) is what holds what
//!   boxbox writes, and the drift test reads the bounds it cares about
//!   from the schema itself.
//! - typebox's spellings become draft-07's, as for cmx2: `const` is a
//!   one-value `enum`, an `anyOf` of string constants is one string
//!   `enum`, and a single `patternProperties` entry is
//!   `additionalProperties`.

use serde_json::{Map, Value};

/// the definitions typify generates, and with them every inline type they
/// hold (`docs/openclaw.md`, 2.3: frames, the handshake, the params and
/// results of every allowlisted method, and the events boxbox consumes).
pub const ROOTS: &[&str] = &[
    "ConnectParams",
    "HelloOk",
    "ErrorShape",
    "RequestFrame",
    "ResponseFrame",
    "EventFrame",
    "TickEvent",
    "ShutdownEvent",
    "SessionsListParams",
    "SessionsCreateParams",
    "SessionsCreateResult",
    "SessionsPatchParams",
    "SessionsMessagesSubscribeParams",
    "SessionsMessagesUnsubscribeParams",
    "ChatSendParams",
    "ChatAbortParams",
    "ChatHistoryParams",
    "ChatHistoryCursorResult",
    "ChatMessageGetParams",
    "ChatMessageGetResult",
    "AgentsListParams",
    "AgentsListResult",
    "ApprovalGetParams",
    "ApprovalGetResult",
    "ApprovalResolveParams",
    "ApprovalResolveResult",
    "ApprovalSnapshot",
    "QuestionListParams",
    "QuestionListResult",
    "QuestionGetParams",
    "QuestionGetResult",
    "QuestionResolveParams",
    "QuestionResolveResult",
    "QuestionRecord",
    "ArtifactsDownloadParams",
    "ArtifactsDownloadResult",
    "SessionReactionsSetParams",
    "SessionReactionsSetResult",
    "SessionReactionsListParams",
    "SessionReactionsListResult",
    "ModelsListParams",
    "ModelsListResult",
    "ChatEvent",
    "SessionRow",
    "SessionApprovalEvent",
    "SessionApprovalReplay",
    "SessionNarrationEvent",
    "SessionReactionEvent",
    "QuestionResolvedEvent",
];

/// keywords that only validate; dropped before typify sees them.
const VALIDATION_ONLY: &[&str] = &[
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "not",
    "contains",
    "propertyNames",
    "additionalItems",
    "maxProperties",
    "minProperties",
    "format",
    "default",
];

pub fn generate(schema: &str, pin: &str) -> String {
    let doc: Value =
        serde_json::from_str(schema).expect("vendor/openclaw/protocol.schema.json is json");
    let all = doc
        .get("definitions")
        .and_then(Value::as_object)
        .expect("the openclaw schema has definitions");
    let mut definitions = Map::new();
    for root in ROOTS {
        let mut definition = all
            .get(*root)
            .unwrap_or_else(|| panic!("the openclaw schema defines {root}"))
            .clone();
        rewrite(&mut definition);
        definitions.insert((*root).to_owned(), definition);
    }
    let root = serde_json::json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": definitions,
    });
    let root: schemars::schema::RootSchema =
        serde_json::from_value(root).expect("the openclaw roots read as draft-07 json schema");
    let mut space =
        typify::TypeSpace::new(typify::TypeSpaceSettings::default().with_struct_builder(false));
    space
        .add_root_schema(root)
        .expect("typify accepts the openclaw roots");
    let types = space.to_stream();

    let (version, protocol) = read_pin(pin);
    crate::format(quote::quote! {
        /// the openclaw release boxbox is built against (`openclaw.pin`).
        pub const PINNED_VERSION: &str = #version;
        /// the gateway protocol boxbox speaks: it sends `minProtocol =
        /// maxProtocol` this, and refuses a gateway that answers another.
        pub const PROTOCOL: u64 = #protocol;
        #types
    })
}

/// `version` and `protocol` from `openclaw.pin`'s `key = value` lines.
fn read_pin(pin: &str) -> (String, u64) {
    let value = |key: &str| {
        pin.lines()
            .filter_map(|line| line.split_once('='))
            .find(|(k, _)| k.trim() == key)
            .map_or_else(
                || panic!("openclaw.pin has a `{key} = ...` line"),
                |(_, v)| v.trim().to_owned(),
            )
    };
    let protocol = value("protocol")
        .parse()
        .expect("openclaw.pin's protocol is an integer");
    (value("version"), protocol)
}

/// rewrites one schema and, through the keywords that hold schemas, every
/// schema inside it. walking by keyword (not by every json object) keeps a
/// property that happens to be named `type` or `pattern` out of reach.
fn rewrite(schema: &mut Value) {
    let Value::Object(map) = schema else {
        return;
    };
    rewrite_object(map);
    for keyword in ["properties", "patternProperties", "definitions"] {
        if let Some(Value::Object(children)) = map.get_mut(keyword) {
            children.values_mut().for_each(rewrite);
        }
    }
    for keyword in ["anyOf", "oneOf", "allOf"] {
        if let Some(Value::Array(arms)) = map.get_mut(keyword) {
            arms.iter_mut().for_each(rewrite);
        }
    }
    for keyword in ["items", "additionalProperties"] {
        match map.get_mut(keyword) {
            Some(Value::Array(items)) => items.iter_mut().for_each(rewrite),
            Some(child @ Value::Object(_)) => rewrite(child),
            _ => {}
        }
    }
}

fn rewrite_object(map: &mut Map<String, Value>) {
    if map.get("additionalProperties") == Some(&Value::Bool(false)) {
        map.remove("additionalProperties");
    }
    for keyword in VALIDATION_ONLY {
        map.remove(*keyword);
    }
    // a tuple (`items` as an array, typebox's fixed lists such as an
    // approval's allowed decisions) reads as a list of any of its arms
    if let Some(Value::Array(arms)) = map.get("items") {
        let arms = arms.clone();
        map.insert("items".into(), serde_json::json!({ "anyOf": arms }));
    }
    if let Some(Value::Array(arms)) = map.get("anyOf")
        && let Some(names) = string_constants(arms)
    {
        map.remove("anyOf");
        map.insert("type".into(), Value::String("string".into()));
        map.insert("enum".into(), Value::Array(names));
    }
    if let Some(constant) = map.remove("const") {
        map.insert("enum".into(), Value::Array(vec![constant]));
    }
    // a closed set of strings would fail a whole frame on the first value a
    // newer gateway adds (an auth method, an approval kind), and openclaw
    // adds them without moving the protocol. a one-value set stays: it is a
    // discriminator, and a variant must not take another's name
    if let Some(Value::Array(names)) = map.get("enum")
        && names.len() > 1
        && names.iter().all(Value::is_string)
    {
        map.remove("enum");
        map.insert("type".into(), Value::String("string".into()));
    }
    // typebox writes `Record<K, T>` as one `patternProperties` entry; for
    // decoding, any key is `additionalProperties: T`, and it spares the
    // generated code a regex engine
    if let Some(Value::Object(patterns)) = map.get("patternProperties")
        && patterns.len() == 1
        && let Some(values) = patterns.values().next()
    {
        let values = values.clone();
        map.remove("patternProperties");
        map.insert("additionalProperties".into(), values);
    }
}

/// the constants when every arm is `{type: string, const: ...}`.
fn string_constants(arms: &[Value]) -> Option<Vec<Value>> {
    arms.iter()
        .map(|arm| {
            let arm = arm.as_object()?;
            let is_string = arm.get("type").and_then(Value::as_str) == Some("string");
            let constant = arm.get("const").filter(|c| c.is_string())?;
            is_string.then(|| constant.clone())
        })
        .collect()
}
