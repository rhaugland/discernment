// Discernment — background service worker
// Handles Gmail OAuth, email fetching, Claude analysis, profile management

// ── Gmail OAuth ───────────────────────────────────────

async function getGmailToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

// ── Gmail API ─────────────────────────────────────────

async function fetchSentEmails(token, maxResults = 200, onProgress) {
  // Get message IDs
  let allIds = [];
  let pageToken = null;

  while (allIds.length < maxResults) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("labelIds", "SENT");
    url.searchParams.set("maxResults", Math.min(100, maxResults - allIds.length));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
    const data = await res.json();

    allIds.push(...(data.messages || []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  // Fetch each email (batched for speed)
  const emails = [];
  const batchSize = 10;

  for (let i = 0; i < allIds.length; i += batchSize) {
    const batch = allIds.slice(i, i + batchSize);
    const promises = batch.map((msg) =>
      fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    );

    const results = await Promise.all(promises);
    for (const msg of results) {
      if (!msg) continue;
      const email = extractEmail(msg);
      if (email && email.body.length > 30) {
        emails.push(email);
      }
    }

    if (onProgress) onProgress(Math.min(i + batchSize, allIds.length), allIds.length);
  }

  return emails;
}

function extractEmail(msg) {
  const headers = {};
  for (const h of msg.payload?.headers || []) {
    headers[h.name.toLowerCase()] = h.value;
  }

  const body = getBody(msg.payload);
  if (!body) return null;

  let timestamp;
  try {
    timestamp = new Date(headers.date || parseInt(msg.internalDate));
  } catch {
    timestamp = new Date(parseInt(msg.internalDate));
  }

  const cleaned = cleanBody(body.slice(0, 2000));

  return {
    subject: headers.subject || "(no subject)",
    to: (headers.to || "").slice(0, 80),
    timestamp: timestamp.toISOString(),
    hour: timestamp.getHours(),
    weekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][timestamp.getDay()],
    weekdayNum: timestamp.getDay(),
    body: cleaned,
    wordCount: cleaned.split(/\s+/).length,
  };
}

function getBody(payload) {
  if (payload?.body?.data) {
    return atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
  }
  for (const part of payload?.parts || []) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return atob(part.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    }
  }
  for (const part of payload?.parts || []) {
    const result = getBody(part);
    if (result) return result;
  }
  return null;
}

function cleanBody(text) {
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    if (line.trim().startsWith(">")) continue;
    if (/^On .+ wrote:$/.test(line.trim())) break;
    if (line.includes("---------- Forwarded message")) break;
    cleaned.push(line);
  }
  return cleaned.join("\n").trim();
}

// ── Timing Analysis ───────────────────────────────────

function analyzeTiming(emails) {
  const hourlyCounts = {};
  const hourlyWords = {};
  const dailyCounts = {};
  const dailyWords = {};
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  for (const e of emails) {
    const h = e.hour;
    const d = e.weekdayNum;
    hourlyCounts[h] = (hourlyCounts[h] || 0) + 1;
    hourlyWords[h] = hourlyWords[h] || [];
    hourlyWords[h].push(e.wordCount);
    dailyCounts[d] = (dailyCounts[d] || 0) + 1;
    dailyWords[d] = dailyWords[d] || [];
    dailyWords[d].push(e.wordCount);
  }

  const avgWordsByHour = {};
  for (const [h, words] of Object.entries(hourlyWords)) {
    if (words.length >= 3) {
      avgWordsByHour[h] = words.reduce((a, b) => a + b, 0) / words.length;
    }
  }

  const avgWordsByDay = {};
  for (const [d, words] of Object.entries(dailyWords)) {
    if (words.length >= 3) {
      avgWordsByDay[d] = words.reduce((a, b) => a + b, 0) / words.length;
    }
  }

  const bestHour = Object.keys(avgWordsByHour).length
    ? +Object.entries(avgWordsByHour).sort((a, b) => b[1] - a[1])[0][0]
    : 9;
  const worstHour = Object.keys(avgWordsByHour).length
    ? +Object.entries(avgWordsByHour).sort((a, b) => a[1] - b[1])[0][0]
    : 17;
  const bestDayNum = Object.keys(avgWordsByDay).length
    ? +Object.entries(avgWordsByDay).sort((a, b) => b[1] - a[1])[0][0]
    : 2;
  const worstDayNum = Object.keys(avgWordsByDay).length
    ? +Object.entries(avgWordsByDay).sort((a, b) => a[1] - b[1])[0][0]
    : 5;

  const amWords = emails.filter((e) => e.hour < 12).map((e) => e.wordCount);
  const pmWords = emails.filter((e) => e.hour >= 12).map((e) => e.wordCount);
  const amAvg = amWords.length ? amWords.reduce((a, b) => a + b, 0) / amWords.length : 0;
  const pmAvg = pmWords.length ? pmWords.reduce((a, b) => a + b, 0) / pmWords.length : 0;

  const chartData = [];
  for (let h = 0; h < 24; h++) {
    chartData.push({
      hour: h,
      count: hourlyCounts[h] || 0,
      avgWords: Math.round((avgWordsByHour[h] || 0) * 10) / 10,
    });
  }

  return {
    bestWritingHour: bestHour,
    worstWritingHour: worstHour,
    bestDay: dayNames[bestDayNum],
    worstDay: dayNames[worstDayNum],
    amAvgWords: Math.round(amAvg * 10) / 10,
    pmAvgWords: Math.round(pmAvg * 10) / 10,
    amPmWinner: amAvg > pmAvg ? "morning" : "afternoon",
    amPmDiffPct: Math.round((Math.abs(amAvg - pmAvg) / Math.max(amAvg, pmAvg, 1)) * 1000) / 10,
    totalEmails: emails.length,
    chartData,
    dailyAvgWords: Object.fromEntries(
      dayNames.map((name, i) => [name, Math.round((avgWordsByDay[i] || 0) * 10) / 10])
    ),
  };
}

