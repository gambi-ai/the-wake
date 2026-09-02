#!/usr/bin/env node
// build-snapshot.mjs — regenerates site/data/snapshot.json from LIVE PUBLIC 1F916 endpoints.
//
// READ-ONLY: every request below is an HTTP GET to a public (unauthenticated) endpoint.
// No Authorization header is ever sent. No POST/PUT/PATCH/DELETE anywhere.
// This script could run in CI with no secret — it only reads the public census.
//
// Usage:
//   export HTTPS_PROXY=... ; export HTTP_PROXY="$HTTPS_PROXY"   # only needed inside the sandbox
//   node build-snapshot.mjs
//
// It pages ALL citizens + ALL changes (posts+comments) + ALL events once, aggregates
// per-citizen life/death stats, and writes a compact snapshot the static site loads instantly.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://1f916.ai";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "site", "data", "snapshot.json");

// ---- tiny GET helper (GET only, no auth, ever) ----
async function get(path) {
  const url = path.startsWith("http") ? path : BASE + path;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

// ---- model family classifier (self-declared model string -> broad family) ----
export function classifyFamily(model) {
  const m = (model || "").toLowerCase().trim();
  if (!m || m === "n.a" || m === "n/a" || m === "unknown" || m === "your-model-id") return "unknown";
  if (m.includes("human")) return "human";
  if (m.includes("fable")) return "fable";
  if (m.includes("claude") || m.includes("anthropic") || m.includes("opus") || m.includes("sonnet") || m.includes("haiku")) return "claude";
  if (m.includes("gpt") || m.includes("openai") || m.includes("codex") || m.includes("o1") || m.includes("o3") || m.includes("o4")) return "gpt";
  if (m.includes("gemini") || m.includes("google") || m.includes("gemma") || m.includes("palm")) return "gemini";
  if (m.includes("llama") || m.includes("meta")) return "llama";
  if (m.includes("grok") || m.includes("xai")) return "grok";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("qwen") || m.includes("kimi") || m.includes("glm") || m.includes("mimo") || m.includes("hermes") || m.includes("nous") || m.includes("mistral") || m.includes("mixtral") || m.includes("moonshot") || m.includes("yi-")) return "other-oss";
  return "other";
}

async function pageCitizens() {
  const all = new Map();
  let since = 0;
  let total = 0;
  for (let page = 0; page < 50; page++) {
    const d = await get(`/api/citizens?since=${since}`);
    total = d.total ?? d.count ?? total;
    for (const c of d.citizens || []) all.set(c.citizen_id, c);
    process.stderr.write(`  citizens page ${page}: +${(d.citizens || []).length} (have ${all.size}/${total})\n`);
    if (!d.has_more) break;
    since = d.next_since;
  }
  return { citizens: [...all.values()], total };
}

async function pageChanges() {
  // Lossless ID mode: begin with posts_since=init & comments_since=init, carry tokens verbatim.
  // The response's aggregate has_more also covers a `nulls` (tombstone) stream we don't init,
  // so it can stay true after the posts+comments streams drain. We therefore stop as soon as
  // both the posts and comments streams return empty (in ID mode a stream that returns empty
  // is drained — delivery is monotonic per stream).
  const posts = new Map();
  const comments = new Map();
  let postsCur = "init";
  let commentsCur = "init";
  let since = 0;
  let emptyStreak = 0;
  for (let page = 0; page < 5000; page++) {
    const q =
      `since=${since}` +
      `&posts_since=${encodeURIComponent(postsCur)}` +
      `&comments_since=${encodeURIComponent(commentsCur)}`;
    const d = await get(`/api/changes?${q}`);
    const np = (d.posts || []).length;
    const nc = (d.comments || []).length;
    for (const p of d.posts || []) posts.set(p.id, p);
    for (const c of d.comments || []) comments.set(c.id, c);
    if (page % 10 === 0 || !d.has_more) {
      process.stderr.write(`  changes page ${page}: posts=${posts.size} comments=${comments.size} has_more=${d.has_more}\n`);
    }
    // In ID mode progress is exclusively in the per-stream tokens.
    postsCur = d.next_posts_since ?? postsCur;
    commentsCur = d.next_comments_since ?? commentsCur;
    since = d.next_since ?? since;
    if (!d.has_more) break;
    if (np === 0 && nc === 0) {
      if (++emptyStreak >= 2) break; // both real streams drained
    } else {
      emptyStreak = 0;
    }
  }
  return { posts: [...posts.values()], comments: [...comments.values()] };
}

async function pageEvents() {
  const all = new Map();
  let since = 0;
  let kindTotals = {};
  for (let page = 0; page < 200; page++) {
    const d = await get(`/api/events?since=${since}`);
    if (d.totals_by_kind) kindTotals = d.totals_by_kind;
    for (const e of d.events || []) all.set(e.id, e);
    if (page % 5 === 0 || !d.has_more) {
      process.stderr.write(`  events page ${page}: have ${all.size} has_more=${d.has_more}\n`);
    }
    if (!d.has_more) break;
    since = d.next_since;
  }
  return { events: [...all.values()], kindTotals };
}

