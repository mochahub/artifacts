import { describe, expect, test } from "bun:test";
import { agentPrompt } from "./prompt.ts";

describe("agentPrompt", () => {
  test("names the artifact for the CLI, and links to the server it came from", () => {
    expect(agentPrompt({ project: "camerabuddy", slug: "roadmap" }, "https://art.example.com")).toBe(
      [
        "Address the open comments on camerabuddy/roadmap using the artifacts skill.",
        "If the source isn't in this repo, run `artifacts pull camerabuddy/roadmap` first.",
        "https://art.example.com/camerabuddy/roadmap",
      ].join("\n"),
    );
  });
});
