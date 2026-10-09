"""a terminal reader that stops reading, for bench/terminal.ts's overflow step.

it opens the relay's websocket with a 4 kb receive buffer, types one line,
then reads nothing for --stall seconds, so the kernel pushes back on the
relay as a phone on a bad link would (bun's sockets keep reading in user
space when paused, so they cannot stand in for this). then it reads what
has arrived, types --then, and reads until the marker arrives, printing
how many bytes it took.

    python3 bench/stall.py --port 3031 --pty <id> --cookie <name=value>
        --line '<command>' --stall 10 --then '<command>' --marker <text>
"""

import argparse
import base64
import os
import socket
import sys
import time


def masked_text(text: str) -> bytes:
    payload = text.encode()
    mask = os.urandom(4)
    head = bytearray([0x81])
    if len(payload) < 126:
        head.append(0x80 | len(payload))
    else:
        head.append(0x80 | 126)
        head += len(payload).to_bytes(2, "big")
    return bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--pty", required=True)
    parser.add_argument("--cookie", required=True)
    parser.add_argument("--line", required=True)
    parser.add_argument("--then", required=True)
    parser.add_argument("--marker", required=True)
    parser.add_argument("--stall", type=float, default=10)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    sock.connect(("127.0.0.1", args.port))
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall(
        (
            f"GET /api/hosts/bench/pty/{args.pty}/connect HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{args.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nCookie: {args.cookie}\r\n\r\n"
        ).encode()
    )
    head = b""
    while b"\r\n\r\n" not in head:
        head += sock.recv(1)
    if b" 101 " not in head.split(b"\r\n", 1)[0]:
        print(f"stall: the upgrade was refused: {head.split(b'\r\n', 1)[0].decode()}", flush=True)
        return 1
    # the first replay and its meta frame, so the line is typed into a live terminal
    time.sleep(0.5)
    sock.sendall(masked_text(args.line + "\r"))
    print(f"stall: typed the line; reading nothing for {args.stall:g} s", flush=True)
    time.sleep(args.stall)
    print("stall: reading again", flush=True)
    marker = args.marker.encode()
    tail = b""
    total = 0
    sock.settimeout(0.5)
    quiet_since = time.monotonic()
    while time.monotonic() - quiet_since < 2:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            print(f"stall: the relay closed the socket after {total} bytes", flush=True)
            return 1
        total += len(chunk)
        quiet_since = time.monotonic()
    print(f"stall: caught up after {total} bytes; typing the next line", flush=True)
    sock.sendall(masked_text(args.then + "\r"))
    caught_up = total
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            print(f"stall: the relay closed the socket after {total} bytes", flush=True)
            return 1
        total += len(chunk)
        tail = (tail + chunk)[-4096:]
        if marker in tail:
            print(f"stall: {args.marker} arrived after {total} bytes, {total - caught_up} of them after the next line", flush=True)
            sock.close()
            return 0
    print(f"stall: no {args.marker} within {args.timeout:g} s ({total} bytes)", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
