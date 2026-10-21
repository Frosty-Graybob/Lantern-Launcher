const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");

/**
 * Downloads a file from `url` to `destPath`, resuming if a partial file
 * (destPath + ".part") already exists. Calls onProgress({receivedBytes,
 * totalBytes}) periodically. Resolves with the final file path on success.
 */
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const partPath = destPath + ".part";
    let startByte = 0;
    if (fs.existsSync(partPath)) {
      startByte = fs.statSync(partPath).size;
    }

    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : {};

    const req = client.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        res.resume();
        return downloadFile(res.headers.location, destPath, onProgress).then(resolve, reject);
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error(`Server responded with status ${res.statusCode}`));
      }

      const isResuming = res.statusCode === 206;
      const contentLength = parseInt(res.headers["content-length"] || "0", 10);
      const totalBytes = isResuming ? startByte + contentLength : contentLength;
      let receivedBytes = isResuming ? startByte : 0;

      const writeStream = fs.createWriteStream(partPath, {
        flags: isResuming ? "a" : "w",
      });

      res.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (onProgress) onProgress({ receivedBytes, totalBytes });
      });

      res.pipe(writeStream);

      writeStream.on("finish", () => {
        fs.renameSync(partPath, destPath);
        resolve(destPath);
      });

      writeStream.on("error", reject);
      res.on("error", reject);
    });

    req.on("error", reject);
  });
}

module.exports = { downloadFile };
