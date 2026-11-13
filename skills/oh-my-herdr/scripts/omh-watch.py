#!/usr/bin/env python3
"""Stream one herdr pane's agent status as JSON lines, for the oh-my-herdr mod.

Usage: omh-watch.py --pane <pane-id> --name <worker-name>

The mod has no unix socket, so this bridges herdr's event stream:
  {"name": N, "status": "idle|working|blocked|done|unknown|none", "ts": ms}
  {"name": N, "status": "gone", "ts": ms}          pane closed or exited; then exit 0
  {"hb": ms}                                       heartbeat every 30 s
  {"name": N, "error": "...", "ts": ms}            herdr went away; then exit 2

"none" means the pane exists but herdr sees no agent in it (yet).
Exits on its own when stdout breaks or the parent that started it is gone.
"""
import argparse
import json
import os
import socket
import sys
import time

HEARTBEAT_S = 30


def now_ms():
    return int(time.time() * 1000)


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        os._exit(0)


def connect():
    path = os.environ.get("HERDR_SOCKET_PATH")
    if not path:
        raise RuntimeError("HERDR_SOCKET_PATH is not set")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(path)
    return s


def request(method, params):
    """One request on its own connection (a subscribed connection takes no further requests)."""
    s = connect()
    try:
        s.sendall((json.dumps({"id": "omh", "method": method, "params": params}) + "\n").encode())
        f = s.makefile("r", encoding="utf-8")
        line = f.readline()
        return json.loads(line) if line else {}
    finally:
        s.close()


def current_status(pane):
    reply = request("agent.get", {"target": pane})
    if "result" in reply:
        agent = reply["result"].get("agent") or {}
        return agent.get("agent_status") or agent.get("status") or "unknown"
    pane_reply = request("pane.get", {"pane_id": pane})
    if "result" in pane_reply:
        return "none"
    return "gone"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pane", required=True)
    ap.add_argument("--name", required=True)
    args = ap.parse_args()
    pane, name = args.pane, args.name
    parent = os.getppid()

    try:
        sub = connect()
        sub.sendall((json.dumps({"id": "sub", "method": "events.subscribe", "params": {"subscriptions": [
            {"type": "pane.agent_status_changed", "pane_id": pane},
            {"type": "pane.exited"},
            {"type": "pane.closed"},
        ]}}) + "\n").encode())
    except OSError as ex:
        emit({"name": name, "error": f"cannot reach herdr: {ex}", "ts": now_ms()})
        return 2

    # Subscribe first, then read the current state, so no transition between the two is lost.
    try:
        st = current_status(pane)
    except OSError as ex:
        emit({"name": name, "error": f"cannot reach herdr: {ex}", "ts": now_ms()})
        return 2
    emit({"name": name, "status": st, "ts": now_ms()})
    if st == "gone":
        return 0

    sub.settimeout(1.0)
    buf = b""
    last_hb = time.time()
    while True:
        if time.time() - last_hb >= HEARTBEAT_S:
            last_hb = time.time()
            if os.getppid() != parent:
                return 0
            emit({"hb": now_ms()})
        try:
            chunk = sub.recv(65536)
        except socket.timeout:
            continue
        except OSError as ex:
            emit({"name": name, "error": f"herdr connection lost: {ex}", "ts": now_ms()})
            return 2
        if not chunk:
            emit({"name": name, "error": "herdr closed the event stream", "ts": now_ms()})
            return 2
        buf += chunk
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            event = msg.get("event") or ""
            data = msg.get("data") or {}
            if data.get("pane_id") != pane:
                continue
            if event == "pane.agent_status_changed":
                emit({"name": name, "status": data.get("agent_status") or "unknown", "ts": now_ms()})
            elif event.replace(".", "_") in ("pane_closed", "pane_exited"):
                emit({"name": name, "status": "gone", "ts": now_ms()})
                return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
