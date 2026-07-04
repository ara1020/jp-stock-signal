"""日本株シグナルウォッチャー - ローカルサーバー

静的ファイル配信と Yahoo Finance API へのプロキシを行う。
ブラウザから直接 Yahoo Finance を叩くと CORS で弾かれるため、
同一オリジンのこのサーバーを経由させることで回避している。
"""
import json
import os
import time
import urllib.request
import urllib.parse
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 8787))
PUBLIC_DIR = (Path(__file__).parent / "public").resolve()
CACHE_TTL_SECONDS = 30
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

_cache: dict[tuple[str, str, str], tuple[float, bytes]] = {}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
}


def fetch_chart(symbol: str, rng: str, interval: str) -> bytes:
    cache_key = (symbol, rng, interval)
    now = time.time()
    cached = _cache.get(cache_key)
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    query = urllib.parse.urlencode({"range": rng, "interval": interval})
    url = f"{YAHOO_CHART_URL.format(symbol=urllib.parse.quote(symbol))}?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=10) as response:
        data = response.read()

    _cache[cache_key] = (now, data)
    return data


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - silence default logging
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/chart":
            self.handle_chart(parsed)
            return
        self.serve_static(parsed.path)

    def handle_chart(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        symbol = query.get("symbol", [None])[0]
        rng = query.get("range", ["6mo"])[0]
        interval = query.get("interval", ["1d"])[0]

        if not symbol:
            self.respond_json(400, {"error": "symbol is required"})
            return

        try:
            data = fetch_chart(symbol, rng, interval)
        except urllib.error.HTTPError as e:
            self.respond_json(e.code, {"error": f"Yahoo Finance returned {e.code}"})
            return
        except Exception as e:  # network errors, timeouts, etc.
            self.respond_json(502, {"error": str(e)})
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self, path: str):
        if path == "/":
            path = "/index.html"

        candidate = (PUBLIC_DIR / path.lstrip("/")).resolve()
        if PUBLIC_DIR not in candidate.parents and candidate != PUBLIC_DIR:
            self.send_error(403, "Forbidden")
            return
        if not candidate.is_file():
            self.send_error(404, "Not Found")
            return

        content_type = CONTENT_TYPES.get(candidate.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.end_headers()
        self.wfile.write(candidate.read_bytes())

    def respond_json(self, status: int, payload: dict):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"起動しました: http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
