import { describe, expect, test } from "bun:test";
import {
  MAX_DISCORD_OUTPUT_MESSAGES,
  splitForDiscord,
} from "./discord-output";

describe("splitForDiscord", () => {
  test("leaves short messages unchanged", () => {
    expect(splitForDiscord("hello")).toEqual(["hello"]);
  });

  test("caps output and marks it as truncated", () => {
    const chunks = splitForDiscord("word ".repeat(10_000));

    expect(chunks).toHaveLength(MAX_DISCORD_OUTPUT_MESSAGES);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.at(-1)).toEndWith("[output truncated]");
  });

  test("closes and reopens code fences between messages", () => {
    const source = `\`\`\`ts\n${"const value = 1;\n".repeat(20)}\`\`\``;
    const chunks = splitForDiscord(source, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("```ts\n"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("```"))).toBe(true);
  });
});
