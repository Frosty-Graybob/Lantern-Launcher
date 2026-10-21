"use strict";

/**
 * Game Launcher server core
 * --------------------------
 * One implementation shared by everything that runs the server: the Windows app,
 * the Docker image, and `npm start`. It scans a library folder for games (see
 * scanner.js) and serves:
 *
 *   GET /                                  a status page you can open in a browser
 *   GET /api/library                       the games found, as JSON
 *   GET /api/games/:id/files/:filename     a file, with Range support (resumable)
 *   GET /api/health                        { ok: true }
 *
 * The server only ever reads the library folder.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { EventEmitter } = require("events");
const express = require("express");
const cors = require("cors");
const { scanLibrary } = require("./scanner");
const { createHashCache } = require("./hashes");

const SCAN_CACHE_MS = 3000; // file requests reuse a scan this recent (library listings never do)

// ------------------------------------------------------------------ helpers

// Addresses players could use, most likely first. A PC often has several
// (Wi-Fi, Ethernet, WSL, VPN...), so each comes with the name of its interface.
function networkAddresses() {
  const rank = (a) => {
    if (a.startsWith("192.168.")) return 0;
    if (a.startsWith("10.")) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 2;
    if (a.startsWith("169.254.")) return 4; // self-assigned: no DHCP, rarely useful
    return 3;
  };
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      const v4 = iface.family === "IPv4" || iface.family === 4;
      if (v4 && !iface.internal) out.push({ address: iface.address, name });
    }
  }
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

const reachableAddresses = () => networkAddresses().map((a) => a.address);

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Games as the client sees them (no server-side paths leaked). `checksumOf` gives a file's
// SHA-256 when it's known, so the launcher can verify its downloads.
function publicGame(game, checksumOf) {
  const { dir, ...rest } = game;
  const shape = (f) => ({
    filename: f.filename,
    size: f.size,
    sha256: checksumOf ? checksumOf(dir, f) : null,
  });
  return {
    ...rest,
    files: (game.files || []).map(shape),
    manuals: (game.manuals || []).map(shape),
    dlc: (game.dlc || []).map((d) => ({ ...d, files: (d.files || []).map(shape) })),
  };
}

/**
 * Parses a Range header for a file of `size` bytes.
 * Returns { start, end } for one satisfiable range, "unsatisfiable", or null to
 * ignore the header and send the whole file (no header, or a form we don't do,
 * like several ranges at once, which HTTP allows).
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  let start;
  let end;
  if (a === "") {
    const n = parseInt(b, 10); // the last n bytes
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(a, 10);
    end = b === "" ? size - 1 : Math.min(parseInt(b, 10), size - 1);
  }
  return start >= size || start > end ? "unsatisfiable" : { start, end };
}

// Turns a listen() failure into a message a person can act on.
function explainListenError(err, port, host) {
  const out = new Error(err.message);
  out.code = err.code;
  if (err.code === "EADDRINUSE") {
    out.message = `Port ${port} is already in use. Is the server already running somewhere (another window, a service, or a container)? Close it, or choose a different port.`;
  } else if (err.code === "EACCES") {
    out.message = `Not allowed to use port ${port}. Try a port above 1024.`;
  } else if (err.code === "EADDRNOTAVAIL") {
    out.message = `"${host}" isn't an address of this computer.`;
  }
  return out;
}

// ------------------------------------------------------------------ the server

function createServer(options = {}) {
  let libraryRoot = path.resolve(options.libraryRoot || path.join(process.cwd(), "library"));
  let port = options.port === undefined ? 5155 : options.port;
  const host = options.host || "0.0.0.0";
  const log = options.log || console;

  // Checksums of the files, worked out quietly in the background (see hashes.js).
  const hashes = options.hashCache || createHashCache({ log });
  const checksumOf = (dir, f) => hashes.request(path.join(dir, ...String(f.filename).split("/")), f.size, f.mtimeMs);

  const events = new EventEmitter();
  const stats = { activeDownloads: 0, bytesServed: 0, filesServed: 0, startedAt: null };
  const sockets = new Set();
  let httpServer = null;

  // ---- library scanning
  let cache = { at: 0, root: null, games: [] };
  function scan({ fresh = false } = {}) {
    if (!fresh && cache.root === libraryRoot && Date.now() - cache.at < SCAN_CACHE_MS) return cache.games;
    const games = scanLibrary(libraryRoot);
    cache = { at: Date.now(), root: libraryRoot, games };
    return games;
  }

  // The file being asked for, from the recent scan; if it isn't there, look again
  // (it may have just been added) before saying no.
  function findFile(gameId, filename) {
    const look = (games) => {
      const game = games.find((g) => g.id === gameId);
      // The game's own files, or a file belonging to one of its DLC.
      const allFiles = game ? [...game.files, ...(game.manuals || []), ...(game.dlc || []).flatMap((d) => d.files)] : [];
      const file = allFiles.find((f) => f.filename === filename);
      return file ? { game, file } : null;
    };
    return look(scan()) || look(scan({ fresh: true }));
  }

  // ---- routes
  const app = express();
  app.disable("x-powered-by");
  app.use(cors());

  app.get("/", (req, res) => {
    let games = [];
    try {
      games = scan({ fresh: true });
    } catch (err) {
      log.error(`Couldn't scan the library: ${err.message}`);
    }
    const url = `http://${req.headers.host || "this-server:" + (httpServer ? httpServer.address().port : port)}`;
    const rows = games
      .map((g) => {
        const size = g.files.reduce((sum, f) => sum + (f.size || 0), 0);
        return `<li><b>${escapeHtml(g.name)}</b><span>${g.files.length} file${g.files.length === 1 ? "" : "s"} · ${formatBytes(size)}</span></li>`;
      })
      .join("");
    res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Game Launcher Server</title>
<style>
  body{margin:0;background:#0f1115;color:#e9ecf3;font:15px/1.5 "Segoe UI",system-ui,sans-serif}
  main{max-width:640px;margin:48px auto;padding:0 20px}
  h1{font-size:22px;margin:0 0 6px} .ok{color:#35c076} .muted{color:#98a0b3}
  .addr{margin:18px 0;padding:14px 16px;background:#1a1e2a;border:1px solid #2c3347;border-radius:12px}
  code{font-size:17px;color:#fff;word-break:break-all}
  ul{list-style:none;margin:16px 0;padding:0}
  li{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;margin-bottom:6px;background:#151821;border:1px solid #242b3d;border-radius:10px}
  li span{color:#98a0b3;white-space:nowrap}
</style>
<main>
  <h1><span class="ok">●</span> Game Launcher server is running</h1>
  <p class="muted">Players enter this address in the launcher's Settings:</p>
  <div class="addr"><code>${escapeHtml(url)}</code></div>
  <p class="muted">${games.length} game${games.length === 1 ? "" : "s"} found in <code style="font-size:13px">${escapeHtml(libraryRoot)}</code></p>
  <ul>${rows || '<li><span>No games yet. Put each game in its own folder here, with its installer inside.</span></li>'}</ul>
</main>`);
  });

  // A fresh scan every time, so a game you just added shows up on the next Refresh.
  app.get("/api/library", (req, res) => {
    try {
      res.json({ games: scan({ fresh: true }).map((g) => publicGame(g, checksumOf)) });
    } catch (err) {
      log.error(`Couldn't scan the library: ${err.message}`);
      res.status(500).json({ error: "Failed to scan library" });
    }
  });

  app.get("/api/games/:gameId/files/:filename", (req, res) => {
    // Only files the scanner found are downloadable, so nothing outside a game's folder can be requested.
    const hit = findFile(req.params.gameId, req.params.filename);
    if (!hit) return res.status(404).json({ error: "File not found" });
    const { game, file } = hit;
    const filePath = path.join(game.dir, file.filename);

    // Size right now, not as of the last scan: the file may still be being copied in.
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return res.status(404).json({ error: "File not found" });
    }

    const range = parseRange(req.headers.range, size);
    if (range === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(path.basename(file.filename))}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader("Content-Length", range.end - range.start + 1);
    } else {
      res.status(200);
      res.setHeader("Content-Length", size);
    }

    // A read error (file locked, deleted or unreadable mid-download) must never reach
    // the process as an unhandled 'error' event, which would take the server down.
    const stream = fs.createReadStream(filePath, range ? { start: range.start, end: range.end } : {});
    stats.activeDownloads++;
    events.emit("download:start", { game: game.name, file: file.filename });
    res.on("close", () => {
      stats.activeDownloads--;
      stream.destroy(); // client went away: stop reading and release the file
      events.emit("download:end", { game: game.name, file: file.filename });
    });
    res.on("finish", () => {
      stats.filesServed++;
    });
    stream.on("error", (err) => {
      log.error(`Error reading ${filePath}: ${err.message}`);
      if (!res.headersSent) {
        res.removeHeader("Content-Length");
        res.removeHeader("Content-Range");
        res.status(500).json({ error: "Couldn't read the file" });
      } else {
        res.destroy(); // too late for an error page: cut the connection so the client sees a failed download
      }
    });
    stream.pipe(res);
    stream.on("data", (chunk) => {
      stats.bytesServed += chunk.length;
    });
  });

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // Anything a route throws becomes a 500 for that one request, not a dead server.
  app.use((err, req, res, next) => {
    log.error(`Error handling ${req.method} ${req.url}: ${err && err.stack ? err.stack : err}`);
    if (res.headersSent) return res.destroy();
    res.status(500).json({ error: "Internal server error" });
  });

  // ---- control
  const api = {
    app,
    events,

    get libraryRoot() {
      return libraryRoot;
    },
    setLibraryRoot(dir) {
      libraryRoot = path.resolve(dir);
      cache = { at: 0, root: null, games: [] };
    },
    setPort(p) {
      port = p;
    },

    listGames: (opts) => scan({ fresh: true, ...opts }).map((g) => publicGame(g, checksumOf)),
    isRunning: () => !!httpServer,
    getPort: () => (httpServer ? httpServer.address().port : null),

    getStatus() {
      return {
        running: !!httpServer,
        port: httpServer ? httpServer.address().port : port,
        libraryRoot,
        libraryExists: fs.existsSync(libraryRoot),
        stats: { ...stats },
      };
    },

    start() {
      if (httpServer) return Promise.resolve({ port: httpServer.address().port });
      return new Promise((resolve, reject) => {
        const srv = http.createServer(app);
        srv.on("connection", (sock) => {
          sockets.add(sock);
          sock.on("close", () => sockets.delete(sock));
        });
        srv.once("error", (err) => reject(explainListenError(err, port, host)));
        srv.once("listening", () => {
          srv.removeAllListeners("error");
          srv.on("error", (err) => log.error(`Server error: ${err.message}`));
          httpServer = srv;
          stats.startedAt = Date.now();
          resolve({ port: srv.address().port });
        });
        srv.listen(port, host);
      });
    },

    // Stops listening and drops open connections. Downloads in progress are cut,
    // which is fine: the launcher resumes them where they stopped.
    stop() {
      if (!httpServer) return Promise.resolve();
      const srv = httpServer;
      httpServer = null;
      return new Promise((resolve) => {
        srv.close(() => resolve());
        for (const s of sockets) s.destroy();
      });
    },
  };
  return api;
}

module.exports = { createServer, networkAddresses, reachableAddresses, parseRange, explainListenError, formatBytes };
