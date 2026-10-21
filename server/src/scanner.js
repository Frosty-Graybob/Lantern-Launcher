/**
 * Library scanner
 * ----------------
 * Every sub-folder of the library root that contains at least one .exe is
 * treated as a game. Nothing needs to be registered anywhere -- drop a
 * folder in, and it shows up the next time the client refreshes.
 *
 *   library/
 *     Cyberpunk 2077/
 *       setup_cyberpunk_2077_2.13_(64bit)_(12345).exe   <- run by the client
 *       setup_cyberpunk_2077_2.13_(64bit)_(12345)-1.bin  <- downloaded alongside
 *     stardew-valley/
 *       setup_stardew_valley_1.5.6.exe
 *
 * Optional: put a game.json in a game's folder to override anything that
 * was auto-detected:  { "name": "...", "gogId": "...", "version": "...", "notes": "...", "installer": "Setup.exe", "portable": true, "playExe": "bin/Game.exe" }
 */

const fs = require("fs");
const path = require("path");

// Files that should never be offered for download.
const IGNORED_FILES = /^(\.|thumbs\.db$|desktop\.ini$|game\.json$)|\.(part|crdownload|tmp)$/i;

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "game"
  );
}

function prettifyName(folderName) {
  return folderName
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// GOG-style names look like setup_game_name_1.2.3_(64bit)_(12345).exe
function parseVersion(filename) {
  const match = /_v?(\d+(?:\.\d+){1,3})/.exec(filename || "");
  return match ? match[1] : null;
}

/**
 * Decide which .exe files are real installers and in what order to prefer
 * them. The client runs the first one. Preference, best first:
 *   1. setup_*            (GOG's convention)
 *   2. anything with "setup" or "install" in its name (SonicRidersSetup.exe,
 *      setup.exe, install.exe) -- typical of disc-style installers
 *   3. everything else
 * Never patches. Launchers, autorun menus, uninstallers and redistributable
 * helpers (DirectX, Visual C++) are pushed to the very end, since running one
 * of those instead of the installer does nothing useful. Within a group the
 * shortest name wins -- DLC installers tend to extend the base game's file
 * name, so the base game sorts ahead of them.
 */
const NOT_AN_INSTALLER = /launcher|autorun|unins|uninst|dxsetup|directx|vcredist|redist|dotnet|physx/i;

function installerRank(name) {
  if (NOT_AN_INSTALLER.test(name)) return 3;
  if (/^setup_.+?_-_/i.test(name)) return 0.5; // GOG marks DLC with "_-_" after the game's name
  if (/^setup_/i.test(name)) return 0;
  if (/setup|install/i.test(name)) return 1;
  return 2;
}

function pickInstallers(exeNames) {
  const notPatch = exeNames.filter((n) => !/patch/i.test(n));
  const pool = notPatch.length ? notPatch : exeNames;
  return [...pool].sort(
    (a, b) => installerRank(a) - installerRank(b) || a.length - b.length || a.localeCompare(b)
  );
}

// Optional game.json fields, validated so a typo can't send junk to the client.
const asId = (v) => {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? parseInt(v, 10) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
};
// First argument that isn't undefined/null (what `a ?? b` does, without needing a recent Node).
const firstDefined = (a, b) => (a !== undefined && a !== null ? a : b);
const asText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const asList = (v) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
    : asText(v)
      ? [asText(v)]
      : [];

// Details typed by hand (shown in the client's game page, and winning over
// anything fetched from the web).
function pickMetadata(o) {
  const m = {
    description: asText(o.description),
    developers: asList(firstDefined(o.developer, o.developers)),
    publishers: asList(firstDefined(o.publisher, o.publishers)),
    genres: asList(firstDefined(o.genres, o.genre)),
    releaseDate: asText(o.releaseDate),
  };
  return Object.values(m).some((v) => (Array.isArray(v) ? v.length : v)) ? m : null;
}

function readOverrides(dir) {
  const overridePath = path.join(dir, "game.json");
  if (!fs.existsSync(overridePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(overridePath, "utf-8"));
    // Only a JSON object makes sense here; `null`, a list or a bare value is ignored.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    console.warn(`Ignoring ${overridePath}: it should contain a JSON object like { "name": "..." }`);
    return {};
  } catch (err) {
    console.warn(`Ignoring unreadable ${overridePath}: ${err.message}`);
    return {};
  }
}

// Size of a file, or null if it can't be read right now (deleted mid-scan, locked,
// no permission). A file like that is simply left out rather than failing the scan.
function fileInfo(dir, entry) {
  try {
    const st = fs.statSync(path.join(dir, entry.name));
    return { filename: entry.name, size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    console.warn(`Skipping ${path.join(dir, entry.name)}: ${err.message}`);
    return null;
  }
}


// ------------------------------------------------------------------ DLC
//
// Two layouts are understood, and they can be mixed:
//
//   A. DLC installers sitting in the game's own folder (GOG's usual layout):
//        A Hat in Time/setup_a_hat_in_time_2025_update_2_(64bit)_(83345).exe        <- the game
//        A Hat in Time/setup_a_hat_in_time_-_seal_the_deal_2025_update_2_(83345).exe <- DLC
//      A setup_* file counts as DLC when its name starts with the game's name
//      (the base installer's name up to its version) followed by a word, not a
//      version number.
//
//   B. DLC in a sub-folder whose name says so (DLC, DLCs, Add-ons, Expansions,
//      Bonus), either with installers directly inside, or one sub-folder per DLC:
//        Game/DLC/setup_game_-_extra_1.0.exe
//        Game/DLC/Extra Levels/setup.exe
//
// A DLC's files travel with it (an installer's -1.bin, -2.bin parts, or the
// whole per-DLC sub-folder), and are left out of the base game's own files so
// installing the game doesn't download every DLC.

// Where a GOG file name stops being the title and starts being the version/build: "_1.0.2", "_v1", "_(", a build id, or a year.
const VERSION_START = /_(?:v\d|\d+\.\d|\(|\d{5,}|(?:199\d|20[0-3]\d)(?:_|$))/i; // 5+ digits: a build id; 1990-2039: a year

const DLC_FOLDER = /(^|[\s_.\-])(dlcs?|add-?ons?|expansions?|bonus)([\s_.\-]|$)/i;

// "setup_a_hat_in_time_2025_update_2_(64bit)_(83345).exe" -> "a_hat_in_time"
function gameStem(installerName) {
  const bare = installerName.replace(/\.exe$/i, "").replace(/^setup_/i, "");
  // the title ends where the version starts; a number that is part of the title ("cyberpunk_2077") stays
  const cut = bare.search(VERSION_START);
  return (cut > 0 ? bare.slice(0, cut) : bare).toLowerCase();
}

function isSiblingDlc(baseName, candidate) {
  if (candidate === baseName || !/^setup_/i.test(candidate) || /patch/i.test(candidate)) return false;
  const prefix = `setup_${gameStem(baseName)}_`;
  const lower = candidate.toLowerCase();
  if (!lower.startsWith(prefix)) return false;
  return !/^v?\d/.test(lower.slice(prefix.length)); // "…_2.1" is another version, not a DLC
}

// Readable DLC name from an installer file name (or its folder as a fallback).
// GOG names look like setup_<game>_-_<dlc name>_<version>_(<build>).exe. The name stops where the
// version starts: a dotted number ("_1.0.2"), "_v1", a "(" or a long number (build ids, dates).
// A short plain number ("episode_2") is part of the name and stays. `keepAll` stops only at "(",
// for telling apart DLC whose shortened names came out the same.
function dlcName(installerName, base, fallback, keepAll = false) {
  let bare = installerName.replace(/\.exe$/i, "").replace(/^setup_/i, "");
  if (base) {
    const stem = gameStem(base);
    if (bare.toLowerCase().startsWith(stem)) bare = bare.slice(stem.length).replace(/^_-_|^_+/, "");
  }
  const cut = bare.search(keepAll ? /_\(/ : VERSION_START);
  bare = cut > 0 ? bare.slice(0, cut) : bare;
  // "…_1_0_0_5" is a version written with underscores: drop a trailing run of two or more numbers
  bare = bare.replace(/(?:_\d{1,3}){2,}$/, "");
  const name = prettifyName(bare);
  return /^(setup|install|installer)?$/i.test(name.replace(/\s/g, "")) ? prettifyName(fallback || "DLC") : name;
}

// Multi-part installers: setup_x.exe goes with setup_x-1.bin, setup_x-2.bin, ...
function partsOf(exeName, files) {
  const stem = exeName.replace(/\.exe$/i, "").toLowerCase() + "-";
  return files.filter((f) => f.filename.toLowerCase().startsWith(stem) && /\.bin$/i.test(f.filename));
}

function makeDlc(usedDlcIds, name, installerRel, fileList) {
  const baseId = slugify(name);
  let id = baseId;
  let n = 2;
  while (usedDlcIds.has(id)) id = `${baseId}-${n++}`;
  usedDlcIds.add(id);
  const files = fileList.map((f) => ({ filename: f.filename, size: f.size, mtimeMs: f.mtimeMs }));
  return { id, name, version: parseVersion(installerRel), installer: installerRel, files };
}

// Lists the plain files of a folder (relative names use "/", whatever the OS).
function filesIn(dir, relPrefix) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files: [], dirs: [] };
  }
  const files = entries
    .filter((e) => e.isFile() && !IGNORED_FILES.test(e.name))
    .map((e) => fileInfo(dir, e))
    .filter(Boolean)
    .map((f) => ({ ...f, filename: relPrefix + f.filename }));
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  return { files, dirs };
}

// Finds all DLC for a game. Returns { dlc, claimed }, where `claimed` is the set
// of top-level file names that belong to DLC and so aren't the base game's.
function findDlc(dir, topFiles, exeNames, baseName) {
  const dlc = [];
  const claimed = new Set();
  const usedIds = new Set();

  // A. installers beside the game's own
  for (const exe of exeNames.filter((n) => isSiblingDlc(baseName, n))) {
    const parts = partsOf(exe, topFiles);
    const mine = [topFiles.find((f) => f.filename === exe), ...parts];
    mine.forEach((f) => claimed.add(f.filename));
    dlc.push(makeDlc(usedIds, dlcName(exe, baseName), exe, mine));
  }

  // B. DLC folders
  const top = filesIn(dir, "");
  for (const folder of top.dirs.filter((d) => DLC_FOLDER.test(d))) {
    const rel = `${folder}/`;
    const inside = filesIn(path.join(dir, folder), rel);

    // installers directly in the DLC folder: one DLC each, with their parts
    const insideExes = inside.files.map((f) => f.filename).filter((n) => /\.exe$/i.test(n) && !/patch/i.test(n));
    for (const exeRel of insideExes) {
      const exe = exeRel.slice(rel.length);
      const parts = partsOf(exeRel, inside.files);
      const mine = [inside.files.find((f) => f.filename === exeRel), ...parts];
      dlc.push(makeDlc(usedIds, dlcName(exe, baseName, folder), exeRel, mine));
    }

    // one sub-folder per DLC: the whole sub-folder is that DLC
    for (const sub of inside.dirs) {
      const subRel = `${rel}${sub}/`;
      const content = filesIn(path.join(dir, folder, sub), subRel);
      const names = content.files.map((f) => f.filename.slice(subRel.length)).filter((n) => /\.exe$/i.test(n));
      if (names.length === 0) continue;
      const installer = pickInstallers(names)[0];
      dlc.push(makeDlc(usedIds, prettifyName(sub), subRel + installer, content.files));
    }
  }

  // DLC whose names came out the same (a number or word was cut off) get their longer names back.
  const counts = new Map();
  for (const d of dlc) counts.set(d.name, (counts.get(d.name) || 0) + 1);
  if ([...counts.values()].some((n) => n > 1)) {
    for (const d of dlc) {
      if (counts.get(d.name) < 2) continue;
      const file = d.installer.split("/").pop();
      const longer = dlcName(file, baseName, d.name, true);
      if (longer && longer !== d.name) d.name = longer;
    }
    const ids = new Set();
    for (const d of dlc) {
      const baseId = slugify(d.name);
      let id = baseId;
      let n = 2;
      while (ids.has(id)) id = `${baseId}-${n++}`;
      ids.add(id);
      d.id = id;
    }
  }

  dlc.sort((a, b) => a.name.localeCompare(b.name));
  return { dlc, claimed };
}


// ------------------------------------------------------------------ portable games
//
// A "portable" game has nothing to install: it's the game's own folder, already set up
// (a DRM-free copy, an unpacked archive). The launcher downloads the whole folder, with
// its sub-folders, straight into the install location and finds the program to start.
//
// A folder is portable when none of its programs looks like an installer, going by:
//   - the name (setup_*, *setup*, *install*), or
//   - what's inside: the signature strings of Inno Setup, NSIS, InstallShield, WiX and MSI.
// A game.json can force the answer: { "portable": true } or { "portable": false }.

const MAX_PORTABLE_FILES = 20000;
const MAX_PORTABLE_DEPTH = 10;
const signatureCache = new Map(); // path|size|mtime -> boolean

function hasInstallerSignature(filePath, size, mtimeMs) {
  const key = `${filePath}|${size}|${mtimeMs}`;
  if (signatureCache.has(key)) return signatureCache.get(key);
  let found = false;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const headLen = Math.min(size, 4 * 1024 * 1024);
      const head = Buffer.alloc(headLen);
      fs.readSync(fd, head, 0, headLen, 0);
      const chunks = [head];
      if (size > headLen) {
        const tailLen = Math.min(size - headLen, 1024 * 1024);
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, size - tailLen);
        chunks.push(tail);
      }
      found = chunks.some(
        (buf) =>
          ["Nullsoft Install System", "NullsoftInst", "Inno Setup", "InstallShield", ".wixburn"].some((sig) =>
            buf.includes(Buffer.from(sig, "latin1"))
          ) ||
          (buf.length >= 4 && buf.readUInt32BE(0) === 0xd0cf11e0) // an .msi
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    found = false;
  }
  signatureCache.set(key, found);
  return found;
}

