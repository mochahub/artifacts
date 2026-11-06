import { defineConfig } from "@playwright/test";
import {
  BASE_URL,
  CONTENT_URL,
  DATABASE_URL,
  IPHONE as iphone,
  PORTS,
  S3_ENDPOINT,
  SECRET,
} from "./e2e/stack.ts";

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: "line",
  use: {
    baseURL: BASE_URL,
    browserName: "webkit",
    trace: "retain-on-failure",
    // A document that gets no answer has hung CI until the test's own limit. Say so sooner.
    navigationTimeout: 30_000,
  },
  // Viewports from 10, "Test layers".
  // `claim` sees the server in setup mode, then claims it for every other test.
  projects: [
    { name: "claim", testMatch: "claim.setup.ts", use: iphone },
    { name: "iphone", use: { ...iphone, storageState: "e2e/.auth.json" }, dependencies: ["claim"] },
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 900 }, storageState: "e2e/.auth.json" },
      dependencies: ["claim"],
    },
    // Virtual authenticators need Chromium's CDP (10), and the offline test its service worker controls.
    {
      name: "passkeys",
      testMatch: "*.chromium.ts",
      use: { browserName: "chromium", viewport: { width: 1280, height: 800 } },
      dependencies: ["claim"],
    },
  ],
  // Runs the real server against docker-compose.test.yml (or the stack e2e/stack.ts is pointed at), serving the built viewer. `bun run e2e` sets both up.
  webServer: {
    command: "bun ../server/src/index.ts",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    // The server's warnings belong next to a test that failed because of them.
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL,
      S3_ENDPOINT,
      S3_REGION: "auto",
      S3_BUCKET: "artifacts-e2e",
      S3_ACCESS_KEY_ID: "devaccesskey",
      S3_SECRET_ACCESS_KEY: "devsecretkey",
      PUBLIC_URL: BASE_URL,
      CONTENT_URL,
      SETUP_TOKEN: SECRET,
      SESSION_SECRET: SECRET,
      OPS_SECRET: SECRET,
      PORT: String(PORTS.app),
      CONTENT_PORT: String(PORTS.content),
      INTERNAL_PORT: String(PORTS.internal),
      LOG_LEVEL: "warn",
    },
  },
});
