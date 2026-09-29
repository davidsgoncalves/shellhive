//! `shellhive --hook <kind>`: the app's own executable standing in for
//! the hook scripts where `sh` and `curl` cannot be counted on (Windows).
//! It reads the hook payload on stdin, posts it to the running app and prints
//! what Claude Code expects back, exiting 0 either way so a closed app never
//! blocks a session.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use crate::hooks::PORT;
use crate::permissions::DECISION_TIMEOUT;

const QUICK: Duration = Duration::from_secs(2);

pub fn run(kind: &str) -> i32 {
    let mut input = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut input);
    let tab = std::env::var("SHELLHIVE_TAB_ID").unwrap_or_default();

    match kind {
        "forward" => {
            let _ = post("/hook", &tab, &input, QUICK);
        }
        "session-start" => {
            // The app answers with what to tell Claude.
            if let Some(out) = post("/session-start", &tab, &input, QUICK) {
                print!("{out}");
            }
        }
        "statusline" => {
            let _ = post("/statusline", &tab, &input, QUICK);
        }
        "permission" => {
            // Held open by the app until someone decides in the queue.
            let wait = DECISION_TIMEOUT + Duration::from_secs(10);
            if let Some(out) = post("/permission", &tab, &input, wait) {
                if out.contains("permissionDecision") {
                    print!("{out}");
                }
            }
        }
        _ => {}
    }
    let _ = std::io::stdout().flush();
    0
}

/// A bare HTTP/1.1 POST to the app's local server, returning the body.
fn post(path: &str, tab: &str, body: &[u8], timeout: Duration) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let mut stream = TcpStream::connect_timeout(&addr, QUICK).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(QUICK)).ok()?;
    let head = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: 127.0.0.1:{PORT}\r\n\
         Content-Type: application/json\r\n\
         X-Tab-Id: {tab}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).ok()?;
    stream.write_all(body).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let text = String::from_utf8_lossy(&response);
    text.split_once("\r\n\r\n").map(|(_, b)| b.to_string())
}
