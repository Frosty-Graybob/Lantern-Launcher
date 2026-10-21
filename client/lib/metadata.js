const fs = require("fs");
const path = require("path");
const http = require("./http");
const sgdb = require("./steamgriddb");

const DAY = 24 * 60 * 60 * 1000;
// Info that was found is kept for good. It's replaced only when the player asks
// for a refresh or picks a different match. A search that found nothing is
// repeated after a day, since a store listing can appear later.
const TTL_EMPTY = 1 * DAY;

// ---------------------------------------------------------------- polite Steam requests
// Steam's store API refuses (HTTP 429, or just errors) when it is hit too fast, and looking up a
// whole library's DLC does hit it fast. So Steam requests go one at a time, spaced out, and are
// tried again after a pause when Steam says to slow down.
const STEAM_GAP_MS = 350;
const RETRY_WAITS_MS = [2500, 8000, 20000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two lanes: what the player is waiting for goes first, background work (naming every DLC,
// fetching banners) only runs when nothing else is waiting.
const foreground = [];
const background = [];
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  while (foreground.length || background.length) {
    const job = foreground.shift() || background.shift();
    try {
      job.resolve(await job.task());
    } catch (err) {
      job.reject(err);
    }
    await sleep(STEAM_GAP_MS);
  }
  pumping = false;
}
const enqueue = (task, lowPriority) =>
  new Promise((resolve, reject) => {
    (lowPriority ? background : foreground).push({ task, resolve, reject });
    pump();
  });

function politeSteam(getJson, lowPriority = false) {
  if (getJson !== http.getJson) return getJson; // tests and callers with their own fetcher are left alone
  return (url, opts) => {
    if (!/steampowered\.com/i.test(url)) return getJson(url, opts);
    return enqueue(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await getJson(url, opts);
        } catch (err) {
          const slowDown = err && (err.statusCode === 429 || err.statusCode === 403 || err.statusCode >= 500);
          if (!slowDown || attempt >= RETRY_WAITS_MS.length) throw err;
          await sleep(RETRY_WAITS_MS[attempt]);
        }
      }
    }, lowPriority);
  };
}

function logLookupError(cacheDir, message) {
  console.error(message);
  try {
    fs.appendFileSync(path.join(cacheDir, "..", "lookup-errors.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* best-effort */
  }
}

const STEAM_SEARCH = "https://store.steampowered.com/api/storesearch/";
const STEAM_DETAILS = "https://store.steampowered.com/api/appdetails";

// ---------------------------------------------------------------- text cleanup

const ENTITIES = {
  quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " ", trade: "™", reg: "®", copy: "©",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•",
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : match;
  });
}

// Steam sends descriptions as HTML. The UI only ever shows plain text.
function htmlToText(html) {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<\s*(?:br|\/p|\/div|\/h[1-6]|\/li|\/ul)\s*\/?>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "• ");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  return s.replace(/[ \t\r\f\v]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncateText(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return stop > max * 0.6 ? cut.slice(0, stop + 1).trim() : `${cut.replace(/\s+\S*$/, "")}…`;
}

// ---------------------------------------------------------------- name matching

const STOP_WORDS = new Set(["the", "a", "an", "of", "and"]);
// Words that mean "this Steam entry is an add-on, not the game itself".
const ADDON_WORDS = new Set(["soundtrack", "ost", "dlc", "demo", "bundle", "pack", "artbook", "season", "pass", "expansion", "upgrade", "beta"]);

// "Episode Zero" and "Episode 0" are the same title.
const NUMBER_WORDS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };

