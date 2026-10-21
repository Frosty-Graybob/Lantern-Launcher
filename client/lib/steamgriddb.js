const fs = require("fs");
const path = require("path");
const http = require("./http");

const API_BASE = "https://www.steamgriddb.com/api/v2";
const auth = (apiKey) => ({ Authorization: `Bearer ${apiKey}` });

// SteamGridDB's id for a game, from a name search (its best match comes first).
async function searchGame(name, apiKey, getJson = http.getJson) {
  const result = await getJson(`${API_BASE}/search/autocomplete/${encodeURIComponent(name)}`, {
    headers: auth(apiKey),
  });
  const match = result && result.data && result.data[0];
  return match && match.id ? match.id : null;
}

// SteamGridDB's id for a game, from its Steam app id. This is what keeps the artwork
// on the same game the player picked on the Steam side. Null if SteamGridDB has none.
async function gameIdFromSteam(steamAppId, apiKey, getJson = http.getJson) {
  const res = await getJson(`${API_BASE}/games/steam/${encodeURIComponent(steamAppId)}`, { headers: auth(apiKey) });
  const d = res && res.data;
  const g = Array.isArray(d) ? d[0] : d;
  return g && Number.isInteger(g.id) ? g.id : null;
}

function yearOf(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return "";
  const y = new Date(unixSeconds * 1000).getUTCFullYear();
  return y >= 1970 && y < 2100 ? String(y) : "";
}

// Candidates for the "pick the right game" list: [{ id, name, image, detail }].
async function searchGames(term, apiKey, getJson = http.getJson, limit = 12) {
  const result = await getJson(`${API_BASE}/search/autocomplete/${encodeURIComponent(term)}`, { headers: auth(apiKey) });
  return ((result && result.data) || [])
    .filter((g) => g && Number.isInteger(g.id) && g.name)
    .slice(0, limit)
    .map((g) => ({ id: g.id, name: String(g.name), image: null, detail: yearOf(g.release_date) }));
}


// Every cover ("grid") image SteamGridDB has for a game, for the "pick a cover" screen:
// [{ id, url, thumb, width, height, style, author }]. Portrait covers (the shape of a library
// card) come first; if there are none, whatever exists is offered.
const PORTRAIT = "600x900,342x482,660x930";
async function listGrids(sgdbId, apiKey, getJson = http.getJson, limit = 48) {
  const query = async (qs) => {
    const res = await getJson(`${API_BASE}/grids/game/${sgdbId}${qs}`, { headers: auth(apiKey) });
    return (res && res.data) || [];
  };
  let list = await query(`?dimensions=${PORTRAIT}`);
  if (!list.length) list = await query("");
  return list
    .filter((g) => g && g.url && /^https:\/\//i.test(g.url))
    .slice(0, limit)
    .map((g) => ({
      id: g.id,
      url: g.url,
      thumb: typeof g.thumb === "string" && /^https:\/\//i.test(g.thumb) ? g.thumb : g.url,
      width: g.width || null,
      height: g.height || null,
      style: g.style || null,
      author: g.author && g.author.name ? String(g.author.name) : null,
    }));
}

// Only SteamGridDB's own image hosts may be downloaded as a cover.
const isSgdbImageUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && /(^|\.)steamgriddb\.com$/i.test(x.hostname);
  } catch {
    return false;
  }
};

function extFromUrl(url, fallback = ".png") {
  const m = /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i.exec(String(url));
  return m ? `.${m[1].toLowerCase()}` : fallback;
}

// Transparent logos are PNG or WebP; prefer those over opaque JPEGs.
function pickLogo(list) {
  return list.find((item) => /png|webp/i.test(item.mime || "")) || list[0] || null;
}

async function fetchArtUrl(kind, sgdbId, apiKey, getJson) {
  const base = `${API_BASE}/${kind}/game/${sgdbId}`;
  let list = [];
  if (kind === "heroes") {
    // Banner-shaped heroes first; fall back to any hero if there are none.
    const wide = await getJson(`${base}?dimensions=1920x620,3840x1240`, { headers: auth(apiKey) });
    list = (wide && wide.data) || [];
  }
  if (!list.length) {
    const any = await getJson(base, { headers: auth(apiKey) });
    list = (any && any.data) || [];
  }
  const item = kind === "logos" ? pickLogo(list) : list[0];
  return item && typeof item.url === "string" ? item.url : null;
}

