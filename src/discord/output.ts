export const DISCORD_MESSAGE_LIMIT = 2_000;
export const MAX_DISCORD_OUTPUT_MESSAGES = 10;

const TRUNCATION_NOTICE = "\n\n[output truncated]";
const FENCE_CLOSE = "\n```";

type Fence = {
  opener: string;
};

export function splitForDiscord(
  value: string,
  limit = DISCORD_MESSAGE_LIMIT,
  maxChunks = MAX_DISCORD_OUTPUT_MESSAGES,
): string[] {
  if (limit < 32) {
    throw new RangeError("Discord message limit must be at least 32 characters");
  }
  if (maxChunks < 1) {
    throw new RangeError("Discord message count must be at least 1");
  }
  if (value.length <= limit) return [value];

  const chunks: string[] = [];
  let start = 0;
  let fence: Fence | undefined;

  while (start < value.length && chunks.length < maxChunks) {
    const prefix = fence ? `${fence.opener}\n` : "";
    const remaining = value.slice(start);
    const finalFence = updateFence(remaining, fence);
    const finalSuffix = finalFence ? FENCE_CLOSE : "";
    if (prefix.length + remaining.length + finalSuffix.length <= limit) {
      chunks.push(`${prefix}${remaining}${finalSuffix}`);
      break;
    }

    const isLastAllowedChunk = chunks.length === maxChunks - 1;
    const reserved =
      FENCE_CLOSE.length +
      (isLastAllowedChunk ? TRUNCATION_NOTICE.length : 0);
    const contentLimit = limit - prefix.length - reserved;
    const { segment, next } = takeSegment(value, start, contentLimit);
    const nextFence = updateFence(segment, fence);
    const truncated = isLastAllowedChunk && next < value.length;
    const suffix = nextFence ? FENCE_CLOSE : "";

    chunks.push(
      `${prefix}${segment}${suffix}${truncated ? TRUNCATION_NOTICE : ""}`,
    );
    start = next;
    fence = nextFence;
  }

  return chunks;
}

function takeSegment(
  value: string,
  start: number,
  limit: number,
): { segment: string; next: number } {
  if (value.length - start <= limit) {
    return { segment: value.slice(start), next: value.length };
  }

  const window = value.slice(start, start + limit);
  let length = window.lastIndexOf("\n");
  if (length < Math.floor(limit / 2)) length = window.lastIndexOf(" ");
  if (length < Math.floor(limit / 2)) length = limit;

  let next = start + length;
  const segment = value.slice(start, next);
  if (value[next] === "\n" || value[next] === " ") next += 1;
  return { segment, next };
}

function updateFence(segment: string, initial: Fence | undefined): Fence | undefined {
  let fence = initial;

  for (const line of segment.split("\n")) {
    const match = line.match(/^[ \t]{0,3}```(.*)$/);
    if (!match) continue;

    const remainder = match[1]?.trim() ?? "";
    if (fence) {
      if (remainder === "") fence = undefined;
    } else {
      const language = remainder.split(/\s+/, 1)[0]?.slice(0, 32);
      fence = { opener: language ? `\`\`\`${language}` : "```" };
    }
  }

  return fence;
}
