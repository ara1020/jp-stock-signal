const STORAGE_KEY = "jp-stock-watchlist-v1";

const PRESETS = [
  { code: "7203", name: "トヨタ自動車" },
  { code: "6758", name: "ソニーグループ" },
  { code: "9984", name: "ソフトバンクグループ" },
  { code: "8306", name: "三菱UFJ" },
  { code: "9983", name: "ファーストリテイリング" },
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

function analyze(timestamps, closes) {
  const sma5 = computeSMA(closes, 5);
  const sma25 = computeSMA(closes, 25);
  const rsi14 = computeRSI(closes, 14);

  const last = closes.length - 1;
  const prev = last - 1;

  let cross = "none"; // 'golden' | 'dead' | 'none'
  let trend = "flat";
  if (sma5[last] != null && sma25[last] != null && sma5[prev] != null && sma25[prev] != null) {
    const prevDiff = sma5[prev] - sma25[prev];
    const currDiff = sma5[last] - sma25[last];
    if (prevDiff <= 0 && currDiff > 0) cross = "golden";
    else if (prevDiff >= 0 && currDiff < 0) cross = "dead";
    trend = currDiff > 0 ? "up" : currDiff < 0 ? "down" : "flat";
  }

  const rsiLast = rsi14[last];

  let signal = "neutral";
  if (cross === "golden" && rsiLast != null && rsiLast < 70) {
    signal = "buy";
  } else if (cross === "dead" && rsiLast != null && rsiLast > 30) {
    signal = "sell";
  } else if (rsiLast != null && rsiLast <= 30 && trend !== "down") {
    signal = "watch-buy";
  } else if (rsiLast != null && rsiLast >= 70 && trend !== "up") {
    signal = "watch-sell";
  }

  return {
    timestamps,
    closes,
    sma5,
    sma25,
    rsi14,
    cross,
    trend,
    rsiLast,
    signal,
    priceLast: closes[last],
  };
}

const SIGNAL_LABEL = {
  buy: "🔴 強い買いサイン",
  sell: "🔵 強い売りサイン",
  "watch-buy": "売られすぎ・反発待ち",
  "watch-sell": "買われすぎ・反落注意",
  neutral: "様子見",
};

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
  const closesRaw = result.indicators.quote[0].close || [];

  const timestamps = [];
  const closes = [];
  for (let i = 0; i < timestampsRaw.length; i++) {
    if (closesRaw[i] != null) {
      timestamps.push(timestampsRaw[i]);
      closes.push(closesRaw[i]);
    }
  }
  if (closes.length < 26) {
    throw new Error("分析に必要なデータ量が不足しています");
  }

  return {
    name: meta.longName || meta.shortName || code,
    currency: meta.currency,
    // meta.chartPreviousClose is not reliably "yesterday's close" (can lag by
    // more than a day), so derive it from the actual close series instead.
    previousClose: closes[closes.length - 2],
    timestamps,
    closes,
  };
}

async function refreshOne(code) {
  state.dataByCode[code] = { status: "loading" };
  render();
  try {
    const { name, previousClose, timestamps, closes } = await fetchChart(code);
    const analysis = analyze(timestamps, closes);
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
    let signalClass = "signal-loading";
    let signalText = "読み込み中...";

    if (!data || data.status === "loading") {
      bodyHtml = `<div class="metrics-row"><span>読み込み中...</span></div>`;
    } else if (data.status === "error") {
      signalClass = "signal-error";
      signalText = "エラー";
      bodyHtml = `<div class="metrics-row"><span>${escapeHtml(data.error)}</span></div>`;
    } else {
      const a = data.analysis;
      const change = formatChange(a.priceLast, data.previousClose);
      signalClass = "signal-" + a.signal;
      signalText = SIGNAL_LABEL[a.signal];
      const trendIcon = a.trend === "up" ? "上向き ↗" : a.trend === "down" ? "下向き ↘" : "横ばい →";
      const crossNote = a.cross === "golden" ? "（本日ゴールデンクロス）" : a.cross === "dead" ? "（本日デッドクロス）" : "";

      bodyHtml = `
        <div class="price-row">
          <span class="price">${a.priceLast.toLocaleString("ja-JP", { maximumFractionDigits: 1 })} 円</span>
          <span class="change ${change.cls}">${change.text}</span>
        </div>
        <div class="metrics-row">
          <span class="metric">SMA5/25: <strong>${trendIcon}</strong> ${crossNote}</span>
          <span class="metric">RSI(14): <strong>${a.rsiLast != null ? a.rsiLast.toFixed(1) : "-"}</strong></span>
        </div>
        <div class="signal-badge ${signalClass}">${signalText}</div>
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
          <span class="card-code">${item.code}</span>
        </div>
        <button class="remove-btn" data-remove="${item.code}" title="削除">✕</button>
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
  code = code.trim();
  if (!/^\d{4}$/.test(code)) {
    alert("銘柄コードは4桁の数字で入力してください (例: 7203)");
    return;
  }
  if (state.watchlist.some((w) => w.code === code)) return;
  state.watchlist.push({ code, name: name?.trim() || "" });
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
}

setupPresets();
setupForm();
setupActions();
render();
if (state.watchlist.length > 0) {
  refreshAll();
}
