// Drawing. Everything here reads shared(KEY) and the live agents(); nothing polls.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, run, shared, theme, closeOverlay } from "herdr";
import { KEY, MOD, isClaude, parseTime, until } from "./data.js";
import { AS_OF, modelName } from "./pricing.js";

const ICON = (name) => `mods/${MOD}/${name}.svg`;

export function tokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export function usd(n) {
  if (n == null) return "–";
  if (n > 0 && n < 0.01) return "<$0.01";
  const [whole, cents] = n.toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

export function level(pct, t) {
  return pct >= 95 ? t.ansi1 : pct >= 80 ? t.ansi3 : t.ansi2;
}

// The Claude agents to list: Herdr's live ones (demo: the demo file's), each with
// its session's usage when it was found.
export function agentRows(s) {
  const usage = s?.usage ?? {};
  if (s?.demoAgents) {
    const program = agents().find(isClaude)?.program ?? null;
    return s.demoAgents.map((a) => ({ ...a, program, usage: usage[a.address] ?? null, demo: true }));
  }
  return agents().filter(isClaude).map((a) => ({
    address: a.address, title: a.title, space_name: a.space_name, tab_name: a.tab_name,
    status: a.status, program: a.program, focused: a.focused,
    usage: usage[a.address] ?? null, remote: a.address.includes("/"),
  }));
}

function status(a, t) {
  if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (a.status === "blocked") return div().size(8).mx(3).flex_none().rounded(4).bg(t.blocked);
  if (a.status === "done") return div().size(8).mx(3).flex_none().rounded(4).bg(t.done);
  return div().size(8).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
}

function programIcon(a, t) {
  const p = a.program;
  if (p?.icon) return p.tint ? svg(p.icon).size(15).flex_none().text_color(t.muted) : image(p.icon).w(15).h(15).flex_none();
  return svg(ICON("sparkle")).size(15).flex_none().text_color(t.ansi3);
}

export function focusAgent(a, overlay) {
  if (a.demo || a.remote) return;
  if (overlay) closeOverlay(overlay);
  run("agent.focus", { terminal: a.address });
}

function bar(id, pct, t, h = 6) {
  const p = Math.max(0, Math.min(100, pct));
  return div().id(id).h(h).w_full().rounded(h / 2).bg(t.border).overflow_hidden().child(
    div().id(`${id}-fill`).h_full().w(`${p}%`).rounded(h / 2).bg(level(p, t))
      .transition("width", { duration: 450, easing: "ease-out" }));
}

function quotaNote(q, t) {
  const say = {
    "signed-out": "Account limits need Claude Code's sign-in (claude /login). Per-agent usage still works.",
    expired: "Claude Code's sign-in has expired. It renews on Claude Code's next request.",
    error: `Couldn't read account limits${q?.error ? ` (${q.error})` : ""}. Trying again in a few minutes.`,
    none: "This account reports no usage limits.",
  }[q?.state];
  return say ? div().text_size(11.5).text_color(t.dim).child(say) : null;
}

function quotaRows(q, t, wide) {
  const rows = (q?.windows ?? []).map((w) => {
    const color = level(w.pct, t);
    const resets = w.resets ? `resets in ${until(parseTime(w.resets))}` : "";
    if (wide) {
      return h_flex().gap(12).items_center().h(22)
        .child(div().w(104).flex_none().text_size(12.5).text_color(t.muted).child(w.label))
        .child(div().flex_1().child(bar(`q-${w.key}`, w.pct, t, 8)))
        .child(div().w(44).flex_none().text_right().text_size(13).font_semibold().text_color(color).child(`${Math.round(w.pct)}%`))
        .child(div().w(130).flex_none().text_size(11.5).text_color(t.dim).child(resets));
    }
    return v_flex().gap(4)
      .child(h_flex().items_center().gap(6).text_size(12)
        .child(div().flex_1().text_color(t.muted).child(w.label))
        .child(div().text_size(11).text_color(t.dim).child(resets))
        .child(div().w(36).text_right().font_semibold().text_color(color).child(`${Math.round(w.pct)}%`)))
      .child(bar(`q-${w.key}`, w.pct, t, 6));
  });
  const note = quotaNote(q, t);
  return note && q?.state !== "ok" ? [...rows, note] : rows;
}

function section(label, t, right) {
  return h_flex().items_center().pt(4)
    .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.dim).child(label.toUpperCase()))
    .when(Boolean(right), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(right)));
}