function isPortable(dir, exeNames, files, overrides) {
  if (typeof overrides.portable === "boolean") return overrides.portable;
  for (const name of exeNames) {
    const rank = installerRank(name);
    if (rank <= 1) return false; // setup_*, *setup*, *install*
    if (rank === 2) {
      const f = files.find((x) => x.filename === name);
      if (f && hasInstallerSignature(path.join(dir, name), f.size, f.mtimeMs)) return false;
    }
  }
  return true;
}

// Every file under a game's folder, as relative "/" paths, for downloading the whole thing.
function listAllFiles(dir) {
  const out = [];
  const walk = (current, rel, depth) => {
    if (out.length >= MAX_PORTABLE_FILES || depth > MAX_PORTABLE_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_PORTABLE_FILES) return;
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) walk(path.join(current, e.name), `${rel}${e.name}/`, depth + 1);
      } else if (e.isFile() && !IGNORED_FILES.test(e.name)) {
        const info = fileInfo(current, e);
        if (info) out.push({ ...info, filename: `${rel}${e.name}` });
      }
    }
  };
  walk(dir, "", 0);
  return out;
}

// ---- manuals ------------------------------------------------------------------
// PDFs that belong to a game but aren't part of installing it: the ones beside the installer, and the
// ones in a folder named like Manual, Manuals, Docs, Documentation, Guides, Extras or Bonus (a few
// levels down at most). They're listed apart from the game's files so installing doesn't download
// them; the launcher fetches one only when the player opens it.
const MANUAL_FOLDER = /(^|[\s_.\-])(manuals?|docs?|documentation|guides?|handbooks?|booklets?|extras?|bonus|goodies|goodie|supplemental|artbooks?)([\s_.\-]|$)/i;
const MAX_MANUAL_DEPTH = 3;
const isPdf = (name) => /\.pdf$/i.test(name);

