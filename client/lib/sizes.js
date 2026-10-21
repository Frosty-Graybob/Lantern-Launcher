const fs = require("fs");
const path = require("path");

// Rule of thumb for how big a game is once installed, relative to its
// download, used only when nothing better is known. Installers compress data,
// so the installed game is usually somewhat larger than the download, but by
// how much varies a lot from game to game: this is a guess, not a measurement,
// and is always presented as an estimate.
const INSTALL_RATIO = 1.3;

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Sizes for a library entry:
 *   download  exact: the total of the files the client will fetch
 *   install   best available figure for the installed game
 *   installKind  "set" (installSizeGB in game.json), "measured" (from an
 *                earlier install on this PC) or "estimate" (rule of thumb)
 *   needed    peak space during install: the installer files and the
 *             installed game exist at the same time
 */
function describeSizes(game, measuredInstallBytes) {
  const download = (game.files || []).reduce((sum, f) => sum + (f.size || 0), 0);
  // A portable game has nothing to install: it takes exactly what it downloads, once.
  if (game.portable) return { download, install: download, installKind: "portable", needed: download };
  let install;
  let installKind;
  if (Number.isFinite(game.installSizeGB) && game.installSizeGB > 0) {
    install = Math.round(game.installSizeGB * 1024 ** 3);
    installKind = "set";
  } else if (Number.isFinite(measuredInstallBytes) && measuredInstallBytes > 0) {
    install = Math.round(measuredInstallBytes);
    installKind = "measured";
  } else {
    install = Math.round(download * INSTALL_RATIO);
    installKind = "estimate";
  }
  return { download, install, installKind, needed: download + install };
}

// Free bytes on the drive holding `dir` (or its nearest existing parent), or
// null if it can't be determined.
function freeBytes(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 32; i++) {
    try {
      const s = fs.statfsSync(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const parent = path.dirname(d);
      if (parent === d) return null;
      d = parent;
    }
  }
  return null;
}

// Identifies the drive/volume a folder is on, so two folders can be compared.
function driveKey(dir) {
  return path.parse(path.resolve(dir)).root.toLowerCase();
}

function driveLabel(key) {
  return /^[a-z]:[\\/]?$/.test(key) ? key.slice(0, 2).toUpperCase() : key;
}

/**
 * Does each drive have room? Downloads and the installed game can be on
 * different drives (downloads live in the app's data folder, games in the
 * install folder). If they share a drive, both are needed there at once.
 * `disks` = { downloads: { key, free }, install: { key, free } }, free may be null.
 */
function checkSpace(sizes, disks) {
  const sameDrive = !!disks.downloads.key && disks.downloads.key === disks.install.key;
  const needs = sameDrive
    ? [{ where: "both", key: disks.install.key, need: sizes.download + sizes.install, free: disks.install.free }]
    : [
        { where: "downloads", key: disks.downloads.key, need: sizes.download, free: disks.downloads.free },
        { where: "install", key: disks.install.key, need: sizes.install, free: disks.install.free },
      ];
  const shortages = needs.filter((n) => Number.isFinite(n.free) && n.need > n.free);
  const message = shortages.length
    ? shortages
        .map((s) => {
          const purpose =
            s.where === "both" ? "the download plus the install" : s.where === "downloads" ? "the download" : "the install";
          // The download size is exact; anything that includes the install may be a guess.
          const about = sizes.installKind === "estimate" && s.where !== "downloads" ? "about " : "";
          return `${driveLabel(s.key)} has ${formatBytes(s.free)} free, but ${purpose} needs ${about}${formatBytes(s.need)}.`;
        })
        .join(" ")
    : null;
  return { sameDrive, needs, shortages, ok: shortages.length === 0, message };
}

module.exports = { INSTALL_RATIO, formatBytes, describeSizes, freeBytes, driveKey, driveLabel, checkSpace };
