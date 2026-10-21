const http = require("http");
const https = require("https");
const fs = require("fs");
const { URL } = require("url");

// Some storefront endpoints refuse requests with no User-Agent.
const DEFAULT_HEADERS = {
  "User-Agent": "GameLauncher/1.0 (self-hosted game library)",
  Accept: "application/json, image/*;q=0.9, */*;q=0.5",
};

// GET a URL, following redirects, and resolve with the response stream.
// Non-200 handling is left to the caller. `timeoutMs` is an idle timeout.
function request(url, { headers = {}, timeoutMs = 15000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (current, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(current);
      } catch (err) {
        return reject(err);
      }
      const client = parsed.protocol === "http:" ? http : https;
      const req = client.get(current, { headers: { ...DEFAULT_HEADERS, ...headers } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects: ${url}`));
          return go(new URL(res.headers.location, current).toString(), redirectsLeft - 1);
        }
        resolve(res);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out: ${current}`)));
      req.on("error", reject);
    };
    go(url, maxRedirects);
  });
}

async function getJson(url, opts = {}) {
  const res = await request(url, opts);
  if (res.statusCode !== 200) {
    res.resume();
    const err = new Error(`HTTP ${res.statusCode} for ${url}`);
    err.statusCode = res.statusCode;
    throw err;
  }
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

// Downloads to destPath via a .part file, so a half-written image is never
// mistaken for a finished one.
async function download(url, destPath, opts = {}) {
  const res = await request(url, opts);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} for ${url}`);
  }
  const tmp = `${destPath}.part`;
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on("finish", resolve);
      file.on("error", reject);
      res.on("error", reject);
    });
    fs.renameSync(tmp, destPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return destPath;
}

module.exports = { request, getJson, download };