function findManuals(dir, topFiles) {
  const manuals = topFiles.filter((f) => isPdf(f.filename)).map((f) => ({ ...f }));
  const walk = (current, rel, depth, inside) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (depth < MAX_MANUAL_DEPTH) walk(path.join(current, e.name), `${rel}${e.name}/`, depth + 1, inside || MANUAL_FOLDER.test(e.name));
      } else if (inside && e.isFile() && isPdf(e.name) && !IGNORED_FILES.test(e.name)) {
        const info = fileInfo(current, e);
        if (info) manuals.push({ ...info, filename: `${rel}${e.name}` });
      }
    }
  };
  walk(dir, "", 0, false);
  return manuals.slice(0, 60);
}

// One game folder -> a game entry, or null if it isn't a game (no installer yet).
function scanGameFolder(root, folder, usedIds) {
  const dir = path.join(root, folder);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // unreadable folder, skip it
  }

  const files = entries
    .filter((e) => e.isFile() && !IGNORED_FILES.test(e.name))
    .map((e) => fileInfo(dir, e))
    .filter(Boolean);

  const exeNames = files.map((f) => f.filename).filter((n) => /\.exe$/i.test(n));
  // No program at the top level: it may still be a portable game with its program in a
  // sub-folder (Game/bin/Game.exe). Otherwise there's nothing installable in here yet.
  let nestedFiles = null;
  if (exeNames.length === 0) {
    nestedFiles = listAllFiles(dir);
    if (!nestedFiles.some((f) => /\.exe$/i.test(f.filename))) return null;
  }

  const overrides = readOverrides(dir);
  const portable = nestedFiles ? overrides.portable !== false : isPortable(dir, exeNames, files, overrides);
  if (portable) {
    // Name, id and the optional game.json details work the same as for any game.
    const baseId = slugify(folder);
    let id = baseId;
    let n = 2;
    while (usedIds.has(id)) id = `${baseId}-${n++}`;
    usedIds.add(id);
    return {
      id,
      dir,
      name: asText(overrides.name) || prettifyName(folder),
      gogId: overrides.gogId || null,
      version: asText(overrides.version),
      notes: overrides.notes || null,
      installArgs: null,
      steamAppId: asId(overrides.steamAppId),
      sgdbId: asId(overrides.sgdbId),
      installSizeGB: null,
      metadata: pickMetadata(overrides),
      silent: null,
      portable: true,
      // Which program starts the game, relative to the folder (optional; found automatically otherwise).
      playExe: asText(overrides.playExe),
      installers: [],
      files: nestedFiles || listAllFiles(dir),
      manuals: [], // a portable game's manuals are inside its own files
      dlc: [],
    };
  }
  const installerNames = pickInstallers(exeNames);
  // game.json { "installer": "MySetup.exe" } pins the installer when the automatic pick is wrong.
  if (typeof overrides.installer === "string") {
    const pinned = exeNames.find((n) => n.toLowerCase() === overrides.installer.trim().toLowerCase());
    if (pinned) installerNames.splice(0, installerNames.length, pinned, ...installerNames.filter((n) => n !== pinned));
  }
  const { dlc, claimed } = findDlc(dir, files, exeNames, installerNames[0]);
  // game.json may describe a DLC: { "dlc": { "seal-the-deal": { "steamAppId": 123, "description": "..." } } }
  // (keyed by the DLC's id or its name as the launcher shows it).
  for (const d of dlc) {
    const o = overrides.dlc && typeof overrides.dlc === "object" ? overrides.dlc[d.id] || overrides.dlc[d.name] : null;
    if (!o || typeof o !== "object") continue;
    if (asText(o.name)) d.name = asText(o.name);
    d.steamAppId = asId(o.steamAppId);
    d.metadata = pickMetadata(o);
  }
  const manuals = findManuals(dir, files);
  const baseFiles = files.filter((f) => !claimed.has(f.filename) && !isPdf(f.filename));
  const installers = installerNames
    .filter((n) => !claimed.has(n))
    .map((n) => baseFiles.find((f) => f.filename === n))
    .filter(Boolean);

  // Stable, filesystem-safe id derived from the folder name.
  const baseId = slugify(folder);
  let id = baseId;
  let n = 2;
  while (usedIds.has(id)) id = `${baseId}-${n++}`;
  usedIds.add(id);

  return {
    id,
    dir,
    name: asText(overrides.name) || prettifyName(folder),
    gogId: overrides.gogId || null,
    version: asText(overrides.version) || parseVersion(installerNames[0]),
    notes: overrides.notes || null,
    // Optional command-line switches for installers that aren't Inno Setup,
    // e.g. "/S" for a silent NSIS install. See library/README.txt.
    installArgs: typeof overrides.installArgs === "string" ? overrides.installArgs : null,
    // Pin the right entry when the automatic name match picks the wrong one.
    steamAppId: asId(overrides.steamAppId),
    sgdbId: asId(overrides.sgdbId),
    // Installed size in GB, if known (otherwise the client estimates).
    installSizeGB:
      typeof overrides.installSizeGB === "number" && overrides.installSizeGB > 0 ? overrides.installSizeGB : null,
    metadata: pickMetadata(overrides),
    // false = never auto-run this game's installer silently (see library/README.txt).
    silent: typeof overrides.silent === "boolean" ? overrides.silent : null,
    installers,
    files: baseFiles,
    manuals,
    dlc,
    portable: false,
    playExe: null,
  };
}

function scanLibrary(root) {
  if (!fs.existsSync(root)) return [];

  let folders;
  try {
    folders = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.warn(`Can't read the library folder ${root}: ${err.message}`);
    return [];
  }

  const usedIds = new Set();
  const games = [];
  for (const folder of folders) {
    try {
      const game = scanGameFolder(root, folder, usedIds);
      if (game) games.push(game);
    } catch (err) {
      // Whatever is wrong with this folder, the rest of the library still works.
      console.warn(`Skipping game folder "${folder}": ${err.message}`);
    }
  }
  return games;
}

module.exports = {
  findManuals, scanLibrary, isPortable, listAllFiles, pickInstallers, isSiblingDlc, gameStem, dlcName, prettifyName, parseVersion, slugify };
