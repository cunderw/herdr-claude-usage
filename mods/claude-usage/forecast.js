// When a limit runs out at the current pace.
//
// The usage endpoint gives a whole-number percentage and a reset time, nothing
// about rate. So every fetch is kept as a (time, percent) sample in the shared
// state, and the burn rate is the least-squares slope of the recent samples.
// Whole percentages are coarse: with too few samples, or too short a span, the
// slope is noise, so no forecast is given until there is enough to go on.

const MIN = 60000;

// How far back each window looks, and how much it needs before it says anything.
const RULES = {
  five_hour: { look: 30 * MIN, span: 15 * MIN, samples: 6 },
  default: { look: 3 * 60 * MIN, span: 45 * MIN, samples: 6 },
};
const KEEP = 3 * 60 * MIN + 5 * MIN;

// The endpoint writes the same reset time with different microseconds on every
// call; a window is the same window while its reset minute is.
export const resetKey = (resets) => String(resets ?? "").slice(0, 16);

/** Adds a fetch's percentages to the samples. A window that reset, or went down,
 *  starts over. Returns new samples: { [key]: { reset, points: [[ms, pct]] } }. */
export function addSamples(samples, windows, now) {
  const next = {};
  for (const w of windows) {
    const old = samples?.[w.key];
    let points = old && old.reset === resetKey(w.resets) ? old.points.filter(([t]) => now - t < KEEP) : [];
    const last = points[points.length - 1];
    if (last && w.pct < last[1] - 0.5) points = [];
    if (!last || now - last[0] > 30000) points = [...points, [now, w.pct]];
    next[w.key] = { reset: resetKey(w.resets), points };
  }
  return next;
}

/** { state: "gathering" | "steady" | "reset-first" | "runs-out" | "at-limit", at?, perHour?, need? } */
export function forecast(w, sample, now, resetsAt) {
  if (w.pct >= 100) return { state: "at-limit" };
  const rule = RULES[w.key] ?? RULES.default;
  const points = (sample?.points ?? []).filter(([t]) => now - t <= rule.look);
  const span = points.length ? points[points.length - 1][0] - points[0][0] : 0;
  if (points.length < rule.samples || span < rule.span) {
    return { state: "gathering", need: Math.max(1, Math.ceil((rule.span - span) / MIN)) };
  }
  const n = points.length;
  const mx = points.reduce((s, [t]) => s + t, 0) / n;
  const my = points.reduce((s, [, p]) => s + p, 0) / n;
  let num = 0, den = 0;
  for (const [t, p] of points) { num += (t - mx) * (p - my); den += (t - mx) * (t - mx); }
  const slope = den ? num / den : 0; // percent per ms
  const perHour = slope * 60 * MIN;
  if (slope <= 0) return { state: "steady", perHour: 0 };
  const at = now + (100 - w.pct) / slope;
  if (resetsAt && at >= resetsAt) return { state: "reset-first", perHour };
  return { state: "runs-out", at, perHour };
}

const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "3:40 pm", or "Sat 3:40 pm" when it isn't today. */
export function clock(ms, now = Date.now()) {
  const d = new Date(ms);
  const h = d.getHours();
  const time = `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? "am" : "pm"}`;
  return new Date(now).toDateString() === d.toDateString() ? time : `${DAYS[d.getDay()]} ${time}`;
}
