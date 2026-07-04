"""日本株シグナルウォッチャー - ローカルサーバー

静的ファイル配信と Yahoo Finance API へのプロキシを行う。
ブラウザから直接 Yahoo Finance を叩くと CORS で弾かれるため、
同一オリジンのこのサーバーを経由させることで回避している。

/api/screen は主要銘柄をテクニカル指標で機械的に採点するスクリーナー。
採点ロジックは public/app.js の evaluate() と同一ルール(表示用に両実装)。
"""
import json
import os
import threading
import time
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 8787))
PUBLIC_DIR = (Path(__file__).parent / "public").resolve()
CACHE_TTL_SECONDS = 30
SCREEN_TTL_SECONDS = 900
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

_cache: dict[tuple[str, str, str], tuple[float, bytes]] = {}
_screen_lock = threading.Lock()
_screen_cache: tuple[float, dict] | None = None

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
}

# スクリーニング対象: 東証プライムの大型株に加え、スタンダード・グロースの
# 中小型・新興銘柄、テーマ関連銘柄を含む(全コードは Yahoo Finance で取得可能なことを検証済み)
UNIVERSE = [
    ("7203", "トヨタ自動車"), ("7267", "ホンダ"), ("6902", "デンソー"),
    ("6758", "ソニーグループ"), ("6501", "日立製作所"), ("6503", "三菱電機"),
    ("6752", "パナソニックHD"), ("6702", "富士通"), ("6981", "村田製作所"),
    ("6861", "キーエンス"), ("6954", "ファナック"), ("6273", "SMC"),
    ("6367", "ダイキン工業"), ("8035", "東京エレクトロン"), ("6857", "アドバンテスト"),
    ("6146", "ディスコ"), ("6920", "レーザーテック"), ("285A", "キオクシアHD"),
    ("4063", "信越化学工業"), ("4901", "富士フイルムHD"), ("4452", "花王"),
    ("2802", "味の素"), ("2914", "JT"), ("4502", "武田薬品工業"),
    ("4568", "第一三共"), ("4519", "中外製薬"), ("9984", "ソフトバンクグループ"),
    ("9434", "ソフトバンク"), ("9432", "NTT"), ("9433", "KDDI"),
    ("4755", "楽天グループ"), ("4689", "LINEヤフー"), ("6098", "リクルートHD"),
    ("9983", "ファーストリテイリング"), ("3382", "セブン&アイHD"), ("8267", "イオン"),
    ("8306", "三菱UFJ FG"), ("8316", "三井住友FG"), ("8411", "みずほFG"),
    ("8766", "東京海上HD"), ("8591", "オリックス"), ("8058", "三菱商事"),
    ("8001", "伊藤忠商事"), ("8031", "三井物産"), ("8053", "住友商事"),
    ("7974", "任天堂"), ("9766", "コナミグループ"), ("7832", "バンダイナムコHD"),
    ("4661", "オリエンタルランド"), ("9020", "JR東日本"), ("9022", "JR東海"),
    ("9101", "日本郵船"), ("9104", "商船三井"), ("5401", "日本製鉄"),
    ("7011", "三菱重工業"), ("7012", "川崎重工業"), ("7013", "IHI"),
    ("8801", "三井不動産"), ("8802", "三菱地所"), ("7741", "HOYA"),
    # 2024年1月以降の新規上場銘柄 (英字入り新形式コードを含む)
    ("215A", "タイミー"), ("147A", "ソラコム"), ("268A", "リガクHD"),
    ("9023", "東京メトロ"),
    # 中小型・新興 (グロース/スタンダード上場のスタートアップ等)
    ("4385", "メルカリ"), ("3994", "マネーフォワード"), ("4478", "freee"),
    ("4443", "Sansan"), ("3923", "ラクス"), ("6027", "弁護士ドットコム"),
    ("5032", "ANYCOLOR"), ("5253", "カバー"),
    # AI関連
    ("3993", "PKSHAテクノロジー"), ("5574", "ABEJA"), ("4259", "エクサウィザーズ"),
    ("4011", "ヘッドウォータース"), ("3778", "さくらインターネット"), ("4751", "サイバーエージェント"),
    ("6701", "NEC"),
    # 半導体関連 (大型以外)
    ("6723", "ルネサスエレクトロニクス"), ("3436", "SUMCO"), ("6963", "ローム"),
    ("6526", "ソシオネクスト"), ("7735", "SCREENホールディングス"), ("6871", "日本マイクロニクス"),
    # インフラ・電力
    ("1801", "大成建設"), ("1802", "大林組"), ("1721", "コムシスHD"),
    ("1944", "きんでん"), ("1963", "日揮HD"), ("6504", "富士電機"),
    ("9501", "東京電力HD"), ("9503", "関西電力"), ("9513", "Jパワー"),
    # 原子力・核融合関連
    ("5631", "日本製鋼所"), ("6378", "木村化工機"), ("6492", "岡野バルブ製造"),
    ("7711", "助川電気工業"), ("5310", "東洋炭素"),
    # 量子コンピュータ関連
    ("3687", "フィックスターズ"), ("6965", "浜松ホトニクス"), ("6864", "エヌエフHD"),
    # 宇宙関連
    ("9348", "ispace"), ("186A", "アストロスケールHD"), ("9412", "スカパーJSAT"),
]

