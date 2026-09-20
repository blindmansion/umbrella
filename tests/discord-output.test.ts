import { describe, expect, test } from "bun:test";
import {
  MAX_OUTPUT_MESSAGES,
  splitOutput,
} from "../src/core/output";

describe("splitOutput", () => {
  test("leaves short messages unchanged", () => {
    expect(splitOutput("hello")).toEqual(["hello"]);
  });

  test("caps output and marks it as truncated", () => {
    const chunks = splitOutput("word ".repeat(10_000));

    expect(chunks).toHaveLength(MAX_OUTPUT_MESSAGES);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.at(-1)).toEndWith("[output truncated]");
  });

  test("closes and reopens code fences between messages", () => {
    const source = `\`\`\`ts\n${"const value = 1;\n".repeat(20)}\`\`\``;
    const chunks = splitOutput(source, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("```ts\n"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("```"))).toBe(true);
  });
});