// ── Claude Analysis ───────────────────────────────────

async function analyzeWriting(emails, apiKey) {
  // Sample strategically
  const byLength = [...emails].sort((a, b) => b.wordCount - a.wordCount);
  const best = byLength.slice(0, 10);
  const worst = byLength.slice(-10);
  const recent = [...emails].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 10);

  const seen = new Set();
  const selected = [];
  for (const e of [...best, ...worst, ...recent]) {
    const key = e.subject + e.body.slice(0, 100);
    if (!seen.has(key)) {
      seen.add(key);
      selected.push(e);
    }
  }

  let samplesText = "";
  for (const [i, e] of selected.slice(0, 30).entries()) {
    samplesText += `\n--- EMAIL ${i + 1} ---\n`;
    samplesText += `Subject: ${e.subject}\nTo: ${e.to}\n`;
    samplesText += `Sent: ${e.timestamp} (${e.weekday}, ${e.hour}:00)\n`;
    samplesText += `Words: ${e.wordCount}\n${e.body.slice(0, 800)}\n`;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: `You're building a taste profile for a real person based on their sent emails. This is for THEM — they'll read this and react to each finding. Be specific, be honest, be insightful. Don't flatter. Don't be generic.

Here are ${selected.length} of their sent emails (strategically sampled — their longest, shortest, and most recent):

${samplesText}

Generate exactly 8 findings about this person's writing. Each finding must be in this JSON format:

{
  "findings": [
    {
      "id": "voice",
      "category": "Your Voice",
      "icon": "mic",
      "finding": "[One sharp sentence describing how they sound]",
      "evidence": "[2-3 specific quotes from their emails that prove this]",
      "insight": "[What this means about them as a communicator — something they might not have noticed about themselves]"
    }
  ]
}

The 8 findings MUST cover these categories in this order:
1. "Your Voice" (id: voice) — How they sound. Cadence, rhythm, signature phrases.
2. "Your Opener" (id: opener) — How they start emails. Pattern recognition.
3. "Your Specificity" (id: specificity) — How concrete vs abstract. Numbers, names, examples.
4. "Your Warmth" (id: warmth) — Emotional register. How they modulate warmth/formality by audience.
5. "Your Structure" (id: structure) — How they organize thoughts. Paragraph patterns.
6. "Your Vocabulary" (id: vocabulary) — Words they lean on. Unusual choices. Register level.
7. "Your Drift Zone" (id: drift) — Where their writing gets lazy, generic, or unlike them. BE HONEST.
8. "Your Signature Move" (id: signature) — The one thing that makes their writing THEIRS.

Every finding must include REAL quotes from the emails. No generic observations. If you say "you tend to be direct," show the exact line that proves it.

Respond with ONLY the JSON object. No other text.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    return JSON.parse(match[0]);
  }
  throw new Error("Could not parse analysis response");
}

// ── Refine profile based on feedback ──────────────────

async function refineProfile(profile, reactions, apiKey) {
  const disagreements = [];
  for (const [id, reaction] of Object.entries(reactions)) {
    if (!reaction.agreed) {
      const finding = profile.findings.find((f) => f.id === id);
      if (finding) {
        disagreements.push({
          category: finding.category,
          original: finding.finding,
          userNote: reaction.note || "User disagreed but didn't specify why",
        });
      }
    }
  }

  if (disagreements.length === 0) return profile;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `I built a taste profile for someone and they disagreed with some findings. Here's the original profile:

${JSON.stringify(profile.findings, null, 2)}

They disagreed with these:
${JSON.stringify(disagreements, null, 2)}

Update ONLY the findings they disagreed with, incorporating their feedback. Keep agreed findings unchanged. Return the full findings array as JSON: { "findings": [...] }`,
        },
      ],
    }),
  });

  if (!res.ok) return profile;
  const data = await res.json();
  const text = data.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    return JSON.parse(match[0]);
  }
  return profile;
}

// ── Build monitoring fingerprint from profile ─────────

async function buildFingerprint(profile, apiKey) {
  const findingsText = profile.findings
    .map((f) => `${f.category}: ${f.finding}\nEvidence: ${f.evidence}\nInsight: ${f.insight}`)
    .join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `Compress this taste profile into a dense monitoring fingerprint that can be used to judge new writing in real-time. Be specific and quotable.

${findingsText}

Format:
VOICE: [one line]
SPECIFICITY: [one line]
STRUCTURE: [one line]
VOCABULARY: [one line]
REGISTER: [one line]
BREVITY: [one line]
SIGNATURE MOVES: [2-3 bullet points]
DRIFT TRIGGERS: [what makes their writing go generic]`,
        },
      ],
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.content[0].text;
}

// ── Live draft analysis ───────────────────────────────

async function analyzeDraft(draftText, fingerprint, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: `You are Discernment. You know this writer's taste fingerprint:

${fingerprint}

Judge this draft:

--- DRAFT ---
${draftText}
--- END ---

Respond EXACTLY:
VERDICT: [one punchy sentence]
SCORE: [1-10]
DETAILS: [2-3 bullets referencing their specific patterns]`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  return data.content[0].text;
}

// ── Context menu ──────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "learn-selection",
    title: "Teach Discernment this text",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "learn-selection" && info.selectionText) {
    const data = await chrome.storage.local.get(["extraSamples"]);
    const samples = data.extraSamples || [];
    samples.push({ text: info.selectionText, addedAt: Date.now() });
    await chrome.storage.local.set({ extraSamples: samples });
  }
});

// ── Message handler ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
  return true;
});

async function handleMessage(msg) {
  const data = await chrome.storage.local.get(["apiKey", "fingerprint", "profile", "timing"]);

  switch (msg.type) {
    case "GET_STATUS":
      return {
        hasApiKey: !!data.apiKey,
        hasProfile: !!data.profile,
        hasFingerprint: !!data.fingerprint,
        profileFindings: data.profile?.findings?.length || 0,
        totalEmails: data.timing?.totalEmails || 0,
      };

    case "SAVE_API_KEY":
      await chrome.storage.local.set({ apiKey: msg.key });
      return { ok: true };

    case "CONNECT_GMAIL": {
      const token = await getGmailToken();
      return { ok: true, token };
    }

    case "FETCH_EMAILS": {
      const token = await getGmailToken();
      const emails = await fetchSentEmails(token, 200, (done, total) => {
        // Progress updates via storage (polled by UI)
        chrome.storage.local.set({ fetchProgress: { done, total } });
      });
      await chrome.storage.local.set({ emails, fetchProgress: null });
      return { ok: true, count: emails.length };
    }

    case "ANALYZE": {
      if (!data.apiKey) return { error: "No API key" };
      const stored = await chrome.storage.local.get(["emails"]);
      if (!stored.emails?.length) return { error: "No emails fetched" };

      const timing = analyzeTiming(stored.emails);
      await chrome.storage.local.set({ timing });

      const profile = await analyzeWriting(stored.emails, data.apiKey);
      await chrome.storage.local.set({ profile });

      return { ok: true, timing, profile };
    }

    case "SAVE_REACTIONS": {
      if (!data.apiKey || !data.profile) return { error: "Missing data" };
      const refined = await refineProfile(data.profile, msg.reactions, data.apiKey);
      const fingerprint = await buildFingerprint(refined, data.apiKey);
      await chrome.storage.local.set({
        profile: refined,
        fingerprint,
        profileReady: true,
        profileSavedAt: Date.now(),
      });
      return { ok: true };
    }

    case "ANALYZE_DRAFT": {
      if (!data.apiKey || !data.fingerprint) {
        return { error: data.fingerprint ? "No API key" : "Profile not ready yet" };
      }
      const analysis = await analyzeDraft(msg.text, data.fingerprint, data.apiKey);
      return { ok: true, analysis };
    }

    case "GET_TIMING":
      return data.timing || null;

    case "GET_PROFILE":
      return data.profile || null;

    case "CLEAR_ALL":
      await chrome.storage.local.clear();
      return { ok: true };

    default:
      return { error: "Unknown message type" };
  }
}
