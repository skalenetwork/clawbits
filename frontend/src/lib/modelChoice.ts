import type { ModelOption, ThinkingLevel } from "@/lib/api";

interface EffortSegment {
  label: string;
  level: ThinkingLevel;
}

interface EffortOptions {
  segments: EffortSegment[];
  think: boolean;
}

const SEGMENTS: readonly { label: string; levels: readonly ThinkingLevel[] }[] = [
  { label: "Low", levels: ["low"] },
  { label: "Medium", levels: ["medium"] },
  { label: "High", levels: ["high"] },
  { label: "Max", levels: ["max", "xhigh"] },
];

function segmentsOf(levels: readonly ThinkingLevel[]): EffortSegment[] {
  return SEGMENTS.flatMap(({ label, levels: candidates }) => {
    const level = candidates.find((c) => levels.includes(c));
    return level ? [{ label, level }] : [];
  });
}

export function vendorOf(ref: string): string {
  return ref.split("/").at(-2) ?? ref;
}

export function effortOptions(levels: readonly ThinkingLevel[]): EffortOptions {
  const segments = segmentsOf(levels);
  return {
    segments: segments.length > 1 ? segments : [],
    think: levels.includes("off") && segments.length > 0,
  };
}

export function thinkOnLevel(option: ModelOption): ThinkingLevel | null {
  const levels = segmentsOf(option.levels).map((s) => s.level);
  return levels.find((l) => l === option.default_level) ?? levels.find((l) => l === "medium") ?? levels[0] ?? null;
}

export function keepThinking(option: ModelOption, thinking: ThinkingLevel | null): ThinkingLevel | null {
  return thinking && option.levels.includes(thinking) ? thinking : null;
}