function today(s, t, wide) {
  const d = s?.today;
  if (!d) return div().text_size(12).text_color(t.dim).child("Reading transcripts…");
  const models = Object.entries(d.models ?? {}).sort((a, b) => b[1].cost - a[1].cost);
  const top = models[0]?.[1].cost || 1;
  const line = (label, n) => h_flex().gap(4).child(div().text_color(t.dim).child(label)).child(div().text_color(t.muted).child(tokens(n)));
  return v_flex().gap(wide ? 8 : 6)
    .child(h_flex().items_end().gap(10)
      .child(div().text_size(wide ? 26 : 20).font_semibold().text_color(t.foreground).child(usd(d.cost)))
      .child(div().pb(wide ? 4 : 2).text_size(11.5).text_color(t.dim).child(`${d.sessions} session${d.sessions === 1 ? "" : "s"} · ${tokens(d.replies)} replies`)))
    .child(h_flex().flex_wrap().gap_x(12).gap_y(2).text_size(11.5)
      .child(line("in", d.input)).child(line("out", d.output))
      .child(line("cache read", d.read)).child(line("cache write", d.write)))
    .when(models.length > 0, (el) => el.child(v_flex().gap(4).children(models.slice(0, wide ? 4 : 3).map(([m, v]) =>
      h_flex().items_center().gap(8).text_size(11.5)
        .child(div().w(wide ? 84 : 72).flex_none().truncate().text_color(t.muted).child(modelName(m)))
        .child(div().flex_1().h(4).rounded(2).bg(t.border).child(div().h_full().rounded(2).w(`${Math.max(2, (v.cost / top) * 100)}%`).bg(t.accent)))
        .child(div().w(wide ? 74 : 64).flex_none().text_right().text_color(t.muted).child(usd(v.cost)))))));
}

function agentDetail(u) {
  if (!u) return null;
  const model = u.model ? `${modelName(u.model)} · ` : "";
  return `${model}in ${tokens(u.input)} · out ${tokens(u.output)} · cache ${tokens(u.read)} read, ${tokens(u.write)} write`;
}

function agentRow(a, t, wide, overlay) {
  const u = a.usage;
  const where = [a.space_name, a.tab_name].filter(Boolean).join(" / ");
  const sub = a.remote ? "on another machine: no local transcript"
    : u ? agentDetail(u) : "session not found yet";
  const price = u ? (u.unpriced ? `${usd(u.cost)}+` : usd(u.cost)) : "";
  return h_flex().id(`agent-${a.address}`).gap(8).px(8).py(wide ? 6 : 5).rounded(7).items_start()
    .when(a.focused, (el) => el.bg(t.selected))
    .when(!a.demo && !a.remote, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
    .on_click(() => focusAgent(a, overlay))
    .child(h_flex().pt(2).gap(6).items_center().flex_none().child(status(a, t)).child(programIcon(a, t)))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).child(a.title || a.address))
        .when(wide && Boolean(where), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(where))))
      .child(div().truncate().text_size(11).text_color(u?.how === "folder" ? t.ansi3 : t.dim).child((u?.how === "folder" ? "≈ " : "") + sub)))
    .child(div().flex_none().pt(1).text_size(13).font_medium().text_color(t.foreground).child(price));
}

function header(s, t) {
  const plan = s?.quota?.plan;
  const when = s?.beat ? `updated ${ago(s.beat)}` : "starting…";
  return h_flex().items_center().gap(8)
    .child(svg(ICON("gauge")).size(16).flex_none().text_color(t.accent))
    .child(div().flex_1().text_size(14).font_semibold().text_color(t.foreground).child("Claude usage"))
    .when(Boolean(plan), (el) => el.child(div().px(6).py(1).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).child(plan)))
    .child(div().text_size(11).text_color(t.dim).child(when));
}

