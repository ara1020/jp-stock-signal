const STORAGE_KEY = "jp-stock-watchlist-v1";

const PRESETS = [
  { code: "7203", name: "トヨタ自動車" },
  { code: "6758", name: "ソニーグループ" },
  { code: "9984", name: "ソフトバンクグループ" },
  { code: "8306", name: "三菱UFJ" },
  { code: "285A", name: "キオクシアHD" },
  { code: "7974", name: "任天堂" },
];

const state = {
  watchlist: loadWatchlist(),
  dataByCode: {},   // code -> { status: 'loading'|'ok'|'error', analysis, error }
  expanded: {},     // code -> bool
};

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveWatchlist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.watchlist));
}

// ---------- indicator math ----------

function computeSMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function computeRSI(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// server.py の evaluate() と同一ルール。変更時は両方を更新すること。
function evaluate(closes, volumes, sma5, sma25, rsi14) {
  const n = closes.length;
  const last = n - 1;
  const price = closes[last];
  const rsi = rsi14[last];

  let score = 0;
  const reasons = [];

  // 1) トレンド (ダウ理論 / トレンドフォロー)
  const s25 = sma25[last];
  const s25p = last >= 5 ? sma25[last - 5] : null;
  const slopeUp = s25 != null && s25p != null && s25 > s25p;
  const slopeDown = s25 != null && s25p != null && s25 < s25p;
  if (s25 != null && price > s25 && slopeUp) {
    score += 2;
    reasons.push("+2 株価が25日線の上で推移し25日線も上向き — 上昇トレンド継続(ダウ理論/トレンドフォロー)");
  } else if (s25 != null && price < s25 && slopeDown) {
    score -= 2;
    reasons.push("-2 株価が25日線の下で推移し25日線も下向き — 下降トレンド(ダウ理論)");
  }

  // 2) 直近5営業日以内の移動平均クロス
  let cross = "none";
  for (let i = last; i > Math.max(last - 5, 0); i--) {
    if (sma5[i] != null && sma25[i] != null && sma5[i - 1] != null && sma25[i - 1] != null) {
      const d0 = sma5[i - 1] - sma25[i - 1];
      const d1 = sma5[i] - sma25[i];
      if (d0 <= 0 && d1 > 0) { cross = "golden"; break; }
      if (d0 >= 0 && d1 < 0) { cross = "dead"; break; }
    }
  }
  if (cross === "golden") {
    score += 2;
    reasons.push("+2 直近5営業日以内にゴールデンクロス発生 — 上昇転換シグナル");
  } else if (cross === "dead") {
    score -= 2;
    reasons.push("-2 直近5営業日以内にデッドクロス発生 — 下落転換シグナル");
  }

  // 3) RSI (ワイルダー)
  if (rsi != null) {
    if (rsi >= 70) {
      score -= 2;
      reasons.push(`-2 RSI ${rsi.toFixed(0)} は買われすぎ圏(70以上) — 高値掴みリスク(ワイルダーのRSI)`);
    } else if (rsi <= 30) {
      score += 1;
      reasons.push(`+1 RSI ${rsi.toFixed(0)} は売られすぎ圏(30以下) — 逆張りの反発候補(ただし下落継続リスクあり)`);
    } else if (rsi >= 50 && rsi < 70 && slopeUp) {
      score += 1;
      reasons.push(`+1 RSI ${rsi.toFixed(0)} は上昇トレンド中の適温圏(50〜70) — 過熱前で上昇余地`);
    }
  }

  // 4) モメンタム効果 (直近25営業日リターン)
  if (n > 25) {
    const mom = price / closes[n - 26] - 1;
    if (mom > 0.05) {
      score += 1;
      reasons.push(`+1 直近25営業日で${(mom * 100).toFixed(1) > 0 ? "+" : ""}${(mom * 100).toFixed(1)}% — 上昇モメンタム(モメンタム効果)`);
    } else if (mom < -0.10) {
      score -= 1;
      reasons.push(`-1 直近25営業日で${(mom * 100).toFixed(1)}% — 下落モメンタムが強い`);
    }
  }

  // 5) 出来高 (出来高はトレンドの信頼度を裏付ける)
  if (volumes && volumes.length >= 25) {
    const v5 = volumes.slice(-5).filter((v) => v);
    const v25 = volumes.slice(-25).filter((v) => v);
    if (v5.length && v25.length) {
      const ratio = (v5.reduce((a, b) => a + b, 0) / v5.length) / (v25.reduce((a, b) => a + b, 0) / v25.length);
      if (ratio > 1.3) {
        score += 1;
        reasons.push(`+1 直近5日の出来高が25日平均の${ratio.toFixed(1)}倍に増加 — トレンドの信頼度を補強(出来高分析)`);
      }
    }
  }

  // 6) 高値ブレイクアウト (オニール)
  if (price >= Math.max(...closes) * 0.97) {
    score += 1;
    reasons.push("+1 直近6ヶ月の高値圏(97%以上)に接近 — 新高値ブレイクアウト候補(オニール)");
  }

  // 7) 移動平均乖離 (グランビルの法則)
  if (s25 != null) {
    const dev = price / s25 - 1;
    if (dev > 0.08) {
      score -= 1;
      reasons.push(`-1 25日線から+${(dev * 100).toFixed(1)}%の上方乖離 — 短期過熱、押し目待ちが定石(グランビルの法則)`);
    }
  }

  return { score, reasons, cross, trend: slopeUp ? "up" : slopeDown ? "down" : "flat" };
}

function verdictInfo(score) {
  if (score >= 4) return { label: "強い買い候補", cls: "signal-buy" };
  if (score >= 2) return { label: "買い寄り", cls: "signal-watch-buy" };
  if (score <= -4) return { label: "強い売り候補", cls: "signal-sell" };
  if (score <= -2) return { label: "売り寄り", cls: "signal-watch-sell" };
  return { label: "中立(様子見)", cls: "signal-neutral" };
}

function analyze(timestamps, closes, volumes) {
  const sma5 = computeSMA(closes, 5);
  const sma25 = computeSMA(closes, 25);
  const rsi14 = computeRSI(closes, 14);
  const last = closes.length - 1;
  const ev = evaluate(closes, volumes, sma5, sma25, rsi14);

  return {
    timestamps,
    closes,
    sma5,
    sma25,
    rsi14,
    rsiLast: rsi14[last],
    priceLast: closes[last],
    ...ev,
  };
}

// ---------- data fetching ----------

async function fetchChart(code) {
  const symbol = `${code}.T`;
  const res = await fetch(`/api/chart?symbol=${encodeURIComponent(symbol)}&range=6mo&interval=1d`);
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  const result = json.chart && json.chart.result && json.chart.result[0];
  if (!result) {
    throw new Error("データが見つかりませんでした");
  }

  const meta = result.meta;
  const timestampsRaw = result.timestamp || [];
  const quote = result.indicators.quote[0];
  const closesRaw = quote.close || [];
  const volumesRaw = quote.volume || [];

  const timestamps = [];
  const closes = [];
  const volumes = [];
  for (let i = 0; i < timestampsRaw.length; i++) {
    if (closesRaw[i] != null) {
      timestamps.push(timestampsRaw[i]);
      closes.push(closesRaw[i]);
      volumes.push(volumesRaw[i] || 0);
    }
  }
  // 上場直後の銘柄は日足が少ないため、最低限チャートと価格表示ができる量だけ要求し、
  // 計算できない指標(SMA25やRSI等)は evaluate() 側で自動的にスキップされる
  if (closes.length < 10) {
    throw new Error("上場直後のためデータが不足しています(10営業日以上で分析可能)");
  }

  return {
    name: meta.longName || meta.shortName || code,
    currency: meta.currency,
    // meta.chartPreviousClose is not reliably "yesterday's close" (can lag by
    // more than a day), so derive it from the actual close series instead.
    previousClose: closes[closes.length - 2],
    timestamps,
    closes,
    volumes,
  };
}

async function refreshOne(code) {
  state.dataByCode[code] = { status: "loading" };
  render();
  try {
    const { name, previousClose, timestamps, closes, volumes } = await fetchChart(code);
    const analysis = analyze(timestamps, closes, volumes);
    const entry = state.watchlist.find((w) => w.code === code);
    if (entry && !entry.name) entry.name = name;
    state.dataByCode[code] = {
      status: "ok",
      analysis,
      name,
      previousClose,
    };
  } catch (err) {
    state.dataByCode[code] = { status: "error", error: err.message };
  }
  render();
}

async function refreshAll() {
  await Promise.all(state.watchlist.map((w) => refreshOne(w.code)));
  document.getElementById("last-updated").textContent =
    "最終更新: " + new Date().toLocaleTimeString("ja-JP");
}

// ---------- screener ----------

async function runScreen() {
  const btn = document.getElementById("run-screen");
  const resultsEl = document.getElementById("screen-results");
  btn.disabled = true;
  btn.textContent = "スクリーニング中...(初回は10秒ほどかかります)";
  resultsEl.innerHTML = "";

  try {
    const maxPriceRaw = document.getElementById("max-price").value.trim();
    let url = "/api/screen";
    if (maxPriceRaw) {
      const maxPrice = Number(maxPriceRaw);
      if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
        throw new Error("株価上限は正の数値で入力してください");
      }
      url += `?maxPrice=${encodeURIComponent(maxPrice)}`;
    }
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);

    const metaLine = document.createElement("p");
    metaLine.className = "screen-meta";
    let metaText = `${json.scanned}銘柄中${json.succeeded}銘柄を採点 (${json.generatedAt} 時点、15分キャッシュ)`;
    if (json.maxPrice != null) {
      metaText += ` / 株価${Number(json.maxPrice).toLocaleString("ja-JP")}円以下: ${json.matched}銘柄が該当`;
    }
    metaLine.textContent = metaText;
    resultsEl.appendChild(metaLine);

    if (json.top.length === 0) {
      const empty = document.createElement("p");
      empty.className = "screen-meta";
      empty.textContent = "条件に該当する銘柄がありませんでした。株価上限を上げてみてください。";
      resultsEl.appendChild(empty);
    }

    json.top.forEach((r, idx) => {
      const v = verdictInfo(r.score);
      const changeCls = r.changePct > 0 ? "up" : r.changePct < 0 ? "down" : "flat";
      const card = document.createElement("div");
      card.className = "screen-card";
      card.innerHTML = `
        <div class="screen-card-head">
          <span class="screen-rank">${idx + 1}</span>
          <span class="card-title">${escapeHtml(r.name)}</span>
          <span class="card-code">${escapeHtml(r.code)}</span>
          <span class="signal-badge ${v.cls}">${v.label} (${r.score >= 0 ? "+" : ""}${r.score}点)</span>
          <button class="add-mini" data-add-code="${escapeHtml(r.code)}" data-add-name="${escapeHtml(r.name)}">+ ウォッチ</button>
        </div>
        <div class="metrics-row">
          <span class="metric"><strong>${r.price.toLocaleString("ja-JP", { maximumFractionDigits: 1 })} 円</strong></span>
          <span class="change ${changeCls}">${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%</span>
        </div>
        <ul class="reasons-list">
          ${r.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
        </ul>
      `;
      resultsEl.appendChild(card);
    });

    resultsEl.querySelectorAll("[data-add-code]").forEach((b) => {
      b.addEventListener("click", () => addStock(b.getAttribute("data-add-code"), b.getAttribute("data-add-name")));
    });
  } catch (err) {
    resultsEl.innerHTML = `<p class="screen-meta">エラー: ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔎 スクリーニング実行";
  }
}

// ---------- chart drawing ----------

function drawChart(canvas, analysis) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const priceH = H * 0.68;
  const rsiTop = priceH + 14;
  const rsiH = H - rsiTop - 4;

  const { closes, sma5, sma25, rsi14 } = analysis;
  const n = closes.length;
  const values = closes.concat(sma5.filter((v) => v != null), sma25.filter((v) => v != null));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.05 || 1;
  const yMin = min - pad;
  const yMax = max + pad;

  const x = (i) => (i / (n - 1)) * (W - 8) + 4;
  const yPrice = (v) => priceH - ((v - yMin) / (yMax - yMin)) * (priceH - 8) + 4;

  function drawLine(arr, color, width) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (v == null) continue;
      const px = x(i);
      const py = yPrice(v);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  drawLine(closes, "#e6e8ec", 1.5);
  drawLine(sma5, "#f0a83c", 1.3);
  drawLine(sma25, "#7c6cf0", 1.3);

  // RSI panel
  ctx.strokeStyle = "#2a2e38";
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  [30, 70].forEach((level) => {
    const y = rsiTop + rsiH - (level / 100) * rsiH;
    ctx.beginPath();
    ctx.moveTo(4, y);
    ctx.lineTo(W - 4, y);
    ctx.stroke();
  });
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.strokeStyle = "#d7a13b";
  ctx.lineWidth = 1.3;
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = rsi14[i];
    if (v == null) continue;
    const px = x(i);
    const py = rsiTop + rsiH - (v / 100) * rsiH;
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();

  ctx.fillStyle = "#9aa0ac";
  ctx.font = "10px sans-serif";
  ctx.fillText("RSI", 6, rsiTop + 10);
}

// ---------- rendering ----------

function formatChange(current, previous) {
  const diff = current - previous;
  const pct = (diff / previous) * 100;
  const sign = diff > 0 ? "+" : "";
  const cls = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  return { text: `${sign}${diff.toFixed(1)} (${sign}${pct.toFixed(2)}%)`, cls };
}

function render() {
  const listEl = document.getElementById("watchlist");
  const emptyEl = document.getElementById("empty-state");
  listEl.innerHTML = "";

  emptyEl.style.display = state.watchlist.length === 0 ? "block" : "none";

  for (const item of state.watchlist) {
    const data = state.dataByCode[item.code];
    const card = document.createElement("div");
    card.className = "card";

    const displayName = (data && data.name) || item.name || item.code;

    let bodyHtml = "";

    if (!data || data.status === "loading") {
      bodyHtml = `<div class="metrics-row"><span>読み込み中...</span></div>`;
    } else if (data.status === "error") {
      bodyHtml = `
        <div class="signal-badge signal-error">エラー</div>
        <div class="metrics-row"><span>${escapeHtml(data.error)}</span></div>`;
    } else {
      const a = data.analysis;
      const v = verdictInfo(a.score);
      const change = formatChange(a.priceLast, data.previousClose);
      const trendIcon = a.trend === "up" ? "上向き ↗" : a.trend === "down" ? "下向き ↘" : "横ばい →";
      const crossNote = a.cross === "golden" ? "(直近ゴールデンクロス)" : a.cross === "dead" ? "(直近デッドクロス)" : "";

      bodyHtml = `
        <div class="price-row">
          <span class="price">${a.priceLast.toLocaleString("ja-JP", { maximumFractionDigits: 1 })} 円</span>
          <span class="change ${change.cls}">${change.text}</span>
        </div>
        <div class="metrics-row">
          <span class="metric">SMA5/25: <strong>${trendIcon}</strong> ${crossNote}</span>
          <span class="metric">RSI(14): <strong>${a.rsiLast != null ? a.rsiLast.toFixed(1) : "-"}</strong></span>
        </div>
        <div class="signal-badge ${v.cls}">${v.label} (${a.score >= 0 ? "+" : ""}${a.score}点)</div>
        <details class="reasons">
          <summary>評価の根拠 (${a.reasons.length}項目)</summary>
          <ul class="reasons-list">
            ${a.reasons.length ? a.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("") : "<li>加点・減点要素なし — 明確なシグナルが出ていません</li>"}
          </ul>
        </details>
        <button class="expand-toggle" data-code="${item.code}">${state.expanded[item.code] ? "▲ チャートを閉じる" : "▼ チャートを見る"}</button>
        <div class="chart-wrap ${state.expanded[item.code] ? "open" : ""}" data-chart-wrap="${item.code}">
          <canvas data-canvas="${item.code}"></canvas>
          <div class="chart-legend">
            <span class="legend-price">終値</span>
            <span class="legend-sma5">SMA5</span>
            <span class="legend-sma25">SMA25</span>
          </div>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="card-top">
        <div>
          <span class="card-title">${escapeHtml(displayName)}</span>
          <span class="card-code">${escapeHtml(item.code)}</span>
        </div>
        <button class="remove-btn" data-remove="${escapeHtml(item.code)}" title="削除">✕</button>
      </div>
      ${bodyHtml}
    `;

    listEl.appendChild(card);
  }

  // wire up events after render
  listEl.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-remove");
      state.watchlist = state.watchlist.filter((w) => w.code !== code);
      delete state.dataByCode[code];
      delete state.expanded[code];
      saveWatchlist();
      render();
    });
  });

  listEl.querySelectorAll("[data-code]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-code");
      state.expanded[code] = !state.expanded[code];
      render();
    });
  });

  listEl.querySelectorAll("[data-canvas]").forEach((canvas) => {
    const code = canvas.getAttribute("data-canvas");
    const wrap = listEl.querySelector(`[data-chart-wrap="${code}"]`);
    if (wrap && wrap.classList.contains("open")) {
      const data = state.dataByCode[code];
      if (data && data.status === "ok") {
        drawChart(canvas, data.analysis);
      }
    }
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- setup ----------

function addStock(code, name) {
  code = code.trim().toUpperCase();
  // 東証の銘柄コードは4桁: 先頭は数字、残りは数字または英大文字 (例: 7203, 285A)
  if (!/^[0-9][0-9A-Z]{3}$/.test(code)) {
    alert("銘柄コードは4桁で入力してください (例: 7203, 285A)");
    return;
  }
  if (state.watchlist.some((w) => w.code === code)) return;
  state.watchlist.push({ code, name: name ? String(name).trim() : "" });
  saveWatchlist();
  render();
  refreshOne(code);
}

function setupPresets() {
  const container = document.getElementById("presets");
  PRESETS.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn";
    btn.textContent = `+ ${p.name}`;
    btn.addEventListener("click", () => addStock(p.code, p.name));
    container.appendChild(btn);
  });
}

function setupForm() {
  const form = document.getElementById("add-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const codeInput = document.getElementById("code-input");
    const nameInput = document.getElementById("name-input");
    addStock(codeInput.value, nameInput.value);
    codeInput.value = "";
    nameInput.value = "";
  });
}

let autoRefreshTimer = null;
function setupActions() {
  document.getElementById("refresh-all").addEventListener("click", refreshAll);
  document.getElementById("auto-refresh").addEventListener("change", (e) => {
    if (e.target.checked) {
      autoRefreshTimer = setInterval(refreshAll, 60000);
    } else {
      clearInterval(autoRefreshTimer);
    }
  });
  document.getElementById("run-screen").addEventListener("click", runScreen);
}

setupPresets();
setupForm();
setupActions();
render();
if (state.watchlist.length > 0) {
  refreshAll();
}
