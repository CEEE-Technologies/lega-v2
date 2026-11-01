import path from "path";
import { PlaywrightTestConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, ".env") });

// Light/dark contrast audit across the app's screens.
const config: PlaywrightTestConfig = {
  timeout: 120 * 1000,
  workers: 1,
  testDir: path.join(__dirname, "e2e/theme-audit"),
  globalSetup: path.join(__dirname, "e2e/global-setup.ts"),
  retries: 0,
  outputDir: "test-results/theme-audit-artifacts/",
  reporter: [["list"]],
  use: {
    testIdAttribute: "data-testId",
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || "http://localhost:4000",
    storageState: "e2e/.auth/user.json",
  },
  projects: [
    {
      name: "Desktop Chrome",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        contextOptions: { reducedMotion: "reduce" },
      },
    },
  ],
};
export default config;
