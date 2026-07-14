import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const output = "screenshot-output";
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  locale: "ru-RU",
  colorScheme: "dark",
});

await context.addInitScript(() => {
  let auth = { configured: false, failedAttempts: 0, masterPassword: "" };
  window.pandoraAuth = {
    status: async () => ({ configured: auth.configured, failedAttempts: auth.failedAttempts }),
    setup: async (masterPassword, _pin) => {
      auth = { configured: true, failedAttempts: 0, masterPassword };
    },
    unlockWithPin: async () => ({
      masterPassword: auth.masterPassword,
      failedAttempts: 0,
      remainingAttempts: 3,
      requiresMasterPassword: false,
    }),
    updatePin: async () => {},
    updateMasterPassword: async (masterPassword) => {
      auth.masterPassword = masterPassword;
    },
    resetFailures: async () => {
      auth.failedAttempts = 0;
    },
    clear: async () => {
      auth = { configured: false, failedAttempts: 0, masterPassword: "" };
    },
  };
});

const page = await context.newPage();
await page.goto("http://127.0.0.1:4173/?platform=android", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

await page.getByLabel("Новый мастер-пароль").fill("Pandora-Readme-2026");
await page.getByLabel("Повторите мастер-пароль").fill("Pandora-Readme-2026");
await page.getByRole("button", { name: "Продолжить" }).click();
await page.getByText("Создайте PIN", { exact: true }).waitFor();
await page.screenshot({ path: `${output}/android-pin.png`, fullPage: false });

for (const digit of ["1", "3", "5", "7"]) {
  await page.getByRole("button", { name: digit, exact: true }).click();
}
await page.getByRole("button", { name: "Продолжить" }).click();
for (const digit of ["1", "3", "5", "7"]) {
  await page.getByRole("button", { name: digit, exact: true }).click();
}
await page.getByRole("button", { name: "Сохранить PIN" }).click();
await page.getByRole("heading", { name: "Хранилище" }).waitFor();

async function addEntry({ title, username, url, password }) {
  const create = page.getByRole("button", { name: /Новая запись|Создать запись/ }).first();
  await create.click();
  const editor = page.locator('[aria-label="Редактор записи"]');
  await editor.waitFor();
  await editor.getByLabel("Название").fill(title);
  await editor.getByLabel("Логин").fill(username);
  await editor.getByLabel("URL").fill(url);
  await editor.locator('input[type="password"]').fill(password);
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  const details = page.locator('[aria-label="Просмотр записи"]');
  if (await details.isVisible()) {
    await details.getByRole("button", { name: "Закрыть просмотр" }).click();
    await details.waitFor({ state: "hidden" });
  }
}

await addEntry({ title: "Reddit", username: "pandora.demo", url: "reddit.com", password: "R3ddit-demo-2026!" });
await addEntry({ title: "Koofr", username: "sync@example.com", url: "koofr.eu", password: "K00fr-demo-2026!" });
await addEntry({ title: "GitHub", username: "pandora-demo", url: "github.com", password: "G1tHub-demo-2026!" });

await page.waitForTimeout(800);
await page.screenshot({ path: `${output}/android-vault.png`, fullPage: false });

await page.getByRole("button", { name: /Reddit.*pandora\.demo/ }).click();
await page.locator('[aria-label="Просмотр записи"]').waitFor();
await page.screenshot({ path: `${output}/android-entry.png`, fullPage: false });

await page.getByRole("button", { name: "Закрыть просмотр" }).click();
await page.getByRole("button", { name: "Настройки", exact: true }).click();
await page.getByRole("heading", { name: "Настройки" }).waitFor();
await page.screenshot({ path: `${output}/android-settings.png`, fullPage: false });

await browser.close();
