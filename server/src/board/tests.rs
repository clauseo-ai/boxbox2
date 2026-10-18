//! presence: one board at a time, replaced, gone, the grace; and the app
//! windows on the board's mac, found by address.

use std::net::IpAddr;

use super::*;

const MAC: &str = "100.64.0.7";
const OTHER: &str = "100.64.0.8";

fn ip(text: &str) -> IpAddr {
    text.parse().unwrap()
}

fn board() -> Arc<Board> {
    Board::new(BoardConfig { machines: None })
}

fn seat(key: &str, digit: u8) -> Seat {
    Seat {
        key: key.into(),
        digit,
        bound: false,
    }
}

/// the next app frame a window got, decoded; none when it got nothing.
fn next(feed: &mut WindowFeed) -> Option<AppFrame> {
    let frame = feed.frames.try_recv().ok()?;
    let text = std::str::from_utf8(&frame).unwrap();
    assert!(
        !text.starts_with("id:"),
        "an app frame carries no id: {text}"
    );
    let json = text.strip_prefix("data: ").unwrap().trim_end();
    Some(serde_json::from_str(json).unwrap())
}

#[tokio::test]
async fn a_board_arriving_seats_the_windows_on_its_mac_and_no_other() {
    let board = board();
    let mut here = board.window(ip(MAC));
    let mut there = board.window(ip(OTHER));
    assert_eq!(next(&mut here), None, "no board yet");
    let _joined = board.join("board-1", vec![ip(MAC)], ip("127.0.0.1"));
    assert_eq!(next(&mut here), Some(AppFrame::Here { seats: Vec::new() }));
    assert_eq!(next(&mut there), None);
    assert_eq!(board.windows_here(), 1);

    board.seats(vec![seat("desk:s1", 1)]).unwrap();
    assert_eq!(
        next(&mut here),
        Some(AppFrame::Here {
            seats: vec![seat("desk:s1", 1)]
        })
    );
    // a window that opens while the board is here gets the digits at once
    let mut late = board.window(ip(MAC));
    assert_eq!(
        next(&mut late),
        Some(AppFrame::Here {
            seats: vec![seat("desk:s1", 1)]
        })
    );
    assert_eq!(next(&mut there), None);
}

#[tokio::test]
async fn the_observed_address_counts_as_the_macs() {
    let board = board();
    let _joined = board.join("board-1", Vec::new(), ip(MAC));
    let mut here = board.window(ip(MAC));
    assert_eq!(next(&mut here), Some(AppFrame::Here { seats: Vec::new() }));
}

#[tokio::test]
async fn a_loopback_peer_is_not_taken_for_the_boards_mac() {
    let board = board();
    let _joined = board.join("board-1", vec![ip(MAC)], ip("127.0.0.1"));
    let mut proxied = board.window(ip("127.0.0.1"));
    assert_eq!(
        next(&mut proxied),
        None,
        "every client behind a silent proxy looks like this"
    );
    let mut v6 = board.window(ip("::1"));
    assert_eq!(next(&mut v6), None);
    // a daemon on the server's own machine names loopback itself
    let _local = board.join("board-1", vec![ip("127.0.0.1")], ip("127.0.0.1"));
    assert_eq!(
        next(&mut proxied),
        Some(AppFrame::Here { seats: Vec::new() })
    );
}

#[tokio::test]
async fn focus_and_compose_reach_only_the_boards_mac_and_say_when_nothing_took_them() {
    let board = board();
    let focus = AppFrame::Focus {
        key: "desk:s1".into(),
    };
    assert_eq!(board.relay(&focus), Err(Refused::NoBoard));
    let _joined = board.join("board-1", vec![ip(MAC)], ip(MAC));
    let mut there = board.window(ip(OTHER));
    assert_eq!(board.relay(&focus), Err(Refused::NoWindow));
    let mut here = board.window(ip(MAC));
    next(&mut here);
    assert_eq!(board.relay(&focus), Ok(()));
    assert_eq!(next(&mut here), Some(focus));
    assert_eq!(next(&mut there), None);
    drop(here);
    assert_eq!(
        board.relay(&AppFrame::Compose {
            machine: "desk".into()
        }),
        Err(Refused::NoWindow),
        "the window closed: nothing took it"
    );
}

