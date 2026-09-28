import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

dotenv.config({ path: ".env.playwright" });

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET ??= process.env.PLAYWRIGHT_JWT_SECRET;

const baseURL = process.env.STAX_BASE_URL ?? "http://127.0.0.1:4173";
const baseUrl = new URL(baseURL);
const useLocalServer =
  !process.env.STAX_BASE_URL ||
  ["localhost", "127.0.0.1"].includes(baseUrl.hostname);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  ...(useLocalServer
    ? {
        webServer: {
          command: `npm run dev -- --host 127.0.0.1 --port ${baseUrl.port || "4173"}`,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }
    : {}),
});