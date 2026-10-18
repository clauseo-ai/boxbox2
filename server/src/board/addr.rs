//! where a request comes from (decision 81): the socket peer, or, when the
//! peer is this machine (`tailscale serve`, a reverse proxy on the same
//! host), the rightmost `X-Forwarded-For` entry, which is the one that proxy
//! wrote. an entry from a peer that is not loopback is never believed: anyone
//! can send the header. read per request: behind a proxy one connection
//! carries many clients' requests, so the connection's peer alone says nothing.
//!
//! addresses identify a person's machines, so they never reach telemetry
//! labels and are logged only at debug.

use std::net::{IpAddr, SocketAddr};

use axum::http::HeaderMap;

/// at most this many addresses in a board's `addrs`: a mac's tailnet v4 and
/// v6, a lan or two, with room to spare.
pub const MAX_ADDRS: usize = 16;

/// the client address of a request that reached the server from `peer`.
#[must_use]
pub fn client(peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    let peer = canonical(peer.ip());
    if !peer.is_loopback() {
        return peer;
    }
    // the last header holds the entry the nearest proxy appended
    headers
        .get_all("x-forwarded-for")
        .iter()
        .next_back()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit(',').next())
        .and_then(parse)
        .unwrap_or(peer)
}

/// a daemon's `addrs`: comma separated, empty entries skipped.
///
/// # Errors
/// an entry that is not an address, or more than [`MAX_ADDRS`], in words
/// for the daemon's log.
pub fn list(text: &str) -> Result<Vec<IpAddr>, String> {
    let mut addrs = Vec::new();
    for entry in text.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let addr = parse(entry).ok_or_else(|| format!("\"{entry}\" in addrs is not an address"))?;
        if !addrs.contains(&addr) {
            addrs.push(addr);
        }
    }
    if addrs.len() > MAX_ADDRS {
        return Err(format!(
            "addrs lists {} addresses; send at most {MAX_ADDRS}",
            addrs.len()
        ));
    }
    Ok(addrs)
}

/// one address, with or without a port (`[v6]:port`, `v4:port`), as
/// proxies write them.
fn parse(text: &str) -> Option<IpAddr> {
    let text = text.trim();
    text.parse::<IpAddr>()
        .ok()
        .or_else(|| text.parse::<SocketAddr>().ok().map(|s| s.ip()))
        .map(canonical)
}

/// a v4 address carried in v6 (`::ffff:a.b.c.d`, how a dual-stack socket
/// reports a v4 peer) is the v4 address.
fn canonical(addr: IpAddr) -> IpAddr {
    match addr {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 @ IpAddr::V4(_) => v4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(forwarded: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for value in forwarded {
            headers.append("x-forwarded-for", HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    fn peer(text: &str) -> SocketAddr {
        text.parse().unwrap()
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn a_direct_peer_is_the_client() {
        assert_eq!(
            client(peer("100.64.0.7:51000"), &headers(&[])),
            ip("100.64.0.7")
        );
        assert_eq!(
            client(peer("[fd7a:115c:a1e0::7]:51000"), &headers(&[])),
            ip("fd7a:115c:a1e0::7")
        );
    }

    #[test]
    fn a_forwarded_entry_counts_only_from_a_loopback_peer() {
        let forwarded = headers(&["100.64.0.9"]);
        assert_eq!(
            client(peer("127.0.0.1:40000"), &forwarded),
            ip("100.64.0.9")
        );
        assert_eq!(client(peer("[::1]:40000"), &forwarded), ip("100.64.0.9"));
        assert_eq!(
            client(peer("192.168.1.20:40000"), &forwarded),
            ip("192.168.1.20"),
            "a remote peer cannot claim another address"
        );
    }

    #[test]
    fn the_rightmost_entry_is_the_one_the_proxy_wrote() {
        let forwarded = headers(&["10.0.0.1, 100.64.0.9", "1.2.3.4,  100.64.0.10 "]);
        assert_eq!(
            client(peer("127.0.0.1:40000"), &forwarded),
            ip("100.64.0.10")
        );
    }

    #[test]
    fn a_v4_address_in_v6_is_v4() {
        assert_eq!(
            client(peer("[::ffff:100.64.0.7]:51000"), &headers(&[])),
            ip("100.64.0.7")
        );
        assert_eq!(
            client(
                peer("[::ffff:127.0.0.1]:51000"),
                &headers(&["::ffff:100.64.0.9"])
            ),
            ip("100.64.0.9"),
            "a mapped loopback peer is loopback, and a mapped entry is v4"
        );
    }

    #[test]
    fn a_forwarded_entry_that_is_not_an_address_leaves_the_peer() {
        assert_eq!(
            client(peer("127.0.0.1:40000"), &headers(&["unknown"])),
            ip("127.0.0.1")
        );
        assert_eq!(
            client(peer("127.0.0.1:40000"), &headers(&["[fd7a::9]:443"])),
            ip("fd7a::9")
        );
    }

    #[test]
    fn a_daemons_addrs_are_read_and_checked() {
        assert_eq!(
            list("100.64.0.7, fd7a:115c:a1e0::7,,192.168.1.20,100.64.0.7").unwrap(),
            [
                ip("100.64.0.7"),
                ip("fd7a:115c:a1e0::7"),
                ip("192.168.1.20")
            ]
        );
        assert!(list("").unwrap().is_empty());
        assert!(list("desk.local").unwrap_err().contains("not an address"));
        let many: Vec<String> = (0..=MAX_ADDRS).map(|n| format!("10.0.0.{n}")).collect();
        assert!(list(&many.join(",")).unwrap_err().contains("at most"));
    }
}
