import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.pandora.passwords",
  appName: "Pandora",
  webDir: "dist",
  bundledWebRuntime: false,
  android: {
    backgroundColor: "#000000",
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
