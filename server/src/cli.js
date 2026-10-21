#!/usr/bin/env node
"use strict";

/**
 * Runs the server from a terminal or a container. Settings come from the environment:
 *
 *   PORT          port to listen on                  (default 5155)
 *   LIBRARY_ROOT  folder holding the game folders    (default ./library; /games in the Docker image)
 *   HOST          address to listen on               (default 0.0.0.0, i.e. all of them)
 */

const path = require("path");
const fs = require("fs");
const { createServer, networkAddresses } = require("./server");

const inDocker = !!process.env.RUNNING_IN_DOCKER;
const host = process.env.HOST || "0.0.0.0";
const libraryRoot = path.resolve(process.env.LIBRARY_ROOT || path.join(process.cwd(), "library"));

const rawPort = process.env.PORT === undefined || process.env.PORT === "" ? 5155 : Number(process.env.PORT);
if (!Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65535) {
  console.error(`PORT must be a whole number from 1 to 65535 (it was "${process.env.PORT}").`);
  process.exit(1);
}

const server = createServer({ libraryRoot, port: rawPort, host });

function banner(port) {
  console.log(`Game Launcher server is running on port ${port}  (Node ${process.version})`);
  console.log(`Library folder: ${libraryRoot}`);

  let games = [];
  try {
    games = server.listGames();
  } catch (err) {
    console.error(`Couldn't scan the library folder (the server keeps running): ${err.message}`);
  }
  console.log(`\nFound ${games.length} game${games.length === 1 ? "" : "s"}${games.length ? ":" : "."}`);
  games.forEach((g) => console.log(`  - ${g.name}  (${g.files.length} file${g.files.length === 1 ? "" : "s"})`));

  if (!fs.existsSync(libraryRoot)) {
    console.warn(`\nThe library folder doesn't exist yet: ${libraryRoot}`);
    if (inDocker) console.warn("Did you mount your games folder into the container at /games?");
  } else if (games.length === 0 && inDocker) {
    console.warn("\nNo games found. Is your games folder mounted at /games? Each game goes in its own folder, with its installer inside.");
  }

  console.log("\nPlayers enter this as the Server URL in the launcher's Settings:");
  if (inDocker) {
    console.log(`  http://<this server's address>:<the port you published>   (the status page at that address shows it)`);
  } else {
    const addrs = networkAddresses();
    if (addrs.length) addrs.forEach((a) => console.log(`  http://${a.address}:${port}   (${a.name})`));
    else console.log("  (couldn't detect a network address; use this computer's IPv4 address)");
  }
}

server.start().then(
  ({ port }) => banner(port),
  (err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
);

// Stop cleanly when the container or terminal asks (docker stop sends SIGTERM).
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} received, shutting down...`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  server.stop().then(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Last resort, so a file server that's meant to run for weeks survives a surprise:
// log it loudly and keep serving. (Known failure modes are handled where they happen.)
process.on("uncaughtException", (err) => console.error("Unexpected error (the server keeps running):", err));
process.on("unhandledRejection", (err) => console.error("Unexpected rejection (the server keeps running):", err));
