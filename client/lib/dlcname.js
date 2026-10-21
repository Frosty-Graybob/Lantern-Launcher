// Tidies a DLC name read from an installer file when Steam has no title for it:
// takes the game's own title off the front and drops trailing store clutter.
const words = (s) => String(s || "").split(/\s+/).filter(Boolean);
const key = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

function tidyDlcName(name, baseNames) {
  const original = String(name || "").trim();
  let w = words(original);
  if (w.length < 2) return original;

  // Leading words that are a run of the game's title ("Dying Light", "4 Special Edition").
  let best = 0;
  for (const base of baseNames || []) {
    const b = words(base).map(key);
    for (let start = 0; start < b.length; start++) {
      let n = 0;
      while (n < w.length && start + n < b.length && key(w[n]) && key(w[n]) === b[start + n]) n++;
      if (n > best) best = n;
    }
  }
  if (best) {
    const rest = w.slice(best);
    const text = rest.join(" ");
    // keep the full name if little would be left ("Dying Light 2" -> "2")
    if (rest.length && text.length >= 3 && !/^[\d\s.]+$/.test(text)) w = rest;
  }

  // Trailing clutter: "GOG", versions like "v7", and a bare "DLC".
  while (w.length > 1 && /^(gog|dlc|v\d+(\.\d+)*)$/i.test(w[w.length - 1])) w.pop();
  // Leading stray "a"/"s" fragments left by file names are left alone on purpose.
  const out = w.join(" ").trim();
  return out.length >= 3 ? out : original;
}

module.exports = { tidyDlcName };
