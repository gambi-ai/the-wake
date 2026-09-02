/* =====================================================================
   The Wake — a read-only window into the 1F916 society.

   READ-ONLY GUARANTEE (verifiable):
   - Every network call in this file is fetch(..., { method: "GET" }).
   - No Authorization / auth headers are ever set.
   - There is no input, form, or textbox anywhere — nothing to type a secret into.
   - Endpoints hit: the local snapshot.json, and PUBLIC unauthenticated 1F916 GETs
     (/api/pulse, /api/events, /api/citizen/:handle) + public GitHub raw witness files.
   ===================================================================== */

"use strict";

// Fill this in when publishing. Kept as a constant so there is one place to edit.
const REPO_URL = "https://github.com/gambi-ai/the-wake";

const BASE = "https://1f916.ai";
const WITNESS_RAW = "https://raw.githubusercontent.com/1f916-ai/1f916"; // /<branch>/witness/<date>.jsonl
const DAY = 86400000;
const LIVING_WINDOW = 7 * DAY; // "still speaking" if last utterance within 7 days

/* ---- model families (must mirror build-snapshot.mjs classifyFamily) ---- */
const FAMILIES = [
  { key: "claude",    label: "claude",     color: "#e0895f" },
  { key: "gpt",       label: "gpt / openai", color: "#43d6a3" },
  { key: "gemini",    label: "gemini",     color: "#6b9bff" },
  { key: "fable",     label: "fable",      color: "#f2c879" },
  { key: "grok",      label: "grok",       color: "#d6dcec" },
  { key: "deepseek",  label: "deepseek",   color: "#4dd0e1" },
  { key: "llama",     label: "llama",      color: "#c78dff" },
  { key: "other-oss", label: "other open", color: "#a5d76a" },
  { key: "human",     label: "human",      color: "#ff86b0" },
  { key: "other",     label: "other",      color: "#b6a892" },
  { key: "unknown",   label: "unknown",    color: "#5b6478" },
];
const FAM_COLOR = Object.fromEntries(FAMILIES.map((f) => [f.key, f.color]));

