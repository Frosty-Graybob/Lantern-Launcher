const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL, pathToFileURL } = require("url");

const { JsonStore } = require("./lib/store");
const { downloadFile } = require("./lib/downloader");
const { extractGogInstaller, extractDlcInstaller, findPlayExecutable, dirSize } = require("./lib/installer");
const { hashFile } = require("./lib/checksum");
const { fetchCoverArt, searchGames: searchSgdb, clearArt, listGrids, searchGame: findSgdbId, gameIdFromSteam, isSgdbImageUrl, extFromUrl } = require("./lib/steamgriddb");
const { tidyDlcName } = require("./lib/dlcname");
const { clearMemoryCaches } = require("./lib/metadata");
const { fetchGameMetadata, applyOverrides, emptyMetadata, searchSteam, cacheFileFor, listSteamDlc, dlcScore } = require("./lib/metadata");
const { describeSizes, freeBytes, driveKey, driveLabel, checkSpace } = require("./lib/sizes");
const { createSpeedMeter } = require("./lib/speed");
const { createDesktopShortcut, removeShortcutIfExists, sanitizeFileName, removeGameShortcuts } = require("./lib/shortcuts");
const { withDetails } = require("./lib/errors");

let mainWindow;
let config;
let state;

const userDataDir = () => app.getPath("userData");
const downloadsDir = () => path.join(userDataDir(), "downloads");
const coversDir = () => path.join(userDataDir(), "covers");
const metadataDir = () => path.join(userDataDir(), "metadata");

// The most recent library from the server, so details/space checks can look a game up by id.
let lastLibrary = new Map();

// The app ships its own copy of innoextract.exe (see client/tools/README.txt
// for how it gets there). This is what makes it work out of the box for
// people running the built app -- no separate download needed on their end.
function bundledInnoExtractPath() {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "tools", "innoextract.exe")
    : path.join(__dirname, "tools", "innoextract.exe");
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveInnoExtractPath() {
  const override = config.get("innoExtractPath");
  if (override) return override;
  return bundledInnoExtractPath() || "innoextract"; // last resort: hope it's on PATH
}

// Icons live in an "assets" folder that is shipped next to the app (not inside its archive),
// where Windows and Electron can both load them reliably once installed.
const assetPath = (name) =>
  app.isPackaged ? path.join(process.resourcesPath, "assets", name) : path.join(__dirname, "assets", name);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    title: "Game Launcher",
    backgroundColor: "#0f1115",
    icon: assetPath("icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  config = new JsonStore(path.join(userDataDir(), "config.json"), {
    serverUrl: "http://localhost:5155",
    steamGridDbApiKey: "",
    installRoot: path.join(app.getPath("documents"), "Games"),
    innoExtractPath: "",
  });
  state = new JsonStore(path.join(userDataDir(), "state.json"), { games: {} });

  fs.mkdirSync(downloadsDir(), { recursive: true });
  fs.mkdirSync(coversDir(), { recursive: true });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Tolerates the ways people type a server address: stray spaces, a missing
// http://, trailing slashes, or a pasted /api or /api/library suffix.
function normalizeServerUrl(input) {
  let url = String(input || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/api(\/library)?\/*$/i, "");
  return url.replace(/\/+$/, "");
}

function serverBase() {
  return normalizeServerUrl(config.get("serverUrl"));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Server returned ${res.statusCode} for ${url}`));
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`${url} did not return valid JSON -- is that the Game Launcher server?`));
        }
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error(`Timed out connecting to ${url}`)));
    req.on("error", reject);
  });
}

function gameState(gameId) {
  return state.get("games", {})[gameId] || {};
}

function setGameState(gameId, patch) {
  const games = state.get("games", {});
  games[gameId] = { ...games[gameId], ...patch };
  state.set("games", games);
}

// What the player picked in the "fix this game's info" screen, per source: a Steam
// or SteamGridDB id, or "none" meaning "there's no right match". Missing = automatic.
// A choice beats anything the server says, which beats the automatic name match.
const matchChoice = (gameId) => gameState(gameId).metaChoice || {};

function withChoice(game) {
  const c = matchChoice(game.id);
  return {
    ...game,
    steamAppId: Number.isInteger(c.steam) ? c.steam : game.steamAppId,
    sgdbId: Number.isInteger(c.sgdb) ? c.sgdb : game.sgdbId,
    skipSteam: c.steam === "none",
    skipSgdb: c.sgdb === "none",
  };
}


// The game as the artwork code should see it. If the player fixed the Steam match but left
// SteamGridDB on automatic, the SteamGridDB game is found from that Steam app, so the poster,
// banner and logo are the matched game's and not a name-search guess. Art downloaded for a
// different SteamGridDB game is thrown away once, so older fixes get corrected too.
const steamToSgdb = new Map();
async function withArtMatch(game) {
  const eff = withChoice(game);
  const apiKey = config.get("steamGridDbApiKey");
  if (!apiKey || eff.skipSgdb) return eff;
  if (!Number.isInteger(eff.sgdbId) && Number.isInteger(eff.steamAppId) && eff.steamAppId > 0) {
    try {
      if (!steamToSgdb.has(eff.steamAppId)) steamToSgdb.set(eff.steamAppId, await gameIdFromSteam(eff.steamAppId, apiKey));
      const id = steamToSgdb.get(eff.steamAppId);
      if (id) eff.sgdbId = id;
    } catch (err) {
      console.error(`SteamGridDB lookup by Steam app failed for "${game.name}":`, err.message);
    }
  }
  const gs = gameState(game.id);
  if (Number.isInteger(eff.sgdbId) && gs.artSgdbId !== eff.sgdbId) {
    clearArt(coversDir(), game.id);
    fs.rmSync(cacheFileFor(metadataDir(), game.id), { force: true });
    setGameState(game.id, { artSgdbId: eff.sgdbId });
  }
  return eff;
}

// A game only counts as installed while its executable is still on disk. This
// deliberately doesn't rewrite the saved state: if the files are just
// temporarily unavailable (say, an external drive that's unplugged), nothing
// is lost and the game shows as installed again once they're back.
function withInstallCheck(gs) {
  if (gs.installed && (!gs.exePath || !fs.existsSync(gs.exePath))) {
    return { ...gs, installed: false, installMissing: true };
  }
  return gs;
}

// True if `child` is strictly inside `parent` (case-insensitive on Windows).
function isInside(child, parent) {
  let c = path.resolve(child);
  let p = path.resolve(parent);
  if (process.platform === "win32") {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

// Deletes a game's downloaded installer files. Only ever deletes inside the
// app's own downloads folder, whatever gameId the server sends.
function deleteGameDownloads(gameId) {
  const root = path.resolve(downloadsDir());
  const dir = path.resolve(path.join(root, gameId));
  if (!dir.startsWith(root + path.sep)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  setGameState(gameId, { downloaded: false, downloadedFiles: [], downloadDir: null });
  return true;
}

// ---------- IPC handlers ----------

ipcMain.handle("config:get", () => config.all());

ipcMain.handle("config:set", (event, patch) => {
  if ("serverUrl" in patch) patch.serverUrl = normalizeServerUrl(patch.serverUrl);
  Object.entries(patch).forEach(([k, v]) => config.set(k, v));
  return config.all();
});

ipcMain.handle("config:chooseInstallRoot", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return config.get("installRoot");
  config.set("installRoot", result.filePaths[0]);
  return result.filePaths[0];
});

ipcMain.handle("library:get", async () => {
  const manifest = await fetchJson(`${serverBase()}/api/library`);
  const apiKey = config.get("steamGridDbApiKey");

  const games = await Promise.all(
    manifest.games.map(async (game) => {
      let cover = null;
      try {
        const eff = await withArtMatch(game);
        cover = await fetchCoverArt(game.name, game.id, apiKey, coversDir(), { sgdbId: eff.sgdbId, disabled: eff.skipSgdb });
      } catch {
        /* non-fatal */
      }
      const gs = gameState(game.id);
      // A picture the player chose for this game beats any automatic art.
      if (gs.customCover && fs.existsSync(gs.customCover)) cover = gs.customCover;
      const titles = gs.dlcTitles || {};
      // Steam's title when there is one, otherwise the file name with the game's title and clutter taken off.
      const dlcList = (game.dlc || []).map((d) => {
        if (d.metadata && d.metadata.name) return d;
        const shown = titles[d.id] || tidyDlcName(d.name, [game.name]);
        const thumb = savedDlcThumb(game.id, d.id) || null;
        return { ...d, thumb, ...(shown && shown !== d.name ? { fileName: d.name, name: shown } : {}) };
      });
      return {
        ...game,
        dlc: dlcList,
        hasCustomCover: !!(gs.customCover && fs.existsSync(gs.customCover)),
        cover,
        sizes: describeSizes(game, gs.installedBytes),
        clientState: withInstallCheck(gs),
      };
    })
  );

  lastLibrary = new Map(games.map((g) => [g.id, g]));
  dlcNameLog(`library loaded: ${games.reduce((n, g) => n + (g.dlc || []).length, 0)} DLC`);
  nameDlcInBackground(games);
  return { games };
});



