import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

declare global {
  interface Window {
    Capacitor?: unknown;
  }
}

function isPackagedSurface() {
  const userAgent = navigator.userAgent.toLowerCase();
  if (Boolean(window.Capacitor) && userAgent.includes("android")) {
    document.documentElement.classList.add("android-native");
  }
  if (userAgent.includes("electron")) {
    document.documentElement.classList.add("electron-windows");
  }
  return userAgent.includes("electron") || Boolean(window.Capacitor);
}

function BrowserDisabled() {
  return (
    <main className="unsupported-screen">
      <section>
        <img src="./pandoralogo.png" alt="Pandora" />
        <h1>Pandora запускается только как программа или Android-приложение</h1>
        <p>Обычная браузерная версия отключена. Используйте Windows .exe или APK.</p>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isPackagedSurface() ? <App /> : <BrowserDisabled />}
  </React.StrictMode>,
);
