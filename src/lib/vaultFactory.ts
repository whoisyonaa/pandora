import type { VaultState } from "../types/vault";
import { defaultTheme } from "./theme";

const now = () => new Date().toISOString();

export function createEmptyVault(): VaultState {
  const rootId = crypto.randomUUID();

  return {
    version: 1,
    folders: [{ id: rootId, name: "Все", parentId: null, createdAt: now() }],
    entries: [],
    settings: {
      theme: defaultTheme,
      lockAfterMinutes: 5,
      authMethods: {
        masterPassword: true,
        pin: false,
        pattern: false,
        biometrics: false,
      },
      sync: {
        googleDriveEnabled: false,
        lastSyncAt: null,
        webdav: {
          provider: "koofr",
          url: "https://app.koofr.net/dav/Koofr",
          username: "",
          password: "",
          filePath: "pandora-vault.pandora",
        },
        googleDrive: {
          clientId: "",
        },
      },
    },
  };
}
