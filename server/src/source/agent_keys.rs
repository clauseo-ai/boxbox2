//! agent keys for foreign agents (`docs/agents.md`, section 3, "agent
//! keys" and "collisions"). a key is pinned in the config or derived from
//! the foreign id, written at first sight, and never changed after; it
//! shares one namespace with connection names, which always win.

use super::ids;
use crate::store::ids::KeyClaim;
use crate::store::{Store, StoreError};

/// one foreign agent's key, or why it has none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub foreign_id: String,
    /// the key, or the refusal's words (`refused: "key"`).
    pub outcome: Result<String, String>,
}

/// the keys of `connection`'s foreign agents, in the order given: each is
/// `(foreign id, pinned key)`. `connection_names` is every configured and
/// paired connection. call it for connections in their `boxbox.toml`
/// order (paired ones after, by pairing time), so when two new agents
/// would take one key the first keeps it.
///
/// # Errors
/// the store failed; agents resolved before it stay written.
pub async fn resolve(
    store: &Store,
    connection_names: &[String],
    connection: &str,
    agents: &[(String, Option<String>)],
) -> Result<Vec<Resolved>, StoreError> {
    let mut resolved = Vec::with_capacity(agents.len());
    for (foreign_id, pinned) in agents {
        let outcome = resolve_one(
            store,
            connection_names,
            connection,
            foreign_id,
            pinned.as_deref(),
        )
        .await?;
        resolved.push(Resolved {
            foreign_id: foreign_id.clone(),
            outcome,
        });
    }
    Ok(resolved)
}

async fn resolve_one(
    store: &Store,
    connection_names: &[String],
    connection: &str,
    foreign_id: &str,
    pinned: Option<&str>,
) -> Result<Result<String, String>, StoreError> {
    // a key once written is the agent's for good, whatever the config or
    // the rule says now: read marks, needs and push links hang off it
    if let Some(kept) = store.agent_key(connection, foreign_id).await? {
        return Ok(Ok(kept));
    }
    let wanted = pinned.map_or_else(
        || ids::derive_agent_key(connection, foreign_id),
        str::to_owned,
    );
    let pin = format!("pin another key for agent {foreign_id} on {connection}");
    if !ids::is_agent_key(&wanted) {
        return Ok(Err(format!(
            "{wanted} is not an agent key (a to z, 0 to 9 and dashes, at most 32); {pin}"
        )));
    }
    if let Some(name) = connection_names.iter().find(|name| **name == wanted) {
        return Ok(Err(format!(
            "{wanted} is the name of the connection {name}; {pin}"
        )));
    }
    Ok(
        match store
            .claim_agent_key(connection, foreign_id, &wanted)
            .await?
        {
            KeyClaim::Kept(kept) => Ok(kept),
            KeyClaim::Claimed => Ok(wanted),
            KeyClaim::Taken {
                connection: owner, ..
            } => Err(format!(
                "{wanted} is already the key of an agent on {owner}; {pin}"
            )),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::scratch;

    fn names() -> Vec<String> {
        vec!["vm-a".into(), "vm-b".into(), "vm-b-main".into()]
    }

    fn agent(foreign: &str, pinned: Option<&str>) -> (String, Option<String>) {
        (foreign.into(), pinned.map(Into::into))
    }

    #[tokio::test]
    async fn derived_and_pinned_keys_are_claimed_and_kept() {
        let (store, thread, dir) = scratch();
        let first = resolve(
            &store,
            &names(),
            "vm-a",
            &[agent("main", None), agent("Ops Bot", Some("ops"))],
        )
        .await
        .unwrap();
        assert_eq!(
            first,
            [
                Resolved {
                    foreign_id: "main".into(),
                    outcome: Ok("vm-a-main".into())
                },
                Resolved {
                    foreign_id: "Ops Bot".into(),
                    outcome: Ok("ops".into())
                },
            ]
        );
        // the config changes its mind: the written keys stay
        let again = resolve(
            &store,
            &names(),
            "vm-a",
            &[agent("main", Some("pinned-now")), agent("Ops Bot", None)],
        )
        .await
        .unwrap();
        assert_eq!(again, first);
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_key_that_is_a_connection_name_is_refused() {
        let (store, thread, dir) = scratch();
        let got = resolve(
            &store,
            &names(),
            "vm-b",
            &[agent("main", None), agent("x", Some("vm-a"))],
        )
        .await
        .unwrap();
        assert_eq!(
            got[0].outcome,
            Err("vm-b-main is the name of the connection vm-b-main; pin another key for agent main on vm-b".into())
        );
        assert_eq!(
            got[1].outcome,
            Err(
                "vm-a is the name of the connection vm-a; pin another key for agent x on vm-b"
                    .into()
            )
        );
        assert_eq!(
            store.agent_key("vm-b", "main").await.unwrap(),
            None,
            "nothing written"
        );
        // a pin clears it
        let got = resolve(
            &store,
            &names(),
            "vm-b",
            &[agent("main", Some("vm-b-assistant"))],
        )
        .await
        .unwrap();
        assert_eq!(got[0].outcome, Ok("vm-b-assistant".into()));
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_key_another_agent_holds_is_refused_naming_its_connection() {
        let (store, thread, dir) = scratch();
        resolve(&store, &names(), "vm-a", &[agent("x", Some("shared"))])
            .await
            .unwrap();
        let got = resolve(&store, &names(), "vm-c", &[agent("y", Some("shared"))])
            .await
            .unwrap();
        assert_eq!(
            got[0].outcome,
            Err("shared is already the key of an agent on vm-a; pin another key for agent y on vm-c".into())
        );
        // two new agents of one connection that derive one key: the first
        // in order keeps it
        let got = resolve(
            &store,
            &names(),
            "vm-c",
            &[agent("my agent", None), agent("My-Agent", None)],
        )
        .await
        .unwrap();
        assert_eq!(got[0].outcome, Ok("vm-c-my-agent".into()));
        assert_eq!(
            got[1].outcome,
            Err("vm-c-my-agent is already the key of an agent on vm-c; pin another key for agent My-Agent on vm-c".into())
        );
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_pinned_key_of_the_wrong_shape_is_refused() {
        let (store, thread, dir) = scratch();
        let got = resolve(&store, &names(), "vm-a", &[agent("x", Some("Not_A_Key"))])
            .await
            .unwrap();
        assert_eq!(
            got[0].outcome,
            Err("Not_A_Key is not an agent key (a to z, 0 to 9 and dashes, at most 32); pin another key for agent x on vm-a".into())
        );
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
