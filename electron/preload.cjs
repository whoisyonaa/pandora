const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pandoraSync", {
  isAvailable: () => ipcRenderer.invoke("sync:is-available"),
  start: (rawVault) => ipcRenderer.invoke("sync:start", rawVault),
  stop: () => ipcRenderer.invoke("sync:stop"),
  getReceived: () => ipcRenderer.invoke("sync:get-received"),
  clearReceived: () => ipcRenderer.invoke("sync:clear-received"),
  onReceived: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("sync:received", listener);
    return () => ipcRenderer.removeListener("sync:received", listener);
  },
});
