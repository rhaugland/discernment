const $ = (id) => document.getElementById(id);

function showStep(id) {
  document.querySelectorAll(".step").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
}

// ── Init ──────────────────────────────────────────────

async function init() {
  const status = await msg("GET_STATUS");
  if (!status) return;

  if (status.hasFingerprint) {
    showStep("step-monitoring");
    $("statEmails").textContent = status.totalEmails;
    $("statFindings").textContent = status.profileFindings;
  } else if (status.hasProfile) {
    showStep("step-done");
  } else if (status.hasApiKey) {
    $("connectBtn").disabled = false;
    $("apiKey").placeholder = "Saved";
  }
}

// ── Step 1: API Key ───────────────────────────────────

$("saveKeyBtn").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  if (!key || !key.startsWith("sk-")) {
    $("apiKey").style.borderColor = "#e5534b";
    return;
  }
  await msg("SAVE_API_KEY", { key });
  $("apiKey").value = "";
  $("apiKey").placeholder = "Saved";
  $("apiKey").style.borderColor = "#34d399";
  $("connectBtn").disabled = false;
});

// ── Step 2: Connect Gmail + Learn ─────────────────────

$("connectBtn").addEventListener("click", async () => {
  showStep("step-learning");

  try {
    // Connect
    updateProgress("Connecting to Gmail...", 0, "Requesting access...");
    await msg("CONNECT_GMAIL");

    // Fetch emails
    updateProgress("Reading your sent emails...", 10, "This takes about a minute...");

    // Start polling for progress
    const progressInterval = setInterval(async () => {
      const data = await chrome.storage.local.get(["fetchProgress"]);
      if (data.fetchProgress) {
        const pct = 10 + (data.fetchProgress.done / data.fetchProgress.total) * 50;
        updateProgress(
          "Reading your sent emails...",
          pct,
          `${data.fetchProgress.done} of ${data.fetchProgress.total} emails`
        );
      }
    }, 500);

    const fetchResult = await msg("FETCH_EMAILS");
    clearInterval(progressInterval);

    if (fetchResult.error) {
      updateProgress("Something went wrong", 0, fetchResult.error);
      return;
    }

    // Analyze
    $("progressEmoji").textContent = "\u{1F9E0}";
    updateProgress("Building your taste profile...", 65, `Analyzing ${fetchResult.count} emails with Claude...`);

    const analyzeResult = await msg("ANALYZE");
    if (analyzeResult.error) {
      updateProgress("Analysis failed", 60, analyzeResult.error);
      return;
    }

    // Done
    updateProgress("Done!", 100, "Your report is ready.");
    $("progressEmoji").textContent = "\u2728";

    // Save report data and open it
    await chrome.storage.local.set({
      reportTiming: analyzeResult.timing,
      reportProfile: analyzeResult.profile,
    });

    setTimeout(() => {
      showStep("step-done");
    }, 1000);
  } catch (e) {
    updateProgress("Error", 0, e.message);
  }
});

function updateProgress(title, pct, label) {
  $("progressTitle").textContent = title;
  $("progressBar").style.width = pct + "%";
  $("progressLabel").textContent = label;
}

// ── View Report ───────────────────────────────────────

$("viewReportBtn").addEventListener("click", openReport);
$("viewReportBtn2").addEventListener("click", openReport);

function openReport() {
  chrome.tabs.create({ url: chrome.runtime.getURL("report.html") });
}

// ── Reset ─────────────────────────────────────────────

$("resetBtn").addEventListener("click", async () => {
  if (confirm("Clear your entire taste profile and start over?")) {
    await msg("CLEAR_ALL");
    showStep("step-setup");
    $("connectBtn").disabled = true;
    $("apiKey").placeholder = "sk-ant-...";
  }
});

// ── Helper ────────────────────────────────────────────

function msg(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, resolve);
  });
}

init();
