import { defineConfig } from "@playwright/test";

const secret = "e2e-secret-e2e-secret-e2e-secret-e2e";
const iphone = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: "line",
  use: { baseURL: "http://localhost:18080", browserName: "webkit", trace: "retain-on-failure" },
  // Viewports from 10, "Test layers".
  // `claim` sees the server in setup mode, then claims it for every other test.
  projects: [
    { name: "claim", testMatch: "claim.setup.ts", use: iphone },
    { name: "iphone", use: iphone, dependencies: ["claim"] },
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } }, dependencies: ["claim"] },
  ],
  // Runs the real server against docker-compose.test.yml, serving the built viewer. `bun run e2e` sets both up.
  webServer: {
    command: "bun ../server/src/index.ts",
    url: "http://localhost:18080/api/health",
    reuseExistingServer: false,
    env: {
      DATABASE_URL: "postgres://artifacts:artifacts@127.0.0.1:55432/artifacts_test",
      S3_ENDPOINT: "http://127.0.0.1:18333",
      S3_REGION: "auto",
      S3_BUCKET: "artifacts-e2e",
      S3_ACCESS_KEY_ID: "devaccesskey",
      S3_SECRET_ACCESS_KEY: "devsecretkey",
      PUBLIC_URL: "http://localhost:18080",
      CONTENT_URL: "http://127.0.0.1:18081",
      SETUP_TOKEN: secret,
      SESSION_SECRET: secret,
      OPS_SECRET: secret,
      PORT: "18080",
      CONTENT_PORT: "18081",
      INTERNAL_PORT: "18082",
      LOG_LEVEL: "warn",
    },
  },
});
