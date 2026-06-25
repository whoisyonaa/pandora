# Pandora

Pandora is a local-first password manager for Windows and Android. The project is built as a desktop application through Electron and as an Android application through Capacitor. The interface is Russian-first and follows a monochrome dark minimalist style with retro terminal and cryptography-inspired UI details.

> Status: early prototype. Do not treat this repository as production-ready password manager software yet.

## Features

- Encrypted local vault protected by a master password.
- Windows desktop app with installer and portable build targets.
- Android APK build through Capacitor.
- Russian interface.
- Empty vault by default, without demo records.
- Folder strip for organizing entries.
- Entry editor with title, login, URL, password, notes, folder and icon.
- Password generator inside the entry editor.
- Optional app unlock skip on a trusted local device.
- Theme settings.
- WebDAV/Koofr sync prototype.
- Wi-Fi local transfer prototype between Windows and Android.
- CSV import for Google Password Manager exports.

## Tech Stack

- React 18
- TypeScript
- Vite
- Electron
- Capacitor Android
- Web Crypto API
- Vitest

## Security Model

Vault data is encrypted locally before it is saved or synchronized.

Current crypto implementation:

- PBKDF2-SHA-256
- 250,000 iterations
- AES-GCM 256-bit
- Random salt and IV per encryption

Important limitations:

- This project has not had an external security audit.
- Sync is still under active debugging.
- Browser/WebView favicon loading is best-effort and should not be considered security-sensitive.
- Master password recovery is not implemented.

## Project Structure

```text
android/              Capacitor Android project
build/                Windows app icon
electron/             Electron main/preload processes
public/               Static app assets
src/                  React app and shared logic
src/lib/cryptoVault.ts
src/lib/syncEngine.ts
src/lib/webdavSync.ts
src/types/vault.ts
```

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm test
npm run build
```

Run the Electron app in development mode:

```bash
npm run electron:dev
```

## Build

Windows installer and portable executable:

```bash
npm run dist:win
```

Android debug APK:

```bash
npm run apk:debug
```

The Android script expects local Java and Android SDK paths used on the original Windows development machine:

```text
JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot
ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
```

Adjust `package.json` if your local paths differ.

## Synchronization

Pandora currently has two sync paths:

- Koofr/WebDAV cloud sync
- local Wi-Fi transfer between Windows and Android

The intended cloud flow is:

1. Configure Koofr WebDAV URL, email and app password.
2. Use the same master password on both devices.
3. Press `Синхронизировать` on the device that has current data.
4. Press `Синхронизировать` on the second device.

Current known issue:

Koofr confirms that `pandora-vault.pandora` is updated and contains one encrypted entry, but the second device still does not display the synchronized entry after download/merge. The sync subsystem has been rewritten to use a shared sync engine, but the end-to-end bug is still unresolved and needs deeper debugging on real Windows + Android installs.

## Known Problem For Investigation

The most important unresolved bug is cross-device sync:

- Phone creates a test entry.
- Phone syncs to Koofr/WebDAV.
- Koofr file `pandora-vault.pandora` is updated.
- The file contains a valid encrypted Pandora payload and reports one entry in sync metadata in the newer format.
- Windows downloads/syncs from Koofr without obvious transport failure.
- The entry still does not appear in the Windows UI.
- Reverse direction also fails from Windows to Android.

Likely areas to inspect:

- whether both installed apps are actually running the same build and sync format;
- whether `readSyncPayload` decrypts the downloaded payload successfully on device;
- whether `mergeSyncedVaults` maps remote root folders into the local root folder correctly;
- whether `onImportVault` persists the merged vault and updates selected folder/query state correctly;
- whether the UI filters hide the imported entry because of selected folder or search state;
- whether Capacitor localStorage origin differs after app reinstall/update;
- whether WebDAV cache or stale file reads happen on Android or Windows.

## Repository Notes

Generated output is intentionally ignored:

- `node_modules/`
- `dist/`
- `release/`
- Android Gradle build folders

No GitHub Release is created for this prototype state.
