#!/usr/bin/env python3
"""usbfwd.py — forward TCP ports on the Mac to ports on a USB-connected iPhone through
macOS's usbmuxd (/var/run/usbmuxd). Used to reach Maestro's XCUITest driver, whose HTTP
server listens on a port *on the phone* (default 22087). `up.sh` starts it for you.

qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.

Prerequisites: macOS, Python 3 standard library only; phone connected by USB and trusted.
Usage:
  python3 usbfwd.py --list                          print usbmux devices (read-only)
  python3 usbfwd.py [--udid UDID] 22087             127.0.0.1:22087 -> device:22087
  python3 usbfwd.py [--udid UDID] 8100:22087 ...    127.0.0.1:8100  -> device:22087
Without --udid the single USB-connected device is used (error if there are several).
Then probe:  curl 127.0.0.1:22087/status   ->   {"status":"ok"}

Trap: the usbmux DeviceID changes whenever the phone re-enumerates (replug, reboot, trust
prompt). It is looked up again on every incoming connection; a cached ID gives
"connection reset" that looks exactly like a driver that never started.
"""
import argparse
import json
import plistlib
import select
import socket
import struct
import sys
import threading

MUX = "/var/run/usbmuxd"


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise OSError("usbmuxd closed the connection")
        buf += chunk
    return buf


def mux_request(sock, msg, tag=1):
    """Send one plist message (protocol v1, type 8) and return the decoded reply."""
    body = plistlib.dumps({"ClientVersionString": "qa-usbfwd", "ProgName": "qa-usbfwd", **msg})
    sock.sendall(struct.pack("<IIII", 16 + len(body), 1, 8, tag) + body)
    length = struct.unpack("<IIII", _recv_exact(sock, 16))[0]
    return plistlib.loads(_recv_exact(sock, length - 16))


def mux_socket():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(MUX)
    return s


def list_devices():
    with mux_socket() as s:
        return mux_request(s, {"MessageType": "ListDevices"}).get("DeviceList", [])


def _norm(udid):
    return udid.replace("-", "").lower()


def device_id(udid=None):
    """Current usbmux DeviceID of the phone (USB only). Call per connection — it changes."""
    usb = [d for d in list_devices() if d["Properties"].get("ConnectionType") == "USB"]
    if udid:
        usb = [d for d in usb if _norm(d["Properties"].get("SerialNumber", "")) == _norm(udid)]
        if not usb:
            raise OSError(f"device {udid} not found on USB")
    elif not usb:
        raise OSError("no USB device found (connected, unlocked, trusted?)")
    elif len(usb) > 1:
        serials = ", ".join(d["Properties"].get("SerialNumber", "?") for d in usb)
        raise OSError(f"several USB devices ({serials}); pass --udid")
    return usb[0]["DeviceID"]


def connect(dev, port):
    """Return a socket that is a raw pipe to <port> on the device."""
    s = mux_socket()
    r = mux_request(s, {"MessageType": "Connect", "DeviceID": dev, "PortNumber": socket.htons(port)})
    if r.get("Number") != 0:
        s.close()
        raise OSError(f"usbmux connect to device port {port} refused: {r} (driver not running?)")
    return s


def pump(a, b):
    try:
        while True:
            r, _, _ = select.select([a, b], [], [])
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass
    finally:
        a.close()
        b.close()


def serve(udid, local, remote, host):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, local))
    srv.listen(16)
    print(f"forwarding {host}:{local} -> device:{remote}", flush=True)
    while True:
        c, _ = srv.accept()
        try:
            dev = connect(device_id(udid), remote)  # fresh DeviceID lookup every time
        except OSError as e:
            print(f"refused: {e}", file=sys.stderr, flush=True)
            c.close()  # client sees a closed connection and can retry
            continue
        threading.Thread(target=pump, args=(c, dev), daemon=True).start()


def _plain(o):
    """Make a usbmux plist JSON-printable (bytes -> hex)."""
    if isinstance(o, dict):
        return {k: _plain(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_plain(v) for v in o]
    if isinstance(o, bytes):
        return o.hex()
    return o


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ports", nargs="*", metavar="LOCAL[:DEVICE]", help="port(s) to forward")
    ap.add_argument("--udid", help="device UDID (default: the only USB device)")
    ap.add_argument("--host", default="127.0.0.1", help="local bind address (default 127.0.0.1)")
    ap.add_argument("--list", action="store_true", help="print usbmux ListDevices result and exit")
    a = ap.parse_args()
    try:
        if a.list:
            print(json.dumps(_plain(list_devices()), indent=2))
            return
        if not a.ports:
            ap.error("give at least one port, or --list")
        pairs = []
        for p in a.ports:
            loc, _, dev = p.partition(":")
            pairs.append((int(loc), int(dev or loc)))
        device_id(a.udid)  # fail fast if the phone isn't on USB
    except (OSError, ValueError) as e:
        sys.exit(f"usbfwd: {e}")
    for loc, dev in pairs:
        threading.Thread(target=serve, args=(a.udid, loc, dev, a.host), daemon=True).start()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