// Deletes cached files whose names start with `prefix`, except `keep`.
function removeCached(cacheDir, prefix, keep) {
  let names = [];
  try {
    names = fs.readdirSync(cacheDir).filter((f) => f.startsWith(prefix));
  } catch {
    return;
  }
  for (const f of names) {
    const full = path.join(cacheDir, f);
    if (full !== keep) fs.rmSync(full, { force: true });
  }
}

// Forget a game's cover, banner and logo (e.g. because the wrong game was matched).
function clearArt(cacheDir, gameId) {
  fs.rmSync(path.join(cacheDir, `${gameId}.png`), { force: true });
  removeCached(cacheDir, `${gameId}-hero.`);
  removeCached(cacheDir, `${gameId}-logo.`);
}

function findCached(cacheDir, prefix) {
  try {
    const hit = fs.readdirSync(cacheDir).find((f) => f.startsWith(prefix) && !f.endsWith(".part"));
    return hit ? path.join(cacheDir, hit) : null;
  } catch {
    return null;
  }
}

/**
 * Banner ("hero") and logo art for a game, downloaded once into cacheDir as
 * <gameId>-hero.<ext> / <gameId>-logo.<ext>. Either can come back null.
 */
async function fetchHeroAndLogo({ sgdbId, gameId, apiKey, cacheDir, getJson = http.getJson, download = http.download, force = false }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = { hero: null, logo: null };
  for (const [key, kind] of [["hero", "heroes"], ["logo", "logos"]]) {
    const prefix = `${gameId}-${key}.`;
    if (!force) {
      out[key] = findCached(cacheDir, prefix);
      if (out[key]) continue;
    }
    try {
      const url = await fetchArtUrl(kind, sgdbId, apiKey, getJson);
      if (url) {
        const dest = path.join(cacheDir, `${prefix.slice(0, -1)}${extFromUrl(url)}`);
        out[key] = await download(url, dest);
        removeCached(cacheDir, prefix, dest); // an older copy with a different extension
        continue;
      }
    } catch (err) {
      console.error(`SteamGridDB ${key} lookup failed for game ${gameId}:`, err.message);
    }
    out[key] = findCached(cacheDir, prefix); // refreshing never throws away what we already have
  }
  return out;
}

/**
 * Finds a cover ("grid") image for a game by name, caches it under
 * cacheDir/<gameId>.png, and returns the local file path. Returns null if
 * nothing was found or no API key is configured. Pass { sgdbId } to skip the
 * name search when the SteamGridDB id is already known, { disabled: true } to
 * use no SteamGridDB art for this game, or { force: true } to fetch it again.
 */
async function fetchCoverArt(gameName, gameId, apiKey, cacheDir, { sgdbId = null, disabled = false, force = false, getJson = http.getJson, download = http.download } = {}) {
  if (!apiKey || disabled) return null;

  fs.mkdirSync(cacheDir, { recursive: true });
  const cachedPath = path.join(cacheDir, `${gameId}.png`);
  if (!force && fs.existsSync(cachedPath)) return cachedPath;
  const keepOld = () => (fs.existsSync(cachedPath) ? cachedPath : null);

  try {
    const id = sgdbId || (await searchGame(gameName, apiKey, getJson));
    if (!id) return keepOld();

    const grids = await getJson(`${API_BASE}/grids/game/${id}?dimensions=600x900`, { headers: auth(apiKey) });
    const grid = grids && grids.data && grids.data[0];
    if (!grid || !grid.url) return keepOld();

    await download(grid.url, cachedPath);
    return cachedPath;
  } catch (err) {
    console.error(`SteamGridDB lookup failed for "${gameName}":`, err.message);
    return keepOld();
  }
}

module.exports = { searchGame, gameIdFromSteam, searchGames, listGrids, isSgdbImageUrl, clearArt, fetchHeroAndLogo, fetchCoverArt, extFromUrl, pickLogo };
