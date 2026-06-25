export type SortMode = "title" | "createdAt" | "updatedAt" | "usedCount";

export type ThemeTokens = {
  id: string;
  name: string;
  background: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  danger: string;
  success: string;
};

export type VaultEntry = {
  id: string;
  title: string;
  url: string;
  username: string;
  password: string;
  icon?: string;
  folderId: string;
  tags: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
  usedCount: number;
};

export type VaultFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
};

export type VaultSettings = {
  theme: ThemeTokens;
  lockAfterMinutes: number;
  authMethods: {
    masterPassword: boolean;
    pin: boolean;
    pattern: boolean;
    biometrics: boolean;
  };
  sync: {
    googleDriveEnabled: boolean;
    lastSyncAt: string | null;
    webdav?: {
      provider: "koofr" | "custom";
      url: string;
      username: string;
      password: string;
      filePath: string;
      remoteModifiedAt?: string;
    };
    googleDrive?: {
      clientId: string;
      clientSecret?: string;
      refreshToken?: string;
      remoteFileId?: string;
      remoteModifiedTime?: string;
    };
  };
};

export type VaultState = {
  version: 1;
  folders: VaultFolder[];
  entries: VaultEntry[];
  settings: VaultSettings;
};

export type EncryptedVault = {
  version: 1;
  kdf: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
};
