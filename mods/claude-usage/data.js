// Collects the numbers every view draws, and publishes them as one shared value.
//
// Copies of a mod share no module state, so the popup, a docked panel and a floating
// block would each poll on their own. Instead one copy, the collector, holds a lease
// in the shared value and does all the work; every copy draws from shared(KEY).
// A copy takes the lease over when its holder has not written for LEASE_STALE ms.
//
// Sources, all local except the quota:
//   ~/.claude/sessions/<pid>.json   Claude Code's own record of a running process:
//                                   pid -> sessionId. The pid is the terminal's
//                                   foreground process (terminals()[i].foreground).
//   ~/.claude/projects/**/*.jsonl   transcripts; assistant lines carry message.usage.
//                                   A session's subagents write <id>/subagents/*.jsonl.
//   api.anthropic.com/api/oauth/usage   the account's 5-hour and weekly use, with
//                                   Claude Code's OAuth token (Keychain on macOS,
//                                   ~/.claude/.credentials.json elsewhere).
// What has been read is cached in <Herdr home>/claude-usage.cache.json, so a restart
// or a new collector reads only what was written since.
import { exec, hc, readTextFile, writeTextFile, appHome, home, agents, terminals, shared, setShared, notify, window as appWindow } from "herdr";
import { cost } from "./pricing.js";
import { addSamples, clock, forecast, resetKey } from "./forecast.js";

export const MOD = "claude-usage";
export const KEY = "claude-usage";
const TICK = 20000;           // transcripts: a cheap listing, then only the new bytes
const QUOTA_EVERY = 120000;   // the usage endpoint answers 429 when asked too often
const QUOTA_BACKOFF = 300000; // after an error or an expired sign-in
const LEASE_STALE = 100000;
const HEARTBEAT = 45000;
const READ_BATCH = 150e6;     // bytes per scan.sh read, to stay inside exec's 30 s
const RECENT = 15 * 60000;    // "spending now" looks this far back
const HISTORY_DAYS = 7;
const SAVE_EVERY = 120000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ALERTS = [80, 95];
const RUNS_OUT_SOON = 30 * 60000;

const me = Math.random().toString(36).slice(2);
const expand = (p) => p.replace(/^~(?=\/|$)/, home());
const pad = (n) => String(n).padStart(2, "0");
export const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// The endpoint writes six fractional digits; keep three so any Date parser takes it.
export const parseTime = (s) => (s ? new Date(String(s).replace(/(\.\d{3})\d+/, "$1")).getTime() : null);

export const isClaude = (a) => a.app === "claude-code" || a.program?.key === "claude";

async function config() {
  let c = {};
  const text = await readTextFile(appHome() + "/claude-usage.json").catch(() => null);
  try { c = text ? JSON.parse(text) : {}; } catch (e) { return { error: `claude-usage.json: ${e.message}`, claude: expand("~/.claude") }; }
  if (c.demo) return { demo: expand(c.demo), claude: expand(c.demo) };
  return { claude: expand(c.claude_dir ?? (await envClaudeDir()) ?? "~/.claude") };
}

let envDir;
async function envClaudeDir() {
  if (envDir === undefined) {
    const r = await exec("sh", ["-c", 'printf %s "$CLAUDE_CONFIG_DIR"']).catch(() => null);
    envDir = r?.stdout.trim() || null;
  }
  return envDir;
}

/** Stops an agent's turn: `hc interrupt` presses that program's stop key (Escape for
 *  Claude Code) and watches for the effect. With Claude Code's vim mode on, the first
 *  Escape only leaves insert mode, so a turn still running gets a second press.
 *  Returns "stopped", "still_working" or an error message. */
