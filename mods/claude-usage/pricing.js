// Estimated prices, US dollars per million tokens, from Anthropic's published API
// rates as of 2026-10. Claude Code on a subscription is not billed per token: these
// say what the same tokens would cost on the API. Edit this table when prices change.
//
//   [prefix, input, output, cache read]
// Cache writes are 1.25x input for the 5-minute cache and 2x for the 1-hour cache.
// Fast mode (usage.speed "fast") costs 2x. The longest matching prefix wins.
export const AS_OF = "2026-10";

const TABLE = [
  ["claude-fable-5-1", 10, 50, 0.25],
  ["claude-mythos-5-1", 10, 50, 0.25],
  ["claude-fable-5", 10, 50, 1],
  ["claude-mythos-5", 10, 50, 1],
  ["claude-opus-5-5", 4, 20, 0.2],
  ["claude-opus-5", 5, 25, 0.5],
  ["claude-opus-4-8", 5, 25, 0.5],
  ["claude-opus-4-7", 5, 25, 0.5],
  ["claude-opus-4-6", 5, 25, 0.5],
  ["claude-opus-4-5", 5, 25, 0.5],
  ["claude-opus-4", 15, 75, 1.5],
  ["claude-sonnet-5", 2, 10, 0.2],
  ["claude-sonnet-4", 3, 15, 0.3],
  ["claude-3-7-sonnet", 3, 15, 0.3],
  ["claude-haiku-5-5", 0.1, 0.5, 0.01],
  ["claude-haiku-4-5", 1, 5, 0.1],
  ["claude-3-5-haiku", 0.8, 4, 0.08],
].sort((a, b) => b[0].length - a[0].length);

// Claude Haiku 5.5 bills a prompt over 100K tokens at a second rate card.
const LONG_PROMPT = { "claude-haiku-5-5": [100000, 0.5, 2.5, 0.05] };

const cache = new Map();
function rates(model) {
  if (!cache.has(model)) cache.set(model, TABLE.find((r) => model.startsWith(r[0])) ?? null);
  return cache.get(model);
}

/** Dollars for one assistant message, or null when the model is not in the table. */
export function cost(model, input, output, cacheRead, write5m, write1h, speed) {
  const r = rates(model);
  if (!r) return null;
  let [, pin, pout, pread] = r;
  const long = LONG_PROMPT[r[0]];
  if (long && input + cacheRead + write5m + write1h > long[0]) [, pin, pout, pread] = long;
  const usd = (input * pin + output * pout + cacheRead * pread + write5m * pin * 1.25 + write1h * pin * 2) / 1e6;
  return speed === "fast" ? usd * 2 : usd;
}

/** "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-4-5-20250929" -> "Sonnet 4.5". */
export function modelName(model) {
  if (!model) return "";
  const parts = model.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  const words = parts.filter((p) => !/^\d+$/.test(p));
  const nums = parts.filter((p) => /^\d+$/.test(p));
  if (!words.length) return model;
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  return nums.length ? `${name} ${nums.join(".")}` : name;
}