# テーマ別の注目銘柄 (2026年7月時点の公開情報に基づく手動キュレーション。
# テーマとの関連度を保証するものではなく、自動更新もされない)
THEMES = {
    "ai": {
        "label": "AI",
        "codes": ["3993", "5574", "4259", "4011", "3778", "4751", "9984", "6701", "6702"],
    },
    "semiconductor": {
        "label": "半導体",
        "codes": ["8035", "6857", "6146", "6920", "285A", "6723", "3436", "4063",
                   "6963", "6526", "7735", "6871"],
    },
    "infra": {
        "label": "インフラ",
        "codes": ["1801", "1802", "1721", "1944", "1963", "6504", "5401",
                   "9501", "9513", "9432", "9433", "9023"],
    },
    "nuclear": {
        "label": "原子力",
        "codes": ["7011", "6501", "5631", "6378", "6492", "9501", "9503", "1963"],
    },
    "quantum": {
        "label": "量子コンピュータ",
        "codes": ["3687", "6702", "6701", "9432", "6965", "6864"],
    },
    "fusion": {
        "label": "核融合",
        "codes": ["7711", "5310", "6965", "7011", "5631", "6378"],
    },
    "space": {
        "label": "宇宙",
        "codes": ["9348", "186A", "9412", "7011", "7012"],
    },
}

# code -> [テーマ名] の逆引き (結果カードのテーマバッジ表示用)
CODE_THEMES: dict[str, list[str]] = {}
for _theme in THEMES.values():
    for _code in _theme["codes"]:
        CODE_THEMES.setdefault(_code, []).append(_theme["label"])


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


# ---------- テクニカル指標とスコアリング ----------

def compute_sma(closes: list[float], period: int) -> list:
    out = [None] * len(closes)
    total = 0.0
    for i, c in enumerate(closes):
        total += c
        if i >= period:
            total -= closes[i - period]
        if i >= period - 1:
            out[i] = total / period
    return out


