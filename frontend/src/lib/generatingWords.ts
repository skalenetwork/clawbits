import type { BrailleSpinnerName } from "unicode-animations";

// Playful gerunds that stand in for "Generating…" while an agent
// drafts a reply. A rotating word reads less clinical than a static
// label and gives users something to watch while they wait.
export const GENERATING_WORDS: readonly string[] = [
  "Cogitating",
  "Pondering",
  "Ruminating",
  "Mulling",
  "Brewing",
  "Percolating",
  "Marinating",
  "Noodling",
  "Whittling",
  "Tinkering",
  "Simmering",
  "Stewing",
  "Musing",
  "Incubating",
  "Conjuring",
  "Scheming",
  "Puttering",
  "Moseying",
  "Deliberating",
  "Contemplating",
  "Synthesising",
  "Reticulating splines",
  "Summoning wisdom",
  "Herding tokens",
  "Untangling thoughts",
  "Wrangling semantics",
  "Chasing neurons",
  "Aligning synapses",
  "Loading brain",
  "Divining",
];

// Pre-init ("optimistic") gerunds shown between the moment you send and the
// agent's first real signal - a distinct set from the thinking words above so
// "just sent, agent hasn't woken up yet" reads differently from "actively
// thinking". Deterministic per agent (below), so it doesn't churn in the brief
// window before the real activity crossfades in.
export const WARMING_WORDS: readonly string[] = [
  "Warming up",
  "Waking up",
  "Booting up",
  "Spinning up",
  "Rousing",
  "Stirring",
  "Coming online",
  "Stretching",
  "Powering on",
  "Blinking awake",
];

export function randomGeneratingWord(previous?: string): string {
  // Avoid repeating the same word twice in a row; with 30 options the
  // cost of a single retry is trivial and the UX is noticeably livelier.
  for (let i = 0; i < 4; i++) {
    const pick = GENERATING_WORDS[Math.floor(Math.random() * GENERATING_WORDS.length)]!;
    if (pick !== previous) return pick;
  }
  return GENERATING_WORDS[0]!;
}

// Braille animations that read well as an inline "thinking" spinner. Restricted
// to SINGLE-CELL spinners (one glyph wide, constant width across frames): the
// multi-cell "wave" spinners (braillewave/dna/helix/sparkle/waverows, up to 4
// glyphs) overflow the fixed spinner slot and collide with the label. A small
// pool still gives each agent a visually distinct-but-tidy spinner.
export const SPINNER_POOL: readonly BrailleSpinnerName[] = [
  "braille",
  "orbit",
  "breathe",
];

// Pick a spinner *deterministically* from the agent id. The presence-derived
// GeneratingRow and the streaming DraftBody render two separate indicator
// instances for the same agent; a random per-mount pick would swap the glyph at
// the handoff. Hashing the id keeps both instances on the same animation, so the
// swap is invisible.
export function spinnerForAgent(agentId: string): BrailleSpinnerName {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (Math.imul(hash, 31) + agentId.charCodeAt(i)) | 0;
  }
  return SPINNER_POOL[Math.abs(hash) % SPINNER_POOL.length] ?? "braille";
}

// Deterministic pre-init word per agent. Salted differently from the spinner
// hash so the two don't correlate. Static (not rotating) - the pre-init window
// is brief and crossfades into the thinking gerunds the moment real activity
// lands.
export function warmingWordForAgent(agentId: string): string {
  let hash = 7;
  for (let i = 0; i < agentId.length; i++) {
    hash = (Math.imul(hash, 131) + agentId.charCodeAt(i)) | 0;
  }
  return WARMING_WORDS[Math.abs(hash) % WARMING_WORDS.length] ?? WARMING_WORDS[0]!;
}