// Description, art and facts for one DLC's page. A DLC is looked up on Steam as
// "<game> - <DLC>" (Steam lists most DLC as their own store entry). It borrows
// the base game's banner, so no SteamGridDB search is made for it.
ipcMain.handle("dlc:details", async (event, { gameId, dlcId, force }) => {
  const game = lastLibrary.get(gameId);
  const dlc = game && (game.dlc || []).find((d) => d.id === dlcId);
  if (!dlc) throw new Error("Unknown DLC -- refresh the library and try again.");
  return resolveDlcMeta(game, dlc, force);
});

// Looks up Steam titles for DLC that don't have one yet, a few at a time, so the list
// shows proper names without the player opening every DLC page.
let scanning = false;
let scanGeneration = 0; // bumped when saved info is cleared, so a scan already running stops and a new one starts
let rescanWith = null;
const triedDlcNames = new Set(); // once per session, so a DLC Steam does not know is not looked up on every refresh

// Game by game: the game's own info first (so its Steam id is known), then its DLC. Runs in the
// background at low priority; whatever the player opens in the meantime goes first.
async function nameDlcInBackground(games) {
  if (scanning) {
    rescanWith = games; // pick up the newest library once the current pass ends
    return;
  }
  scanning = true;
  const generation = scanGeneration;
  const apiKey = config.get("steamGridDbApiKey");
  let named = 0;
  let unnamed = 0;
  try {
    for (const g of games) {
      if (generation !== scanGeneration) break;
      try {
        const eff = await withArtMatch(g);
        await fetchGameMetadata(eff, { apiKey, cacheDir: metadataDir(), artDir: coversDir(), lowPriority: true });
      } catch (err) {
        dlcNameLog(`${g.name}: game info lookup failed: ${err.message}`);
      }
      for (const d of g.dlc || []) {
        if (generation !== scanGeneration) break;
        const titles = gameState(g.id).dlcTitles || {};
        const key = `${g.id}/${d.id}`;
        if ((titles[d.id] && savedDlcThumb(g.id, d.id) !== undefined) || triedDlcNames.has(key)) continue;
        triedDlcNames.add(key);
        if ((gameState(g.id).dlcChoice || {})[d.id] === "none") continue;
        try {
          await resolveDlcMeta(g, d, savedDlcThumb(g.id, d.id) === undefined, true);
          if ((gameState(g.id).dlcTitles || {})[d.id]) named++;
          else unnamed++;
        } catch (err) {
          unnamed++;
          dlcNameLog(`${g.name} / "${d.name}": lookup failed: ${err.message}`);
        }
      }
    }
    if (generation === scanGeneration) dlcNameLog(`scan finished: ${named} DLC named from Steam, ${unnamed} without a Steam match`);
  } finally {
    scanning = false;
    const next = rescanWith;
    rescanWith = null;
    if (next && generation !== scanGeneration) nameDlcInBackground(next); // only after a clear; a plain reload needs no second pass
  }
}

// The DLC's title as Steam spells it, with the game's own title taken off the front:
// "Cyberpunk 2077: Phantom Liberty" -> "Phantom Liberty".
function cleanDlcTitle(steamName, baseNames, fallback) {
  let t = String(steamName || "").trim();
  for (const b of [...baseNames].filter(Boolean).sort((x, y) => y.length - x.length)) {
    if (t.toLowerCase().startsWith(b.toLowerCase())) {
      const rest = t.slice(b.length).replace(/^[\s:\-\u2013\u2014\u2022|]+/, "").trim();
      if (rest.length >= 2) return rest;
    }
  }
  return t || fallback;
}

