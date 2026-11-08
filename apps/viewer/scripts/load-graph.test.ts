import { expect, test } from "bun:test";
import { closure, coldLoad, type Manifest } from "./load-graph.ts";

test("cold editors include transitive shared code and CSS once, without the other editor", () => {
  const graph: Manifest = {
    reader: { file: "reader.js", imports: ["base"], dynamicImports: ["article", "board"] },
    base: { file: "base.js", imports: ["reader"] },
    article: { file: "article.js", imports: ["reader", "provider", "provider"] },
    board: { file: "board.js", imports: ["reader", "provider"] },
    provider: { file: "provider.js", imports: ["yjs"], css: ["shared.css"] },
    yjs: { file: "yjs.js" },
  };
  expect(coldLoad(graph, "article", "reader")).toEqual(["article.js", "provider.js", "shared.css", "yjs.js"]);
  expect(coldLoad(graph, "board", "reader")).toEqual(["board.js", "provider.js", "shared.css", "yjs.js"]);
  expect(() => closure(graph, "missing")).toThrow("Missing build chunk");
});
