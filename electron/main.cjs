const { app, BrowserWindow, ipcMain, safeStorage, shell } = require("electron");
const crypto = require("crypto");
const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

let mainWindow = null;
let syncServer = null;
let syncState = null;
let discoverySocket = null;
let discoveryTimer = null;
const discoveryPort = 45454;
const pinIterations = 310000;

function authFilePath() {
  return path.join(app.getPath("userData"), "device-auth.json");
}

function readAuthState() {
  try {
    return JSON.parse(fs.readFileSync(authFilePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeAuthState(state) {
  const target = authFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}

function validPin(pin) {
  return typeof pin === "string" && /^\d{4,}$/.test(pin);
}

function pinDigest(pin, salt) {
  return crypto.pbkdf2Sync(pin, Buffer.from(salt, "base64"), pinIterations, 32, "sha256").toString("base64");
}

function secureEqual(left, right) {
  const first = Buffer.from(left || "", "base64");
  const second = Buffer.from(right || "", "base64");
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function protectMasterPassword(masterPassword) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI недоступен.");
  return safeStorage.encryptString(masterPassword).toString("base64");
}

function revealMasterPassword(state) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI недоступен.");
  return safeStorage.decryptString(Buffer.from(state.encryptedMasterPassword, "base64"));
}

function nextAuthState(masterPassword, pin) {
  if (typeof masterPassword !== "string" || masterPassword.length < 8) throw new Error("Мастер-пароль должен содержать минимум 8 символов.");
  if (!validPin(pin)) throw new Error("PIN должен содержать минимум 4 цифры.");
  const salt = crypto.randomBytes(16).toString("base64");
  return {
    version: 1,
    salt,
    pinHash: pinDigest(pin, salt),
    encryptedMasterPassword: protectMasterPassword(masterPassword),
    failedAttempts: 0,
  };
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || "";
  if (!senderUrl.startsWith("file://")) throw new Error("Недоверенный источник IPC.");
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(__dirname, "..", "build", "icon.ico");
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: "#000000",
    title: "Pandora",
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
  });

  mainWindow = window;
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return { action: "deny" };
    }
    if (target.protocol === "https:" || target.protocol === "http:") shell.openExternal(target.toString());
    return { action: "deny" };
  });
  mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function localAddresses(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address)
    .sort((left, right) => addressPriority(left) - addressPriority(right))
    .map((address) => `http://${address}:${port}`);
}

