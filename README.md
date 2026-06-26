# Pandora

> Локальный зашифрованный менеджер паролей для Windows и Android.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android-f2f2f2?style=for-the-badge&labelColor=050505)
![Stack](https://img.shields.io/badge/stack-React%20%2B%20Electron%20%2B%20Capacitor-f2f2f2?style=for-the-badge&labelColor=050505)
![Status](https://img.shields.io/badge/status-early%20release-f2f2f2?style=for-the-badge&labelColor=050505)

Pandora — это локальный менеджер паролей с зашифрованным хранилищем, русским интерфейсом, приложением для Windows, APK для Android и синхронизацией между устройствами через Koofr/WebDAV. Проект сделан в стиле **Dark Minimalist / Cryptography / Retro Terminal**: спокойный монохромный интерфейс без перегруженных экранов.

> Важно: проект находится на ранней стадии. Не считайте Pandora прошедшим профессиональный security audit продуктом.

## Скачать

Актуальные сборки публикуются в разделе **Releases**:

- `Pandora-Setup-0.1.0.exe` — установщик Windows.
- `Pandora-Portable-0.1.0.exe` — portable-версия Windows.
- `Pandora-Android-0.1.0-debug.apk` — Android APK.

## Возможности

- Локальное зашифрованное хранилище паролей.
- Мастер-пароль с минимальной длиной 4 символа.
- Windows-приложение через Electron.
- Android-приложение через Capacitor.
- Русский интерфейс по умолчанию.
- Папки для организации записей.
- Поиск, сортировка и быстрый просмотр записей.
- Создание, редактирование, удаление и восстановление записей через корзину.
- Просмотр пароля через кнопку-глаз и копирование логина/пароля.
- Генератор паролей внутри формы создания/редактирования записи.
- Иконки записей: авто-подхват favicon по сайту, загрузка файла, URL картинки или вставка через буфер обмена.
- Темы оформления: Pandora Cipher, Terminal Green, Paper Key.
- Koofr/WebDAV синхронизация между Windows и Android.
- Дополнительный локальный Wi-Fi обмен.
- Отладочные логи, которые можно экспортировать и отправить для диагностики.
- Биометрический вход на Android, если устройство и системные настройки это поддерживают.
- CSV импорт для переносов из других менеджеров.

## Безопасность

Pandora шифрует данные локально перед сохранением и синхронизацией.

Текущая криптография:

- PBKDF2-SHA-256;
- 250 000 итераций;
- AES-GCM 256-bit;
- случайные salt и IV при шифровании.

Что важно понимать:

- мастер-пароль не восстанавливается;
- без мастер-пароля расшифровать хранилище нельзя;
- синхронизация передаёт зашифрованный `.pandora` файл;
- пароли не должны попадать в логи;
- проект пока не проходил внешний аудит безопасности.

## Синхронизация

Основной рекомендуемый способ — **Koofr через WebDAV**.

Общий сценарий:

1. Создайте Koofr account.
2. В Koofr создайте app password: `Account settings -> Preferences -> Password`.
3. В Pandora укажите WebDAV URL, email Koofr и app password.
4. Используйте одинаковый мастер-пароль на Windows и Android.
5. Нажмите синхронизацию на устройстве с актуальными данными.
6. Нажмите синхронизацию на втором устройстве.

Состояние корзины тоже синхронизируется: удалённая запись попадает в корзину на другом устройстве, пока пользователь не удалит её навсегда.

## Интерфейс

Pandora использует один React-интерфейс, адаптированный под две платформы:

- **Windows**: sidebar, command bar, список записей и правая панель деталей.
- **Android**: компактный top bar, поиск, папки, список, bottom navigation и bottom sheet для деталей.

Основная цель интерфейса — быстро открыть запись, скопировать логин/пароль и не отвлекаться на лишние панели.

## Сборка из исходников

Требования:

- Node.js;
- npm;
- Java 21 для Android-сборки;
- Android SDK для APK;
- Windows для сборки `.exe`.

Установка зависимостей:

```bash
npm install
```

Проверки:

```bash
npm test -- --run
npm run build
```

Windows installer и portable:

```bash
npm run dist:win
```

Android debug APK:

```bash
npm run apk:debug
```

Android script в `package.json` использует локальные пути Windows-разработчика:

```text
JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot
ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
```

Если у вас другие пути, измените скрипт под свою систему.

## Структура проекта

```text
android/              Capacitor Android project
build/                Windows icon and build assets
electron/             Electron main process
public/               Static assets
src/                  React app, crypto, sync and storage logic
src/lib/cryptoVault.ts
src/lib/syncEngine.ts
src/lib/webdavSync.ts
src/types/vault.ts
```

## Статус проекта

Pandora уже собирается в Windows EXE и Android APK, но остаётся ранним релизом. Перед использованием для критически важных паролей нужен аудит, больше тестов и аккуратная проверка сценариев восстановления/обновления.

---

# Pandora

> A local encrypted password manager for Windows and Android.

Pandora is a local-first password manager with an encrypted vault, Windows desktop builds, Android APK builds and cross-device sync through Koofr/WebDAV. The interface follows a **Dark Minimalist / Cryptography / Retro Terminal** direction: monochrome, focused and intentionally quiet.

> Important: Pandora is an early release. Do not treat it as professionally audited password manager software yet.

## Download

Current builds are published in **Releases**:

- `Pandora-Setup-0.1.0.exe` — Windows installer.
- `Pandora-Portable-0.1.0.exe` — Windows portable build.
- `Pandora-Android-0.1.0-debug.apk` — Android APK.

## Features

- Encrypted local password vault.
- Master password with a 4-character minimum.
- Windows app through Electron.
- Android app through Capacitor.
- Russian-first interface.
- Folders for organizing entries.
- Search, sorting and quick entry preview.
- Create, edit, soft-delete, restore and permanently delete entries.
- Password reveal button and login/password copy actions.
- Password generator inside the entry editor.
- Entry icons through favicon auto-loading, local file upload, image URL or clipboard paste.
- Themes: Pandora Cipher, Terminal Green, Paper Key.
- Koofr/WebDAV sync between Windows and Android.
- Optional local Wi-Fi transfer.
- Exportable debug logs for troubleshooting.
- Android biometric unlock when supported by the device.
- CSV import for migration from other managers.

## Security

Pandora encrypts vault data locally before saving or syncing it.

Current crypto implementation:

- PBKDF2-SHA-256;
- 250,000 iterations;
- AES-GCM 256-bit;
- random salt and IV for encryption.

Important notes:

- there is no master password recovery;
- the vault cannot be decrypted without the master password;
- sync uploads an encrypted `.pandora` file;
- passwords should never be written to logs;
- the project has not passed an external security audit yet.

## Sync

The recommended sync method is **Koofr through WebDAV**.

General flow:

1. Create a Koofr account.
2. Create an app password in Koofr: `Account settings -> Preferences -> Password`.
3. Enter the WebDAV URL, Koofr email and app password in Pandora.
4. Use the same master password on Windows and Android.
5. Sync from the device that has the newest data.
6. Sync from the second device.

Trash state is synced too: a deleted entry appears in trash on the other device until it is permanently deleted.

## Interface

Pandora uses one React interface adapted for both platforms:

- **Windows**: sidebar, command bar, entry list and persistent details panel.
- **Android**: compact top bar, search, folders, list, bottom navigation and bottom sheet details.

The product goal is simple: open an entry quickly, copy login/password and avoid unnecessary UI noise.

## Build From Source

Requirements:

- Node.js;
- npm;
- Java 21 for Android builds;
- Android SDK for APK builds;
- Windows for `.exe` builds.

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm test -- --run
npm run build
```

Build Windows installer and portable app:

```bash
npm run dist:win
```

Build Android debug APK:

```bash
npm run apk:debug
```

The Android script in `package.json` uses local Windows development paths:

```text
JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot
ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
```

Change the script if your paths are different.

## Project Structure

```text
android/              Capacitor Android project
build/                Windows icon and build assets
electron/             Electron main process
public/               Static assets
src/                  React app, crypto, sync and storage logic
src/lib/cryptoVault.ts
src/lib/syncEngine.ts
src/lib/webdavSync.ts
src/types/vault.ts
```

## Project Status

Pandora already builds as a Windows EXE and Android APK, but it is still an early release. Before using it for critical passwords, it needs a security audit, broader testing and careful validation of recovery/update scenarios.