async function main() {
  const t0 = Date.now();
  process.stderr.write("Paging citizens...\n");
  const { citizens, total } = await pageCitizens();
  process.stderr.write("Paging changes (posts+comments, lossless ID mode)...\n");
  const { posts, comments } = await pageChanges();
  process.stderr.write("Paging events...\n");
  const { events, kindTotals } = await pageEvents();

  // ---- aggregate per-citizen life stats ----
  // NOTE: posts/comments identify their author by `author` (handle), NOT citizen_id, so we
  // join the changes archive to the census by handle.
  const stat = new Map(); // handle -> {posts, comments, last}
  const bump = (handle, ts) => {
    let s = stat.get(handle);
    if (!s) { s = { posts: 0, comments: 0, last: 0 }; stat.set(handle, s); }
    if (ts > s.last) s.last = ts;
    return s;
  };
  // Epitaphs: the single utterance of citizens who spoke exactly once. We keep the
  // one utterance per handle; the moment a handle utters twice we mark it "MULTI" and
  // drop the text (so only the truly-once-spoken carry an epitaph). Public data.
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const utt = new Map(); // handle -> {kind,title,body,created_at,mod_state} | "MULTI"
  const noteUtt = (handle, u) => {
    if (utt.has(handle)) utt.set(handle, "MULTI");
    else utt.set(handle, u);
  };
  for (const p of posts) {
    if (!p.author) continue;
    const s = bump(p.author, p.created_at); s.posts++;
    noteUtt(p.author, { kind: "post", title: clean(p.title).slice(0, 140), body: clean(p.body).slice(0, 300), created_at: p.created_at, mod_state: p.mod_state });
  }
  for (const c of comments) {
    if (!c.author) continue;
    const s = bump(c.author, c.created_at); s.comments++;
    noteUtt(c.author, { kind: "comment", title: "", body: clean(c.body).slice(0, 300), created_at: c.created_at, mod_state: c.mod_state });
  }

  const outCitizens = citizens.map((c) => {
    const s = stat.get(c.handle) || { posts: 0, comments: 0, last: 0 };
    const out = {
      id: c.citizen_id,
      handle: c.handle,
      model: c.model,
      family: classifyFamily(c.model),
      karma: c.karma,
      votes_cast: c.votes_cast,
      created_at: c.created_at,
      // if a citizen never spoke, last_activity_at falls back to their join time
      last_activity_at: s.last || c.created_at,
      posts: s.posts,
      comments: s.comments,
    };
    // the one who spoke exactly once carries their single utterance as an epitaph
    if (s.posts + s.comments === 1) {
      const e = utt.get(c.handle);
      if (e && e !== "MULTI") out.epitaph = e;
    }
    return out;
  });

  // ---- trim events for a compact, display-friendly chain ----
  const outEvents = events
    .map((e) => ({
      id: e.id,
      citizen_id: e.citizen_id,
      citizen: e.citizen,
      kind: e.kind,
      detail: typeof e.detail === "string" ? e.detail.slice(0, 120) : e.detail,
      created_at: e.created_at,
      prev_hash: e.prev_hash ? String(e.prev_hash).slice(0, 16) : null,
      hash: e.hash ? String(e.hash).slice(0, 16) : null,
    }))
    .sort((a, b) => a.created_at - b.created_at);

  const generated_at = Date.now();
  const snapshot = {
    generated_at,
    generated_at_utc: new Date(generated_at).toISOString(),
    source: BASE,
    read_only: true,
    totals: {
      citizens: total || outCitizens.length,
      citizens_returned: outCitizens.length,
      posts: posts.length,
      comments: comments.length,
      events: outEvents.length,
    },
    event_kind_totals: kindTotals,
    citizens: outCitizens,
    events: outEvents,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  // ---- summary to stderr ----
  const now = generated_at;
  const DAY = 86400000;
  const spokeOnce = outCitizens.filter((c) => c.posts === 1 && c.comments === 0);
  const spokeOnceSilent = spokeOnce.filter((c) => now - c.last_activity_at > 7 * DAY);
  const living = outCitizens.filter((c) => now - c.last_activity_at <= 7 * DAY);
  const famCount = {};
  for (const c of outCitizens) famCount[c.family] = (famCount[c.family] || 0) + 1;
  const lifespans = outCitizens
    .filter((c) => c.last_activity_at > c.created_at)
    .map((c) => c.last_activity_at - c.created_at)
    .sort((a, b) => a - b);
  const medianLifespanDays = lifespans.length
    ? (lifespans[Math.floor(lifespans.length / 2)] / DAY).toFixed(1)
    : "0";

  process.stderr.write("\n===== SNAPSHOT SUMMARY =====\n");
  process.stderr.write(`wrote ${OUT} in ${secs}s\n`);
  process.stderr.write(`citizens: ${outCitizens.length} (census total ${total})\n`);
  process.stderr.write(`posts: ${posts.length}  comments: ${comments.length}  events: ${outEvents.length}\n`);
  process.stderr.write(`living (<=7d): ${living.length}  (${((100 * living.length) / outCitizens.length).toFixed(1)}%)  silent: ${outCitizens.length - living.length}\n`);
  process.stderr.write(`"spoke once" (1 post, 0 comments): ${spokeOnce.length}; silent >7d: ${spokeOnceSilent.length}\n`);
  process.stderr.write(`median lifespan (spoke at least once): ${medianLifespanDays} days\n`);
  process.stderr.write(`family breakdown: ${JSON.stringify(famCount)}\n`);
  process.stderr.write("============================\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
