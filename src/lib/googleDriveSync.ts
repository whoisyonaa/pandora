const driveScope = "https://www.googleapis.com/auth/drive.appdata";
const fileName = "pandora-vault.pandora";

export type GoogleDriveCredentials = {
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  remoteFileId?: string;
};

export type DeviceAuthPrompt = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
};

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
};

export type RemoteVaultFile = {
  id: string;
  modifiedTime: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_url: string;
  verification_url_complete?: string;
  expires_in: number;
  interval?: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

function formBody(values: Record<string, string | undefined>) {
  const body = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value) body.set(key, value);
  });
  return body;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string; error_description?: string };
  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Google API error ${response.status}`);
  }
  return data;
}

export async function startGoogleDeviceAuth(clientId: string): Promise<DeviceAuthPrompt> {
  const response = await fetch("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: clientId,
      scope: driveScope,
    }),
  });
  const data = await parseJsonResponse<DeviceCodeResponse>(response);
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_url_complete || data.verification_url,
    expiresIn: data.expires_in,
    interval: data.interval || 5,
  };
}

export async function pollGoogleDeviceAuth(
  credentials: Pick<GoogleDriveCredentials, "clientId" | "clientSecret">,
  prompt: DeviceAuthPrompt,
): Promise<TokenSet | null> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      device_code: prompt.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const data = (await response.json()) as TokenResponse;

  if (!response.ok) {
    if (data.error === "authorization_pending" || data.error === "slow_down") return null;
    throw new Error(data.error_description || data.error || "Google authorization failed");
  }

  if (!data.access_token) throw new Error("Google did not return an access token");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 3600,
  };
}

export async function refreshGoogleAccessToken(credentials: GoogleDriveCredentials): Promise<TokenSet> {
  if (!credentials.refreshToken) {
    throw new Error("Google Drive is not connected");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await parseJsonResponse<TokenResponse>(response);
  if (!data.access_token) throw new Error("Google did not return an access token");

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || 3600,
  };
}

export async function findRemoteVault(accessToken: string): Promise<RemoteVaultFile | null> {
  const query = encodeURIComponent(`name='${fileName}' and trashed=false`);
  const fields = encodeURIComponent("files(id,name,modifiedTime)");
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=${fields}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = await parseJsonResponse<{ files: RemoteVaultFile[] }>(response);
  return data.files[0] ?? null;
}

function multipartBody(metadata: object, content: string) {
  const boundary = `pandora-${crypto.randomUUID()}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n");

  return { boundary, body };
}

export async function uploadRemoteVault(
  accessToken: string,
  encryptedVault: string,
  remoteFileId?: string,
): Promise<RemoteVaultFile> {
  const metadata = remoteFileId ? { name: fileName } : { name: fileName, parents: ["appDataFolder"] };
  const multipart = multipartBody(metadata, encryptedVault);
  const url = remoteFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${remoteFileId}?uploadType=multipart&fields=id,modifiedTime`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime";

  const response = await fetch(url, {
    method: remoteFileId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${multipart.boundary}`,
    },
    body: multipart.body,
  });

  return parseJsonResponse<RemoteVaultFile>(response);
}

export async function downloadRemoteVault(accessToken: string, remoteFileId: string): Promise<string> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${remoteFileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Google Drive download failed: ${response.status}`);
  }
  return response.text();
}
