import { expect, test } from "bun:test";
import { containerExtractor } from "./container-extractor.ts";
import { extractBytes } from "./extractor.ts";

test("extractor requires immutable local image id", () => {
  expect(() => containerExtractor("latest")).toThrow("extractor_image_required");
});
// Private construction-time fixture, never exposed by HTTP or production configuration.
const image = process.env.TEST_LIBRARIAN_EXTRACTOR_IMAGE;
(image ? test : test.skip)(
  "isolated inert text/HTML extraction and malformed PDF refusal",
  async () => {
    if (!image) throw new Error("fixture_image_required");
    const sandbox = containerExtractor(image);
    expect(await extractBytes(Buffer.from("hello"), "text/plain", sandbox)).toBe("hello");
    expect(
      await extractBytes(
        Buffer.from('<p>hello</p><script>secret()</script><img src="http://127.0.0.1/">'),
        "text/html",
        sandbox,
      ),
    ).toBe("hello");
    await expect(
      extractBytes(Buffer.from("%PDF-1.7\nmalformed\n%%EOF"), "application/pdf", sandbox),
    ).rejects.toThrow();
    await expect(extractBytes(Buffer.from("a".repeat(1048577)), "text/plain", sandbox)).rejects.toThrow();
  },
  60000,
);
