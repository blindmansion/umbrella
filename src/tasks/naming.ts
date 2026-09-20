import type { TaskKind } from "../store";

export function createChannelName(
  kind: TaskKind,
  number: number | null,
  slug: string,
): string {
  const prefixes: Record<TaskKind, string> = {
    planning: "plan",
    feature: "feat",
    bugfix: "bug",
    review: "pr",
  };
  const stem = `${prefixes[kind]}${number === null ? "" : `-${number}`}`;
  const maxSlugLength = Math.max(1, 60 - stem.length - 1);
  return `${stem}-${slug.slice(0, maxSlugLength)}`.slice(0, 100);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}
