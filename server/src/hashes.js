"use strict";

/**
 * File checksums for the server
 * ------------------------------
 * The launcher checks every file it downloads against a SHA-256 published here, so a
 * damaged or cut-short download is caught before it is unpacked. Hashing a multi-gigabyte
 * game takes a while, so it happens quietly in the background, one file at a time (small
 * files first), and the library listing carries a file's checksum once it is known. Until
 * then the launcher simply skips the check for that file.
 *
 * Results are remembered, keyed by the file's path, size and modification time, so a file
 * is only hashed again if it changes. They are kept in memory and, best effort, in a file
 * in the temp folder (the games folder itself is never written to).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function createHashCache({
  persistPath = path.join(os.tmpdir(), "game-launcher-hashes.json"),
  hashFile = sha256OfFile,
  log = console,
  onIdle = null,
} = {}) {
  let entries = {};
  try {
    const saved = JSON.parse(fs.readFileSync(persistPath, "utf8"));
    if (saved && typeof saved === "object") entries = saved;
  } catch {
    /* first run, or unreadable: start empty */
  }

  const queue = [];
  const queued = new Set();
  let running = null;

  function persist() {
    if (!persistPath) return;
    try {
      fs.writeFileSync(persistPath, JSON.stringify(entries));
    } catch {
      /* temp folder not writable: the in-memory copy still works */
    }
  }

  // The checksum for a file, or null if it isn't known (yet) or the file changed since.
  function lookup(fullPath, size, mtimeMs) {
    const e = entries[fullPath];
    return e && e.size === size && e.mtimeMs === mtimeMs ? e.sha256 : null;
  }

  async function drain() {
    while (queue.length) {
      queue.sort((a, b) => a.size - b.size);
      const job = queue.shift();
      try {
        const before = fs.statSync(job.path);
        const sha256 = await hashFile(job.path);
        const after = fs.statSync(job.path);
        // A file still being copied in changes while we read it: don't trust that result.
        if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
          entries[job.path] = { size: after.size, mtimeMs: after.mtimeMs, sha256 };
          persist();
        }
      } catch (err) {
        log.warn && log.warn(`Couldn't checksum ${job.path}: ${err.message}`);
      }
      queued.delete(job.path);
    }
    running = null;
    if (onIdle) onIdle();
  }

  // Ask for a file's checksum: returns it if known, otherwise queues the work and returns null.
  function request(fullPath, size, mtimeMs) {
    const known = lookup(fullPath, size, mtimeMs);
    if (known) return known;
    if (!queued.has(fullPath)) {
      queued.add(fullPath);
      queue.push({ path: fullPath, size });
      if (!running) running = drain();
    }
    return null;
  }

  return { lookup, request, pending: () => queued.size, idle: () => running || Promise.resolve() };
}

module.exports = { createHashCache, sha256OfFile };
