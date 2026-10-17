//! cmx2's wire types from its generated `openapi.json`.
//!
//! typify turns every component schema into a serde type. two things are
//! generated here instead of by typify, both from the document itself:
//!
//! - the `Event` union. openapi declares it as a `oneOf` with a
//!   `discriminator` mapping on `type`; typify would emit an untagged enum
//!   that tries up to fifty variants per frame and reports "no variant
//!   matched" when one is malformed. the mapping becomes an `EventKind`
//!   enum and a one-step dispatch: read `type`, decode exactly that
//!   variant, and name the field that failed when it does.
//! - the sse envelope (`GlobalFrame`), with the payload kept as raw json
//!   so the frame is parsed once and the payload decoded once.
//!
//! typify reads draft-07 schemas, where a one-value `enum` is what 3.1's
//! `const` says; the loader rewrites `const` so every variant's `type`
//! field is its own one-value enum and cannot hold another variant's name.
//! it also rewrites typebox's any-key `patternProperties` to the equivalent
//! `additionalProperties` (see `rewrite_object`).

use heck::ToPascalCase;
use proc_macro2::{Ident, Span, TokenStream};
use quote::quote;
use serde_json::{Map, Value};

const REF_PREFIX: &str = "#/components/schemas/";
const DEF_PREFIX: &str = "#/definitions/";

pub fn generate(openapi: &str) -> String {
    let doc: Value = serde_json::from_str(openapi).expect("vendor/cmx2/openapi.json is json");
    let mut schemas = doc
        .pointer("/components/schemas")
        .and_then(Value::as_object)
        .expect("openapi.json has components.schemas")
        .clone();

    add_route_schemas(&doc, &mut schemas);
    let event = schemas
        .remove("Event")
        .expect("openapi.json declares Event");
    let frame = schemas
        .remove("GlobalFrame")
        .expect("openapi.json declares GlobalFrame");
    let variants = event_variants(&event);

    let mut definitions = Value::Object(schemas);
    relax_added_fields(&mut definitions);
    rewrite(&mut definitions);
    let root = serde_json::json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": definitions,
    });
    let root: schemars::schema::RootSchema =
        serde_json::from_value(root).expect("cmx2 schemas read as draft-07 json schema");
    let mut space =
        typify::TypeSpace::new(typify::TypeSpaceSettings::default().with_struct_builder(false));
    space
        .add_root_schema(root)
        .expect("typify accepts the cmx2 schemas");
    let types = space.to_stream();

    let union = event_union(&variants);
    let envelope = global_frame(&frame);
    // cmx2's generator writes its CONTRACT_VERSION as info.version
    let contract: i64 = doc
        .pointer("/info/version")
        .and_then(Value::as_str)
        .and_then(|v| v.parse().ok())
        .expect("openapi.json's info.version is cmx2's integer contract version");

    crate::format(quote! {
        /// the cmx2 contract version these types were generated from; a
        /// daemon reports its own in `/global/health`.
        pub const CONTRACT_VERSION: i64 = #contract;
        #types
        #union
        #envelope
    })
}

/// event fields a later cmx2 added as required to an event an older daemon
/// of the same contract still sends without them: (schema, field). each is
/// read as optional, so the older daemon's frames keep decoding instead of
/// being counted undecodable. a row leaves when the oldest daemon boxbox
/// supports sends the field; cmx2 declaring such additions optional, as it
/// does `waiting` and `refresh`, would retire the table.
const ADDED_SINCE_OLDEST: &[(&str, &str)] = &[
    // cmx2 0.8.13 (compaction.cold); 0.8.8 and earlier send session.compacted without it
    ("Event_session_compacted", "cold"),
];

fn relax_added_fields(definitions: &mut Value) {
    for (schema, field) in ADDED_SINCE_OLDEST {
        let required = definitions
            .pointer_mut(&format!("/{schema}/properties/properties/required"))
            .and_then(Value::as_array_mut)
            .unwrap_or_else(|| panic!("{schema} has a properties object with required fields"));
        let before = required.len();
        required.retain(|name| name.as_str() != Some(field));
        assert!(
            required.len() < before,
            "{schema}.{field} is no longer required; drop its ADDED_SINCE_OLDEST row"
        );
    }
}

/// one arm of the union: the wire name, the rust variant, the payload type.
struct Variant {
    wire: String,
    name: Ident,
    payload: Ident,
}

