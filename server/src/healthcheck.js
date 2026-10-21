"use strict";
// Used by the Docker HEALTHCHECK: exits 0 if the server answers, 1 if not.
const http = require("http");

const req = http.get(
  { host: "127.0.0.1", port: process.env.PORT || 5155, path: "/api/health", timeout: 4000 },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  }
);
req.on("timeout", () => {
  req.destroy();
  process.exit(1);
});
req.on("error", () => process.exit(1));
