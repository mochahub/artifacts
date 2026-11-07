// Where the e2e stack listens, in one place. The defaults match deploy/compose/docker-compose.test.yml;
// a second stack beside it sets these instead.
const port = Number(process.env.E2E_PORT ?? 18080);

/** The viewer and API. The content host is another site, on 127.0.0.1, as the sandbox needs. */
export const BASE_URL = `http://localhost:${port}`;
export const CONTENT_URL = `http://127.0.0.1:${port + 1}`;
export const PORTS = { app: port, content: port + 1, internal: port + 2 };
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://artifacts:artifacts@127.0.0.1:55432/artifacts_test";
export const S3_ENDPOINT = process.env.E2E_S3_ENDPOINT ?? "http://127.0.0.1:18333";

/** The setup token, session and ops secret the test server runs with. */
export const SECRET = "e2e-secret-e2e-secret-e2e-secret-e2e";

/** The phone every iPhone test uses, and the stranger who visits on one. */
export const IPHONE = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
