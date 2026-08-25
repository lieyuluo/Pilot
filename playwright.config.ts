import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4317",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "cross-env JOBPILOT_DATA_DIR=.jobpilot/e2e npm run start",
    url: "http://127.0.0.1:4317/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
