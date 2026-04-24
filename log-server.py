#!/usr/bin/env python3
"""
log-server.py — collects logs from the Lampa log-collector plugin.

Companion to app/support/log-collector.js. Listens on the LAN for log entries
from ANY TV platform (Android TV, Tizen, WebOS, Chromecast, desktop) via
three transports in order of preference:
  1. POST /log                 — JSON body (batch or single entry)
  2. navigator.sendBeacon      — same endpoint, POST, fire-and-forget
  3. GET  /log?d=<base64>      — base64-encoded JSON, responds with 1x1 gif

Splits entries by "[PluginName]" prefix and writes one log file per plugin
per day (plus a combined all-<date>.log). Zero external dependencies —
Python 3.8+ stdlib only.

Usage:
    python3 log-server.py                       # port 9999, logs in ./logs, HTTP
    python3 log-server.py --port 8080
    python3 log-server.py --dir /tmp/lampa-logs
    python3 log-server.py --quiet               # no stdout mirroring
    python3 log-server.py --tls                 # HTTPS on :9999 with self-signed cert
    python3 log-server.py --tls --cert x.pem --key y.pem

Mixed-content tip: if your TV's Lampa is loaded over HTTPS, HTTP endpoints
are blocked. Either run Lampa from HTTP (Tizen widgets usually do), or
start with --tls and accept the self-signed certificate on the TV.

On startup it prints the LAN URLs you can paste into Lampa on the TV
(Настройки → Сборщик логов → Endpoint).
"""

import argparse
import base64
import http.server
import json
import os
import re
import socket
import ssl
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse, parse_qs

ANSI = {
    "reset":  "\033[0m",
    "dim":    "\033[90m",
    "prefix": "\033[36m",
    "info":   "\033[37m",
    "warn":   "\033[33m",
    "error":  "\033[31m",
}

# 1x1 transparent GIF — returned to <img src> GET transport.
TINY_GIF = base64.b64decode("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=")

_UNSAFE_FN_CHARS = re.compile(r"[^A-Za-z0-9_\-.]")
_write_lock = Lock()


def safe_prefix(p: str) -> str:
    p = (p or "unprefixed").strip()
    p = _UNSAFE_FN_CHARS.sub("_", p)
    return p or "unprefixed"


