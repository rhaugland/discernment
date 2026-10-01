// Discernment — content script
// Live monitoring: watches compose areas, shows taste feedback

let debounceTimer = null;
let lastAnalyzedText = "";
let widget = null;
let isAnalyzing = false;
let isReady = false;

// ── Check if profile is ready before doing anything ──

chrome.storage.local.get(["profileReady"], (data) => {
  if (data.profileReady) {
    isReady = true;
    setTimeout(boot, 2000);
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.profileReady?.newValue) {
    isReady = true;
    boot();
  }
});

function boot() {
  observe();
  watchForSend();
  createWidget();
}

// ── Detect compose areas ──────────────────────────────

function getComposeAreas() {
  const areas = [];
  // Gmail
  document.querySelectorAll('div[aria-label="Message Body"][contenteditable="true"]').forEach((el) => areas.push(el));
  // Google Docs
  document.querySelectorAll('div.kix-appview-editor [contenteditable="true"]').forEach((el) => areas.push(el));
  // Notion
  document.querySelectorAll('div[contenteditable="true"][data-content-editable-leaf="true"]').forEach((el) => areas.push(el));
  // Slack
  document.querySelectorAll('div[data-qa="message_input"] [contenteditable="true"]').forEach((el) => areas.push(el));
  // Fallback
  if (areas.length === 0) {
    document.querySelectorAll('textarea, [contenteditable="true"]').forEach((el) => {
      if ((el.innerText || el.value || "").length > 80) areas.push(el);
    });
  }
  return areas;
}

// ── Widget ────────────────────────────────────────────

function createWidget() {
  if (widget) return;
  widget = document.createElement("div");
  widget.id = "discernment-widget";
  widget.innerHTML = `
    <div class="discernment-pill" id="discernment-pill">
      <span class="discernment-dot"></span>
      <span class="discernment-label">Discernment</span>
    </div>
    <div class="discernment-panel" id="discernment-panel">
      <div class="discernment-panel-header">
        <span>Discernment</span>
        <button id="discernment-close">&times;</button>
      </div>
      <div class="discernment-panel-body" id="discernment-body">
        Write something — I'm watching.
      </div>
    </div>`;
  document.body.appendChild(widget);

  widget.querySelector("#discernment-pill").addEventListener("click", () => {
    widget.querySelector("#discernment-panel").classList.toggle("discernment-open");
  });
  widget.querySelector("#discernment-close").addEventListener("click", () => {
    widget.querySelector("#discernment-panel").classList.remove("discernment-open");
  });
}

function updateWidget(analysis, score) {
  if (!widget) return;
  const dot = widget.querySelector(".discernment-dot");
  if (score >= 8) dot.className = "discernment-dot discernment-green";
  else if (score >= 5) dot.className = "discernment-dot discernment-yellow";
  else if (score > 0) dot.className = "discernment-dot discernment-red";
  else dot.className = "discernment-dot";

  const body = widget.querySelector("#discernment-body");
  body.innerHTML = formatAnalysis(analysis);
}

function formatAnalysis(text) {
  let html = "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("VERDICT:")) {
      html += `<div style="font-size:14px;font-weight:600;margin-bottom:10px;">${esc(t.replace("VERDICT:", "").trim())}</div>`;
    } else if (t.startsWith("SCORE:") && !t.includes("-")) {
      const s = t.replace("SCORE:", "").trim();
      html += `<div style="font-size:28px;font-weight:700;margin-bottom:12px;">${esc(s)}<span style="font-size:13px;color:#999;font-weight:400">/10</span></div>`;
    } else if (t.startsWith("-") || t.startsWith("\u2022")) {
      html += `<p style="margin:0 0 8px;padding-left:10px;border-left:2px solid #e5e5e5;font-size:12px;color:#555;line-height:1.5;">${esc(t)}</p>`;
    } else if (t.startsWith("DETAILS:")) {
      const rest = t.replace("DETAILS:", "").trim();
      if (rest && rest !== "-") html += `<p style="margin:0 0 8px;font-size:12px;color:#555;">${esc(rest)}</p>`;
    }
  }
  return html || `<p style="font-size:12px;color:#555;">${esc(text)}</p>`;
}

function esc(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

// ── Analysis ──────────────────────────────────────────

function analyzeIfReady(text) {
  if (text.length < 80 || text === lastAnalyzedText || isAnalyzing) return;
  lastAnalyzedText = text;
  isAnalyzing = true;

  if (widget) {
    widget.querySelector(".discernment-dot").className = "discernment-dot discernment-thinking";
  }

  chrome.runtime.sendMessage({ type: "ANALYZE_DRAFT", text }, (response) => {
    isAnalyzing = false;
    if (!response) return;
    if (response.error) {
      updateWidget(response.error, 0);
    } else if (response.analysis) {
      const m = response.analysis.match(/SCORE:\s*(\d+)/);
      updateWidget(response.analysis, m ? parseInt(m[1]) : 0);
    }
  });
}

// ── Gmail auto-learn on send ──────────────────────────

function watchForSend() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-tooltip*="Send"], [aria-label*="Send"]');
    if (!btn) return;
    document.querySelectorAll('div[aria-label="Message Body"][contenteditable="true"]').forEach((area) => {
      const text = (area.innerText || "").trim();
      if (text.length > 50) {
        chrome.runtime.sendMessage({ type: "ADD_SAMPLE", text, source: "gmail-sent" });
      }
    });
  }, true);
}

// ── Observer ──────────────────────────────────────────

function observe() {
  for (const area of getComposeAreas()) {
    if (area.dataset.discernmentWatched) continue;
    area.dataset.discernmentWatched = "true";
    const handler = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        analyzeIfReady((area.innerText || area.value || "").trim());
      }, 3000);
    };
    area.addEventListener("input", handler);
    area.addEventListener("keyup", handler);
  }
}

const observer = new MutationObserver(() => { if (isReady) observe(); });
observer.observe(document.body, { childList: true, subtree: true });
