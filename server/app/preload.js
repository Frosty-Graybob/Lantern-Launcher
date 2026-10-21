"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("serverApi", {
  getState: () => ipcRenderer.invoke("state:get"),
  chooseLibrary: () => ipcRenderer.invoke("library:choose"),
  openLibrary: () => ipcRenderer.invoke("library:open"),
  rescan: () => ipcRenderer.invoke("games:rescan"),
  setPort: (port) => ipcRenderer.invoke("port:set", port),
  restart: () => ipcRenderer.invoke("server:restart"),
  setAutoStart: (enabled) => ipcRenderer.invoke("autostart:set", enabled),
  copyAddress: (url) => ipcRenderer.invoke("address:copy", url),
});
