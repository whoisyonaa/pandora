import { Capacitor, CapacitorHttp } from "@capacitor/core";

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
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error();
    }
    return url.toString().replace(/\/+$/g, "");
  } catch {
    throw new Error("Адрес WebDAV должен начинаться с http:// или https://.");
  }
}

function normalizeFilePath(value: string) {
  const path = trimSlashes(value.trim());
  if (!path) throw new Error("Введите имя файла синхронизации.");
  return path;
}

function remoteFileUrl(config: WebDavConfig) {
  const base = normalizeBaseUrl(config.url);
  const path = normalizeFilePath(config.filePath)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${base}/${path}`;
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
  return JSON.stringify(data);
}

async function request(method: "GET" | "PUT", config: WebDavConfig, data?: string): Promise<WebDavResponse> {
  assertConfig(config);
  const url = remoteFileUrl(config);
  const headers = {
    Authorization: encodeBasicAuth(config.username.trim(), config.password),
    Accept: "application/json, text/plain, */*",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Content-Type": "application/json; charset=utf-8",
  };

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      method,
      url,
      headers,
      data,
      responseType: "text",
    });
    return {
      status: response.status,
      data: stringifyData(response.data),
      headers: response.headers ?? {},
    };
  }

  const response = await fetch(url, {
    method,
    headers,
    body: method === "PUT" ? data : undefined,
    cache: "no-store",
  });
  return {
    status: response.status,
    data: await response.text(),
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
  if ([200, 404].includes(response.status)) return;
  throw statusError("Не удалось подключиться к Koofr/WebDAV", response);
}

export async function uploadWebDavVault(config: WebDavConfig, rawVault: string) {
  const response = await request("PUT", config, rawVault);
  if ([200, 201, 204].includes(response.status)) return;
  throw statusError("Не удалось сохранить файл синхронизации в Koofr/WebDAV", response);
}

export async function downloadWebDavVault(config: WebDavConfig) {
  const response = await request("GET", config);
  if (response.status === 200) {
    if (!response.data.trim()) throw new Error("Файл синхронизации в облаке пустой.");
    return response.data;
  }
  if (response.status === 404) {
    throw new Error("В облаке ещё нет файла Pandora. Сначала нажмите «Сохранить в облако» на устройстве с записями.");
  }
  throw statusError("Не удалось загрузить файл синхронизации из Koofr/WebDAV", response);
}
