//! the cmx2 source's history read (`http/history.rs`): one page of the
//! daemon's root listing, and whether it has more behind it.

use std::time::Duration;

use reqwest::Method;
use serde_json::value::RawValue;

use crate::http::asks::read_capped;
use crate::source::cmx2::Cmx2Source;
use crate::upstream::{plain, request};

const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// 100 sessions of a few kb each fit with room; past it the answer is not read.
const READ_CAP: usize = 4 * 1024 * 1024;

impl Cmx2Source {
    /// one page of the daemon's listing of root sessions, `size` of them,
    /// older than `before` when given (`GET /session?roots=true`), and
    /// whether the daemon has more behind it.
    ///
    /// # Errors
    /// why the host could not be read, in words for the page's `unreached`.
    pub async fn history_page(
        &self,
        size: usize,
        before: Option<u64>,
    ) -> Result<(Vec<Box<RawValue>>, bool), String> {
        let route = match before {
            Some(before) => format!("/session?roots=true&limit={size}&before={before}"),
            None => format!("/session?roots=true&limit={size}"),
        };
        let host = self.host();
        let read = async {
            let answer = request(&self.client, host, Method::GET, &route)
                .send()
                .await
                .map_err(|e| plain(&e))?;
            let status = answer.status();
            if !status.is_success() {
                return Err(format!("it answered {status}"));
            }
            let more = answer.headers().contains_key("x-next-cursor");
            let body = read_capped(answer, &host.name, READ_TIMEOUT, READ_CAP)
                .await
                .map_err(|e| e.to_string())?;
            let list = serde_json::from_slice::<Vec<Box<RawValue>>>(&body)
                .map_err(|e| format!("its answer was not a list of threads ({e})"))?;
            Ok((list, more))
        };
        tokio::time::timeout(READ_TIMEOUT, read)
            .await
            .map_err(|_| format!("no answer within {}s", READ_TIMEOUT.as_secs()))?
    }
}
