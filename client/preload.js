const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (patch) => ipcRenderer.invoke("config:set", patch),
  chooseInstallRoot: () => ipcRenderer.invoke("config:chooseInstallRoot"),

  getLibrary: () => ipcRenderer.invoke("library:get"),
  getDetails: (gameId) => ipcRenderer.invoke("game:details", { gameId }),
  checkSpace: (gameId) => ipcRenderer.invoke("disk:check", { gameId }),
  searchMatches: (gameId, source, term, dlcId) => ipcRenderer.invoke("meta:search", { gameId, dlcId, source, term }),
  chooseMatch: (gameId, source, choice) => ipcRenderer.invoke("meta:choose", { gameId, source, choice }),
  getDlcDetails: (gameId, dlcId, force) => ipcRenderer.invoke("dlc:details", { gameId, dlcId, force }),
  chooseDlcMatch: (gameId, dlcId, choice) => ipcRenderer.invoke("dlc:chooseMatch", { gameId, dlcId, choice }),
  listCovers: (gameId) => ipcRenderer.invoke("art:list", { gameId }),
  chooseOnlineCover: (gameId, url) => ipcRenderer.invoke("art:choose", { gameId, url }),
  chooseCover: (gameId) => ipcRenderer.invoke("cover:choose", { gameId }),
  resetCover: (gameId) => ipcRenderer.invoke("cover:reset", { gameId }),
  refreshInfo: (gameId) => ipcRenderer.invoke("meta:refresh", { gameId }),

  downloadGame: (gameId, files) => ipcRenderer.invoke("game:download", { gameId, files }),
  onDownloadProgress: (cb) =>
    ipcRenderer.on("game:downloadProgress", (event, data) => cb(data)),

  installGame: (gameId, installerFilename, gameName, options) =>
    ipcRenderer.invoke("game:install", { gameId, installerFilename, gameName, options }),
  installDlc: (gameId, dlcId) => ipcRenderer.invoke("dlc:install", { gameId, dlcId }),
  installPortable: (gameId) => ipcRenderer.invoke("game:installPortable", { gameId }),
  onLibraryChanged: (cb) => ipcRenderer.on("library:changed", () => cb()),
  onInstallLog: (cb) => ipcRenderer.on("game:installLog", (event, data) => cb(data)),
  onInstallProgress: (cb) => ipcRenderer.on("game:installProgress", (event, data) => cb(data)),

  playGame: (gameId) => ipcRenderer.invoke("game:play", { gameId }),
  setRunAsAdmin: (gameId, value) => ipcRenderer.invoke("game:setRunAsAdmin", { gameId, value }),
  openInstallFolder: (gameId) => ipcRenderer.invoke("game:openInstallFolder", { gameId }),
  createShortcut: (gameId, gameName) => ipcRenderer.invoke("game:createShortcut", { gameId, gameName }),
  uninstallGame: (gameId) => ipcRenderer.invoke("game:uninstall", { gameId }),

  openDownloadsFolder: () => ipcRenderer.invoke("downloads:openFolder"),
  clearMetadata: () => ipcRenderer.invoke("meta:clearAll"),
  listManuals: (gameId) => ipcRenderer.invoke("manuals:list", { gameId }),
  openManual: (gameId, source, key) => ipcRenderer.invoke("manuals:open", { gameId, source, key }),
  clearDownloads: () => ipcRenderer.invoke("downloads:clear"),
  innoExtractStatus: () => ipcRenderer.invoke("tools:innoExtractStatus"),
});
