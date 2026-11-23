//! Active TCP connections and UDP endpoints with owning PIDs, via the IP Helper API
//! (`GetExtendedTcpTable` / `GetExtendedUdpTable`). Read-only; no packet capture.

use serde::Serialize;
use std::net::{Ipv4Addr, Ipv6Addr};
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
    MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
};

const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Connection {
    /// "TCP", "TCP6", "UDP" or "UDP6".
    pub protocol: &'static str,
    pub local_addr: String,
    pub local_port: u16,
    /// `None` for listeners and UDP endpoints, which have no remote peer.
    pub remote_addr: Option<String>,
    pub remote_port: Option<u16>,
    /// TCP state name; `None` for UDP.
    pub state: Option<&'static str>,
    pub pid: u32,
}

pub fn tcp_state_name(state: u32) -> &'static str {
    match state {
        1 => "Closed",
        2 => "Listen",
        3 => "SynSent",
        4 => "SynReceived",
        5 => "Established",
        6 => "FinWait1",
        7 => "FinWait2",
        8 => "CloseWait",
        9 => "Closing",
        10 => "LastAck",
        11 => "TimeWait",
        12 => "DeleteTcb",
        _ => "Unknown",
    }
}

/// Ports are stored in network byte order in the low 16 bits of a DWORD.
fn port(raw: u32) -> u16 {
    u16::from_be((raw & 0xFFFF) as u16)
}

/// IPv4 addresses are stored as network-order bytes inside a DWORD.
fn v4(raw: u32) -> Ipv4Addr {
    Ipv4Addr::from(raw.to_ne_bytes())
}

/// Reads rows of type `T` that follow the leading `dwNumEntries` DWORD.
fn rows<T: Copy>(buf: &[u8]) -> Vec<T> {
    if buf.len() < 4 {
        return Vec::new();
    }
    let count = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    let size = std::mem::size_of::<T>();
    (0..count)
        .map_while(|i| {
            let start = 4 + i * size;
            let bytes = buf.get(start..start + size)?;
            // SAFETY: `bytes` is exactly size_of::<T>() long; T is a plain-old-data MIB row.
            Some(unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const T) })
        })
        .collect()
}

pub fn parse_tcp4(buf: &[u8]) -> Vec<Connection> {
    rows::<MIB_TCPROW_OWNER_PID>(buf)
        .into_iter()
        .map(|r| {
            let listening = r.dwState == 2;
            Connection {
                protocol: "TCP",
                local_addr: v4(r.dwLocalAddr).to_string(),
                local_port: port(r.dwLocalPort),
                remote_addr: (!listening).then(|| v4(r.dwRemoteAddr).to_string()),
                remote_port: (!listening).then(|| port(r.dwRemotePort)),
                state: Some(tcp_state_name(r.dwState)),
                pid: r.dwOwningPid,
            }
        })
        .collect()
}

pub fn parse_tcp6(buf: &[u8]) -> Vec<Connection> {
    rows::<MIB_TCP6ROW_OWNER_PID>(buf)
        .into_iter()
        .map(|r| {
            let listening = r.dwState == 2;
            Connection {
                protocol: "TCP6",
                local_addr: Ipv6Addr::from(r.ucLocalAddr).to_string(),
                local_port: port(r.dwLocalPort),
                remote_addr: (!listening).then(|| Ipv6Addr::from(r.ucRemoteAddr).to_string()),
                remote_port: (!listening).then(|| port(r.dwRemotePort)),
                state: Some(tcp_state_name(r.dwState)),
                pid: r.dwOwningPid,
            }
        })
        .collect()
}

pub fn parse_udp4(buf: &[u8]) -> Vec<Connection> {
    rows::<MIB_UDPROW_OWNER_PID>(buf)
        .into_iter()
        .map(|r| Connection {
            protocol: "UDP",
            local_addr: v4(r.dwLocalAddr).to_string(),
            local_port: port(r.dwLocalPort),
            remote_addr: None,
            remote_port: None,
            state: None,
            pid: r.dwOwningPid,
        })
        .collect()
}

pub fn parse_udp6(buf: &[u8]) -> Vec<Connection> {
    rows::<MIB_UDP6ROW_OWNER_PID>(buf)
        .into_iter()
        .map(|r| Connection {
            protocol: "UDP6",
            local_addr: Ipv6Addr::from(r.ucLocalAddr).to_string(),
            local_port: port(r.dwLocalPort),
            remote_addr: None,
            remote_port: None,
            state: None,
            pid: r.dwOwningPid,
        })
        .collect()
}