fn event_variants(event: &Value) -> Vec<Variant> {
    let discriminator = event
        .get("discriminator")
        .expect("Event has a discriminator");
    assert_eq!(
        discriminator.get("propertyName").and_then(Value::as_str),
        Some("type"),
        "Event is discriminated on `type`"
    );
    let mapping = discriminator
        .get("mapping")
        .and_then(Value::as_object)
        .expect("Event's discriminator has a mapping");
    let one_of: Vec<&str> = event
        .get("oneOf")
        .and_then(Value::as_array)
        .expect("Event is a oneOf")
        .iter()
        .map(|v| {
            v.get("$ref")
                .and_then(Value::as_str)
                .expect("every Event arm is a $ref")
        })
        .collect();
    assert_eq!(
        one_of.len(),
        mapping.len(),
        "Event's oneOf and its mapping list the same arms"
    );

    mapping
        .iter()
        .map(|(wire, target)| {
            let target = target.as_str().expect("mapping targets are refs");
            assert!(
                one_of.contains(&target),
                "mapping target {target} is an arm of the oneOf"
            );
            let definition = target
                .strip_prefix(REF_PREFIX)
                .expect("refs point at components");
            Variant {
                wire: wire.clone(),
                name: ident(&wire.replace('.', "_").to_pascal_case()),
                payload: ident(&definition.to_pascal_case()),
            }
        })
        .collect()
}

