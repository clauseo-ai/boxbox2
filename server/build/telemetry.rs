//! the telemetry dictionary as rust data, from `telemetry/schema.json`.
//! the types it fills (`Column`, `Kind`, `Prop`, `ColumnType`) live in
//! `src/telemetry/dictionary.rs`, which includes this output.

use proc_macro2::TokenStream;
use quote::quote;
use serde_json::Value;

pub fn generate(json: &str) -> String {
    let dictionary: Value = serde_json::from_str(json).expect("telemetry/schema.json is json");

    let envelope = list(&dictionary, "envelope").iter().map(|column| {
        let name = text(column, "name");
        let ty = column_type(text(column, "type"));
        quote! { Column { name: #name, ty: #ty } }
    });

    let mut events: Vec<&Value> = list(&dictionary, "events").iter().collect();
    events.sort_by_key(|event| text(event, "kind"));
    let kinds = events.iter().map(|event| {
        let name = text(event, "kind");
        let props = list(event, "props").iter().map(|prop| {
            let prop_name = text(prop, "name");
            let ty = column_type(text(prop, "type"));
            quote! { Prop { name: #prop_name, ty: #ty } }
        });
        quote! { Kind { name: #name, props: &[#(#props),*] } }
    });

    let classes = list(&dictionary, "deviceClasses")
        .iter()
        .map(|class| class.as_str().expect("device classes are strings"));

    crate::format(quote! {
        /// every envelope column, in `schema.ts` order.
        pub const ENVELOPE: &[Column] = &[#(#envelope),*];
        /// every event kind, sorted by name for binary search.
        pub const KINDS: &[Kind] = &[#(#kinds),*];
        /// the device classes a producer may claim.
        pub const DEVICE_CLASSES: &[&str] = &[#(#classes),*];
    })
}

fn list<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("schema.json: `{key}` is a list"))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("schema.json: `{key}` is a string"))
}

fn column_type(name: &str) -> TokenStream {
    match name {
        "TEXT" => quote! { ColumnType::Text },
        "INTEGER" => quote! { ColumnType::Integer },
        "REAL" => quote! { ColumnType::Real },
        other => panic!("schema.json: unknown column type {other}"),
    }
}