// The saved Steam banner for a DLC, or undefined if its info was saved before banners were kept,
// or null if Steam has none.
function savedDlcThumb(gameId, dlcId) {
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFileFor(metadataDir(), `${gameId}--dlc--${dlcId}`), "utf8"));
    if (!saved || !saved.data) return null;
    return "headerImage" in saved.data ? saved.data.headerImage : saved.found ? undefined : null;
  } catch {
    return null;
  }
}

// A short log of DLC name lookups (dlc-names.log in the launcher's data folder), for finding out why a name didn't change.
function dlcNameLog(line) {
  console.log(`[dlc names] ${line}`);
  try {
    fs.appendFileSync(path.join(userDataDir(), "dlc-names.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging is best-effort */
  }
}

// Remembers (or forgets) the Steam title for a DLC. Returns true if it changed.
function storeDlcTitle(gameId, dlcId, title) {
  const titles = { ...(gameState(gameId).dlcTitles || {}) };
  if (title ? titles[dlcId] === title : !(dlcId in titles)) return false;
  if (title) titles[dlcId] = title;
  else delete titles[dlcId];
  setGameState(gameId, { dlcTitles: titles });
  return true;
}

async function resolveDlcMeta(game, dlc, force, lowPriority = false) {
  const gameId = game.id;
  const dlcId = dlc.id;
  const rawName = dlc.fileName || dlc.name; // what the server calls it, before any Steam title
  // The base game's title as Steam spells it, when that's already known: a folder
  // called "Hat in Time" still finds "A Hat in Time - Seal the Deal".
  let steamTitle = null;
  let baseSaved = null;
  try {
    const base = JSON.parse(fs.readFileSync(cacheFileFor(metadataDir(), gameId), "utf8"));
    baseSaved = base;
    steamTitle = base && base.data && typeof base.data.steamName === "string" ? base.data.steamName : null;
  } catch {
    /* no saved info for the base game yet */
  }
  const baseAppId = withChoice(game).steamAppId || (baseSaved && baseSaved.data && baseSaved.data.steamAppId) || null;
  const gameNames = [game.name, steamTitle].filter((n, i, all) => n && all.indexOf(n) === i);
  // What the player picked on the "fix match" screen beats what the server says.
  const picked = (gameState(gameId).dlcChoice || {})[dlcId];
  const pseudo = {
    id: `${gameId}--dlc--${dlcId}`,
    name: `${gameNames[gameNames.length - 1]} - ${rawName}`,
    steamAppId: Number.isInteger(picked) ? picked : dlc.steamAppId || null,
    skipSteam: picked === "none",
    skipSgdb: true,
    isDlc: true,
    // Steam lists a game's DLC on the game's page; with the game's Steam id the DLC is picked from that list.
    baseAppId: baseAppId || null,
    baseNames: gameNames,
    dlcName: rawName,
    // Steam's search often finds nothing for the long form, but finds the DLC by its own name.
    searchTerms: [rawName, ...gameNames.map((n) => `${n} ${rawName}`), `${game.name} - ${rawName}`],
  };
  const hadThumb = !!savedDlcThumb(gameId, dlcId);
  // An earlier "Steam has nothing" answer is kept for a day; don't let it hide a lookup that can work now.
  let retry = !!force;
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFileFor(metadataDir(), pseudo.id), "utf8"));
    if (saved && saved.found === false) retry = true;
  } catch {
    /* nothing saved yet */
  }
  let meta;
  try {
    meta = await fetchGameMetadata(pseudo, { apiKey: "", cacheDir: metadataDir(), artDir: coversDir(), force: retry, lowPriority });
  } catch (err) {
    console.error(`Metadata lookup failed for "${pseudo.name}":`, err.message);
    meta = emptyMetadata();
  }
  // Name the DLC the way Steam does, once it has a Steam match.
  let nice = meta && meta.steamName ? cleanDlcTitle(meta.steamName, gameNames, rawName) : null;
  if (nice && gameNames.some((b) => b.toLowerCase().replace(/[^a-z0-9]/g, "") === nice.toLowerCase().replace(/[^a-z0-9]/g, ""))) nice = null; // that's the game's own title, not a DLC's
  dlcNameLog(`${game.name} / "${rawName}": base app ${baseAppId || "unknown"}, Steam says ${meta && meta.steamName ? `"${meta.steamName}"` : "nothing"} -> ${nice ? `"${nice}"` : "keeps file name"}`);
  const newThumb = !!(meta && meta.headerImage) && !hadThumb;
  if ((storeDlcTitle(gameId, dlcId, nice) || newThumb) && mainWindow) mainWindow.webContents.send("library:changed");
  return { ...applyOverrides(meta, dlc.metadata), choice: { steam: picked === undefined ? "auto" : picked } };
}

// The player's pick for a DLC's Steam match: a Steam id from the search list, "none"
// (it isn't on Steam), or "auto" (back to the automatic match).
ipcMain.handle("dlc:chooseMatch", async (event, { gameId, dlcId, choice }) => {
  const game = lastLibrary.get(gameId);
  const dlc = game && (game.dlc || []).find((d) => d.id === dlcId);
  if (!dlc) throw new Error("Unknown DLC -- refresh the library and try again.");

  storeDlcTitle(gameId, dlcId, null); // the old match's name no longer applies
  const current = { ...(gameState(gameId).dlcChoice || {}) };
  if (choice === "auto") delete current[dlcId];
  else if (choice === "none") current[dlcId] = "none";
  else if (Number.isInteger(choice) && choice > 0) current[dlcId] = choice;
  else throw new Error("Invalid choice");
  setGameState(gameId, { dlcChoice: current });

  fs.rmSync(cacheFileFor(metadataDir(), `${gameId}--dlc--${dlcId}`), { force: true }); // it belonged to the old match
  return { ok: true };
});


// Covers SteamGridDB has for a game, for the player to pick from.
ipcMain.handle("art:list", async (event, { gameId }) => {
  const game = lastLibrary.get(gameId);
  if (!game) throw new Error("Unknown game -- refresh the library and try again.");
  const apiKey = config.get("steamGridDbApiKey");
  if (!apiKey) return { grids: [], needsKey: true };
  const eff = await withArtMatch(game);
  if (eff.skipSgdb) return { grids: [], disabled: true };

  let sgdbId = eff.sgdbId;
  if (!sgdbId) {
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFileFor(metadataDir(), gameId), "utf8"));
      sgdbId = saved && saved.data ? saved.data.sgdbId : null;
    } catch {
      /* nothing saved */
    }
  }
  if (!sgdbId) sgdbId = await findSgdbId(game.name, apiKey);
  if (!sgdbId) return { grids: [] };
  return { grids: await listGrids(sgdbId, apiKey) };
});