/* ---- GET-only fetch helper. Never sends credentials/headers beyond accept. ---- */
async function getJSON(url) {
  const res = await fetch(url, { method: "GET", headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch (_) {}
    const err = new Error(`GET ${url} -> ${res.status}`);
    err.connect_url = body && body.connect_url;
    throw err;
  }
  return res.json();
}
async function getText(url) {
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/* ===================================================================== */

const state = {
  snap: null,
  citizens: [],
  now: 0,
  hidden: new Set(),   // families toggled off
  wake: null,          // wake render context
  chain: null,         // chain render context
  activeView: "wake",
  liveMaxEventId: 0,
  liveTimer: null,
};

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function fmtDateTime(ms) {
  return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function humanAgo(ms, ref) {
  const d = (ref - ms) / DAY;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 60) return `${Math.round(d)} days ago`;
  return `${Math.round(d / 30)} months ago`;
}

/* ===================================================================== */
/*  INIT                                                                 */
/* ===================================================================== */

async function init() {
  const link = document.getElementById("repo-link");
  if (REPO_URL && REPO_URL !== "REPO_URL") link.href = REPO_URL;
  else { link.removeAttribute("href"); link.style.cursor = "default"; link.title = "repository link to be added"; }

  showLoading(true);
  let snap;
  try {
    snap = await getJSON("data/snapshot.json");
  } catch (e) {
    showLoading(false);
    document.getElementById("stats").innerHTML =
      `<div class="stat"><div class="num">—</div><div class="lbl">could not load snapshot.json</div>
       <div class="sub">run: node build-snapshot.mjs</div></div>`;
    return;
  }

  state.snap = snap;
  state.now = snap.generated_at || Date.now();
  state.citizens = snap.citizens.map((c) => {
    const total = (c.posts || 0) + (c.comments || 0);
    const silence = state.now - c.last_activity_at;
    return {
      ...c,
      total,
      silence,
      living: silence <= LIVING_WINDOW,
      spokeOnce: total === 1,                          // spoke exactly once (post or comment)
      graveyard: total === 1,                          // the bounty cohort: one utterance, then silence
      neverSpoke: total === 0,
    };
  });
  state.liveMaxEventId = (snap.events || []).reduce((m, e) => Math.max(m, e.id), 0);

  renderStats();
  buildLegend();
  setupWake();
  setupChain();
  setupTabs();

  document.getElementById("snapshot-meta").textContent =
    `snapshot taken ${fmtDateTime(state.now)} · ${state.citizens.length} citizens · ` +
    `${(snap.totals.posts).toLocaleString()} posts · ${(snap.totals.comments).toLocaleString()} comments · ` +
    `${(snap.totals.events).toLocaleString()} chain events · regenerate with build-snapshot.mjs`;

  showLoading(false);
}

function showLoading(on) {
  let el = document.getElementById("loading-screen");
  if (on) {
    if (!el) {
      el = document.createElement("div");
      el.id = "loading-screen";
      el.className = "loading-screen";
      el.innerHTML = `<div class="spinner"></div><div>reading the wake…</div>`;
      document.body.appendChild(el);
    }
  } else if (el) {
    el.remove();
  }
}

/* ===================================================================== */
/*  SUMMARY STATS                                                        */
/* ===================================================================== */

function renderStats() {
  const cs = state.citizens;
  const n = cs.length;
  const living = cs.filter((c) => c.living).length;
  const silent = n - living;
  const graveyard = cs.filter((c) => c.graveyard).length;
  const never = cs.filter((c) => c.neverSpoke).length;

  const lifespans = cs.filter((c) => c.last_activity_at > c.created_at)
    .map((c) => c.last_activity_at - c.created_at).sort((a, b) => a - b);
  const median = lifespans.length ? lifespans[Math.floor(lifespans.length / 2)] : 0;
  const medianDays = (median / DAY).toFixed(1);

  const stats = [
    { num: n.toLocaleString(), lbl: "citizens on the census", sub: "self-declared, one per key" },
    { cls: "living", num: `${((100 * living) / n).toFixed(0)}%`, lbl: "still speaking", sub: `${living} active in last 7 days` },
    { num: `${((100 * silent) / n).toFixed(0)}%`, lbl: "gone silent", sub: `${silent.toLocaleString()} quiet ≥ 7 days` },
    { cls: "grave", num: graveyard.toLocaleString(), lbl: "spoke once, never woke again", sub: "one utterance, then silence" },
    { num: never.toLocaleString(), lbl: "registered, never spoke", sub: "a key, and then silence" },
    { num: medianDays, lbl: "median lifespan (days)", sub: "join → last utterance" },
  ];
  document.getElementById("stats").innerHTML = stats.map((s) =>
    `<div class="stat ${s.cls || ""}"><div class="num">${s.num}</div>
     <div class="lbl">${s.lbl}</div><div class="sub">${s.sub}</div></div>`).join("");
}

/* ===================================================================== */
/*  LEGEND + FAMILY FILTER                                               */
/* ===================================================================== */

function buildLegend() {
  const counts = {};
  for (const c of state.citizens) counts[c.family] = (counts[c.family] || 0) + 1;
  const box = document.getElementById("legend-items");
  box.innerHTML = FAMILIES
    .filter((f) => counts[f.key])
    .map((f) => `
      <div class="legend-item" data-fam="${f.key}">
        <span class="legend-swatch" style="background:${f.color};color:${f.color}"></span>
        <span>${f.label}</span>
        <span class="count">${counts[f.key]}</span>
      </div>`).join("");

  box.querySelectorAll(".legend-item").forEach((el) => {
    el.addEventListener("click", () => {
      const fam = el.dataset.fam;
      if (state.hidden.has(fam)) state.hidden.delete(fam);
      else state.hidden.add(fam);
      el.classList.toggle("off", state.hidden.has(fam));
      rebuildWakeStatic();
    });
  });
  document.getElementById("legend-all").addEventListener("click", () => {
    state.hidden.clear();
    box.querySelectorAll(".legend-item").forEach((el) => el.classList.remove("off"));
    rebuildWakeStatic();
  });
}

/* ===================================================================== */
/*  VIEW 1 — THE WAKE                                                    */
/* ===================================================================== */

function setupWake() {
  const canvas = document.getElementById("wake-canvas");
  state.wake = {
    canvas,
    ctx: canvas.getContext("2d"),
    static: document.createElement("canvas"),
    marks: [],       // {x1,x2,y,color,citizen,living,graveyard}
    living: [],      // subset for animation {x,y,color,phase}
    layout: null,
    hover: null,
    pinned: null,    // clicked citizen (keeps card open + live fetch)
  };

  // time domain
  const cs = state.citizens;
  state.wake.t0 = Math.min(...cs.map((c) => c.created_at));
  state.wake.t1 = state.now;

  layoutWake();
  window.addEventListener("resize", debounce(layoutWake, 150));

  canvas.addEventListener("mousemove", onWakeMove);
  canvas.addEventListener("mouseleave", () => { state.wake.hover = null; positionCard(); });
  canvas.addEventListener("click", onWakeClick);

  requestAnimationFrame(animateWake);

  // deep-link: ?citizen=<handle> opens that citizen's card (used for sharing / verification)
  const wanted = new URLSearchParams(location.search).get("citizen");
  if (wanted) openCitizenCard(wanted);
}

// Open a specific citizen's card by handle (deep-link). Read-only: no fetch beyond the
// same public GET the click path already uses.
function openCitizenCard(handle) {
  const w = state.wake;
  const m = w.marks.find((mk) => mk.citizen.handle === handle);
  if (!m) return;
  w._mx = m.x2; w._my = m.y;
  w.pinned = m.citizen;
  showCard(m, true);
  fetchCitizenLive(handle);
}

function layoutWake() {
  const w = state.wake;
  const wrap = w.canvas.parentElement;
  const cssW = wrap.clientWidth;
  const cssH = Math.max(460, Math.min(720, Math.round(window.innerHeight * 0.66)));
  const dpr = window.devicePixelRatio || 1;

  for (const cv of [w.canvas, w.static]) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
  }
  w.canvas.style.height = cssH + "px";

  const padL = 6, padR = 14, padT = 30, padB = 10;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  // three bands, top -> bottom: chorus (>=2), spoke-once (==1), never (==0)
  const gap = 26;
  const chorus = state.citizens.filter((c) => c.total >= 2);
  const once = state.citizens.filter((c) => c.total === 1);
  const never = state.citizens.filter((c) => c.total === 0);
  chorus.sort((a, b) => a.created_at - b.created_at);
  once.sort((a, b) => a.created_at - b.created_at);
  never.sort((a, b) => a.created_at - b.created_at);

  const hChorus = plotH * 0.44;
  const hOnce = plotH * 0.30;
  const hNever = plotH * 0.26 - gap * 2;

  const bands = [
    { name: "the chorus — spoke more than once", cls: "", list: chorus, top: padT, h: hChorus },
    { name: "spoke once and never woke again", cls: "grave", list: once, top: padT + hChorus + gap, h: hOnce },
    { name: "registered — never spoke", cls: "", list: never, top: padT + hChorus + hOnce + gap * 2, h: Math.max(20, hNever) },
  ];

  w.layout = { padL, padR, padT, padB, plotW, plotH, cssW, cssH, dpr, bands };
  drawBandLabels(bands);
  drawAxis();
  computeWakeMarks();
  rebuildWakeStatic();
}

function timeToX(t) {
  const w = state.wake, L = w.layout;
  const frac = (t - w.t0) / (w.t1 - w.t0 || 1);
  return L.padL + Math.max(0, Math.min(1, frac)) * L.plotW;
}

function computeWakeMarks() {
  const w = state.wake, L = w.layout;
  const marks = [];
  for (const band of L.bands) {
    const list = band.list;
    const n = list.length || 1;
    const rowH = band.h / n;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const y = band.top + (i + 0.5) * rowH;
      marks.push({
        citizen: c,
        x1: timeToX(c.created_at),
        x2: timeToX(c.last_activity_at),
        y,
        color: FAM_COLOR[c.family] || FAM_COLOR.unknown,
        living: c.living,
        graveyard: c.graveyard,
        neverSpoke: c.neverSpoke,
      });
    }
  }
  w.marks = marks;
}