fn event_union(variants: &[Variant]) -> TokenStream {
    let count = variants.len();
    let wires: Vec<&str> = variants.iter().map(|v| v.wire.as_str()).collect();
    let names: Vec<&Ident> = variants.iter().map(|v| &v.name).collect();
    let payloads: Vec<&Ident> = variants.iter().map(|v| &v.payload).collect();
    quote! {
        /// every event type cmx2 declares, by its wire name.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum EventKind { #(#names,)* }

        impl EventKind {
            pub const ALL: [EventKind; #count] = [#(EventKind::#names,)*];

            #[must_use]
            pub fn as_str(self) -> &'static str {
                match self { #(EventKind::#names => #wires,)* }
            }

            #[must_use]
            pub fn from_wire(name: &str) -> Option<Self> {
                match name { #(#wires => Some(EventKind::#names),)* _ => None }
            }
        }

        /// one decoded cmx2 event.
        #[derive(Clone, Debug)]
        pub enum Event { #(#names(#payloads),)* }

        impl Event {
            /// decodes a payload whose `type` has already been read as `kind`.
            ///
            /// # Errors
            /// the payload does not match `kind`'s schema.
            pub fn decode(kind: EventKind, payload: &str) -> Result<Self, ::serde_json::Error> {
                Ok(match kind {
                    #(EventKind::#names => Event::#names(::serde_json::from_str(payload)?),)*
                })
            }

            #[must_use]
            pub fn kind(&self) -> EventKind {
                match self { #(Event::#names(_) => EventKind::#names,)* }
            }

            /// the daemon's event id (`evt_...`), unique within one daemon run.
            #[must_use]
            pub fn id(&self) -> &str {
                match self { #(Event::#names(event) => &event.id,)* }
            }

            /// the event's place in the daemon's log (cmx2-asks a1); `None`
            /// on what the daemon does not log: deltas, heartbeats, the
            /// connection's own frames and the resume re-send of a part.
            #[must_use]
            pub fn seq(&self) -> Option<i64> {
                match self { #(Event::#names(event) => event.seq,)* }
            }

            /// the store `seq` belongs to; present exactly when `seq` is.
            #[must_use]
            pub fn epoch(&self) -> Option<&str> {
                match self { #(Event::#names(event) => event.epoch.as_deref(),)* }
            }
        }

        impl ::serde::Serialize for Event {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                match self { #(Event::#names(event) => event.serialize(serializer),)* }
            }
        }
    }
}

/// the envelope `/global/event` writes around each payload.
fn global_frame(frame: &Value) -> TokenStream {
    let required: Vec<&str> = frame
        .get("required")
        .and_then(Value::as_array)
        .expect("GlobalFrame lists required fields")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(
        required,
        ["payload"],
        "only the payload is required in a GlobalFrame"
    );
    let properties = frame
        .get("properties")
        .and_then(Value::as_object)
        .expect("GlobalFrame has properties");
    assert_eq!(
        properties
            .get("payload")
            .and_then(|p| p.get("$ref"))
            .and_then(Value::as_str),
        Some("#/components/schemas/Event"),
        "a GlobalFrame's payload is an Event"
    );
    let fields = properties
        .iter()
        .filter(|(name, _)| *name != "payload")
        .map(|(name, schema)| {
            assert_eq!(
                schema.get("type").and_then(Value::as_str),
                Some("string"),
                "GlobalFrame.{name} is a string"
            );
            let field = ident(name);
            quote! {
                #[serde(default, borrow)]
                pub #field: Option<::std::borrow::Cow<'a, str>>,
            }
        });
    quote! {
        /// one `/global/event` frame, with the payload left as raw json.
        #[derive(Debug, ::serde::Deserialize)]
        pub struct GlobalFrame<'a> {
            #(#fields)*
            #[serde(borrow)]
            pub payload: &'a ::serde_json::value::RawValue,
        }

        /// the discriminator of a payload, read before the payload is decoded.
        #[derive(Debug, ::serde::Deserialize)]
        pub struct PayloadType<'a> {
            #[serde(rename = "type", borrow)]
            pub name: ::std::borrow::Cow<'a, str>,
        }
    }
}

/// inline request and response bodies become named definitions too:
/// `<OperationId>Body` and `<OperationId>Response` (`health` answers a
/// `HealthResponse`), so every route's json is a generated type.
fn add_route_schemas(doc: &Value, schemas: &mut Map<String, Value>) {
    let paths = doc
        .get("paths")
        .and_then(Value::as_object)
        .expect("openapi.json has paths");
    for operation in paths
        .values()
        .filter_map(Value::as_object)
        .flat_map(|item| item.values())
    {
        let Some(id) = operation.get("operationId").and_then(Value::as_str) else {
            continue;
        };
        let body = operation.pointer("/requestBody/content/application~1json/schema");
        let response = ["200", "201", "202"].iter().find_map(|status| {
            operation.pointer(&format!(
                "/responses/{status}/content/application~1json/schema"
            ))
        });
        for (suffix, schema) in [("Body", body), ("Response", response)] {
            let Some(schema) = schema.filter(|s| is_named_worthy(s)) else {
                continue;
            };
            let name = format!("{}{suffix}", id.to_pascal_case());
            let previous = schemas.insert(name.clone(), schema.clone());
            assert!(
                previous.is_none(),
                "{name} collides with a component schema"
            );
        }
    }
}

/// an inline object. refs already have a name, a bare `null` or `true`
/// is not worth a type, and typify names a nullable inline union and its
/// object arm alike (`ShellResponse(Option<ShellResponse>)`), so unions at
/// the route level stay unnamed until a milestone needs one.
fn is_named_worthy(schema: &Value) -> bool {
    schema.get("$ref").is_none() && schema.get("type").and_then(Value::as_str) == Some("object")
}

/// points refs at draft-07 definitions and spells `const` as a one-value
/// `enum`, which is what typify understands.
fn rewrite(value: &mut Value) {
    match value {
        Value::Object(map) => {
            rewrite_object(map);
            for child in map.values_mut() {
                rewrite(child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(rewrite),
        _ => {}
    }
}

fn rewrite_object(map: &mut Map<String, Value>) {
    // typebox writes a string union as `anyOf` of consts; draft-07 says it
    // as one `enum`, which typify turns into a plain rust enum.
    if let Some(Value::Array(arms)) = map.get("anyOf")
        && let Some(names) = string_constants(arms)
    {
        map.remove("anyOf");
        map.insert("type".into(), Value::String("string".into()));
        map.insert("enum".into(), Value::Array(names));
    }
    if let Some(Value::String(target)) = map.get_mut("$ref")
        && let Some(name) = target.strip_prefix(REF_PREFIX)
    {
        *target = format!("{DEF_PREFIX}{name}");
    }
    if let Some(constant) = map.remove("const") {
        map.insert("enum".into(), Value::Array(vec![constant]));
    }
    // typebox writes `Record<string, T>` as `patternProperties: {"^.*$": T}`;
    // any key matches, which is exactly `additionalProperties: T`, and it
    // spares the generated code a regex engine.
    if let Some(Value::Object(patterns)) = map.get("patternProperties")
        && patterns.len() == 1
        && let Some(values) = patterns.get("^.*$")
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

fn ident(name: &str) -> Ident {
    Ident::new(name, Span::call_site())
}