function addressPriority(address) {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  const second = Number(address.split(".")[1]);
  if (address.startsWith("172.") && second >= 16 && second <= 31) return 2;
  if (address.startsWith("169.254.")) return 20;
  return 10;
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function stopSyncServer() {
  stopDiscovery();
  if (syncServer) {
    syncServer.close();
    syncServer = null;
  }
  syncState = null;
}

function startDiscovery(session) {
  stopDiscovery();
  discoverySocket = dgram.createSocket("udp4");
  discoverySocket.bind(() => {
    discoverySocket?.setBroadcast(true);
  });

  const sendBeacon = () => {
    if (!discoverySocket || !syncState) return;
    const payload = Buffer.from(
      JSON.stringify({
        type: "pandora-sync-host",
        name: os.hostname(),
        code: session.code,
        urls: session.urls,
        at: new Date().toISOString(),
      }),
      "utf8",
    );
    discoverySocket.send(payload, discoveryPort, "255.255.255.255");
  };

  discoveryTimer = setInterval(sendBeacon, 1000);
  sendBeacon();
}

function stopDiscovery() {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
  if (discoverySocket) {
    discoverySocket.close();
    discoverySocket = null;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 12_000_000) {
        reject(new Error("Payload is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

ipcMain.handle("sync:start", async (_event, rawVault) => {
  throw new Error("Локальная синхронизация по Wi-Fi отключена. Используйте Koofr/WebDAV.");
  /* c8 ignore start -- retained only for reading legacy sessions */
  stopSyncServer();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  syncState = {
    code,
    rawVault,
    receivedVault: null,
  };

  syncServer = http.createServer(async (request, response) => {
    setCors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const validCode = requestUrl.searchParams.get("code") === syncState?.code;
    if (!validCode) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Неверный код синхронизации" }));
      return;
    }

    try {
      if (request.method === "GET" && requestUrl.pathname === "/vault") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(syncState.rawVault);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/vault") {
        syncState.receivedVault = await readBody(request);
        mainWindow?.webContents.send("sync:received");
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Не найдено" }));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message || "Ошибка синхронизации" }));
    }
  });

  await new Promise((resolve, reject) => {
    syncServer.once("error", reject);
    syncServer.listen(0, "0.0.0.0", resolve);
  });

  const port = syncServer.address().port;
  const session = {
    code,
    urls: localAddresses(port),
  };
  startDiscovery(session);
  return session;
  /* c8 ignore stop */
});

ipcMain.handle("sync:stop", () => {
  stopSyncServer();
});

ipcMain.handle("sync:get-received", () => syncState?.receivedVault || null);

ipcMain.handle("sync:clear-received", () => {
  if (syncState) syncState.receivedVault = null;
});

ipcMain.handle("sync:is-available", () => false);

ipcMain.handle("auth:status", (event) => {
  assertTrustedSender(event);
  const state = readAuthState();
  return { configured: Boolean(state?.encryptedMasterPassword && state?.pinHash), failedAttempts: state?.failedAttempts || 0 };
});

ipcMain.handle("auth:setup", (event, { masterPassword, pin }) => {
  assertTrustedSender(event);
  writeAuthState(nextAuthState(masterPassword, pin));
});

ipcMain.handle("auth:unlock-pin", (event, { pin }) => {
  assertTrustedSender(event);
  const state = readAuthState();
  if (!state) throw new Error("Локальный PIN ещё не настроен.");
  if ((state.failedAttempts || 0) >= 3) {
    return {
      failedAttempts: 3,
      remainingAttempts: 0,
      requiresMasterPassword: true,
    };
  }
  if (!validPin(pin) || !secureEqual(pinDigest(pin, state.salt), state.pinHash)) {
    state.failedAttempts = Math.min((state.failedAttempts || 0) + 1, 3);
    writeAuthState(state);
    return {
      failedAttempts: state.failedAttempts,
      remainingAttempts: Math.max(0, 3 - state.failedAttempts),
      requiresMasterPassword: state.failedAttempts >= 3,
    };
  }
  state.failedAttempts = 0;
  writeAuthState(state);
  return {
    masterPassword: revealMasterPassword(state),
    failedAttempts: 0,
    remainingAttempts: 3,
    requiresMasterPassword: false,
  };
});

ipcMain.handle("auth:update-pin", (event, { masterPassword, pin }) => {
  assertTrustedSender(event);
  const state = readAuthState();
  if (!state || revealMasterPassword(state) !== masterPassword) throw new Error("Неверный мастер-пароль.");
  writeAuthState(nextAuthState(masterPassword, pin));
});

ipcMain.handle("auth:update-master", (event, { masterPassword }) => {
  assertTrustedSender(event);
  const state = readAuthState();
  if (!state) throw new Error("Локальная авторизация не настроена.");
  if (typeof masterPassword !== "string" || masterPassword.length < 8) throw new Error("Мастер-пароль должен содержать минимум 8 символов.");
  state.encryptedMasterPassword = protectMasterPassword(masterPassword);
  state.failedAttempts = 0;
  writeAuthState(state);
});

ipcMain.handle("auth:reset-failures", (event) => {
  assertTrustedSender(event);
  const state = readAuthState();
  if (!state) return;
  state.failedAttempts = 0;
  writeAuthState(state);
});

ipcMain.handle("auth:clear", (event) => {
  assertTrustedSender(event);
  try {
    fs.rmSync(authFilePath(), { force: true });
  } catch {
    // The vault reset still succeeds if the credential file was already absent.
  }
});

app.on("before-quit", stopSyncServer);

app.whenReady().then(() => {
  app.setAppUserModelId("com.pandora.passwords");
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
