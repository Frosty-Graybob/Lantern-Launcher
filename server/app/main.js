"use strict";

/**
 * Game Launcher Server (Windows app)
 * -----------------------------------
 * Runs the same server core as the Docker image, with a window to see the address
 * to give players, pick the games folder and change the port, and a tray icon so
 * it keeps serving after the window is closed.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, clipboard, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const { createServer, networkAddresses } = require("../src/server");

// The icons are shipped next to the app (not inside its archive), where Windows and Electron can both load them.
const assetPath = (name) =>
  app.isPackaged ? path.join(process.resourcesPath, "assets", name) : path.join(__dirname, "assets", name);
const MIN_PORT = 1024;

let settings;
let server;
let win = null;
let tray = null;
let quitting = false;
let startError = null; // why the server isn't running, in words
let gamesCache = { at: 0, list: [] };
let trayHintShown = false;

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

// ------------------------------------------------------------------ settings

function defaultSettings() {
  return { libraryRoot: path.join(app.getPath("documents"), "Game Library"), port: 5155 };
}

function loadSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    return defaultSettings();
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error(`Couldn't save settings: ${err.message}`);
  }
}

// First run: the default library folder is created with a note on how to use it, so
// there is something to open and put games into. A folder the person picked is never written to.
function ensureDefaultLibrary() {
  const dir = defaultSettings().libraryRoot;
  if (path.resolve(settings.libraryRoot) !== path.resolve(dir) || fs.existsSync(dir)) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "README.txt"),
      [
        "Put each game in its own folder inside this one:",
        "",
        "  Game Library",
        "    Dead Space",
        "      setup_dead_space_2.0.exe",
        "      setup_dead_space_2.0-1.bin        (if the installer came with extra parts)",
        "    Stardew Valley",
        "      setup_stardew_valley_1.5.exe",
        "",
        "The game's name is taken from its folder. It shows up in the launcher the next time",
        "players press Refresh. Nothing else to set up.",
        "",
      ].join("\r\n")
    );
  } catch (err) {
    console.error(`Couldn't create ${dir}: ${err.message}`);
  }
}

// ------------------------------------------------------------------ the server

function refreshGames() {
  try {
    gamesCache = {
      at: Date.now(),
      list: server.listGames().map((g) => ({
        id: g.id,
        name: g.name,
        files: g.files.length,
        size: g.files.reduce((sum, f) => sum + (f.size || 0), 0),
      })),
    };
  } catch (err) {
    console.error(`Couldn't scan the library: ${err.message}`);
    gamesCache = { at: Date.now(), list: [] };
  }
  return gamesCache.list;
}

async function startServer() {
  try {
    await server.start();
    startError = null;
  } catch (err) {
    startError = err.message;
  }
  refreshGames();
  updateTray();
}

function getState() {
  // A big library on a slow disk shouldn't be re-read every second.
  if (Date.now() - gamesCache.at > 30000) refreshGames();
  const status = server.getStatus();
  const port = status.port;
  return {
    running: status.running,
    port,
    error: startError,
    addresses: networkAddresses().map((a) => ({ name: a.name, url: `http://${a.address}:${port}` })),
    libraryRoot: status.libraryRoot,
    libraryExists: status.libraryExists,
    games: gamesCache.list,
    stats: status.stats,
    autoStart: app.getLoginItemSettings().openAtLogin,
    version: app.getVersion(),
  };
}

// ------------------------------------------------------------------ window and tray

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: "Game Launcher Server",
    backgroundColor: "#0f1115",
    icon: assetPath("icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  // Closing the window hides it; the server keeps running in the tray. Quit is in the tray menu.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      if (Notification.isSupported()) {
        new Notification({
          title: "Game Launcher Server is still running",
          body: "It keeps serving your games from the system tray. Right-click its icon to quit.",
        }).show();
      }
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

function showWindow() {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function toggleWindow() {
  if (win && win.isVisible()) win.hide();
  else showWindow();
}

function updateTray() {
  if (!tray) return;
  const status = server.getStatus();
  const addrs = networkAddresses();
  tray.setToolTip(
    status.running ? `Game Launcher Server: running on port ${status.port}` : "Game Launcher Server: not running"
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Game Launcher Server", click: showWindow },
      { label: status.running ? `Running on port ${status.port}` : "Not running", enabled: false },
      {
        label: "Copy address",
        enabled: status.running && addrs.length > 0,
        click: () => clipboard.writeText(`http://${addrs[0].address}:${status.port}`),
      },
      { label: "Open library folder", click: () => shell.openPath(status.libraryRoot) },
      { type: "separator" },
      { label: "Quit", click: quit },
    ])
  );
}

function createTray() {
  // An .ico lets Windows pick the right size for this screen's scaling, which a single bitmap can't.
  tray = new Tray(nativeImage.createFromPath(assetPath("icon.ico")));
  tray.on("click", toggleWindow);
  updateTray();
}

async function quit() {
  quitting = true;
  try {
    await server.stop();
  } catch {
    /* quitting anyway */
  }
  app.quit();
}