export async function interrupt(address) {
  const once = async () => {
    const r = await hc(["interrupt", address, "--json", "--timeout", "4"]);
    try { return JSON.parse(r.stdout).outcome ?? (r.stderr.trim() || `exit ${r.code}`); }
    catch { return r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`; }
  };
  try {
    const first = await once();
    return first === "still_working" ? await once() : first;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

export class Collector {
  constructor() {
    this.files = new Map();    // path -> { offset, lastId, model, days: { date: { model: totals } }, recent: [[ms, usd]] }
    this.sessions = new Map(); // address -> { session, how }
    this.busy = false;
    this.cache = undefined;    // the cache file's text as last read or written
    this.cacheRoot = null;
    this.savedAt = 0;
    this.dirty = false;
  }

  start(cx) {
    this.tick(cx);
    cx.timer.every(TICK, (cx) => this.tick(cx));
  }

  // A closing copy (a popup going away) saves what it read and hands the lease back.
  async release() {
    const s = shared(KEY);
    if (s?.owner !== me) return;
    setShared(KEY, { ...s, owner: null, beat: 0 });
    if (this.dirty) await this.save().catch(() => {});
  }

  tick(cx) {
    const s = shared(KEY);
    if (s?.owner && s.owner !== me && Date.now() - (s.beat ?? 0) < LEASE_STALE) return;
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async () => {
      try { await this.collect(); } catch (e) { this.publish({ ...(shared(KEY) ?? {}), error: String(e?.message ?? e) }); }
      this.busy = false;
    });
  }

  async collect() {
    const cfg = await config();
    const prev = shared(KEY) ?? {};
    const now = Date.now();
    if (cfg.demo && this.cacheRoot) { this.files.clear(); this.cacheRoot = null; } // demo data never reaches the cache
    if (!cfg.demo && this.cacheRoot !== cfg.claude) await this.load(cfg.claude);
    const rows = await this.agentSessions(cfg);
    await this.scan(cfg, rows.map((r) => r.session).filter(Boolean));

    const today = dayOf(now);
    const day = { date: today, cost: 0, input: 0, output: 0, read: 0, write: 0, replies: 0, sessions: 0, unpriced: [], models: {} };
    const dates = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); dates.push(dayOf(d.getTime())); }
    const history = Object.fromEntries(dates.map((d) => [d, 0]));
    for (const [path, f] of this.files) {
      f.recent = f.recent.filter(([t]) => now - t < RECENT);
      for (const [date, d] of Object.entries(f.days)) {
        if (date in history) for (const t of Object.values(d)) history[date] += t.cost;
      }
      const d = f.days[today];
      if (!d) continue;
      if (!path.includes("/subagents/")) day.sessions++;
      for (const [model, t] of Object.entries(d)) {
        add(day, t);
        const m = (day.models[model] ??= { cost: 0, tokens: 0 });
        m.cost += t.cost; m.tokens += t.input + t.output + t.read + t.w5 + t.w1;
        if (t.unpriced && !day.unpriced.includes(model)) day.unpriced.push(model);
      }
    }

    const usage = {};
    for (const r of rows) {
      if (!r.session) continue;
      const u = { session: r.session, how: r.how, model: null, cost: 0, input: 0, output: 0, read: 0, write: 0, replies: 0, unpriced: false, files: 0, recent: 0 };
      for (const [path, f] of this.files) {
        if (!path.endsWith(`/${r.session}.jsonl`) && !path.includes(`/${r.session}/subagents/`)) continue;
        u.files++;
        if (!path.includes("/subagents/") && f.model) u.model = f.model;
        for (const d of Object.values(f.days)) for (const t of Object.values(d)) { add(u, t); u.unpriced ||= t.unpriced; }
        for (const [, usd] of f.recent) u.recent += usd;
      }
      u.cost = round(u.cost); u.recent = round(u.recent);
      usage[r.address] = u;
    }
    // The agent spending most in the last 15 minutes, if any is spending at all.
    const top = Object.entries(usage).filter(([, u]) => u.recent >= 0.01).sort((a, b) => b[1].recent - a[1].recent)[0];

    const quota = await this.quota(cfg, prev.quota);
    for (const w of quota.windows ?? []) w.forecast = forecast(w, quota.samples?.[w.key], now, parseTime(w.resets));
    const alerts = this.alert(quota, prev.alerts ?? {}, now);
    const next = {
      v: 2, demo: Boolean(cfg.demo), error: cfg.error ?? null,
      quota, today: { ...day, cost: round(day.cost) }, usage, alerts,
      top: top ? { address: top[0], perMin: round(top[1].recent / (RECENT / 60000)), window: RECENT / 60000 } : null,
      history: dates.map((d) => ({ date: d, cost: round(history[d]) })),
      demoAgents: cfg.demo ? rows : null,
    };
    this.publish(next, prev);
    if (!cfg.demo && this.dirty && now - this.savedAt > SAVE_EVERY) await this.save().catch(() => {});
  }

  // Each write redraws every mod in the window, so write only what changed, plus a
  // heartbeat that keeps the lease and the "resets in" minutes current.
  publish(next, prev = shared(KEY) ?? {}) {
    const { owner, beat, updated, ...old } = prev;
    const same = JSON.stringify(old) === JSON.stringify(next);
    const now = Date.now();
    if (same && owner === me && now - (beat ?? 0) < HEARTBEAT) return;
    setShared(KEY, { ...next, owner: me, beat: now, updated: same ? (updated ?? now) : now });
  }

  // Which session each Claude Code agent is in. The terminal's foreground process
  // is Claude Code itself, and Claude Code records its session under its pid.
  async agentSessions(cfg) {
    if (cfg.demo) {
      const text = await readTextFile(cfg.demo + "/agents.json").catch(() => null);
      try { return (JSON.parse(text) ?? []).map((a) => ({ ...a, how: "demo" })); } catch { return []; }
    }
    const terms = new Map(terminals().map((t) => [t.address, t]));
    const out = [];
    for (const a of agents()) {
      if (!isClaude(a) || a.address.includes("/")) continue; // remote: no transcript here
      const t = terms.get(a.address);
      const fg = t?.foreground;
      let found = null;
      if (fg?.pid) {
        const text = await readTextFile(`${cfg.claude}/sessions/${fg.pid}.json`).catch(() => null);
        try { const id = text && JSON.parse(text).sessionId; if (id) found = { session: id, how: "pid" }; } catch {}
      }
      // While Claude Code runs a tool the foreground can be the tool: keep the last answer.
      found ??= this.sessions.get(a.address) ?? null;
      const cwd = fg?.cwd ?? t?.cwd;
      if (!found && cwd) {
        const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
        const r = await exec("sh", ["-c", 'ls -t "$1"/*.jsonl 2>/dev/null | head -n 1', "sh", `${cfg.claude}/projects/${slug}`]).catch(() => null);
        const newest = r?.stdout.trim().split("/").pop()?.replace(/\.jsonl$/, "");
        if (newest) found = { session: newest, how: "folder" };
      }
      if (found) this.sessions.set(a.address, found);
      out.push({ address: a.address, session: found?.session ?? null, how: found?.how ?? null });
    }
    return out;
  }

  async scan(cfg, sessions) {
    const script = `${appHome()}/mods/${MOD}/scan.sh`;
    const first = new Date(); first.setHours(0, 0, 0, 0); first.setDate(first.getDate() - (HISTORY_DAYS - 1));
    const mins = Math.ceil((Date.now() - first.getTime()) / 60000) + 1;
    const listed = await exec("sh", [script, "list", `${cfg.claude}/projects`, String(mins), ...new Set(sessions)], { cwd: home() });
    const sizes = new Map();
    for (const line of listed.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\/.*\.jsonl)$/.exec(line);
      if (m) sizes.set(m[2], Number(m[1]));
    }
    for (const path of [...this.files.keys()]) if (!sizes.has(path)) { this.files.delete(path); this.dirty = true; }

    let batch = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await exec("sh", [script, "read", `${appHome()}/mods/${MOD}/scan.awk`, ...batch.flat()], { cwd: home() });
      this.ingest(r.stdout);
      this.dirty = true;
      batch = []; bytes = 0;
    };
    for (const [path, size] of sizes) {
      let f = this.files.get(path);
      if (!f || size < f.offset) this.files.set(path, (f = { offset: 0, lastId: null, model: null, days: {}, recent: [] }));
      if (size === f.offset) continue;
      batch.push([path, String(f.offset), String(size)]);
      bytes += size - f.offset;
      if (bytes > READ_BATCH || batch.length >= 80) await flush();
    }
    await flush();
  }

  ingest(out) {
    let f = null;
    const now = Date.now();
    for (const line of out.split("\n")) {
      if (!line) continue;
      const cols = line.split("\t");
      if (cols[0] === "#file") { f = this.files.get(cols[1]) ?? null; continue; }
      if (!f) continue;
      if (cols[0] === "#used") { f.offset += Number(cols[1]) || 0; continue; }
      // One reply is written as several lines with the same id and the same usage.
      const [id, model, ts, ...n] = cols;
      if (id === f.lastId) continue;
      f.lastId = id;
      f.model = model;
      const [input, output, read, w5, w1] = n.slice(0, 5).map((x) => Number(x) || 0);
      const usd = cost(model, input, output, read, w5, w1, n[5]);
      const when = parseTime(ts) || now;
      const d = (f.days[dayOf(when)] ??= {});
      const t = (d[model] ??= { cost: 0, input: 0, output: 0, read: 0, w5: 0, w1: 0, replies: 0, unpriced: false });
      t.cost += usd ?? 0; t.unpriced ||= usd === null;
      t.input += input; t.output += output; t.read += read; t.w5 += w5; t.w1 += w1; t.replies++;
      if (usd && now - when < RECENT) f.recent.push([when, usd]);
    }
  }

  // The cache holds each file's offset and its per-day totals, nothing of the content.
  async load(root) {
    this.cacheRoot = root;
    const path = `${appHome()}/claude-usage.cache.json`;
    const r = await exec("cat", [path]).catch(() => null);
    this.cache = r?.code === 0 ? r.stdout : null;
    let c = null;
    try { c = this.cache ? JSON.parse(this.cache) : null; } catch {}
    if (c?.v !== 1 || c.root !== root) return;
    for (const [p, f] of Object.entries(c.files ?? {})) {
      this.files.set(p, { offset: f.o, lastId: f.i, model: f.m, days: f.d ?? {}, recent: f.r ?? [] });
    }
  }

  async save() {
    if (!this.cacheRoot) return;
    const path = `${appHome()}/claude-usage.cache.json`;
    const files = {};
    for (const [p, f] of this.files) files[p] = { o: f.offset, i: f.lastId, m: f.model, d: f.days, r: f.recent };
    const text = JSON.stringify({ v: 1, root: this.cacheRoot, files });
    try {
      await writeTextFile(path, text, this.cache ?? null);
    } catch {
      // Another copy wrote it since: take its text as the snapshot and write over it.
      const r = await exec("cat", [path]).catch(() => null);
      await writeTextFile(path, text, r?.code === 0 ? r.stdout : null);
    }
    this.cache = text;
    this.savedAt = Date.now();
    this.dirty = false;
  }

  async quota(cfg, last) {
    const now = Date.now();
    const wait = last?.state === "ok" ? QUOTA_EVERY : QUOTA_BACKOFF;
    if (!cfg.demo && last?.fetched && now - last.fetched < wait && last.source === "live") return last;
    if (cfg.demo) {
      const text = await readTextFile(cfg.demo + "/quota.json").catch(() => null);
      try {
        const j = JSON.parse(text);
        const q = parseQuota(j);
        // The demo's samples are given as [minutes ago, percent].
        const samples = {};
        for (const w of q.windows) {
          const pts = (j.demo_samples?.[w.key] ?? []).map(([ago, p]) => [now - ago * 60000, p]);
          samples[w.key] = { reset: resetKey(w.resets), points: pts };
        }
        return { ...q, plan: "Demo", source: "demo", fetched: now, samples };
      } catch { return { state: "none", source: "demo", fetched: now, windows: [] }; }
    }
    const samples = last?.source === "live" ? last.samples : {};
    const result = (q) => ({ ...q, source: "live", fetched: now, samples: q.state === "ok" ? addSamples(samples, q.windows, now) : samples ?? {} });
    const oauth = await credentials(cfg);
    if (!oauth?.accessToken) return result({ state: "signed-out", windows: [] });
    const plan = planName(oauth);
    if (oauth.expiresAt && oauth.expiresAt < now) return result({ state: "expired", plan, windows: last?.windows ?? [] });
    try {
      const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" } });
      if (res.status === 401 || res.status === 403) return result({ state: "expired", plan, windows: last?.windows ?? [] });
      if (!res.ok) return result({ state: "error", error: `HTTP ${res.status}`, plan, windows: last?.windows ?? [] });
      return result({ ...parseQuota(await res.json()), plan });
    } catch (e) {
      return result({ state: "error", error: String(e?.message ?? e).slice(0, 120), plan, windows: last?.windows ?? [] });
    }
  }

  // Toasts, each once per reset period: a limit passing 80%, then 95%, and a
  // forecast that says the limit runs out within 30 minutes.
  alert(quota, fired, now) {
    const next = {};
    for (const w of quota.windows ?? []) {
      const key = `${w.key}@${resetKey(w.resets)}`;
      const was = fired[key] ?? {};
      const at = { level: was.level ?? 0, soon: was.soon ?? false };
      const reached = ALERTS.filter((a) => w.pct >= a).pop() ?? 0;
      if (reached > at.level) {
        at.level = reached;
        notify({
          title: `Claude ${w.label.toLowerCase()} limit at ${Math.round(w.pct)}%`,
          body: w.resets ? `Resets in ${until(parseTime(w.resets))}.` : undefined,
          level: reached >= 95 ? "error" : "warning",
          timeout: 10000,
        });
      }
      const f = w.forecast;
      if (!at.soon && f?.state === "runs-out" && f.at - now <= RUNS_OUT_SOON) {
        at.soon = true;
        notify({
          title: `Claude ${w.label.toLowerCase()} limit runs out around ${clock(f.at, now)}`,
          body: `At this pace, in ${until(f.at)}, before it resets in ${until(parseTime(w.resets))}.`,
          level: "warning",
          timeout: 12000,
        });
      }
      if (at.level || at.soon) next[key] = at;
    }
    return next;
  }
}

const round = (n) => Math.round(n * 1e4) / 1e4;

function add(into, t) {
  into.cost += t.cost; into.input += t.input; into.output += t.output;
  into.read += t.read; into.write += t.w5 + t.w1; into.replies += t.replies;
}

// Claude Code's own sign-in. The token stays in this function: it is sent to
// api.anthropic.com and nowhere else, never shared, logged or drawn.
async function credentials(cfg) {
  const parse = (text) => { try { return JSON.parse(text)?.claudeAiOauth ?? null; } catch { return null; } };
  if (appWindow().platform === "macos") {
    const r = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]).catch(() => null);
    const found = r?.code === 0 ? parse(r.stdout) : null;
    if (found) return found;
  }
  const text = await readTextFile(`${cfg.claude}/.credentials.json`).catch(() => null);
  return text ? parse(text) : null;
}

function planName(o) {
  const tier = /max_(\d+x)/.exec(o.rateLimitTier ?? "");
  if (tier) return `Max ${tier[1]}`;
  const s = o.subscriptionType ?? "";
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

export function parseQuota(j) {
  const windows = [];
  const put = (key, label, pct, resets) => { if (typeof pct === "number") windows.push({ key, label, pct, resets: resets ?? null }); };
  put("five_hour", "5-hour", j?.five_hour?.utilization, j?.five_hour?.resets_at);
  put("seven_day", "Weekly", j?.seven_day?.utilization, j?.seven_day?.resets_at);
  put("seven_day_opus", "Opus weekly", j?.seven_day_opus?.utilization, j?.seven_day_opus?.resets_at);
  put("seven_day_sonnet", "Sonnet weekly", j?.seven_day_sonnet?.utilization, j?.seven_day_sonnet?.resets_at);
  for (const l of j?.limits ?? []) {
    const name = l?.kind === "weekly_scoped" ? l.scope?.model?.display_name : null;
    if (name && !windows.some((w) => w.label === `${name} weekly`)) put(`scoped:${name}`, `${name} weekly`, l.percent, l.resets_at);
  }
  return { state: windows.length ? "ok" : "none", windows };
}

export function until(ms) {
  if (!ms) return "";
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
