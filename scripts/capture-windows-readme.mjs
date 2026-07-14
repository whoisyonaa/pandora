import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const output = "screenshot-output";
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
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
await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

await page.getByLabel("Новый мастер-пароль").fill("Pandora-Readme-2026");
await page.getByLabel("Повторите мастер-пароль").fill("Pandora-Readme-2026");
await page.getByRole("button", { name: "Продолжить" }).click();
await page.getByLabel("Новый PIN-код").fill("1357");
await page.getByLabel("Повторите PIN-код").fill("1357");
await page.getByRole("button", { name: "Сохранить PIN" }).click();
await page.getByRole("button", { name: "Хранилище", exact: true }).click();

async function addEntry({ title, username, site, password }) {
  await page.getByRole("button", { name: "Новая запись", exact: true }).click();
  const editor = page.locator('[aria-label="Редактор записи"]');
  await editor.waitFor();
  await editor.getByLabel("Название").fill(title);
  await editor.getByLabel("Логин").fill(username);
  await editor.getByRole("textbox", { name: "Сайт", exact: true }).fill(site);
  await editor.locator('input[type="password"]').fill(password);
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  const details = page.locator('[aria-label="Просмотр записи"]');
  if (await details.isVisible()) {
    await details.getByRole("button", { name: "Закрыть просмотр" }).click();
    await details.waitFor({ state: "hidden" });
  }
}

await addEntry({ title: "Reddit", username: "pandora.demo", site: "reddit.com", password: "R3ddit-demo-2026!" });
await addEntry({ title: "Koofr", username: "sync@example.com", site: "koofr.eu", password: "K00fr-demo-2026!" });
await addEntry({ title: "GitHub", username: "pandora-demo", site: "github.com", password: "G1tHub-demo-2026!" });

await page.getByRole("button", { name: /Reddit.*pandora\.demo/ }).click();
await page.locator('[aria-label="Просмотр записи"]').waitFor();
await page.waitForTimeout(600);
await page.screenshot({ path: `${output}/desktop-vault.png`, fullPage: false });

await page.getByRole("button", { name: "Закрыть просмотр" }).click();
await page.getByRole("button", { name: "Настройки", exact: true }).click();
const settings = page.locator('[aria-label="Настройки"]');
await settings.waitFor();
await settings.getByRole("button", { name: "Внешний вид", exact: true }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${output}/settings-themes.png`, fullPage: false });

await settings.getByRole("button", { name: "Закрыть настройки" }).click();
await page.getByRole("button", { name: "Заблокировать" }).click();
await page.getByLabel("PIN-код").waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: `${output}/unlock.png`, fullPage: false });

await browser.close();