class LogHandler(http.server.BaseHTTPRequestHandler):
    server_version = "LampaLogServer/1.1"

    # ---- response helpers -------------------------------------------------

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")

    def _respond_json(self, code: int, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _respond_gif(self):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "image/gif")
        self.send_header("Content-Length", str(len(TINY_GIF)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(TINY_GIF)

    # ---- handlers ---------------------------------------------------------

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        # GET /log?d=<base64 JSON> — image transport from locked-down WebViews
        if path in ("/log", "/logs"):
            q = parse_qs(parsed.query)
            d = q.get("d", [""])[0]
            if not d:
                self._respond_json(400, {"ok": False, "error": "missing d"})
                return
            try:
                # base64 may be URL-safe or standard — accept both
                padded = d + "=" * (-len(d) % 4)
                raw = base64.b64decode(padded)
                data = json.loads(raw.decode("utf-8", errors="replace"))
            except Exception as e:
                self._respond_json(400, {"ok": False, "error": f"bad base64/json: {e}"})
                return
            entries = data if isinstance(data, list) else [data]
            for entry in entries:
                if isinstance(entry, dict):
                    try: process_entry(entry, self.client_address[0], transport="img")
                    except Exception as ex: sys.stderr.write(f"write error: {ex}\n")
            self._respond_gif()
            return

        if path in ("/", "/health"):
            self._respond_json(200, {"ok": True, "service": "lampa-log-server"})
            return

        self._respond_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path not in ("/log", "/logs"):
            self._respond_json(404, {"ok": False, "error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length else b""

        try:
            data = json.loads(body.decode("utf-8", errors="replace"))
        except Exception as e:
            self._respond_json(400, {"ok": False, "error": f"invalid json: {e}"})
            return

        entries = data if isinstance(data, list) else [data]
        written = 0
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            try:
                process_entry(entry, self.client_address[0], transport="post")
                written += 1
            except Exception as ex:
                sys.stderr.write(f"write error: {ex}\n")

        self._respond_json(200, {"ok": True, "n": written})

    def log_message(self, *args, **kwargs):
        return  # suppress default "POST /log HTTP/1.1 200 -" noise


def process_entry(entry: dict, client_ip: str = "", transport: str = ""):
    ts = entry.get("ts") or 0
    level = str(entry.get("level") or "info").lower()
    prefix = safe_prefix(str(entry.get("prefix") or "unprefixed"))
    msg = str(entry.get("msg") or "")

    try:
        dt = datetime.fromtimestamp(ts / 1000) if ts else datetime.now()
    except (ValueError, OSError):
        dt = datetime.now()

    ts_str = dt.strftime("%Y-%m-%d %H:%M:%S.") + f"{dt.microsecond // 1000:03d}"
    day = dt.strftime("%Y-%m-%d")

    per_prefix_line = f"[{ts_str}] {level.upper():5s} {msg}\n"
    combined_line   = f"[{ts_str}] [{prefix}] {level.upper():5s} {msg}\n"

    with _write_lock:
        pdir = LOG_DIR / prefix
        pdir.mkdir(parents=True, exist_ok=True)
        with open(pdir / f"{day}.log", "a", encoding="utf-8") as f:
            f.write(per_prefix_line)
        with open(LOG_DIR / f"all-{day}.log", "a", encoding="utf-8") as f:
            f.write(combined_line)

    if not QUIET:
        color = ANSI.get(level, ANSI["info"])
        tag = f"{ANSI['dim']}({client_ip}"
        if transport:
            tag += f" via {transport}"
        tag += f"){ANSI['reset']}"
        print(
            f"{ANSI['dim']}{ts_str}{ANSI['reset']} "
            f"{ANSI['prefix']}[{prefix}]{ANSI['reset']} "
            f"{color}{level.upper():5s}{ANSI['reset']} {msg} {tag}",
            flush=True,
        )


def local_ips():
    ips = set()
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127."):
                ips.add(ip)
    except socket.gaierror:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ips)


def ensure_cert(cert_path: Path, key_path: Path):
    """Generate a self-signed cert via openssl if missing."""
    if cert_path.exists() and key_path.exists():
        return
    if subprocess.call(["which", "openssl"], stdout=subprocess.DEVNULL) != 0:
        sys.stderr.write("ERROR: --tls requires 'openssl' binary\n")
        sys.exit(2)
    print(f"Generating self-signed cert → {cert_path.name}, {key_path.name}")
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", str(key_path), "-out", str(cert_path),
        "-days", "3650", "-nodes",
        "-subj", "/CN=lampa-log-server"
    ], check=True)


def main():
    parser = argparse.ArgumentParser(description="Lampa plugin log collector server")
    parser.add_argument("--port", type=int, default=9999)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--dir", default="logs")
    parser.add_argument("--quiet", action="store_true", help="don't mirror entries to stdout")
    parser.add_argument("--tls", action="store_true", help="enable HTTPS with self-signed cert")
    parser.add_argument("--cert", default="lampa-log-server.cert.pem")
    parser.add_argument("--key", default="lampa-log-server.key.pem")
    args = parser.parse_args()

    global LOG_DIR, QUIET
    LOG_DIR = Path(args.dir).resolve()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    QUIET = args.quiet

    server = http.server.ThreadingHTTPServer((args.host, args.port), LogHandler)

    scheme = "http"
    if args.tls:
        cert = Path(args.cert).resolve()
        key = Path(args.key).resolve()
        ensure_cert(cert, key)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(cert), keyfile=str(key))
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        scheme = "https"

    print(f"{ANSI['prefix']}Lampa log server{ANSI['reset']}")
    print(f"  bind:    {scheme}://{args.host}:{args.port}")
    print(f"  logs:    {LOG_DIR}")
    print(f"  mirror:  {'off' if QUIET else 'on (stdout, colored)'}")
    if args.tls:
        print(f"  cert:    {args.cert} (self-signed — accept it on TV when asked)")
    print()
    print("Endpoint(s) to paste into Lampa → Настройки → Сборщик логов → Endpoint:")
    ips = local_ips()
    if ips:
        for ip in ips:
            print(f"  {scheme}://{ip}:{args.port}")
    else:
        print(f"  {scheme}://<your-lan-ip>:{args.port}  (couldn't auto-detect)")
    print()
    print("Transports accepted: POST /log (JSON)  |  GET /log?d=<base64 JSON>")
    print("Ctrl+C to stop.")
    print("-" * 60)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