// Downloads the cover the player picked and uses it for this game.
ipcMain.handle("art:choose", async (event, { gameId, url }) => {
  if (!lastLibrary.has(gameId)) throw new Error("Unknown game -- refresh the library and try again.");
  if (!isSgdbImageUrl(url)) throw new Error("That isn't a SteamGridDB image.");
  const dest = path.join(coversDir(), `${sanitizeFileName(gameId)}-custom-${Date.now()}${extFromUrl(url)}`);
  await require("./lib/http").download(url, dest);

  const old = gameState(gameId).customCover;
  if (old && old !== dest) fs.rmSync(old, { force: true });
  setGameState(gameId, { customCover: dest });
  return { ok: true };
});

// ----- the player's own cover picture -----

ipcMain.handle("cover:choose", async (event, { gameId }) => {
  if (!lastLibrary.has(gameId)) throw new Error("Unknown game -- refresh the library and try again.");
  const pick = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a cover picture",
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    properties: ["openFile"],
  });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false };

  const source = pick.filePaths[0];
  const ext = path.extname(source).toLowerCase() || ".png";
  // A new file name each time, so the window doesn't keep showing a cached older picture.
  const dest = path.join(coversDir(), `${sanitizeFileName(gameId)}-custom-${Date.now()}${ext}`);
  fs.copyFileSync(source, dest);

  const old = gameState(gameId).customCover;
  if (old && old !== dest) fs.rmSync(old, { force: true });
  setGameState(gameId, { customCover: dest });
  return { ok: true };
});

ipcMain.handle("cover:reset", async (event, { gameId }) => {
  const old = gameState(gameId).customCover;
  if (old) fs.rmSync(old, { force: true });
  setGameState(gameId, { customCover: null });
  return { ok: true };
});

// Description, genres, screenshots, banner and logo for the game page. Cached on
// disk, and never throws: a game with no info just gets an empty result.
ipcMain.handle("game:details", async (event, { gameId }) => {
  const game = lastLibrary.get(gameId);
  if (!game) throw new Error("Unknown game -- refresh the library and try again.");
  const apiKey = config.get("steamGridDbApiKey");
  let meta;
  try {
    meta = await fetchGameMetadata(await withArtMatch(game), { apiKey, cacheDir: metadataDir(), artDir: coversDir() });
  } catch (err) {
    console.error(`Metadata lookup failed for "${game.name}":`, err.message);
    meta = emptyMetadata();
  }
  const c = matchChoice(gameId);
  return {
    ...applyOverrides(meta, game.metadata),
    // what the "fix match" screen needs to know
    choice: { steam: c.steam === undefined ? "auto" : c.steam, sgdb: c.sgdb === undefined ? "auto" : c.sgdb },
    hasArtKey: !!apiKey,
  };
});

// ----- game manuals (PDFs) -----
// GOG puts manuals in the game's folder, so installed games are searched for PDFs. PDFs that sit with
// the game on the server are offered too, and downloaded when opened. They open in a viewer window
// of their own (Electron's built-in PDF viewer).

const manualsDir = () => path.join(userDataDir(), "manuals");
const MANUAL_LIKELY = /manual|guide|handbook|instruction|booklet|quick.?start|reference|controls?|keyboard|walkthrough|lore|artbook|codex|map|strategy|cheat/i;
const MANUAL_SKIP = /eula|licen[sc]e|third.?party|notice|redist|vcredist|directx|dotnet|privacy|terms|copyright|attribution|credits?|changelog|release.?notes/i;
const MANUAL_SKIP_DIRS = /^(__|\.)|redist|directx|dotnet|vcredist|node_modules|licenses?$/i;

function manualLabel(file) {
  let name = path.posix.basename(file).replace(/\.pdf$/i, "").replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  if (name && name === name.toLowerCase()) name = name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return name || "Manual";
}

function findPdfs(root, maxDepth = 4, cap = 300) {
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= cap) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= cap) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !MANUAL_SKIP_DIRS.test(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && /\.pdf$/i.test(e.name)) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* unreadable: still listed */
        }
        found.push({ rel: path.relative(root, full).split(path.sep).join("/"), size });
      }
    }
  };
  walk(root, 0);
  return found;
}

// Keeps what looks like a manual. When nothing is clearly one, a few of the others are offered.
function chooseManuals(items) {
  const usable = items.filter((m) => !MANUAL_SKIP.test(m.key));
  const likely = usable.filter((m) => MANUAL_LIKELY.test(m.key));
  const chosen = likely.length ? likely : usable.slice(0, 6);
  return chosen.sort((a, b) => a.label.localeCompare(b.label)).slice(0, 15);
}