function tokens(name) {
  return new Set(
    String(name || "")
      .toLowerCase()
      .replace(/[™®©]/g, " ")
      .replace(/['’`]/g, "") // "Woman's" and "Womans" are the same word
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !STOP_WORDS.has(t))
      .map((t) => NUMBER_WORDS[t] || t)
  );
}

// An installment number the query doesn't have ("Dead Space" vs "Dead Space 2")
// means a different game. Years don't count: "Dead Space (2008)" is the same game.
const ROMAN = /^(ii|iii|iv|v|vi|vii|viii|ix|x)$/;
const isInstallmentNumber = (t) => (/^\d+$/.test(t) && !/^(19|20)\d{2}$/.test(t)) || ROMAN.test(t);

function nameScore(query, candidate, { allowAddons = false } = {}) {
  const q = tokens(query);
  const c = tokens(candidate);
  if (!q.size || !c.size) return 0;
  let inter = 0;
  for (const t of q) if (c.has(t)) inter++;
  if (inter === 0) return 0;
  let score = inter / (q.size + c.size - inter); // 1.0 = same words
  if (inter === q.size) score += 0.25; // every word the user typed is in the title
  for (const t of c) {
    if (q.has(t)) continue;
    if (!allowAddons && ADDON_WORDS.has(t)) score -= 0.5; // a DLC lookup expects add-on words
    if (isInstallmentNumber(t)) score -= 0.5;
  }
  return score;
}

// Steam's search also returns packages and bundles ("Fallout 4: Game of the Year Edition" is one). They
// have no store details of their own, so only real apps are matched.
const isPackage = (item) => !!item && (item.type === "sub" || item.type === "bundle");

// "Dishonored - Definitive Edition", "The Witcher 3 - GOTY", "Saints Row The Third - The Full Package (2011)":
// Steam lists most of these under the plain game title, so edition wording is dropped for a second try.
const EDITION_WORDS = /\b(game of the year|goty|definitive|ultimate|complete|deluxe|digital|enhanced|special|royal|anniversary|gold|collector'?s|director'?s cut|the full package|full package|augmented|legendary|premium|standard|gog)\b/gi;
function stripEdition(name) {
  return String(name || "")
    .replace(/\((?:19|20)\d\d\)/g, " ") // a release year in brackets
    .replace(EDITION_WORDS, " ")
    .replace(/\bedition\b/gi, " ")
    .replace(/[-:–—]\s*$/g, " ")
    .replace(/\s+[-:–—]\s+(?=[-:–—]|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Like pickSteamMatch, but with edition wording left out on both sides. Several results can end up
// equal ("Saints Row: The Third" and "...Remastered"), so the full-name score breaks the tie.
function pickLooseSteamMatch(query, items) {
  const q = stripEdition(query);
  if (tokens(q).size === 0 || q === String(query).trim()) return null;
  let best = null;
  let bestScore = 0.74;
  let bestFull = -1;
  for (const item of items || []) {
    if (!item || !item.name || item.id == null || isPackage(item)) continue;
    const score = nameScore(q, stripEdition(item.name));
    const full = nameScore(query, item.name);
    if (score > bestScore + 0.001 || (Math.abs(score - bestScore) <= 0.001 && best && full > bestFull)) {
      best = { id: item.id, name: item.name };
      bestScore = Math.max(score, bestScore);
      bestFull = full;
    }
  }
  return best;
}

// The best Steam search result for a title, or null. Better to show nothing
// than another game's description, so weak matches are rejected.
function pickSteamMatch(query, items, opts) {
  let best = null;
  let bestScore = 0.74;
  for (const item of items || []) {
    if (!item || !item.name || item.id == null || isPackage(item)) continue;
    const score = nameScore(query, item.name, opts);
    if (score > bestScore) {
      best = { id: item.id, name: item.name };
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------- Steam

const isHttps = (u) => typeof u === "string" && /^https:\/\//i.test(u);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);

function emptyMetadata() {
  return {
    sources: [], summary: null, description: null, developers: [], publishers: [], genres: [],
    releaseDate: null, score: null, screenshots: [], steamAppId: null, steamName: null, headerImage: null,
    sgdbId: null, hero: null, logo: null,
  };
}

function parseSteamDetails(d, appId) {
  const summary = htmlToText(d.short_description) || null;
  let about = htmlToText(d.about_the_game || d.detailed_description);
  if (summary && about.startsWith(summary)) about = about.slice(summary.length).trim(); // don't say it twice
  const release = d.release_date && !d.release_date.coming_soon ? d.release_date.date : null;
  return {
    summary,
    description: truncateText(about, 1500) || null,
    developers: strList(d.developers),
    publishers: strList(d.publishers),
    genres: (Array.isArray(d.genres) ? d.genres : []).map((g) => g && g.description).filter(Boolean),
    releaseDate: typeof release === "string" && release.trim() ? release.trim() : null,
    score: d.metacritic && Number.isFinite(d.metacritic.score) ? d.metacritic.score : null,
    // Only https image URLs are ever handed to the UI.
    screenshots: (Array.isArray(d.screenshots) ? d.screenshots : [])
      .map((s) => ({ thumb: s && s.path_thumbnail, full: s && s.path_full }))
      .filter((s) => isHttps(s.thumb) && isHttps(s.full))
      .slice(0, 10),
    steamAppId: Number(appId) || null,
    steamName: typeof d.name === "string" ? d.name : null,
    headerImage: isHttps(d.header_image) ? d.header_image : null, // the store banner, used as the DLC thumbnail
  };
}

// Candidates for the "pick the right game" list: [{ id, name, image, detail }].
async function searchSteam(term, { getJson = http.getJson, limit = 12 } = {}) {
  getJson = politeSteam(getJson);
  const res = await getJson(`${STEAM_SEARCH}?term=${encodeURIComponent(term)}&l=english&cc=US`);
  return ((res && res.items) || [])
    .map((i) => ({ id: Number(i && i.id), name: i && i.name, image: i && isHttps(i.tiny_image) ? i.tiny_image : null }))
    .filter((i) => Number.isInteger(i.id) && i.id > 0 && typeof i.name === "string" && i.name)
    .slice(0, limit)
    .map((i) => ({ ...i, detail: "" }));
}


// Forget the DLC lists kept in memory.
function clearMemoryCaches() {
  dlcListCache.clear();
}

// ---- DLC of a known game ----------------------------------------------------
// Steam lists a game's DLC on the game's own page. Matching a DLC folder against that
// short list is far more reliable than searching the whole store.
const dlcListCache = new Map();

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  });
  await Promise.all(workers);
  return out;
}

// [{ id, name }] for the DLC Steam lists under a game. Throws on network trouble.
function listSteamDlc(baseAppId, getJson, lowPriority = false) {
  getJson = politeSteam(getJson, lowPriority);
  if (!dlcListCache.has(baseAppId)) {
    const p = (async () => {
      const res = await getJson(`${STEAM_DETAILS}?appids=${encodeURIComponent(baseAppId)}&l=english&cc=US`);
      const entry = res && res[String(baseAppId)];
      const ids = entry && entry.success && entry.data && Array.isArray(entry.data.dlc) ? entry.data.dlc.slice(0, 80) : [];
      const named = await mapLimit(ids, 6, async (id) => {
        const r = await getJson(`${STEAM_DETAILS}?appids=${encodeURIComponent(id)}&filters=basic&l=english&cc=US`);
        const e = r && r[String(id)];
        return e && e.success && e.data && e.data.name ? { id: Number(id), name: String(e.data.name) } : null;
      });
      return named.filter(Boolean);
    })();
    p.catch(() => dlcListCache.delete(baseAppId)); // a network failure must not stick
    dlcListCache.set(baseAppId, p);
  }
  return dlcListCache.get(baseAppId);
}

const DLC_NOISE = new Set(["dlc", "pack", "add", "on", "addon", "gog", "edition", "content", "bonus", "digital", "extra", "extras"]);

// Words of a DLC title with the game's own title taken out ("A Hat in Time - Seal the Deal" -> "seal deal").
function dlcWords(name, baseNames) {
  const base = new Set();
  for (const b of baseNames || []) for (const t of tokens(b)) base.add(t);
  const all = [...tokens(name)];
  const rest = all.filter((t) => !base.has(t) && !DLC_NOISE.has(t));
  return new Set(rest.length ? rest : all.filter((t) => !DLC_NOISE.has(t)));
}

function dlcScore(query, candidate, baseNames) {
  const q = dlcWords(query, baseNames);
  const c = dlcWords(candidate, baseNames);
  if (!q.size || !c.size) return 0;
  let inter = 0;
  for (const t of q) if (c.has(t)) inter++;
  if (!inter) return 0;
  const jaccard = inter / (q.size + c.size - inter);
  return inter === Math.min(q.size, c.size) ? Math.max(jaccard, 0.6 + 0.4 * jaccard) : jaccard;
}

// Best of the game's own DLC for a folder name, or null. Both the folder name and Steam's
// title are compared without the game's title, so "Seal the Deal" finds "A Hat in Time - Seal the Deal".
function pickDlcFromList(query, list, baseNames) {
  let best = null;
  let bestScore = 0.55;
  let tie = false;
  for (const item of list || []) {
    const sc = dlcScore(query, item.name, baseNames);
    if (sc > bestScore + 0.001) {
      best = item;
      bestScore = sc;
      tie = false;
    } else if (best && Math.abs(sc - bestScore) <= 0.001) tie = true;
  }
  return tie ? null : best; // two equally good answers: better to search the store than guess
}

// Throws on network trouble; returns null for a clean "Steam doesn't have it".
// `searchTerms` are extra things to type into Steam's search when the full name finds
// nothing (Steam's search is picky: "Game - DLC name" can return no results at all while
// "DLC name" alone finds it). Matching is always against `name`.
async function fetchSteam({ name, steamAppId, getJson, searchTerms, isDlc = false, baseAppId = null, baseNames = [], dlcName = null, lowPriority = false }) {
  getJson = politeSteam(getJson, lowPriority);
  let appId = steamAppId || null;
  if (!appId && isDlc && baseAppId) {
    try {
      const hit = pickDlcFromList(dlcName || name, await listSteamDlc(baseAppId, getJson, lowPriority), baseNames);
      if (hit) appId = hit.id;
    } catch (err) {
      console.error(`Steam DLC list failed for app ${baseAppId}:`, err.message);
    }
  }
  let looseFallback = null;
  if (!appId) {
    const terms = [name, ...(Array.isArray(searchTerms) ? searchTerms : [])];
    const seen = new Map();
    looseFallback = (skipId) => {
      // the plain title ("Fallout 4"), searched when it has not been yet
      return pickLooseSteamMatch(name, [...seen.values()].filter((i) => Number(i.id) !== Number(skipId)));
    };
    let match = null;
    for (const term of terms) {
      const search = await getJson(`${STEAM_SEARCH}?term=${encodeURIComponent(term)}&l=english&cc=US`);
      for (const item of (search && search.items) || []) if (item && item.id != null && !seen.has(item.id)) seen.set(item.id, item);
      match = pickSteamMatch(name, [...seen.values()], { allowAddons: isDlc });
      if (match) break;
    }
    if (!isDlc) {
      // nothing under the full name: try the plain title, without "Definitive Edition" and the like
      const plain = stripEdition(name);
      if (plain && plain !== name) {
        const search = await getJson(`${STEAM_SEARCH}?term=${encodeURIComponent(plain)}&l=english&cc=US`);
        for (const item of (search && search.items) || []) if (item && item.id != null && !seen.has(item.id)) seen.set(item.id, item);
        if (!match) match = pickLooseSteamMatch(name, [...seen.values()]);
      }
    }
    if (!match) return null;
    // A DLC is never the base game itself: "Dying Light" the DLC must not become the "Dying Light" game.
    if (isDlc) {
      const sameTitle = (baseNames || []).some((b) => tokens(b).size === tokens(match.name).size && nameScore(b, match.name) > 1);
      if ((baseAppId && Number(match.id) === Number(baseAppId)) || sameTitle) return null;
    }
    appId = match.id;
  }
  const res = await getJson(`${STEAM_DETAILS}?appids=${encodeURIComponent(appId)}&l=english&cc=US`);
  const entry = res && res[String(appId)];
  if (!entry || !entry.success || !entry.data) {
    // The best match has no store page of its own (a package, say): try the plain title instead.
    if (!steamAppId && !isDlc && looseFallback) {
      const alt = looseFallback(appId);
      if (alt) {
        const r2 = await getJson(`${STEAM_DETAILS}?appids=${encodeURIComponent(alt.id)}&l=english&cc=US`);
        const e2 = r2 && r2[String(alt.id)];
        if (e2 && e2.success && e2.data) return parseSteamDetails(e2.data, alt.id);
      }
    }
    return null;
  }
  return parseSteamDetails(entry.data, appId);
}

// ---------------------------------------------------------------- cache + assembly

const safeFile = (id) => String(id).replace(/[^a-zA-Z0-9._-]/g, "_");

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const cacheFileFor = (cacheDir, gameId) => path.join(cacheDir, `${safeFile(gameId)}.json`);

function cacheKey(game, apiKey) {
  return JSON.stringify([game.name, game.steamAppId || null, game.sgdbId || null, !!apiKey, !!game.skipSteam, !!game.skipSgdb, game.searchTerms || null, !!game.isDlc, game.baseAppId || null, game.isDlc ? 3 : 0]);
}

// Bump when matching improves, so earlier "found nothing" answers are tried again (good ones are kept).
const CACHE_VERSION = 4;

function cacheUsable(cached, key, now, game = {}) {
  if (!cached || cached.key !== key || !cached.data) return false;
  // "Found" can be only banner art from SteamGridDB. With no Steam match (and none ruled out by the
  // player), the Steam part is looked up again after matching improved, and then once a day.
  const noSteam = !game.skipSteam && !cached.data.steamAppId;
  const missing = !cached.found || noSteam;
  if (missing && cached.v !== CACHE_VERSION) return false;
  if (missing && now - cached.fetchedAt > TTL_EMPTY) return false;
  return [cached.data.hero, cached.data.logo].every((p) => !p || fs.existsSync(p)); // art wasn't deleted
}

/**
 * Description, genres, screenshots, banner and logo for a game, cached on disk
 * for good once found. Errors in one source don't lose the other, and a failed
 * lookup is never cached, so it retries next time.
 *
 * game.skipSteam / game.skipSgdb mean "the player says there's no right match
 * there": that source is left out. { force: true } looks everything up again
 * but, if that fails (say, no internet), keeps what's already saved.
 */
async function fetchGameMetadata(game, { apiKey = "", cacheDir, artDir, getJson = http.getJson, download = http.download, now = Date.now(), force = false, lowPriority = false }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = cacheFileFor(cacheDir, game.id);
  const key = cacheKey(game, apiKey);
  const cached = readCache(file);
  if (!force && cacheUsable(cached, key, now, game)) return cached.data;

  const data = emptyMetadata();
  let hadError = false;

  if (!game.skipSteam) {
    try {
      const steam = await fetchSteam({ name: game.name, steamAppId: game.steamAppId, getJson, searchTerms: game.searchTerms, isDlc: !!game.isDlc, baseAppId: game.baseAppId, baseNames: game.baseNames, dlcName: game.dlcName, lowPriority });
      if (steam) {
        Object.assign(data, steam);
        data.sources.push("steam");
      }
    } catch (err) {
      hadError = true;
      logLookupError(cacheDir, `Steam lookup failed for "${game.name}" (${game.id}): ${err.message}`);
    }
  }

  if (apiKey && !game.skipSgdb) {
    try {
      const sgdbId =
        game.sgdbId || (cached && cached.data && cached.data.sgdbId) || (await sgdb.searchGame(game.name, apiKey, getJson));
      if (sgdbId) {
        data.sgdbId = sgdbId;
        const art = await sgdb.fetchHeroAndLogo({ sgdbId, gameId: game.id, apiKey, cacheDir: artDir, getJson, download, force });
        data.hero = art.hero;
        data.logo = art.logo;
        if (art.hero || art.logo) data.sources.push("steamgriddb");
      }
    } catch (err) {
      hadError = true;
      logLookupError(cacheDir, `SteamGridDB art lookup failed for "${game.name}" (${game.id}): ${err.message}`);
    }
  }

  if (hadError) {
    // A refresh that couldn't reach the network must not replace good saved info with a blank.
    return force && cacheUsable(cached, key, now, game) ? cached.data : data;
  }
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: now, found: data.sources.length > 0, key, v: CACHE_VERSION, data }));
  return data;
}

// Details typed into the game's game.json win over anything fetched, so games
// the stores don't know (mods, indie releases) can still be described.
function applyOverrides(meta, manual) {
  if (!manual) return meta;
  const out = { ...meta, sources: [...meta.sources] };
  let used = false;
  if (manual.description) {
    out.summary = manual.description;
    out.description = null;
    used = true;
  }
  for (const k of ["developers", "publishers", "genres"]) {
    if (manual[k] && manual[k].length) {
      out[k] = manual[k];
      used = true;
    }
  }
  if (manual.releaseDate) {
    out.releaseDate = manual.releaseDate;
    used = true;
  }
  if (used) out.sources.push("game.json");
  return out;
}

module.exports = {
  htmlToText, decodeEntities, truncateText, nameScore, pickSteamMatch, parseSteamDetails,
  fetchSteam, clearMemoryCaches, stripEdition, pickLooseSteamMatch, searchSteam, listSteamDlc, dlcScore, pickDlcFromList, fetchGameMetadata, applyOverrides, emptyMetadata, cacheFileFor,
};
