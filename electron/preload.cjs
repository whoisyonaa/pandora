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

contextBridge.exposeInMainWorld("pandoraAuth", {
  status: () => ipcRenderer.invoke("auth:status"),
  setup: (masterPassword, pin) => ipcRenderer.invoke("auth:setup", { masterPassword, pin }),
  unlockWithPin: (pin) => ipcRenderer.invoke("auth:unlock-pin", { pin }),
  updatePin: (masterPassword, pin) => ipcRenderer.invoke("auth:update-pin", { masterPassword, pin }),
  updateMasterPassword: (masterPassword) => ipcRenderer.invoke("auth:update-master", { masterPassword }),
  resetFailures: () => ipcRenderer.invoke("auth:reset-failures"),
  clear: () => ipcRenderer.invoke("auth:clear"),
});