def compute_rsi(closes: list[float], period: int = 14) -> list:
    out = [None] * len(closes)
    if len(closes) <= period:
        return out
    gain_sum = 0.0
    loss_sum = 0.0
    for i in range(1, period + 1):
        diff = closes[i] - closes[i - 1]
        if diff >= 0:
            gain_sum += diff
        else:
            loss_sum -= diff
    avg_gain = gain_sum / period
    avg_loss = loss_sum / period
    out[period] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    for i in range(period + 1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gain = diff if diff > 0 else 0.0
        loss = -diff if diff < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return out


def evaluate(closes: list[float], volumes: list[float]) -> dict:
    """public/app.js の evaluate() と同一ルール。変更時は両方を更新すること。"""
    n = len(closes)
    last = n - 1
    price = closes[last]
    sma5 = compute_sma(closes, 5)
    sma25 = compute_sma(closes, 25)
    rsi14 = compute_rsi(closes, 14)
    rsi = rsi14[last]

    score = 0
    reasons = []

    # 1) トレンド (ダウ理論 / トレンドフォロー)
    s25 = sma25[last]
    s25p = sma25[last - 5] if last >= 5 else None
    slope_up = s25 is not None and s25p is not None and s25 > s25p
    slope_down = s25 is not None and s25p is not None and s25 < s25p
    if s25 is not None and price > s25 and slope_up:
        score += 2
        reasons.append("+2 株価が25日線の上で推移し25日線も上向き — 上昇トレンド継続(ダウ理論/トレンドフォロー)")
    elif s25 is not None and price < s25 and slope_down:
        score -= 2
        reasons.append("-2 株価が25日線の下で推移し25日線も下向き — 下降トレンド(ダウ理論)")

    # 2) 直近5営業日以内の移動平均クロス
    cross = "none"
    i = last
    while i > max(last - 5, 0):
        if all(v is not None for v in (sma5[i], sma25[i], sma5[i - 1], sma25[i - 1])):
            d0 = sma5[i - 1] - sma25[i - 1]
            d1 = sma5[i] - sma25[i]
            if d0 <= 0 and d1 > 0:
                cross = "golden"
                break
            if d0 >= 0 and d1 < 0:
                cross = "dead"
                break
        i -= 1
    if cross == "golden":
        score += 2
        reasons.append("+2 直近5営業日以内にゴールデンクロス発生 — 上昇転換シグナル")
    elif cross == "dead":
        score -= 2
        reasons.append("-2 直近5営業日以内にデッドクロス発生 — 下落転換シグナル")

    # 3) RSI (ワイルダー)
    if rsi is not None:
        if rsi >= 70:
            score -= 2
            reasons.append(f"-2 RSI {rsi:.0f} は買われすぎ圏(70以上) — 高値掴みリスク(ワイルダーのRSI)")
        elif rsi <= 30:
            score += 1
            reasons.append(f"+1 RSI {rsi:.0f} は売られすぎ圏(30以下) — 逆張りの反発候補(ただし下落継続リスクあり)")
        elif 50 <= rsi < 70 and slope_up:
            score += 1
            reasons.append(f"+1 RSI {rsi:.0f} は上昇トレンド中の適温圏(50〜70) — 過熱前で上昇余地")

    # 4) モメンタム効果 (直近25営業日リターン)
    if n > 25:
        mom = price / closes[-26] - 1
        if mom > 0.05:
            score += 1
            reasons.append(f"+1 直近25営業日で{mom * 100:+.1f}% — 上昇モメンタム(モメンタム効果)")
        elif mom < -0.10:
            score -= 1
            reasons.append(f"-1 直近25営業日で{mom * 100:+.1f}% — 下落モメンタムが強い")

    # 5) 出来高 (出来高はトレンドの信頼度を裏付ける)
    vols = [v for v in volumes if v]
    if len(volumes) >= 25:
        v5 = [v for v in volumes[-5:] if v]
        v25 = [v for v in volumes[-25:] if v]
        if v5 and v25:
            ratio = (sum(v5) / len(v5)) / (sum(v25) / len(v25))
            if ratio > 1.3:
                score += 1
                reasons.append(f"+1 直近5日の出来高が25日平均の{ratio:.1f}倍に増加 — トレンドの信頼度を補強(出来高分析)")

    # 6) 高値ブレイクアウト (オニール)
    if price >= max(closes) * 0.97:
        score += 1
        reasons.append("+1 直近6ヶ月の高値圏(97%以上)に接近 — 新高値ブレイクアウト候補(オニール)")

    # 7) 移動平均乖離 (グランビルの法則)
    if s25 is not None:
        dev = price / s25 - 1
        if dev > 0.08:
            score -= 1
            reasons.append(f"-1 25日線から{dev * 100:+.1f}%の上方乖離 — 短期過熱、押し目待ちが定石(グランビルの法則)")

    return {"score": score, "reasons": reasons, "rsi": rsi}


def build_screen_results() -> dict:
    def work(item):
        code, name = item
        try:
            raw = fetch_chart(f"{code}.T", "6mo", "1d")
            data = json.loads(raw)
            result = data["chart"]["result"][0]
            quote = result["indicators"]["quote"][0]
            closes_raw = quote.get("close") or []
            vols_raw = quote.get("volume") or []
            closes = []
            volumes = []
            for i, c in enumerate(closes_raw):
                if c is not None:
                    closes.append(c)
                    v = vols_raw[i] if i < len(vols_raw) else None
                    volumes.append(v if v else 0)
            if len(closes) < 60:
                return None
            ev = evaluate(closes, volumes)
            prev = closes[-2]
            return {
                "code": code,
                "name": name,
                "price": closes[-1],
                "changePct": (closes[-1] - prev) / prev * 100,
                "themes": CODE_THEMES.get(code, []),
                **ev,
            }
        except Exception:
            return None

    results = []
    with ThreadPoolExecutor(max_workers=8) as executor:
        for res in executor.map(work, UNIVERSE):
            if res is not None:
                results.append(res)
    results.sort(key=lambda r: r["score"], reverse=True)
    return {
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "scanned": len(UNIVERSE),
        "succeeded": len(results),
        "results": results,
    }


def get_screen(max_price: float | None, theme: str | None) -> bytes:
    global _screen_cache
    with _screen_lock:
        now = time.time()
        if _screen_cache and now - _screen_cache[0] < SCREEN_TTL_SECONDS:
            data = _screen_cache[1]
        else:
            data = build_screen_results()
            _screen_cache = (now, data)

    results = data["results"]
    theme_label = None
    if theme is not None:
        theme_codes = set(THEMES[theme]["codes"])
        theme_label = THEMES[theme]["label"]
        results = [r for r in results if r["code"] in theme_codes]
    if max_price is not None:
        results = [r for r in results if r["price"] <= max_price]
    # テーマ指定時は「テーマ内の注目銘柄を挙げる」のが目的なので多めに返す
    limit = 12 if theme is not None else 8
    payload = {
        "generatedAt": data["generatedAt"],
        "scanned": data["scanned"],
        "succeeded": data["succeeded"],
        "maxPrice": max_price,
        "theme": theme,
        "themeLabel": theme_label,
        "matched": len(results),
        "top": results[:limit],
    }
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - silence default logging
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/chart":
            self.handle_chart(parsed)
            return
        if parsed.path == "/api/screen":
            self.handle_screen(parsed)
            return
        if parsed.path == "/api/themes":
            self.respond_json(200, {
                "themes": [{"key": k, "label": v["label"]} for k, v in THEMES.items()],
            })
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

    def handle_screen(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        max_price_raw = query.get("maxPrice", [None])[0]
        max_price = None
        if max_price_raw:
            try:
                max_price = float(max_price_raw)
            except ValueError:
                self.respond_json(400, {"error": "maxPrice must be a number"})
                return
            if max_price <= 0:
                self.respond_json(400, {"error": "maxPrice must be positive"})
                return
        theme = query.get("theme", [None])[0]
        if theme is not None and theme not in THEMES:
            self.respond_json(400, {"error": f"unknown theme: {theme}"})
            return
        try:
            data = get_screen(max_price, theme)
        except Exception as e:
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
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"起動しました: http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
