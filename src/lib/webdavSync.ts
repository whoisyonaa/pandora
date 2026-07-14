import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { addDebugLog } from "./debugLog";

export type WebDavConfig = {
  url: string;
  username: string;
  password: string;
  filePath: string;
};

type WebDavResponse = {
  status: number;
  data: string;
  headers: Record<string, string>;
};

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/g, "");
  if (!trimmed) throw new Error("Введите адрес WebDAV.");

  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    if (url.protocol !== "https:") throw new Error("insecure");
    return url.toString().replace(/\/+$/g, "");
  } catch (error) {
    if (error instanceof Error && error.message === "insecure") {
      throw new Error("WebDAV должен использовать HTTPS. Незашифрованный HTTP отключён для защиты логина и app password.");
    }
    throw new Error("Адрес WebDAV должен начинаться с https://.");
  }
}

function normalizeFilePath(value: string) {
  const path = trimSlashes(value.trim());
  if (!path) throw new Error("Введите имя файла синхронизации.");
  return path;
}

function remoteFileUrl(config: WebDavConfig, options: { cacheBust?: boolean } = {}) {
  const base = normalizeBaseUrl(config.url);
  const path = normalizeFilePath(config.filePath)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `${base}/${path}`;
  return options.cacheBust ? `${url}?_pandora_t=${Date.now()}` : url;
}

function encodeBasicAuth(username: string, password: string) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return `Basic ${btoa(binary)}`;
}

function assertConfig(config: WebDavConfig) {
  if (!config.username.trim()) throw new Error("Введите логин WebDAV.");
  if (!config.password.trim()) throw new Error("Введите пароль приложения WebDAV.");
  remoteFileUrl(config);
}

function stringifyData(data: unknown) {
  if (typeof data === "string") return data;
  if (data === null || data === undefined) return "";
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return JSON.stringify(data);
}

async function request(method: "GET" | "PUT", config: WebDavConfig, data?: string): Promise<WebDavResponse> {
  assertConfig(config);
  const url = remoteFileUrl(config, { cacheBust: method === "GET" });
  const headers = {
    Authorization: encodeBasicAuth(config.username.trim(), config.password),
    Accept: "application/json, text/plain, */*",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Content-Type": "application/json; charset=utf-8",
  };

  addDebugLog("webdav", `${method} request`, {
    url: url.replace(/_pandora_t=\d+/g, "_pandora_t=..."),
    native: Capacitor.isNativePlatform(),
    hasBody: Boolean(data),
    bodyLength: data?.length ?? 0,
  });

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      method,
      url,
      headers,
      data,
      responseType: "text",
    });
    const responseText = stringifyData(response.data);
    addDebugLog("webdav", `${method} response`, {
      status: response.status,
      dataType: typeof response.data,
      dataLength: responseText.length,
      contentType: response.headers?.["content-type"] ?? response.headers?.["Content-Type"] ?? "",
    });
    return {
      status: response.status,
      data: responseText,
      headers: response.headers ?? {},
    };
  }

  const response = await fetch(url, {
    method,
    headers,
    body: method === "PUT" ? data : undefined,
    cache: "no-store",
  });
  const responseText = await response.text();
  addDebugLog("webdav", `${method} response`, {
    status: response.status,
    dataLength: responseText.length,
    contentType: response.headers.get("content-type") ?? "",
  });
  return {
    status: response.status,
    data: responseText,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function authError() {
  return new Error("Koofr/WebDAV отклонил логин или пароль. Используйте пароль приложения Koofr, не обычный пароль аккаунта.");
}

function statusError(action: string, response: WebDavResponse) {
  if ([401, 403].includes(response.status)) return authError();
  if (response.status === 409) {
    return new Error("Папка для файла синхронизации не существует. Укажите файл без папок, например pandora-vault.pandora.");
  }
  return new Error(`${action}. HTTP ${response.status}.`);
}

export async function testWebDavConnection(config: WebDavConfig) {
  const response = await request("GET", config);
  if ([200, 404].includes(response.status)) {
    addDebugLog("webdav", "connection test ok", { status: response.status });
    return;
  }
  addDebugLog("webdav", "connection test failed", { status: response.status }, "error");
  throw statusError("Не удалось подключиться к Koofr/WebDAV", response);
}

export async function uploadWebDavVault(config: WebDavConfig, rawVault: string) {
  const response = await request("PUT", config, rawVault);
  if ([200, 201, 204].includes(response.status)) {
    addDebugLog("webdav", "upload ok", { status: response.status, bytes: rawVault.length });
    return;
  }
  addDebugLog("webdav", "upload failed", { status: response.status }, "error");
  throw statusError("Не удалось сохранить файл синхронизации в Koofr/WebDAV", response);
}

export async function downloadWebDavVault(config: WebDavConfig) {
  const response = await request("GET", config);
  if (response.status === 200) {
    if (!response.data.trim()) throw new Error("Файл синхронизации в облаке пустой.");
    addDebugLog("webdav", "download ok", { status: response.status, bytes: response.data.length });
    return response.data;
  }
  if (response.status === 404) {
    addDebugLog("webdav", "download missing", { status: response.status }, "warn");
    throw new Error("В облаке ещё нет файла Pandora. Сначала нажмите «Сохранить в облако» на устройстве с записями.");
  }
  addDebugLog("webdav", "download failed", { status: response.status }, "error");
  throw statusError("Не удалось загрузить файл синхронизации из Koofr/WebDAV", response);
}
