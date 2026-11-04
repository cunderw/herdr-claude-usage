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
import { exec, readTextFile, appHome, home, agents, terminals, shared, setShared, notify, window as appWindow } from "herdr";
import { cost } from "./pricing.js";

export const MOD = "claude-usage";
export const KEY = "claude-usage";
const TICK = 20000;           // transcripts: a cheap listing, then only the new bytes
const QUOTA_EVERY = 90000;    // the usage endpoint, never faster than once a minute
const QUOTA_BACKOFF = 300000; // after an error or an expired sign-in
const LEASE_STALE = 100000;
const HEARTBEAT = 45000;
const READ_BATCH = 150e6;     // bytes per scan.sh read, to stay inside exec's 30 s
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ALERTS = [80, 95];

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

export class Collector {
  constructor() {
    this.files = new Map();    // path -> { offset, lastId, model, days: { date: { model: totals } } }
    this.sessions = new Map(); // address -> { session, how }
    this.busy = false;
  }

  start(cx) {
    this.tick(cx);
    cx.timer.every(TICK, (cx) => this.tick(cx));
  }

  // A closing copy (a popup going away) hands the lease back at once.
  release() {
    const s = shared(KEY);
    if (s?.owner === me) setShared(KEY, { ...s, owner: null, beat: 0 });
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
    const rows = await this.agentSessions(cfg);
    await this.scan(cfg, rows.map((r) => r.session).filter(Boolean));

    const today = dayOf(Date.now());
    const day = { date: today, cost: 0, input: 0, output: 0, read: 0, write: 0, replies: 0, sessions: 0, unpriced: [], models: {} };
    for (const [path, f] of this.files) {
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
      const u = { session: r.session, how: r.how, model: null, cost: 0, input: 0, output: 0, read: 0, write: 0, replies: 0, unpriced: false, files: 0, last: 0 };
      for (const [path, f] of this.files) {
        if (!path.endsWith(`/${r.session}.jsonl`) && !path.includes(`/${r.session}/subagents/`)) continue;
        u.files++;
        if (!path.includes("/subagents/") && f.model) u.model = f.model;
        for (const d of Object.values(f.days)) for (const t of Object.values(d)) { add(u, t); u.unpriced ||= t.unpriced; }
      }
      usage[r.address] = u;
    }

    const quota = await this.quota(cfg, prev.quota);
    const alerts = this.alert(quota, prev.alerts ?? {});
    const next = {
      v: 1, demo: Boolean(cfg.demo), error: cfg.error ?? null,
      quota, today: day, usage, alerts,
      demoAgents: cfg.demo ? rows : null,
    };
    this.publish(next, prev);
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
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const mins = Math.ceil((Date.now() - midnight.getTime()) / 60000) + 1;
    const listed = await exec("sh", [script, "list", `${cfg.claude}/projects`, String(mins), ...new Set(sessions)], { cwd: home() });
    const sizes = new Map();
    for (const line of listed.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\/.*\.jsonl)$/.exec(line);
      if (m) sizes.set(m[2], Number(m[1]));
    }
    for (const path of [...this.files.keys()]) if (!sizes.has(path)) this.files.delete(path);

    let batch = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await exec("sh", [script, "read", `${appHome()}/mods/${MOD}/scan.awk`, ...batch.flat()], { cwd: home() });
      this.ingest(r.stdout);
      batch = []; bytes = 0;
    };
    for (const [path, size] of sizes) {
      let f = this.files.get(path);
      if (!f || size < f.offset) this.files.set(path, (f = { offset: 0, lastId: null, model: null, days: {} }));
      if (size === f.offset) continue;
      batch.push([path, String(f.offset), String(size)]);
      bytes += size - f.offset;
      if (bytes > READ_BATCH || batch.length >= 80) await flush();
    }
    await flush();
  }

  ingest(out) {
    let f = null;
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
      const when = parseTime(ts) || Date.now();
      const d = (f.days[dayOf(when)] ??= {});
      const t = (d[model] ??= { cost: 0, input: 0, output: 0, read: 0, w5: 0, w1: 0, replies: 0, unpriced: false });
      t.cost += usd ?? 0; t.unpriced ||= usd === null;
      t.input += input; t.output += output; t.read += read; t.w5 += w5; t.w1 += w1; t.replies++;
    }
  }

  async quota(cfg, last) {
    const now = Date.now();
    const wait = last?.state === "ok" ? QUOTA_EVERY : QUOTA_BACKOFF;
    if (!cfg.demo && last?.fetched && now - last.fetched < wait && last.source === "live") return last;
    if (cfg.demo) {
      const text = await readTextFile(cfg.demo + "/quota.json").catch(() => null);
      try { return { ...parseQuota(JSON.parse(text)), plan: "Demo", source: "demo", fetched: now }; }
      catch { return { state: "none", source: "demo", fetched: now }; }
    }
    const result = (q) => ({ ...q, source: "live", fetched: now });
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

  // A toast once when a window passes 80% and once at 95%, per reset period.
  alert(quota, fired) {
    const next = {};
    for (const w of quota.windows ?? []) {
      const key = `${w.key}@${w.resets}`;
      let level = fired[key] ?? 0;
      const reached = ALERTS.filter((a) => w.pct >= a).pop() ?? 0;
      if (reached > level) {
        level = reached;
        notify({
          title: `Claude ${w.label.toLowerCase()} limit at ${Math.round(w.pct)}%`,
          body: w.resets ? `Resets in ${until(parseTime(w.resets))}.` : undefined,
          level: reached >= 95 ? "error" : "warning",
          timeout: 10000,
        });
      }
      if (level) next[key] = level;
    }
    return next;
  }
}

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