ipcMain.handle("manuals:list", (event, { gameId }) => {
  const game = lastLibrary.get(gameId);
  if (!game) return [];
  const items = [];
  const gs = gameState(gameId);
  if (gs.installed && gs.installPath && fs.existsSync(gs.installPath)) {
    for (const f of findPdfs(gs.installPath)) items.push({ source: "installed", key: f.rel, label: manualLabel(f.rel), size: f.size });
  }
  for (const f of [...(game.manuals || []), ...(game.files || [])]) {
    if (/\.pdf$/i.test(f.filename)) items.push({ source: "server", key: f.filename, label: manualLabel(f.filename), size: f.size || 0 });
  }
  // the same manual in both places: the installed copy wins
  const seen = new Set();
  const unique = items.filter((m) => {
    const k = path.posix.basename(m.key).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return chooseManuals(unique);
});

const manualWindows = new Map();

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// The PDF itself is drawn by Chromium's built-in viewer (PDFium). It can't be restyled, so it sits inside a small
// page of our own: a dark title bar matching the launcher, with the viewer filling the rest of the window.
function manualShell(file, title) {
  const dir = path.join(manualsDir(), "_viewer");
  fs.mkdirSync(dir, { recursive: true });
  const shell = path.join(dir, crypto.createHash("sha1").update(file).digest("hex").slice(0, 16) + ".html");
  const src = pathToFileURL(file).href + "#toolbar=1&navpanes=0&zoom=100";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
html,body{margin:0;height:100%;background:#0e1015;color:#e8eaf0;font:13px/1 "Segoe UI",system-ui,sans-serif;overflow:hidden}
header{display:flex;align-items:center;gap:10px;height:40px;padding:0 150px 0 16px;box-sizing:border-box;background:#14171f;border-bottom:1px solid #262b3a;-webkit-app-region:drag;user-select:none}
.badge{flex:none;padding:3px 6px;border-radius:5px;background:#262b3a;color:#9aa3b8;font-size:10px;font-weight:700;letter-spacing:.06em}
.t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
iframe{display:block;width:100%;height:calc(100% - 41px);border:0;background:#0e1015}
</style></head><body><header><span class="badge">MANUAL</span><span class="t">${escapeHtml(title)}</span></header><iframe src="${escapeHtml(src)}"></iframe></body></html>`;
  fs.writeFileSync(shell, html);
  return shell;
}

function showManual(file, title) {
  const open = manualWindows.get(file);
  if (open && !open.isDestroyed()) {
    open.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1000,
    height: 840,
    title,
    backgroundColor: "#0e1015",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#14171f", symbolColor: "#e8eaf0", height: 40 },
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.on("page-title-updated", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  manualWindows.set(file, win);
  win.on("closed", () => manualWindows.delete(file));
  win.loadFile(manualShell(file, title));
}

ipcMain.handle("manuals:open", async (event, { gameId, source, key }) => {
  const game = lastLibrary.get(gameId);
  if (!game) throw new Error("Unknown game -- refresh the library and try again.");
  let file;
  let label = manualLabel(String(key));

  if (source === "installed") {
    const root = gameState(gameId).installPath;
    if (!root) throw new Error("This game isn't installed.");
    const full = path.resolve(root, ...String(key).split("/"));
    const inside = (p) => p === root || p.startsWith(root + path.sep);
    if (!inside(full) || !/\.pdf$/i.test(full) || !fs.existsSync(full)) throw new Error("That manual isn't there any more.");
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(full); // a link pointing out of the game's folder is refused
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) throw new Error("That manual isn't inside the game's folder.");
    file = full;
  } else if (source === "server") {
    const entry = [...(game.manuals || []), ...(game.files || [])].find((f) => f.filename === key && /\.pdf$/i.test(f.filename));
    if (!entry) throw new Error("The server doesn't list that manual any more.");
    const dest = path.join(manualsDir(), sanitizeFileName(gameId), path.posix.basename(entry.filename));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!(entry.size && fs.existsSync(dest) && fs.statSync(dest).size === entry.size)) {
      const url = `${serverBase()}/api/games/${encodeURIComponent(gameId)}/files/${encodeURIComponent(entry.filename)}`;
      await downloadFile(url, dest, () => {});
    }
    if (entry.sha256 && (await hashFile(dest)) !== entry.sha256) {
      fs.rmSync(dest, { force: true });
      throw new Error("The downloaded manual didn't match the server's copy. Try again.");
    }
    file = dest;
  } else {
    throw new Error("Unknown manual source");
  }
  showManual(file, `${game.name || gameId} - ${label}`);
  return { ok: true };
});

// ----- fixing a wrong match -----

// Candidates for the "pick the right game" list.
ipcMain.handle("meta:search", async (event, { gameId, dlcId, source, term }) => {
  const q = String(term || "").trim();
  if (!q) return { results: [] };
  if (source === "steam" && dlcId) {
    // The game's own DLC on Steam come first, best match on top, then the general search.
    const game = lastLibrary.get(gameId);
    const results = [];
    try {
      let baseAppId = game ? withChoice(game).steamAppId : null;
      if (!baseAppId) {
        const base = JSON.parse(fs.readFileSync(cacheFileFor(metadataDir(), gameId), "utf8"));
        baseAppId = base && base.data ? base.data.steamAppId : null;
      }
      if (baseAppId) {
        const names = [game.name];
        const list = await listSteamDlc(baseAppId, fetchJson);
        list
          .map((d) => ({ d, sc: dlcScore(q, d.name, names) }))
          .sort((a, b) => b.sc - a.sc)
          .forEach(({ d }) => results.push({ id: d.id, name: d.name, image: null, detail: "DLC of this game" }));
      }
    } catch {
      /* no saved info or no internet: the plain search below still works */
    }
    const seen = new Set(results.map((r) => r.id));
    for (const r of await searchSteam(q)) if (!seen.has(r.id)) results.push(r);
    return { results };
  }
  if (source === "steam") return { results: await searchSteam(q) };
  if (source === "steamgriddb") {
    const apiKey = config.get("steamGridDbApiKey");
    if (!apiKey) return { results: [], needsKey: true };
    return { results: await searchSgdb(q, apiKey) };
  }
  throw new Error("Unknown source");
});

// choice: a positive id, "none" (no right match), or "auto" (back to automatic).
ipcMain.handle("meta:choose", async (event, { gameId, source, choice }) => {
  if (!lastLibrary.has(gameId)) throw new Error("Unknown game -- refresh the library and try again.");
  const key = source === "steam" ? "steam" : source === "steamgriddb" ? "sgdb" : null;
  if (!key) throw new Error("Unknown source");

  const current = { ...matchChoice(gameId) };
  if (choice === "auto") delete current[key];
  else if (choice === "none") current[key] = "none";
  else if (Number.isInteger(choice) && choice > 0) current[key] = choice;
  else throw new Error("Invalid choice");
  setGameState(gameId, { metaChoice: current });

  // What was saved belonged to the old match.
  fs.rmSync(cacheFileFor(metadataDir(), gameId), { force: true });
  clearArt(coversDir(), gameId); // the Steam match decides the artwork too, unless SteamGridDB was set by hand
  return { ok: true };
});

// Look everything up again. If that can't be done (no internet), what's saved stays.
ipcMain.handle("meta:refresh", async (event, { gameId }) => {
  const game = lastLibrary.get(gameId);
  if (!game) throw new Error("Unknown game -- refresh the library and try again.");
  const apiKey = config.get("steamGridDbApiKey");
  const eff = await withArtMatch(game);
  await fetchCoverArt(game.name, game.id, apiKey, coversDir(), { sgdbId: eff.sgdbId, disabled: eff.skipSgdb, force: true });
  await fetchGameMetadata(eff, { apiKey, cacheDir: metadataDir(), artDir: coversDir(), force: true });
  return { ok: true };
});

// Is there room for this game? Downloads and installs can be on different drives.
// Files already downloaded (fully or partly) don't need space again.
ipcMain.handle("disk:check", (event, { gameId }) => {
  const game = lastLibrary.get(gameId);
  if (!game) return { ok: true, message: null };

  // A portable game downloads straight into the install folder, so that's where progress already made is.
  const dlDir = game.portable
    ? path.join(config.get("installRoot"), sanitizeFileName(game.name || gameId))
    : path.join(downloadsDir(), gameId);
  const remaining = (game.files || []).reduce((sum, f) => {
    const rel = f.filename.split("/");
    const have = [path.join(dlDir, ...rel), path.join(dlDir, ...rel.slice(0, -1), `${rel[rel.length - 1]}.part`)]
      .map((p) => (fs.existsSync(p) ? fs.statSync(p).size : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    return sum + Math.max(0, (f.size || 0) - have);
  }, 0);

  const installRoot = config.get("installRoot");
  const disks = {
    downloads: { key: driveKey(downloadsDir()), free: freeBytes(downloadsDir()) },
    install: { key: driveKey(installRoot), free: freeBytes(installRoot) },
  };
  const result = checkSpace(
    game.portable ? { ...game.sizes, download: 0, install: remaining } : { ...game.sizes, download: remaining },
    disks
  );
  return {
    ok: result.ok,
    message: result.message,
    sameDrive: result.sameDrive,
    downloadsFree: disks.downloads.free,
    installFree: disks.install.free,
    downloadsDrive: driveLabel(disks.downloads.key),
    installDrive: driveLabel(disks.install.key),
  };
});

// Downloads a set of files from the server into `destDir`, reporting combined progress,
// and checks each one against the checksum the server published (when it has one).
// Files already fully there are skipped (but still checked), partial ones resume.
// `flatten` puts every file straight in destDir; otherwise sub-folders in the names are kept.
async function downloadSet(gameId, files, destDir, { flatten = false } = {}) {
  const base = serverBase();
  fs.mkdirSync(destDir, { recursive: true });

  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  let completedBytes = 0;

  // Progress goes to the window at most ~4 times a second, with a smoothed
  // speed and time remaining.
  const meter = createSpeedMeter();
  let lastSent = 0;
  const sendProgress = (receivedBytes, { force = false } = {}) => {
    const now = Date.now();
    const speed = meter.sample(receivedBytes, now);
    if (!force && now - lastSent < 250) return;
    lastSent = now;
    const remaining = Math.max(0, totalBytes - receivedBytes);
    mainWindow.webContents.send("game:downloadProgress", {
      gameId,
      receivedBytes,
      totalBytes,
      speedBps: speed,
      etaSec: speed > 0 ? Math.round(remaining / speed) : null,
    });
  };

  for (const file of files) {
    const rel = flatten ? path.posix.basename(file.filename) : file.filename;
    const destPath = path.join(destDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // A file that's already complete or partly there makes the byte counter jump;
    // that isn't download speed, so restart the speed measurement around it.
    meter.rebase();

    if (file.size && fs.existsSync(destPath) && fs.statSync(destPath).size === file.size) {
      completedBytes += file.size;
      sendProgress(completedBytes, { force: true });
    } else {
      const url = `${base}/api/games/${encodeURIComponent(gameId)}/files/${encodeURIComponent(file.filename)}`;
      await downloadFile(url, destPath, ({ receivedBytes }) => sendProgress(completedBytes + receivedBytes));
      completedBytes += file.size || 0;
    }
    await verifyFile(gameId, destPath, file);
  }
  sendProgress(totalBytes, { force: true });
}

// Compares a downloaded file with the server's checksum. A file that doesn't match is
// deleted, so the next try downloads it afresh instead of resuming a bad copy.
async function verifyFile(gameId, destPath, file) {
  if (!file.sha256) return; // the server hasn't worked this one out yet: nothing to compare with
  mainWindow.webContents.send("game:installLog", {
    gameId,
    line: `Checking ${path.posix.basename(file.filename)}…`,
  });
  const actual = await hashFile(destPath);
  if (actual !== file.sha256) {
    fs.rmSync(destPath, { force: true });
    throw new Error(
      withDetails(
        "A downloaded file didn't match the server's copy, so it was discarded. Click Install to download it again.",
        `${file.filename}\nexpected ${file.sha256}\n     got ${actual}`
      )
    );
  }
}

// Downloads every file the server lists for a game (an installer .exe plus any
// .bin parts) into one folder, reporting combined progress. Files that are
// already fully downloaded are skipped, and partial ones resume.
ipcMain.handle("game:download", async (event, { gameId, files }) => {
  if (!files || files.length === 0) throw new Error("The server lists no files for this game.");

  const gameDownloadDir = path.join(downloadsDir(), gameId);
  await downloadSet(gameId, files, gameDownloadDir);

  setGameState(gameId, {
    downloaded: true,
    downloadedFiles: files.map((f) => f.filename),
    downloadDir: gameDownloadDir,
  });

  return { ok: true, path: gameDownloadDir };
});


// ----- portable games -----

// A game that needs no installing: its whole folder is downloaded straight into the
// install location, and the program that starts it is found automatically.
ipcMain.handle("game:installPortable", async (event, { gameId }) => {
  const game = lastLibrary.get(gameId);
  if (!game || !game.portable) throw new Error("Unknown game -- refresh the library and try again.");
  if (!game.files || game.files.length === 0) throw new Error("The server lists no files for this game.");

  const installDir = path.join(config.get("installRoot"), sanitizeFileName(game.name || gameId));
  const log = (line) => mainWindow.webContents.send("game:installLog", { gameId, line });

  try {
    await downloadSet(gameId, game.files, installDir);

    log("Looking for the program that starts the game…");
    let exePath = findPlayExecutable(installDir, game.name, game.playExe);
    let method = "portable";

    if (!exePath) {
      const pick = await dialog.showOpenDialog(mainWindow, {
        title: "Select the program that starts the game",
        defaultPath: installDir,
        filters: [{ name: "Programs", extensions: ["exe"] }],
        properties: ["openFile"],
      });
      if (pick.canceled || !pick.filePaths[0]) {
        throw new Error(
          "The game was downloaded, but no program was found to start it. Click Install again and pick the game's .exe when asked."
        );
      }
      exePath = pick.filePaths[0];
      method = "manual";
    }

    const gs = gameState(gameId);
    setGameState(gameId, {
      installed: true,
      dlcInstalled: {},
      installPath: installDir,
      exePath,
      exeArgs: "",
      detectionMethod: method,
      installError: null,
    });

    try {
      removeShortcutIfExists(gs.shortcutPath);
      const shortcutPath = await createDesktopShortcut(app.getPath("desktop"), game.name || gameId, exePath, path.dirname(exePath));
      setGameState(gameId, { shortcutPath });
    } catch (err) {
      log(`(shortcut not created: ${err.message})`);
    }

    try {
      const bytes = await dirSize(installDir);
      if (bytes > 0) setGameState(gameId, { installedBytes: bytes });
    } catch {
      /* purely informational */
    }
    return { ok: true, exePath };
  } catch (err) {
    setGameState(gameId, { installed: false, installError: err.message });
    throw err;
  }
});


// ----- DLC -----

// Downloads one DLC's files (an installer plus any .bin parts, or a whole DLC
// folder) and unpacks it on top of the installed game. Each DLC gets its own
// download folder, since two DLC can have files with the same name.
ipcMain.handle("dlc:install", async (event, { gameId, dlcId }) => {
  const game = lastLibrary.get(gameId);
  const dlc = game && (game.dlc || []).find((d) => d.id === dlcId);
  if (!dlc) throw new Error("That DLC isn't listed on the server any more. Refresh the library and try again.");

  const gs = withInstallCheck(gameState(gameId));
  if (!gs.installed || !gs.installPath) throw new Error("Install the game first, then add its DLC.");

  const dlDir = path.join(downloadsDir(), gameId, "dlc", sanitizeFileName(dlc.id));
  const log = (line) => mainWindow.webContents.send("game:installLog", { gameId, line });

  // Flat inside the DLC's own folder: an installer looks for its parts beside it.
  await downloadSet(gameId, dlc.files, dlDir, { flatten: true });

  // ---- unpack into the game's folder
  log(`Installing ${dlc.name}…`);
  const installerPath = path.join(dlDir, path.posix.basename(dlc.installer));
  const innoPath = resolveInnoExtractPath();
  const installPath = path.resolve(gs.installPath);

  // Unpack so the DLC's files land exactly where the base game's did. Two layouts exist:
  // the game in <folder>/app (the output folder is then its parent), or the game right in
  // the output folder itself.
  const outputDir = path.basename(installPath).toLowerCase() === "app" ? path.dirname(installPath) : installPath;
  await extractDlcInstaller(installerPath, outputDir, innoPath, log);

  const done = { ...(gameState(gameId).dlcInstalled || {}), [dlc.id]: { name: dlc.name, at: Date.now() } };
  setGameState(gameId, { dlcInstalled: done });

  try {
    fs.rmSync(dlDir, { recursive: true, force: true });
  } catch {
    /* leftovers are cleared by Settings -> Clear downloads */
  }

  // The game is bigger now; let the displayed size follow.
  try {
    const bytes = await dirSize(installPath);
    if (bytes > 0) setGameState(gameId, { installedBytes: bytes });
  } catch {
    /* purely informational */
  }
  return { ok: true };
});

ipcMain.handle("game:install", async (event, { gameId, installerFilename, gameName, options }) => {
  const gs = gameState(gameId);
  const installerPath = path.join(gs.downloadDir || path.join(downloadsDir(), gameId), installerFilename);

  if (!fs.existsSync(installerPath)) {
    throw new Error("Installer file not found on disk -- download it first.");
  }

  const installRoot = config.get("installRoot");
  const installDir = path.join(installRoot, sanitizeFileName(gameName || gameId));
  const innoExtractPath = resolveInnoExtractPath();

  let result;
  try {
    result = await extractGogInstaller(
      installerPath,
      installDir,
      innoExtractPath,
      (line) => {
        mainWindow.webContents.send("game:installLog", { gameId, line });
      },
      {
        installArgs: options && typeof options.installArgs === "string" ? options.installArgs : "",
        silent: options && typeof options.silent === "boolean" ? options.silent : null,
        onProgress: (progress) => mainWindow.webContents.send("game:installProgress", { gameId, ...progress }),
      }
    );
  } catch (err) {
    if (err.code !== "DETECT_FAILED") {
      setGameState(gameId, { installed: false, installError: err.message });
      throw err;
    }

    // The installer ran, but nothing told us where the game went. Ask the user
    // to point at the game's exe rather than leaving the install half-done.
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: "Couldn't find the game automatically -- select the program that starts it",
      defaultPath: err.hintDir && fs.existsSync(err.hintDir) ? err.hintDir : installRoot,
      filters: [{ name: "Programs", extensions: ["exe"] }],
      properties: ["openFile"],
    });
    if (pick.canceled || !pick.filePaths[0]) {
      const msg =
        "The installer finished, but no program was selected to start the game, so it wasn't added as " +
        "installed. Click Install again and pick the game's .exe when asked.";
      setGameState(gameId, { installed: false, installError: msg });
      throw new Error(msg);
    }
    const chosen = pick.filePaths[0];
    result = {
      installPath: path.dirname(chosen),
      exePath: chosen,
      exeArgs: "",
      gameName: null,
      detectionMethod: "manual",
    };
  }

  setGameState(gameId, {
    installed: true,
    dlcInstalled: {}, // a fresh install of the game has none of its DLC yet
    installPath: result.installPath,
    exePath: result.exePath,
    exeArgs: result.exeArgs,
    detectionMethod: result.detectionMethod,
    installError: null,
  });

  // Best-effort: a missing desktop shortcut shouldn't fail the whole install.
  // Any shortcut left from a previous install is replaced rather than
  // duplicated as "Game (2)".
  try {
    removeShortcutIfExists(gs.shortcutPath);
    const shortcutPath = await createDesktopShortcut(
      app.getPath("desktop"),
      gameName || gameId,
      result.exePath,
      path.dirname(result.exePath)
    );
    setGameState(gameId, { shortcutPath });
  } catch (err) {
    mainWindow.webContents.send("game:installLog", { gameId, line: `(shortcut not created: ${err.message})` });
  }

  // The installer files aren't needed once the game is installed, so free the
  // space. Also best-effort: the install itself already succeeded.
  try {
    deleteGameDownloads(gameId);
  } catch (err) {
    mainWindow.webContents.send("game:installLog", {
      gameId,
      line: `(couldn't remove the downloaded installer: ${err.message})`,
    });
  }

  // Remember how big the game really is, so a reinstall can show a measured size
  // instead of an estimate. (Not when the folder was picked by hand: that may
  // be only part of the game.)
  if (result.detectionMethod !== "manual") {
    try {
      const bytes = await dirSize(result.installPath);
      if (bytes > 0) setGameState(gameId, { installedBytes: bytes });
    } catch {
      /* purely informational */
    }
  }

  return result;
});

ipcMain.handle("game:play", async (event, { gameId }) => {
  const gs = gameState(gameId);
  if (!gs.exePath || !fs.existsSync(gs.exePath)) {
    throw new Error("Game executable not found. Try reinstalling.");
  }
  const { spawn } = require("child_process");
  const args = gs.exeArgs ? gs.exeArgs.split(" ") : [];

  // Some older games insist on administrator rights. A plain spawn() can't ask
  // Windows for them, so go through PowerShell, which shows the normal permission prompt.
  if (gs.runAsAdmin && process.platform === "win32") {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const script =
      `try { Start-Process -FilePath ${q(gs.exePath)} -WorkingDirectory ${q(path.dirname(gs.exePath))}` +
      (args.length ? ` -ArgumentList ${q(args.join(" "))}` : "") +
      " -Verb RunAs -ErrorAction Stop } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
    const result = await new Promise((resolve) => {
      let stderr = "";
      const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
      ps.stderr.on("data", (d) => (stderr += d.toString()));
      ps.on("error", (err) => resolve({ code: 1, stderr: err.message }));
      ps.on("exit", (code) => resolve({ code, stderr }));
    });
    if (result.code !== 0) {
      throw new Error(
        /cancel|declin|denied|refus/i.test(result.stderr)
          ? "Windows asked for permission to run the game as administrator, and it was declined."
          : "The game couldn't be started as administrator."
      );
    }
    return { ok: true };
  }

  const child = spawn(gs.exePath, args, {
    cwd: path.dirname(gs.exePath),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true };
});

ipcMain.handle("game:setRunAsAdmin", (event, { gameId, value }) => {
  setGameState(gameId, { runAsAdmin: !!value });
  return { ok: true };
});

ipcMain.handle("game:openInstallFolder", (event, { gameId }) => {
  const gs = gameState(gameId);
  if (gs.installPath && fs.existsSync(gs.installPath)) {
    shell.openPath(gs.installPath);
  }
});

// Manual re-creation, e.g. if the user deleted the shortcut from their desktop.
ipcMain.handle("game:createShortcut", async (event, { gameId, gameName }) => {
  const gs = gameState(gameId);
  if (!gs.exePath || !fs.existsSync(gs.exePath)) {
    throw new Error("This game isn't installed (or its executable is missing), so there's nothing to link to.");
  }

  removeShortcutIfExists(gs.shortcutPath); // replace ours rather than add "(2)"
  const shortcutPath = await createDesktopShortcut(
    app.getPath("desktop"),
    gameName || gameId,
    gs.exePath,
    path.dirname(gs.exePath)
  );
  setGameState(gameId, { shortcutPath });
  return { ok: true, shortcutPath };
});

// Desktops to look on for a game's leftover shortcuts: this user's, and the shared one.
function desktopDirs() {
  const dirs = [app.getPath("desktop")];
  if (process.platform === "win32") dirs.push(path.join(process.env.PUBLIC || "C:\\Users\\Public", "Desktop"));
  return dirs;
}

ipcMain.handle("game:uninstall", async (event, { gameId }) => {
  const gs = gameState(gameId);

  // Only delete inside the install folder this app manages. A game put
  // elsewhere by its own installer (e.g. Program Files) is left alone, since
  // that folder could be shared or need that installer's own uninstaller.
  let leftOnDisk = null;
  let deletedFolder = null;
  if (gs.installPath && fs.existsSync(gs.installPath)) {
    const target = path.resolve(gs.installPath);
    if (isInside(target, config.get("installRoot"))) {
      try {
        // A few retries: antivirus and the just-closed game can hold files for a moment.
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
        deletedFolder = target;
      } catch (err) {
        // Nothing is marked as uninstalled and no shortcut is touched: the game is still there.
        throw new Error(
          withDetails("Couldn't delete all of the game's files. If it's still running, close it and try again.", err.message)
        );
      }
    } else {
      leftOnDisk = target;
    }
  }

  // The shortcut this launcher made, plus any other desktop shortcut that points at
  // the game (the game's own installer often adds one).
  await removeGameShortcuts({
    recorded: gs.shortcutPath,
    dirs: desktopDirs(),
    exePath: gs.exePath,
    folder: deletedFolder,
  });

  setGameState(gameId, {
    installed: false,
    dlcInstalled: {},
    installPath: null,
    exePath: null,
    exeArgs: null,
    detectionMethod: null,
    installError: null,
    shortcutPath: null,
  });

  return { ok: true, leftOnDisk };
});

ipcMain.handle("tools:innoExtractStatus", () => {
  const bundled = bundledInnoExtractPath();
  return { bundled: !!bundled, bundledPath: bundled, override: config.get("innoExtractPath") };
});

ipcMain.handle("downloads:openFolder", () => {
  shell.openPath(downloadsDir());
});

// Forgets everything looked up from Steam and SteamGridDB (descriptions, banners, logos, automatic covers,
// DLC names) so the next look at each game starts from scratch. What the player chose is kept: fixed
// matches, covers picked by hand, and install state.
ipcMain.handle("meta:clearAll", () => {
  for (const dir of [metadataDir(), coversDir()]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (dir === coversDir() && name.includes("-custom-")) continue; // covers the player picked
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
  const games = state.get("games", {});
  Object.keys(games).forEach((id) => {
    delete games[id].dlcTitles;
    delete games[id].artSgdbId;
  });
  state.set("games", games);
  steamToSgdb.clear();
  triedDlcNames.clear();
  scanGeneration++;
  clearMemoryCaches();
  dlcNameLog("saved game info cleared");
  return { ok: true };
});

ipcMain.handle("downloads:clear", () => {
  fs.rmSync(downloadsDir(), { recursive: true, force: true });
  fs.mkdirSync(downloadsDir(), { recursive: true });

  // Downloaded files are gone, so any "downloaded" state pointing at them is stale.
  // Installed games are untouched -- their files live under the install root, not here.
  const games = state.get("games", {});
  Object.keys(games).forEach((id) => {
    games[id].downloaded = false;
    games[id].downloadedFiles = [];
    delete games[id].downloadDir;
  });
  state.set("games", games);

  return { ok: true };
});

