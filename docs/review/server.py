#!/usr/bin/env python3
"""Review server for the Artifacts viewer mocks.

Lays the boards in ../mocks/boards out on a pannable, zoomable canvas with
comment pins, and keeps comments in comments.json next to this file (git
ignores it). Boards are re-read on every load, so edits show up on refresh.

    python3 -I server.py --port 8788

/board/<name> shows one board on its own, for screenshots.
"""
import argparse
import html
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
MOCKS = os.path.normpath(os.path.join(HERE, "..", "mocks"))
BOARDS = os.path.join(MOCKS, "boards")
STORE = os.path.join(HERE, "comments.json")
BOARD_GAP = 200
META = re.compile(r"^<!--board (\{.*?\})-->", re.S)
LIMITS = {"text": 4000, "author": 60, "screen": 200, "board": 100}
lock = threading.Lock()


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def load():
    try:
        return json.loads(read(STORE))
    except FileNotFoundError:
        return []


def save(items):
    tmp = STORE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=2, ensure_ascii=False)
    os.replace(tmp, STORE)


def boards():
    """Yields (key, meta, html) for each board file, in name order."""
    for name in sorted(f for f in os.listdir(BOARDS) if f.endswith(".html")):
        text = read(os.path.join(BOARDS, name))
        match = META.match(text)
        meta = json.loads(match.group(1)) if match else {}
        yield name[:-len(".html")], meta, text[match.end():] if match else text


def page():
    sections, left = [], 0
    for key, meta, body in boards():
        width = int(meta.get("width", 728))
        title, subtitle = meta.get("title", key), meta.get("subtitle", "")
        sections.append(
            f'<section class="board" data-title="{html.escape(title)}" style="left:{left}px;width:{width}px">'
            f'<div class="board-title">{html.escape(title)}<small>{html.escape(subtitle)}</small></div>{body}</section>'
        )
        left += width + BOARD_GAP
    return (
        read(os.path.join(HERE, "canvas.html"))
        .replace("/*MOCK_CSS*/", read(os.path.join(MOCKS, "kit.css")))
        .replace("<!--BOARDS-->", "\n".join(sections))
        .replace("/*MOCK_JS*/", read(os.path.join(MOCKS, "kit.js")))
    )


def single(key):
    """One board alone at 1:1 on the canvas colour, for screenshots."""
    for k, meta, body in boards():
        if k == key:
            width = int(meta.get("width", 728))
            return (
                '<!doctype html><html><head><meta charset="utf-8"><base href="/"><style>'
                ':root{--foreground:#f4f4f5;--muted-foreground:#a1a1aa;--font-sans:-apple-system,system-ui,sans-serif}'
                f'body{{background:#1b1d22;padding:24px}}{read(os.path.join(MOCKS, "kit.css"))}</style></head>'
                f'<body><section class="board" style="width:{width}px">{body}</section>'
                f'<script>{read(os.path.join(MOCKS, "kit.js"))}</script></body></html>'
            )
    return None


def markdown(items):
    lines = ["# Mock review comments", ""]
    for c in sorted(items, key=lambda c: (c["board"], c["screen"], c["n"])):
        state = "resolved" if c.get("resolved") else "open"
        when = datetime.fromtimestamp(c["created"] / 1000).strftime("%Y-%m-%d %H:%M")
        lines.append(f"- **#{c['n']}** {c['board']} · {c['screen']} ({state}) — {c['author']}, {when}")
        lines += [f"  > {line}" for line in c["text"].splitlines()]
        for r in c.get("replies", []):
            lines.append(f"  - {r['author']}: {r['text']}")
    return "\n".join(lines) + "\n"


def clean(value, key):
    if not isinstance(value, str):
        raise ValueError(f"{key} must be text")
    value = value.strip()
    if not value or len(value) > LIMITS[key]:
        raise ValueError(f"{key} is empty or too long")
    return value


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, ctype="application/json; charset=utf-8", etag=None):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if etag:
            # Images may be cached but are checked on every load, so regenerated ones still show up.
            self.send_header("Cache-Control", "no-cache")
            self.send_header("ETag", etag)
        else:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 65536:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self.send(200, page(), "text/html; charset=utf-8")
        if self.path == "/api/comments":
            with lock:
                return self.send(200, json.dumps(load()))
        match = re.fullmatch(r"/board/([\w-]+)", self.path)
        if match:
            body = single(match.group(1))
            if body:
                return self.send(200, body, "text/html; charset=utf-8")
        match = re.fullmatch(r"/(img|fonts)/((?:[\w-]+/)?[\w-]+\.(jpg|png|woff2))", self.path)
        if match:
            path = os.path.join(MOCKS, match.group(1), match.group(2))
            kind = {"jpg": "image/jpeg", "png": "image/png", "woff2": "font/woff2"}[match.group(3)]
            if os.path.isfile(path):
                info = os.stat(path)
                etag = f'"{info.st_mtime_ns:x}-{info.st_size:x}"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304)
                    self.send_header("ETag", etag)
                    self.send_header("Cache-Control", "no-cache")
                    return self.end_headers()
                with open(path, "rb") as f:
                    return self.send(200, f.read(), kind, etag)
        if self.path == "/comments.md":
            with lock:
                return self.send(200, markdown(load()), "text/markdown; charset=utf-8")
        self.send(404, '{"error":"not found"}')

    def do_POST(self):
        try:
            body = self.json_body()
            if self.path == "/api/comments":
                comment = {
                    "id": uuid.uuid4().hex[:10],
                    "x": float(body["x"]),
                    "y": float(body["y"]),
                    "board": clean(body["board"], "board"),
                    "screen": clean(body["screen"], "screen"),
                    "author": clean(body["author"], "author"),
                    "text": clean(body["text"], "text"),
                    "created": int(time.time() * 1000),
                    "resolved": False,
                    "replies": [],
                }
                with lock:
                    items = load()
                    comment["n"] = max((c["n"] for c in items), default=0) + 1
                    items.append(comment)
                    save(items)
                return self.send(201, json.dumps(comment))
            match = re.fullmatch(r"/api/comments/(\w+)/replies", self.path)
            if match:
                reply = {
                    "author": clean(body["author"], "author"),
                    "text": clean(body["text"], "text"),
                    "created": int(time.time() * 1000),
                }
                return self.update(match.group(1), lambda c: c["replies"].append(reply))
        except (KeyError, TypeError, ValueError) as error:
            return self.send(400, json.dumps({"error": str(error)}))
        self.send(404, '{"error":"not found"}')

    def do_PATCH(self):
        match = re.fullmatch(r"/api/comments/(\w+)", self.path)
        if not match:
            return self.send(404, '{"error":"not found"}')
        try:
            resolved = bool(self.json_body()["resolved"])
        except (KeyError, ValueError) as error:
            return self.send(400, json.dumps({"error": str(error)}))
        self.update(match.group(1), lambda c: c.update(resolved=resolved))

    def do_DELETE(self):
        match = re.fullmatch(r"/api/comments/(\w+)", self.path)
        if not match:
            return self.send(404, '{"error":"not found"}')
        with lock:
            items = load()
            kept = [c for c in items if c["id"] != match.group(1)]
            save(kept)
        self.send(200 if len(kept) < len(items) else 404, "{}")

    def update(self, comment_id, change):
        with lock:
            items = load()
            comment = next((c for c in items if c["id"] == comment_id), None)
            if comment is None:
                return self.send(404, '{"error":"not found"}')
            change(comment)
            save(items)
        self.send(200, json.dumps(comment))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    args = parser.parse_args()
    print(f"Review canvas on http://{args.host}:{args.port}", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