const footnote = (t) => div().text_size(10.5).text_color(t.dim)
  .child(`Costs are estimates at API list prices (${AS_OF}); a subscription is not billed per token.`);

/** The popup: everything, wide. */
export function popup(overlay) {
  const t = theme();
  const s = shared(KEY);
  const rows = agentRows(s);
  const total = rows.reduce((n, a) => n + (a.usage?.cost ?? 0), 0);
  return v_flex().id("root").size_full().bg(t.popover).p(16).gap(12)
    .child(header(s, t))
    .child(v_flex().gap(6).children(quotaRows(s?.quota, t, true)))
    .child(div().h(1).bg(t.border))
    .child(section("Today, every Claude Code session", t))
    .child(today(s, t, true))
    .child(div().h(1).bg(t.border))
    .child(section(`Agents in Herdr (${rows.length})`, t, rows.length ? `${usd(total)} across their sessions` : ""))
    .child(v_flex().id("agents").max_h(380).overflow_y_scrollbar().gap(1).children(
      rows.length ? rows.map((a) => agentRow(a, t, true, overlay))
        : [div().px(8).text_size(12).text_color(t.dim).child("No Claude Code agents are running in Herdr.")]))
    .child(footnote(t))
    .when(Boolean(s?.error), (el) => el.child(div().text_size(11).text_color(t.ansi1).child(s.error)));
}

/** The panel: a pane or a layout block, narrow and tall. */
export function panel() {
  const t = theme();
  const s = shared(KEY);
  const rows = agentRows(s);
  return v_flex().id("root").size_full().bg(t.surface).p(12).gap(10)
    .child(header(s, t))
    .child(v_flex().gap(8).children(quotaRows(s?.quota, t, false)))
    .child(section("Today", t))
    .child(today(s, t, false))
    .child(section(`Agents (${rows.length})`, t))
    .child(v_flex().id("agents").flex_1().min_h(0).overflow_y_scrollbar().gap(1).children(
      rows.length ? rows.map((a) => agentRow(a, t, false, null))
        : [div().px(8).text_size(12).text_color(t.dim).child("No Claude Code agents running.")]))
    .child(footnote(t));
}

/** A floating block in a layout: the limits as rows whose percentage sits on the
 *  window-edge side, so a `peek` drawer shows them while closed. */
export function drawer(place) {
  const t = theme();
  const s = shared(KEY);
  const right = place.edge === "right";
  const row = (id, big, color, label, extra) => h_flex().id(id).w(232).gap(10).items_center().px(10).py(5)
    .when(right, (el) => el.flex_row_reverse())
    .child(div().w(36).flex_none().text_size(14).font_semibold().text_color(color).when(right, (el) => el.text_right()).child(big))
    .child(v_flex().flex_1().gap(3).child(div().text_size(11).text_color(t.muted).child(label)).when(Boolean(extra), (el) => el.child(extra)));
  const windows = (s?.quota?.windows ?? []).map((w) =>
    row(`d-${w.key}`, `${Math.round(w.pct)}`, level(w.pct, t), `${w.label} · ${until(parseTime(w.resets))}`, bar(`dq-${w.key}`, w.pct, t, 4)));
  const top = agentRows(s).filter((a) => a.usage).sort((a, b) => b.usage.cost - a.usage.cost).slice(0, 4);
  return v_flex().id("root").py(2)
    .children(windows)
    .child(row("d-today", "$", t.accent, `Today ${usd(s?.today?.cost)}`, null))
    .children(top.map((a) => h_flex().id(`d-agent-${a.address}`).w(232).px(10).py(3).gap(8).items_center()
      .when(right, (el) => el.flex_row_reverse())
      .when(!a.demo && !a.remote, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)))
      .on_click(() => focusAgent(a, null))
      .child(h_flex().w(36).flex_none().justify_center().child(status(a, t)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(a.title || a.address))
      .child(div().flex_none().text_size(11.5).text_color(t.foreground).child(usd(a.usage.cost)))));
}