// ------------------------------------------------------------------ what the window can ask for

function registerIpc() {
  ipcMain.handle("state:get", () => getState());

  ipcMain.handle("library:choose", async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "Choose the folder that holds your games",
      defaultPath: settings.libraryRoot,
      properties: ["openDirectory", "createDirectory"],
    });
    if (!result.canceled && result.filePaths[0]) {
      settings.libraryRoot = result.filePaths[0];
      saveSettings();
      server.setLibraryRoot(settings.libraryRoot);
      refreshGames();
    }
    return getState();
  });

  ipcMain.handle("library:open", async () => {
    const error = await shell.openPath(settings.libraryRoot);
    return { ok: !error, error: error || null };
  });

  ipcMain.handle("games:rescan", () => {
    refreshGames();
    return getState();
  });

  // Changes the port. If the new one can't be used, the old one is put back, so the
  // server is never left stopped by a typo.
  ipcMain.handle("port:set", async (event, value) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < MIN_PORT || port > 65535) {
      return { ok: false, error: `Use a number from ${MIN_PORT} to 65535.`, state: getState() };
    }
    if (server.isRunning() && server.getPort() === port) return { ok: true, state: getState() };

    const previous = settings.port;
    await server.stop();
    server.setPort(port);
    try {
      await server.start();
      settings.port = port;
      saveSettings();
      startError = null;
      updateTray();
      return { ok: true, state: getState() };
    } catch (err) {
      server.setPort(previous);
      await startServer(); // back on the old port
      return { ok: false, error: err.message, state: getState() };
    }
  });

  ipcMain.handle("server:restart", async () => {
    await server.stop();
    await startServer();
    return getState();
  });

  ipcMain.handle("autostart:set", (event, enabled) => {
    // Started this way it opens straight into the tray, with no window in the way at logon.
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: ["--hidden"] });
    return getState();
  });

  ipcMain.handle("address:copy", (event, url) => {
    const known = networkAddresses().some((a) => `http://${a.address}:${server.getStatus().port}` === url);
    if (!known) return { ok: false };
    clipboard.writeText(url);
    return { ok: true };
  });
}

// ------------------------------------------------------------------ start-up

async function init() {
  // Windows only shows notifications for an app that has an identity; this matches the installer's.
  if (typeof app.setAppUserModelId === "function") app.setAppUserModelId("com.local.gamelauncher.server");
  settings = loadSettings();
  ensureDefaultLibrary();
  server = createServer({ libraryRoot: settings.libraryRoot, port: settings.port });
  registerIpc();
  createTray();
  if (!process.argv.includes("--hidden")) createWindow();
  await startServer();
}

if (!app.requestSingleInstanceLock()) {
  // Already running (probably in the tray): that copy handles it.
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("window-all-closed", () => {
    /* stay alive in the tray */
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.whenReady().then(init);
}
