const fs = require("fs");
const crypto = require("crypto");

// SHA-256 of a file, streamed so a multi-gigabyte game never sits in memory.
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

module.exports = { hashFile };