/// Calls a `GetExtended*Table` function, growing the buffer until it fits (the table can
/// grow between the size probe and the real call).
fn fetch(call: impl Fn(*mut core::ffi::c_void, *mut u32) -> u32) -> Result<Vec<u8>, String> {
    let mut size = 16 * 1024u32;
    for _ in 0..8 {
        let mut buf = vec![0u8; size as usize];
        match call(buf.as_mut_ptr() as *mut _, &mut size) {
            NO_ERROR => {
                buf.truncate(size as usize);
                return Ok(buf);
            }
            ERROR_INSUFFICIENT_BUFFER => size += size / 2 + 1024,
            other => {
                return Err(format!(
                    "Windows reported error {other} reading the connection table."
                ))
            }
        }
    }
    Err("The connection table kept changing size; try again.".into())
}

pub fn list() -> Result<Vec<Connection>, String> {
    let mut out = Vec::new();
    // SAFETY (all four closures): the buffer/size pointers are valid for the call duration.
    let tcp4 =
        fetch(|p, s| unsafe { GetExtendedTcpTable(p, s, 0, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) })?;
    out.extend(parse_tcp4(&tcp4));
    let tcp6 = fetch(|p, s| unsafe {
        GetExtendedTcpTable(p, s, 0, AF_INET6, TCP_TABLE_OWNER_PID_ALL, 0)
    })?;
    out.extend(parse_tcp6(&tcp6));
    let udp4 =
        fetch(|p, s| unsafe { GetExtendedUdpTable(p, s, 0, AF_INET, UDP_TABLE_OWNER_PID, 0) })?;
    out.extend(parse_udp4(&udp4));
    let udp6 =
        fetch(|p, s| unsafe { GetExtendedUdpTable(p, s, 0, AF_INET6, UDP_TABLE_OWNER_PID, 0) })?;
    out.extend(parse_udp6(&udp6));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn byte_order_is_decoded_correctly() {
        // 127.0.0.1:8080 listening, owned by pid 1234, as Windows lays it out.
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u32.to_ne_bytes()); // dwNumEntries
        buf.extend_from_slice(&2u32.to_ne_bytes()); // state = LISTEN
        buf.extend_from_slice(&[127, 0, 0, 1]); // local addr bytes in network order
        buf.extend_from_slice(&(u32::from(8080u16.to_be())).to_ne_bytes()); // local port
        buf.extend_from_slice(&0u32.to_ne_bytes()); // remote addr
        buf.extend_from_slice(&0u32.to_ne_bytes()); // remote port
        buf.extend_from_slice(&1234u32.to_ne_bytes()); // owning pid
        let parsed = parse_tcp4(&buf);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].local_addr, "127.0.0.1");
        assert_eq!(parsed[0].local_port, 8080);
        assert_eq!(parsed[0].state, Some("Listen"));
        assert_eq!(parsed[0].remote_addr, None);
        assert_eq!(parsed[0].pid, 1234);
    }

    #[test]
    fn truncated_tables_do_not_panic() {
        assert!(parse_tcp4(&[]).is_empty());
        let mut buf = 5u32.to_ne_bytes().to_vec(); // claims 5 rows, has none
        buf.extend_from_slice(&[0; 10]);
        assert!(parse_tcp4(&buf).is_empty());
    }

    #[test]
    fn finds_this_process_listener_and_established_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).unwrap();
        let (_server_side, _) = listener.accept().unwrap();
        let me = std::process::id();
        let all = list().expect("read tables");
        assert!(
            all.iter().any(|c| c.protocol == "TCP"
                && c.pid == me
                && c.state == Some("Listen")
                && c.local_port == addr.port()),
            "listener on {addr} not found"
        );
        assert!(
            all.iter().any(|c| c.protocol == "TCP"
                && c.pid == me
                && c.state == Some("Established")
                && c.remote_port == Some(addr.port())
                && c.local_port == client.local_addr().unwrap().port()),
            "established client connection not found"
        );
    }

    #[test]
    fn finds_this_process_udp_endpoint() {
        let sock = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let p = sock.local_addr().unwrap().port();
        let me = std::process::id();
        assert!(list()
            .unwrap()
            .iter()
            .any(|c| c.protocol == "UDP" && c.pid == me && c.local_port == p));
    }
}
