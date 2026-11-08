/** Separate process only: never import this transport mock into the server test process. */
import { mock } from "bun:test";

mock.module("../../ingestion/transport.ts", () => ({
  fetchPublicSource: async (url: string) => {
    if (url !== "https://source.example.test/fixture") throw new Error("fixture URL denied");
    return { bytes: Buffer.from("Verified fixture fact."), mime: "text/plain" };
  },
}));
process.env.LIBRARIAN_QA_URL = "private-fixture";
await import("../../../../test/librarian-content-tools.test.ts");