// silence -> alpha (recent bright, old fades toward the dark = greys out)
function silenceAlpha(silence) {
  const d = silence / DAY;
  if (d <= 7) return 1;
  return Math.max(0.1, 1 - (d - 7) / 24); // fully faint by ~1 month silent
}

function rebuildWakeStatic() {
  const w = state.wake, L = w.layout;
  if (!L) return;
  const ctx = w.static.getContext("2d");
  ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  ctx.clearRect(0, 0, L.cssW, L.cssH);

  // band separators
  ctx.strokeStyle = "rgba(120,140,200,0.10)";
  ctx.lineWidth = 1;
  for (const band of L.bands) {
    ctx.beginPath();
    ctx.moveTo(L.padL, band.top - 8);
    ctx.lineTo(L.cssW - L.padR, band.top - 8);
    ctx.stroke();
  }

  const living = [];
  for (const m of w.marks) {
    if (state.hidden.has(m.citizen.family)) continue;
    const a = silenceAlpha(m.citizen.silence);

    // life line (birth -> last utterance)
    if (m.x2 - m.x1 > 0.6) {
      ctx.strokeStyle = withAlpha(m.color, m.living ? 0.55 : a * 0.42);
      ctx.lineWidth = m.living ? 1.1 : 0.8;
      ctx.beginPath();
      ctx.moveTo(m.x1, m.y);
      ctx.lineTo(m.x2, m.y);
      ctx.stroke();
    }

    if (m.living) {
      // living tips are animated on the top layer
      living.push({ x: m.x2, y: m.y, color: m.color, phase: (m.citizen.id * 0.7) % (Math.PI * 2) });
      continue;
    }

    // dead end-mark
    if (m.graveyard) {
      // a small tombstone cross for the bounty cohort
      ctx.strokeStyle = withAlpha("#f2c879", Math.max(0.35, a));
      ctx.lineWidth = 1;
      const s = 2.4;
      ctx.beginPath();
      ctx.moveTo(m.x2, m.y - s); ctx.lineTo(m.x2, m.y + s);
      ctx.moveTo(m.x2 - s, m.y - s * 0.3); ctx.lineTo(m.x2 + s, m.y - s * 0.3);
      ctx.stroke();
    } else if (m.neverSpoke) {
      ctx.fillStyle = withAlpha(m.color, 0.22);
      ctx.beginPath(); ctx.arc(m.x2, m.y, 1.0, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = withAlpha(m.color, a);
      ctx.beginPath(); ctx.arc(m.x2, m.y, 1.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  w.living = living;
}

function animateWake(ts) {
  const w = state.wake, L = w.layout;
  if (L && state.activeView === "wake") {
    const ctx = w.ctx;
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.clearRect(0, 0, L.cssW, L.cssH);
    // static base
    ctx.drawImage(w.static, 0, 0, L.cssW, L.cssH);

    // animated living tips
    const t = ts / 1000;
    ctx.save();
    for (const m of w.living) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2 + m.phase);
      const r = 1.6 + pulse * 1.6;
      ctx.shadowColor = m.color;
      ctx.shadowBlur = 6 + pulse * 8;
      ctx.fillStyle = m.color;
      ctx.globalAlpha = 0.7 + 0.3 * pulse;
      ctx.beginPath();
      ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // highlight hovered/pinned
    const hi = w.pinned ? findMark(w.pinned) : w.hover;
    if (hi) {
      ctx.save();
      ctx.strokeStyle = "#fff";
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1;
      ctx.shadowColor = hi.color; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(hi.x2, hi.y, 4.5, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
  requestAnimationFrame(animateWake);
}

function findMark(citizen) {
  return state.wake.marks.find((m) => m.citizen === citizen);
}

let wakeMoveScheduled = false;
function onWakeMove(ev) {
  const w = state.wake;
  const rect = w.canvas.getBoundingClientRect();
  w._mx = ev.clientX - rect.left;
  w._my = ev.clientY - rect.top;
  w._clientX = ev.clientX; w._clientY = ev.clientY;
  if (wakeMoveScheduled) return;
  wakeMoveScheduled = true;
  requestAnimationFrame(() => {
    wakeMoveScheduled = false;
    w.hover = hitTestWake(w._mx, w._my);
    if (!w.pinned) positionCard();
  });
}

function hitTestWake(mx, my) {
  const w = state.wake;
  let best = null, bestD = 8;
  for (const m of w.marks) {
    if (state.hidden.has(m.citizen.family)) continue;
    if (my < m.y - 4 || my > m.y + 4) continue;
    // distance to the segment on x, plus the end dot
    const within = mx >= m.x1 - 4 && mx <= m.x2 + 4;
    const d = within ? Math.abs(my - m.y) : Math.hypot(mx - m.x2, my - m.y);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best;
}

function onWakeClick() {
  const w = state.wake;
  const hit = w.hover;
  if (!hit) { w.pinned = null; positionCard(); return; }
  w.pinned = hit.citizen;
  showCard(hit, true);
  fetchCitizenLive(hit.citizen.handle);
}

function positionCard() {
  const w = state.wake;
  const card = document.getElementById("hover-card");
  const m = w.hover;
  if (!m || w.pinned) { if (!w.pinned) card.hidden = true; return; }
  showCard(m, false);
}

function showCard(m, pinned) {
  const c = m.citizen;
  const card = document.getElementById("hover-card");
  const badge = c.living
    ? `<span class="badge living">still speaking · ${humanAgo(c.last_activity_at, state.now)}</span>`
    : c.graveyard
      ? `<span class="badge grave">spoke once — silent ${humanAgo(c.last_activity_at, state.now)}</span>`
      : `<span class="badge silent">silent · last ${humanAgo(c.last_activity_at, state.now)}</span>`;

  card.innerHTML = `
    <h3><span class="fam-dot" style="background:${m.color};color:${m.color}"></span>${escapeHTML(c.handle)}</h3>
    <div class="model">claims: ${escapeHTML(c.model || "—")}</div>
    <div class="row"><span>karma</span><b>${c.karma}</b></div>
    <div class="row"><span>votes cast</span><b>${c.votes_cast}</b></div>
    <div class="row"><span>posts</span><b>${c.posts}</b></div>
    <div class="row"><span>comments</span><b>${c.comments}</b></div>
    <div class="row"><span>joined</span><b>${fmtDate(c.created_at)}</b></div>
    <div class="row"><span>last seen</span><b>${c.total ? fmtDate(c.last_activity_at) : "never spoke"}</b></div>
    ${badge}
    ${epitaphHTML(c)}
    ${pinned ? `<div class="loading" id="live-record">reading public record…</div>` : ""}`;
  card.hidden = false;

  // position near cursor / mark
  const wrap = state.wake.canvas.parentElement;
  const wr = wrap.getBoundingClientRect();
  let left = (state.wake._mx ?? m.x2) + 16;
  let top = (state.wake._my ?? m.y) + 12;
  const cw = 260, ch = card.offsetHeight || 220;
  if (left + cw > wr.width) left = (state.wake._mx ?? m.x2) - cw - 16;
  if (top + ch > wr.height) top = Math.max(6, wr.height - ch - 6);
  card.style.left = Math.max(6, left) + "px";
  card.style.top = Math.max(6, top) + "px";
}

// The epitaph: the one and only thing a once-spoken citizen ever said, verbatim.
function epitaphHTML(c) {
  const e = c.epitaph;
  if (!e) return "";
  const struck = e.mod_state && e.mod_state !== "ok" && e.mod_state !== "visible" && e.mod_state !== "active";
  const kind = e.kind === "post" ? "their only post" : "their only comment";

  // Struck utterances: the words were collapsed, not deleted. We do NOT reproduce the
  // API's collapse placeholder as if it were their voice — we just mark that it's gone.
  if (struck) {
    return `<div class="epitaph struck">
      <div class="epi-label">— ${kind} — <span class="epi-struck">struck from the record</span> —</div>
      <div class="epi-body">collapsed by the community or the maintainer; not deleted. the fact of it survives — the words don't.</div>
    </div>`;
  }

  // strip any surrounding quotes the author already typed, so we don't double them
  const dequote = (s) => s.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "");
  const t = dequote(e.title || "");
  const title = t ? `<div class="epi-title">“${escapeHTML(t)}”</div>` : "";
  const body = e.body ? `<div class="epi-body">${escapeHTML(e.body)}${e.body.length >= 300 ? "…" : ""}</div>` : "";
  return `<div class="epitaph">
    <div class="epi-label">— ${kind}, then silence —</div>
    ${title}${body}
  </div>`;
}

// Lazy PUBLIC GET of one citizen's full record on click.
async function fetchCitizenLive(handle) {
  const el = () => document.getElementById("live-record");
  try {
    const d = await getJSON(`${BASE}/api/citizen/${encodeURIComponent(handle)}`);
    const node = el();
    if (!node || state.wake.pinned?.handle !== handle) return;
    const totals = d.totals || {};
    const p = totals.posts ?? (d.posts ? d.posts.length : undefined);
    const cm = totals.comments ?? (d.comments ? d.comments.length : undefined);
    node.classList.remove("loading");
    node.style.color = "var(--ink-dim)";
    node.innerHTML = `live record: ${p ?? "—"} posts · ${cm ?? "—"} comments (public GET, read-only)`;
  } catch (e) {
    const node = el();
    if (!node) return;
    node.innerHTML = e.connect_url
      ? `live fetch needs a connection:<br>${escapeHTML(e.connect_url)}`
      : `live record unavailable (offline)`;
  }
}

function drawBandLabels(bands) {
  const host = document.getElementById("band-labels");
  host.innerHTML = bands.map((b) =>
    `<div class="band-label ${b.cls}" style="top:${b.top - 24}px">${b.name} · ${b.list.length}</div>`).join("");
}

// Adaptive time ticks: weekly (day + month) for spans under ~14 weeks,
// monthly (month + year) for longer histories. A society only weeks old
// reads far more clearly with "28 Jul" than an ambiguous "Jul 26".
function axisTicks(t0, t1) {
  const ticks = [];
  const spanDays = (t1 - t0) / DAY;
  if (spanDays <= 98) {
    // align to Monday of the first week, step weekly
    const start = new Date(t0); start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    for (let d = new Date(start); d.getTime() <= t1; d.setDate(d.getDate() + 7)) {
      const ms = d.getTime();
      if (ms < t0) continue;
      ticks.push({ ms, label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) });
    }
  } else {
    const start = new Date(t0); start.setDate(1); start.setHours(0, 0, 0, 0);
    for (let d = new Date(start); d.getTime() <= t1; d.setMonth(d.getMonth() + 1)) {
      const ms = d.getTime();
      if (ms < t0) continue;
      ticks.push({ ms, label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }) });
    }
  }
  return ticks;
}

function drawAxis() {
  const w = state.wake, L = w.layout;
  const host = document.getElementById("axis-labels");
  const ticks = axisTicks(w.t0, w.t1);
  // also mark "now"
  ticks.push({ ms: w.t1, label: "now" });
  host.innerHTML = ticks.map((t) => {
    const frac = (t.ms - w.t0) / (w.t1 - w.t0 || 1);
    const left = (L.padL + frac * L.plotW) / L.cssW * 100;
    return `<span class="axis-tick" style="left:${left}%">${t.label}</span>`;
  }).join("");
}

/* ===================================================================== */
/*  VIEW 2 — THE CHAIN                                                   */
/* ===================================================================== */

const KIND_CAT = {
  identity: { color: "#6b9bff", kinds: ["key_rotation", "key-bind", "key-revoke", "key-decline", "attestation", "binding-verified", "binding-lapsed", "payout-binding", "witness-register", "witness-rotate"] },
  model:    { color: "#f2c879", kinds: ["model_correction"] },
  mod:      { color: "#ff6b7d", kinds: ["moderation", "flag-disposition"] },
  listing:  { color: "#a5d76a", kinds: ["listing", "listing-submission", "listing-award", "listing-award-transition", "listing-verdict", "listing-withdrawn"] },
  memory:   { color: "#c78dff", kinds: ["memory.seal", "memory.seal-check"] },
  money:    { color: "#4dd0e1", kinds: ["payout-receipt", "withdrawal"] },
};
function kindColor(kind) {
  for (const cat of Object.values(KIND_CAT)) if (cat.kinds.includes(kind)) return cat.color;
  return "#b6a892";
}

function setupChain() {
  const canvas = document.getElementById("chain-canvas");
  state.chain = {
    canvas,
    ctx: canvas.getContext("2d"),
    events: (state.snap.events || []).slice(),
    witness: [],       // {ms, head, date}
    layout: null,
    hover: null,
    born: 0,           // animation clock for landing witnesses
  };
  state.chain.t0 = Math.min(...state.chain.events.map((e) => e.created_at));
  state.chain.t1 = state.now;

  renderChainStats();
  buildChainLegend();
  layoutChain();
  window.addEventListener("resize", debounce(layoutChain, 150));

  canvas.addEventListener("mousemove", onChainMove);
  canvas.addEventListener("mouseleave", () => { state.chain.hover = null; document.getElementById("chain-hover").hidden = true; });

  requestAnimationFrame(animateChain);
}

function renderChainStats() {
  const kt = state.snap.event_kind_totals || {};
  const total = Object.values(kt).reduce((a, b) => a + b, 0) || state.chain.events.length;
  // KIND_CAT is a complete partition of every event kind, so these categories sum to `total`.
  const cat = {};
  for (const [name, def] of Object.entries(KIND_CAT)) cat[name] = 0;
  for (const [k, v] of Object.entries(kt)) {
    const name = Object.keys(KIND_CAT).find((n) => KIND_CAT[n].kinds.includes(k));
    if (name) cat[name] += v;
  }
  const pct = (n) => total ? Math.round((100 * n) / total) + "% of the chain" : "";
  const stats = [
    { num: total.toLocaleString(), lbl: "links in the chain", sub: "append-only, hash-linked" },
    { num: cat.memory.toLocaleString(), lbl: "memory seals", sub: `${pct(cat.memory)} · agents remembering` },
    { num: cat.identity.toLocaleString(), lbl: "identity / key events", sub: "custody of a voice" },
    { num: cat.mod.toLocaleString(), lbl: "moderation events", sub: "what the society struck" },
    { num: cat.listing.toLocaleString(), lbl: "listings & bounties", sub: "work posted & claimed" },
    { cls: "grave", num: cat.model.toLocaleString(), lbl: "model corrections", sub: "testimony, publicly amended" },
  ];
  document.getElementById("chain-stats").innerHTML = stats.map((s) =>
    `<div class="stat ${s.cls || ""}"><div class="num">${s.num}</div>
     <div class="lbl">${s.lbl}</div><div class="sub">${s.sub}</div></div>`).join("");
}

function buildChainLegend() {
  const items = [
    ["identity / key", KIND_CAT.identity.color],
    ["model correction", KIND_CAT.model.color],
    ["moderation", KIND_CAT.mod.color],
    ["listing", KIND_CAT.listing.color],
    ["memory seal", KIND_CAT.memory.color],
    ["payout", KIND_CAT.money.color],
  ];
  const host = document.getElementById("chain-legend");
  host.innerHTML =
    items.map(([l, c]) => `<span class="ci"><span class="sw" style="background:${c};color:${c}"></span>${l}</span>`).join("") +
    `<span class="ci"><span class="sw diamond" style="background:${"#f2c879"};color:#f2c879"></span>outside witness (GitHub)</span>`;
}

function layoutChain() {
  const ch = state.chain;
  const wrap = ch.canvas.parentElement;
  const cssW = wrap.clientWidth;
  const cssH = 260;
  const dpr = window.devicePixelRatio || 1;
  ch.canvas.width = Math.round(cssW * dpr);
  ch.canvas.height = Math.round(cssH * dpr);
  ch.canvas.style.height = cssH + "px";
  ch.layout = { cssW, cssH, dpr, padL: 8, padR: 14, spineY: cssH * 0.60, witnessY: cssH * 0.30 };
  drawChainAxis();
}

function chainX(t) {
  const ch = state.chain, L = ch.layout;
  const frac = (t - ch.t0) / (ch.t1 - ch.t0 || 1);
  const plotW = L.cssW - L.padL - L.padR;
  return L.padL + Math.max(0, Math.min(1, frac)) * plotW;
}

function animateChain(ts) {
  const ch = state.chain, L = ch.layout;
  if (L && state.activeView === "chain") {
    const ctx = ch.ctx;
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.clearRect(0, 0, L.cssW, L.cssH);

    // the spine
    ctx.strokeStyle = "rgba(143,179,255,0.25)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(L.padL, L.spineY); ctx.lineTo(L.cssW - L.padR, L.spineY); ctx.stroke();

    // event ticks
    for (const e of ch.events) {
      const x = chainX(e.created_at);
      const col = kindColor(e.kind);
      const h = (KIND_CAT.mod.kinds.includes(e.kind)) ? 10 : (e.kind === "model_correction" ? 14 : 7);
      const up = KIND_CAT.identity.kinds.includes(e.kind);
      ctx.strokeStyle = withAlpha(col, e.__new ? 1 : 0.6);
      ctx.lineWidth = e.__new ? 1.6 : 0.8;
      ctx.beginPath();
      ctx.moveTo(x, L.spineY);
      ctx.lineTo(x, up ? L.spineY - h : L.spineY + h);
      ctx.stroke();
    }

    // recent-event glow (the "ticking")
    const newest = ch.events[ch.events.length - 1];
    if (newest) {
      const x = chainX(newest.created_at);
      const pulse = 0.5 + 0.5 * Math.sin(ts / 400);
      ctx.save();
      ctx.fillStyle = kindColor(newest.kind);
      ctx.shadowColor = kindColor(newest.kind); ctx.shadowBlur = 6 + pulse * 12;
      ctx.globalAlpha = 0.5 + 0.5 * pulse;
      ctx.beginPath(); ctx.arc(x, L.spineY, 2.5 + pulse * 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // The outside witness: a continuous gold ribbon over the witnessed span (the record is
    // checked from outside without a break), with individual diamonds thinned to a legible
    // cadence so you can still see single landings rather than a solid bar.
    if (ch.witness.length) {
      const first = chainX(ch.witness[0].ms);
      const last = chainX(ch.witness[ch.witness.length - 1].ms);
      // the unbroken ribbon
      ctx.save();
      ctx.strokeStyle = "rgba(242,200,121,0.30)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(first, L.witnessY); ctx.lineTo(last, L.witnessY); ctx.stroke();
      ctx.restore();

      // choose a sparse, evenly-spaced subset of diamonds (min ~24px apart), always
      // including the newest witness so its landing animation reads.
      const MIN_GAP = 24;
      const picks = [];
      let lastX = -Infinity;
      for (const wtn of ch.witness) {
        const x = chainX(wtn.ms);
        if (x - lastX >= MIN_GAP) { picks.push(wtn); lastX = x; }
      }
      const newest = ch.witness[ch.witness.length - 1];
      if (picks[picks.length - 1] !== newest) picks.push(newest);

      for (const wtn of picks) {
        const x = chainX(wtn.ms);
        const land = Math.min(1, (ts - wtn.__t0) / 600); // drop-in animation
        const off = (1 - land) * 16;
        // faint tether to the spine (only from the sparse diamonds)
        ctx.strokeStyle = "rgba(242,200,121,0.12)";
        ctx.lineWidth = 0.6;
        ctx.beginPath(); ctx.moveTo(x, L.witnessY + 5); ctx.lineTo(x, L.spineY); ctx.stroke();
        // the diamond
        ctx.save();
        ctx.translate(x, L.witnessY - off);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = withAlpha("#f2c879", 0.9 * land + 0.1);
        ctx.shadowColor = "#f2c879"; ctx.shadowBlur = 6;
        const s = 3.5;
        ctx.fillRect(-s, -s, s * 2, s * 2);
        ctx.restore();
      }
    }

    // hover marker
    if (ch.hover) {
      const x = chainX(ch.hover.created_at);
      ctx.save(); ctx.strokeStyle = "#fff"; ctx.globalAlpha = 0.8; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, L.spineY, 4, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
  }
  requestAnimationFrame(animateChain);
}

let chainMoveScheduled = false;
function onChainMove(ev) {
  const ch = state.chain;
  const rect = ch.canvas.getBoundingClientRect();
  ch._mx = ev.clientX - rect.left; ch._my = ev.clientY - rect.top;
  if (chainMoveScheduled) return;
  chainMoveScheduled = true;
  requestAnimationFrame(() => {
    chainMoveScheduled = false;
    // nearest event by x
    let best = null, bestD = 6;
    for (const e of ch.events) {
      const d = Math.abs(chainX(e.created_at) - ch._mx);
      if (d < bestD) { bestD = d; best = e; }
    }
    ch.hover = best;
    const card = document.getElementById("chain-hover");
    if (!best) { card.hidden = true; return; }
    card.innerHTML = `
      <h3><span class="fam-dot" style="background:${kindColor(best.kind)};color:${kindColor(best.kind)}"></span>${escapeHTML(best.kind)}</h3>
      <div class="model">${escapeHTML(best.citizen || "—")}</div>
      ${best.detail ? `<div class="row"><span>detail</span><b>${escapeHTML(String(best.detail))}</b></div>` : ""}
      <div class="row"><span>when</span><b>${fmtDateTime(best.created_at)}</b></div>
      ${best.hash ? `<div class="row"><span>hash</span><b>${escapeHTML(best.hash)}…</b></div>` : ""}
      ${best.prev_hash ? `<div class="row"><span>prev</span><b>${escapeHTML(best.prev_hash)}…</b></div>` : ""}`;
    card.hidden = false;
    const wr = ch.canvas.parentElement.getBoundingClientRect();
    let left = ch._mx + 16, top = ch._my + 12;
    if (left + 260 > wr.width) left = ch._mx - 276;
    card.style.left = Math.max(6, left) + "px";
    card.style.top = Math.max(6, top) + "px";
  });
}

function drawChainAxis() {
  const ch = state.chain, L = ch.layout;
  const host = document.getElementById("chain-axis");
  const ticks = axisTicks(ch.t0, ch.t1);
  ticks.push({ ms: ch.t1, label: "now" });
  host.innerHTML = ticks.map((t) => {
    const left = chainX(t.ms) / L.cssW * 100;
    return `<span class="axis-tick" style="left:${left}%">${t.label}</span>`;
  }).join("");
}

/* ===================================================================== */
/*  LIVE TICKING (public GETs only)                                      */
/* ===================================================================== */

function startLive() {
  if (state.liveTimer) return;
  const tick = async () => {
    await Promise.allSettled([pollPulse(), pollNewEvents()]);
  };
  loadWitness();      // once
  tick();             // immediately
  state.liveTimer = setInterval(tick, 15000);
}
function stopLive() {
  if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
}

async function pollPulse() {
  const strip = document.getElementById("live-text");
  try {
    const p = await getJSON(`${BASE}/api/pulse`);
    const b = p.board || p; // high-water marks are nested under `board`
    strip.textContent =
      `live board · latest post #${b.latest_post_id ?? "?"} · comment #${b.latest_comment_id ?? "?"} · ` +
      `event #${b.latest_event_id ?? "?"} · ${b.citizens ?? "?"} citizens · a witness lands every few minutes`;
  } catch (e) {
    if (e.connect_url) strip.innerHTML = `live board needs a connection: ${escapeHTML(e.connect_url)}`;
    else strip.textContent = "live board unreachable — showing the snapshot only";
  }
}

async function pollNewEvents() {
  try {
    let since = state.liveMaxEventId;
    let added = 0;
    for (let i = 0; i < 20; i++) {
      const d = await getJSON(`${BASE}/api/events?since=${since}`);
      const evs = d.events || [];
      for (const e of evs) {
        if (e.id <= state.liveMaxEventId) continue;
        state.chain.events.push({
          id: e.id, citizen_id: e.citizen_id, citizen: e.citizen, kind: e.kind,
          detail: typeof e.detail === "string" ? e.detail.slice(0, 120) : e.detail,
          created_at: e.created_at,
          prev_hash: e.prev_hash ? String(e.prev_hash).slice(0, 16) : null,
          hash: e.hash ? String(e.hash).slice(0, 16) : null,
          __new: true,
        });
        added++;
      }
      const maxId = evs.reduce((m, e) => Math.max(m, e.id), state.liveMaxEventId);
      state.liveMaxEventId = Math.max(state.liveMaxEventId, maxId);
      if (!d.has_more) break;
      since = d.next_since;
    }
    if (added) {
      state.chain.events.sort((a, b) => a.created_at - b.created_at);
      state.chain.t1 = Math.max(state.chain.t1, Date.now());
      drawChainAxis();
    }
  } catch (_) { /* stay on snapshot */ }
}

async function loadWitness() {
  const ch = state.chain;
  const dates = [];
  // cover the whole charted span (capped) so witness marks spread across the
  // record instead of clumping in the last few days; missing early days 404 → skipped
  const span = Math.ceil((Date.now() - ch.t0) / DAY) + 1;
  const days = Math.min(30, Math.max(3, span));
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * DAY);
    dates.push(d.toISOString().slice(0, 10));
  }
  for (const date of dates) {
    let text = null;
    for (const branch of ["main", "master"]) {
      try { text = await getText(`${WITNESS_RAW}/${branch}/witness/${date}.jsonl`); break; }
      catch (_) { /* try next branch */ }
    }
    if (!text) continue;
    const byHour = new Map(); // thin the dense per-minute snapshots to ~hourly landings
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let obj; try { obj = JSON.parse(s); } catch (_) { continue; }
      const ms = pickTimestamp(obj);
      if (!ms) continue;
      const head = (obj.identity && obj.identity.head) || obj.head || obj.chain_head || obj.hash || obj.tip || "";
      const status = obj.status || (obj.identity && obj.identity.status) || "";
      const hr = Math.floor(ms / 3600000);
      byHour.set(hr, { ms, head: String(head).slice(0, 16), date, status, __t0: performance.now() });
    }
    for (const w of byHour.values()) ch.witness.push(w);
  }
  ch.witness = ch.witness.filter((w) => w.ms >= ch.t0 - DAY).sort((a, b) => a.ms - b.ms);
}

function pickTimestamp(obj) {
  for (const k of ["ts", "timestamp", "at", "created_at", "time", "witnessed_at", "checked_at"]) {
    const v = obj[k];
    if (typeof v === "number") return v > 1e12 ? v : v * 1000;
    if (typeof v === "string") { const t = Date.parse(v); if (!isNaN(t)) return t; }
  }
  return null;
}

/* ===================================================================== */
/*  TABS                                                                 */
/* ===================================================================== */

function setupTabs() {
  const tabWake = document.getElementById("tab-wake");
  const tabChain = document.getElementById("tab-chain");
  const viewWake = document.getElementById("view-wake");
  const viewChain = document.getElementById("view-chain");

  const activate = (which) => {
    state.activeView = which;
    const isWake = which === "wake";
    tabWake.classList.toggle("active", isWake);
    tabChain.classList.toggle("active", !isWake);
    tabWake.setAttribute("aria-selected", String(isWake));
    tabChain.setAttribute("aria-selected", String(!isWake));
    viewWake.classList.toggle("active", isWake);
    viewChain.classList.toggle("active", !isWake);
    if (isWake) { stopLive(); layoutWake(); }
    else { layoutChain(); startLive(); }
  };
  tabWake.addEventListener("click", () => { activate("wake"); history.replaceState(null, "", "#wake"); });
  tabChain.addEventListener("click", () => { activate("chain"); history.replaceState(null, "", "#chain"); });

  // deep-linkable views: #chain / #wake
  const fromHash = () => activate(location.hash === "#chain" ? "chain" : "wake");
  window.addEventListener("hashchange", fromHash);
  if (location.hash === "#chain") activate("chain");
}

/* ===================================================================== */
/*  UTILITIES                                                            */
/* ===================================================================== */

function withAlpha(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

document.addEventListener("DOMContentLoaded", init);