#[tokio::test]
async fn a_new_stream_replaces_the_old_and_the_board_moves_with_it() {
    let board = board();
    let mut on_first = board.window(ip(MAC));
    let mut on_second = board.window(ip(OTHER));
    let first = board.join("board-1", vec![ip(MAC)], ip(MAC));
    board.seats(vec![seat("desk:s1", 1)]).unwrap();
    next(&mut on_first);
    next(&mut on_first);

    let second = board.join("board-1", vec![ip(OTHER)], ip(OTHER));
    assert!(
        first.replaced.is_cancelled(),
        "the old stream hears replaced"
    );
    assert!(!second.replaced.is_cancelled());
    assert_eq!(next(&mut on_first), Some(AppFrame::Gone));
    assert_eq!(
        next(&mut on_second),
        Some(AppFrame::Here {
            seats: vec![seat("desk:s1", 1)]
        }),
        "the same board keeps its digits"
    );
    // the old stream closing changes nothing
    board.left(first.generation);
    assert!(board.device().is_some());

    let _third = board.join("board-2", vec![ip(OTHER)], ip(OTHER));
    assert_eq!(
        next(&mut on_second),
        Some(AppFrame::Here { seats: Vec::new() }),
        "another board starts with no digits"
    );
}

#[tokio::test]
async fn gone_ends_presence_at_once_but_only_from_the_boards_mac() {
    let board = board();
    let mut here = board.window(ip(MAC));
    let mut joined = board.join("board-1", vec![ip(MAC)], ip(MAC));
    next(&mut here);
    board.gone(ip(OTHER));
    assert!(board.device().is_some(), "a late gone from the mac it left");
    board.gone(ip(MAC));
    assert!(board.device().is_none());
    assert_eq!(next(&mut here), Some(AppFrame::Gone));
    assert!(!joined.replaced.is_cancelled(), "nothing took over");
    assert_eq!(
        joined.frames.try_recv(),
        Err(mpsc::error::TryRecvError::Disconnected),
        "its stream ends"
    );
    assert_eq!(board.seats(Vec::new()), Err(Refused::NoBoard));
    // its stream closing afterwards starts no grace
    board.left(joined.generation);
    assert!(board.device().is_none());
}

#[tokio::test(start_paused = true)]
async fn a_dropped_stream_keeps_the_board_through_the_grace_then_lets_go() {
    let board = board();
    let mut here = board.window(ip(MAC));
    let joined = board.join("board-1", vec![ip(MAC)], ip(MAC));
    next(&mut here);
    board.left(joined.generation);
    tokio::time::sleep(Duration::from_secs(19)).await;
    assert!(board.device().is_some(), "still in the grace");
    assert_eq!(next(&mut here), None);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(board.device().is_none());
    assert_eq!(next(&mut here), Some(AppFrame::Gone));
}

#[tokio::test(start_paused = true)]
async fn a_stream_back_inside_the_grace_keeps_the_board() {
    let board = board();
    let first = board.join("board-1", vec![ip(MAC)], ip(MAC));
    board.left(first.generation);
    tokio::time::sleep(Duration::from_secs(5)).await;
    let _second = board.join("board-1", vec![ip(MAC)], ip(MAC));
    tokio::time::sleep(GRACE * 2).await;
    assert!(
        board.device().is_some(),
        "the first grace's timer was stopped"
    );
}

#[tokio::test]
async fn a_board_stream_that_does_not_read_is_busy_not_gone() {
    let board = board();
    let pin = Frame::Pin {
        key: "desk:s1".into(),
        color: [1, 2, 3],
        expires_in_ms: 30_000,
    };
    let _joined = board.join("board-1", vec![ip(MAC)], ip(MAC));
    for _ in 0..FRAMES {
        board.to_board(&pin).unwrap();
    }
    assert_eq!(board.to_board(&pin), Err(Refused::Busy));
}

#[tokio::test]
async fn a_pin_reaches_the_boards_stream_while_one_is_open() {
    let board = board();
    let pin = Frame::Pin {
        key: "desk:s1".into(),
        color: [1, 2, 3],
        expires_in_ms: 30_000,
    };
    assert_eq!(board.to_board(&pin), Err(Refused::NoBoard));
    let mut joined = board.join("board-1", vec![ip(MAC)], ip(MAC));
    board.to_board(&pin).unwrap();
    let frame = joined.frames.try_recv().unwrap();
    assert!(
        std::str::from_utf8(&frame)
            .unwrap()
            .starts_with(r#"data: {"type":"pin","key":"desk:s1""#)
    );
    board.left(joined.generation);
    assert_eq!(
        board.to_board(&pin),
        Err(Refused::NoBoard),
        "in the grace no stream listens"
    );
}
