/**
 * The sample org both product demos render: one cast, twelve conversations.
 * Invented except the desktop version, the real latest release passed in at
 * build time (src/lib/releases.ts). Row times are formatRelativeShort
 * (frontend/src/lib/formatting.ts:73-85) read at the demo's now: Tue, Aug 4
 * 2026, 11:30 AM.
 */

type Species = "human" | "agent" | "channel";
export type Presence = "online" | "idle" | "setup" | "offline";
export type Who = "you" | "mara" | "josh" | "priya" | "sasha" | "ivan" | "atlas" | "hermes" | "scout" | "quill" | "forge";

export interface AgentFacts {
  blurb: string;
  runtime: "openclaw" | "hermes" | "ironclaw";
  host: "reef" | "self";
  engine?: string;
  plugin: string;
  owner: Who;
  dm: boolean;
}

export interface Person {
  name: string;
  species: "human" | "agent";
  ava: string;
  presence: Presence;
  agent?: AgentFacts;
}

export const CAST: Record<Who, Person> = {
  you: { name: "Chris", species: "human", ava: "/avatars/human-5.webp", presence: "online" },
  mara: { name: "Mara", species: "human", ava: "/avatars/human-1.webp", presence: "online" },
  josh: { name: "Josh", species: "human", ava: "/avatars/human-2.webp", presence: "idle" },
  priya: { name: "Priya", species: "human", ava: "/avatars/human-3.webp", presence: "online" },
  sasha: { name: "Sasha", species: "human", ava: "/avatars/human-4.webp", presence: "online" },
  ivan: { name: "Ivan", species: "human", ava: "/avatars/human-6.svg", presence: "online" },
  atlas: {
    name: "atlas", species: "agent", ava: "/avatars/agent-2.svg", presence: "online",
    agent: { blurb: "Ships the release train and writes the notes nobody else will.", runtime: "openclaw", host: "reef", engine: "2026.9.4", plugin: "0.17.24", owner: "mara", dm: false },
  },
  hermes: {
    name: "hermes", species: "agent", ava: "/avatars/agent-1.svg", presence: "online",
    agent: { blurb: "Handles the shared mailbox end to end.", runtime: "hermes", host: "reef", engine: "1.2.0", plugin: "0.17.24", owner: "priya", dm: true },
  },
  scout: {
    name: "scout", species: "agent", ava: "/avatars/agent-3.svg", presence: "online",
    agent: { blurb: "Watches the repos overnight and triages what matters.", runtime: "ironclaw", host: "reef", engine: "0.4.1", plugin: "0.17.24", owner: "josh", dm: true },
  },
  quill: {
    name: "quill", species: "agent", ava: "/avatars/agent-4.svg", presence: "online",
    agent: { blurb: "Turns sprawling threads into crisp weekly digests.", runtime: "hermes", host: "reef", engine: "1.2.0", plugin: "0.17.24", owner: "you", dm: true },
  },
  forge: {
    name: "forge", species: "agent", ava: "/avatars/agent-5.svg", presence: "setup",
    agent: { blurb: "Owns CI. Reruns the flaky, quarantines the broken.", runtime: "openclaw", host: "self", plugin: "0.17.19", owner: "you", dm: true },
  },
};

interface Attachment {
  kind: "image" | "doc";
  src?: string;
  name: string;
  meta: string;
  from: string;
  when: string;
}

export interface About {
  line?: string;
  rows?: [string, string][];
}

export interface Msg {
  day?: string;
  by: Who;
  html?: string;
  edited?: boolean;
  file?: { name: string; meta: string };
  img?: { src: string; w: number; h: number };
  card?: boolean;
  reactions?: { e: string; n: number; mine?: boolean }[];
  time: string;
  receipt?: "read" | "delivered";
}

export interface Chat {
  id: string;
  species: Species;
  name: string;
  src: string;
  peer?: Who;
  members?: number;
  pins?: number;
  preview: string;
  time: string;
  clip?: boolean;
  unread?: number;
  mention?: number;
  pinned?: boolean;
  working?: boolean;
  msgs: Msg[];
  draft?: string;
  older?: Attachment[];
  about?: About;
}

const dm = (peer: Exclude<Who, "you">, chat: Omit<Chat, "species" | "name" | "src" | "peer">): Chat => ({
  species: CAST[peer].species,
  name: CAST[peer].name,
  src: CAST[peer].ava,
  peer,
  ...chat,
});

export function demoChats(v: string): Chat[] {
  return [
    {
      id: "allhands", species: "channel", name: "all-hands", src: "/avatars/channel-1.svg",
      members: 24, preview: "⭐ Clawbits is open-source! Go star…", time: "25m",
      about: {
        rows: [
          ["Topic", "Company-wide announcements"],
          ["Members", "24 · 5 agents"],
          ["Visibility", "Open to the org"],
          ["Created", "8 Jan 2026"],
        ],
      },
      older: [
        { kind: "doc", name: "launch-deck.pdf", meta: "6.2 MB · PDF", from: "Mara", when: "Yesterday" },
        { kind: "doc", name: "weekly-digest-w31.md", meta: "9 KB · Markdown", from: "quill", when: "Fri, Jul 31" },
      ],
      msgs: [
        { day: "Yesterday", by: "priya", html: "<p>offsite photos are in the drive 📸</p>", time: "4:20 PM" },
        { by: "mara", html: "<p>already stole one for the launch deck</p>", time: "4:31 PM" },
        { day: "Today", by: "josh", html: "<p>reminder: demo day is Thursday - bring questions</p>", time: "9:40 AM" },
        { by: "quill", html: "<p>Weekly digest drops Friday. Send me highlights by Thursday EOD.</p>", time: "10:30 AM" },
        { by: "priya", html: "<p>launch post is live on the blog 🚀</p>", time: "11:02 AM" },
        { by: "you", html: `<p>⭐ Clawbits is open-source! Go star the repo <span class="lnk">(github.com)</span></p>`, time: "11:05 AM", reactions: [{ e: "🎉", n: 5, mine: true }, { e: "⭐", n: 3 }] },
      ],
    },
    dm("hermes", {
      id: "hermes", preview: "Replied - the vendor thread is sorted.", time: "1h", working: true,
      about: {
        line: "Agent · inbox and voice",
        rows: [
          ["Mailbox", "hermes@clawbits.ai"],
          ["Runtime", "Hermes on reef"],
          ["Model", "Claude Opus 5"],
          ["Automations", "3 scheduled"],
          ["Voice", "tts + barge-in"],
        ],
      },
      older: [
        { kind: "doc", name: "invoice-4471.pdf", meta: "84 KB · PDF", from: "hermes", when: "Yesterday" },
        { kind: "doc", name: "vendor-thread.eml", meta: "31 KB · Email", from: "hermes", when: "Tue, Jul 28" },
      ],
      msgs: [
        { day: "Yesterday", by: "you", html: "<p>how's the inbox backlog?</p>", time: "4:40 PM", receipt: "read" },
        { by: "hermes", html: "<p>Cleared 14 threads - 2 are waiting on you.</p>", time: "4:42 PM" },
        { by: "you", html: "<p>watch for the contract renewal email next week</p>", time: "4:45 PM", receipt: "read" },
        { by: "hermes", html: "<p>Flagged - I'll surface it the moment it arrives.</p>", time: "4:46 PM" },
        { day: "Today", by: "you", html: "<p>hermes, can you chase the vendor invoice thread?</p>", time: "10:20 AM", receipt: "read" },
        { by: "hermes", html: "<p>Found it - drafting a reply with the corrected PO number.</p>", time: "10:21 AM" },
        { by: "you", html: "<p>cc finance@ when you send it</p>", time: "10:22 AM", receipt: "read" },
        { by: "hermes", html: "<p>Done - sent with finance in copy.</p>", time: "10:23 AM" },
        { by: "hermes", html: "<p>Replied - the vendor thread is sorted.</p>", time: "10:24 AM" },
      ],
    }),
    {
      id: "eng", species: "channel", name: "engineering", src: "/avatars/channel-3.svg",
      members: 18, pins: 2, pinned: true, preview: `clawbits desktop v${v} is out on the prod channel`, time: "2h",
      draft: `Sounds good - let's ship v${v} to the office fleet tonight`,
      about: {
        rows: [
          ["Topic", "Ship the desktop app"],
          ["Members", "18 · 4 agents"],
          ["Pinned", "2 messages"],
          ["Created", "12 Jan 2026"],
        ],
      },
      older: [
        { kind: "doc", name: `release-notes-v${v}.md`, meta: "12 KB · Markdown", from: "Ivan", when: "Fri, Jul 31" },
        { kind: "doc", name: "barge-in-latency.csv", meta: "4 KB · Spreadsheet", from: "hermes", when: "Thu, Jul 30" },
        { kind: "image", src: "/brand/server.webp", name: "pi-rack.jpeg", meta: "1.1 MB · Photo", from: "Josh", when: "Wed, Jul 29" },
        { kind: "doc", name: "updater-resume.md", meta: "8 KB · Markdown", from: "atlas", when: "Tue, Jul 28" },
      ],
      msgs: [
        { day: "Yesterday", by: "josh", html: "<p>who owns the updater resume work? want it in the release notes</p>", time: "6:10 PM" },
        { by: "you", html: `<p>atlas does - it's in v${v}</p>`, edited: true, time: "6:12 PM" },
        { by: "priya", img: { src: "/brand/tennis.webp", w: 640, h: 800 }, time: "6:15 PM" },
        { day: "Today", by: "josh", html: "<p>morning! does barge-in work on the pi yet?</p>", time: "8:41 AM" },
        { by: "hermes", html: "<p>Yes - tested on the office Pi 5 this morning. Round-trip latency ≈ 180 ms.</p>", edited: true, time: "8:43 AM" },
        { by: "you", html: "<p>perfect - that's well under the bar</p>", time: "8:44 AM" },
        { by: "you", html: "<p>any word on the desktop release?</p>", time: "8:58 AM" },
        {
          by: "atlas", card: true, time: "9:01 AM",
          reactions: [{ e: "🎉", n: 4, mine: true }, { e: "🚀", n: 2 }],
          html: `<p>clawbits desktop v${v} is out on the prod channel <span class="lnk">(github.com)</span></p>`,
        },
      ],
    },
    dm("mara", {
      id: "mara", preview: "can you check the deploy?", time: "2h", unread: 2,
      about: {
        rows: [
          ["Email", "mara@clawbits.ai"],
          ["Role", "Infrastructure"],
          ["Shared channels", "5"],
          ["Notifications", "All messages"],
        ],
      },
      older: [
        { kind: "doc", name: "staging-migration.log", meta: "62 KB · Log", from: "Mara", when: "Tue, Jul 28" },
      ],
      msgs: [
        { day: "Yesterday", by: "mara", html: "<p>heads up - taking tomorrow morning for errands</p>", time: "5:12 PM" },
        { by: "you", html: "<p>no worries - I'll kick the staging deploy early</p>", time: "5:15 PM", receipt: "read" },
        { by: "you", html: "<p>also: staging DB got resized, migrations should be quicker</p>", time: "5:16 PM", receipt: "read" },
        { by: "mara", html: "<p>fingers crossed 🤞</p>", time: "5:20 PM" },
        { day: "Today", by: "you", html: "<p>kicked off the staging deploy, migrations included</p>", time: "9:02 AM", receipt: "read" },
        { by: "you", html: "<p>ETA ~20 min, I'll post when it's green</p>", time: "9:03 AM", receipt: "read" },
        { by: "mara", html: "<p>morning! it looks stuck at the migration step</p>", time: "9:14 AM" },
        { by: "mara", html: "<p>the progress bar hasn't moved since 9:05</p>", time: "9:15 AM" },
        { by: "mara", html: "<p>can you check the deploy?</p>", time: "9:16 AM" },
      ],
    }),
    dm("scout", {
      id: "scout", preview: "Merged. The flaky-test fix needs your eyes.", time: "3h",
      about: {
        line: "Agent · repos and CI",
        rows: [
          ["Mailbox", "scout@clawbits.ai"],
          ["Runtime", "IronClaw on reef"],
          ["Model", "Claude Opus 5"],
          ["Repos", "4 connected"],
          ["Automations", "2 scheduled"],
        ],
      },
      msgs: [
        { day: "Yesterday", by: "you", html: "<p>scout, watch the repos tonight - release week</p>", time: "11:02 PM", receipt: "read" },
        { by: "scout", html: "<p>On it. I'll triage anything that lands.</p>", time: "11:03 PM" },
        { by: "scout", html: "<p>Heads-up: release-week watch means noisier pings. Mute me if needed.</p>", time: "11:05 PM" },
        { by: "you", html: "<p>never 😄</p>", time: "11:06 PM", receipt: "read" },
        { day: "Today", by: "you", html: "<p>anything land overnight?</p>", time: "8:12 AM", receipt: "read" },
        {
          by: "scout", time: "8:13 AM",
          html: "<p>3 new PRs triaged overnight:</p><table><thead><tr><th>PR</th><th>Change</th><th>CI</th><th>Call</th></tr></thead><tbody><tr><td>#412</td><td>vite 8.1</td><td>Green</td><td>Merge</td></tr><tr><td>#415</td><td>ruff 0.15</td><td>Green</td><td>Merge</td></tr><tr><td>#409</td><td>Flaky test fix</td><td>Flaky</td><td>Review</td></tr></tbody></table>",
        },
        { by: "you", html: "<p>merge the green ones</p>", time: "8:15 AM", receipt: "read" },
        { by: "scout", html: "<p>Merged. The flaky-test fix needs your eyes.</p>", time: "8:16 AM", reactions: [{ e: "🙏", n: 1, mine: true }] },
      ],
    }),
    dm("priya", {
      id: "priya", preview: "see you tomorrow 👋", time: "19h",
      about: {
        rows: [
          ["Email", "priya@clawbits.ai"],
          ["Role", "Design"],
          ["Shared channels", "6"],
          ["Notifications", "All messages"],
        ],
      },
      older: [
        { kind: "doc", name: "tokens-2026-08.fig", meta: "2.4 MB · Figma", from: "Priya", when: "Yesterday" },
      ],
      msgs: [
        { day: "Yesterday", by: "you", html: "<p>still on for tennis before work tomorrow?</p>", time: "3:35 PM", receipt: "read" },
        { by: "priya", html: "<p>obviously. courts at 7, coffee after</p>", time: "3:38 PM" },
        { by: "priya", img: { src: "/brand/tennis.webp", w: 640, h: 800 }, time: "3:39 PM" },
        { by: "you", html: "<p>no fair, you've been practicing 😄</p>", time: "3:40 PM", receipt: "read" },
        { by: "priya", html: "<p>design pass is done, the new tokens land tomorrow</p>", time: "3:42 PM" },
        { by: "you", html: "<p>perfect - I'll wire them into the theme</p>", time: "3:43 PM", receipt: "read" },
        { by: "priya", html: "<p>see you tomorrow 👋</p>", time: "3:45 PM" },
      ],
    }),
    {
      id: "smartclaws", species: "channel", name: "smartclaws", src: "/avatars/channel-4.svg",
      members: 9, mention: 1, preview: "@Chris please tell me the…", time: "3d",
      about: {
        rows: [
          ["Topic", "On-chain sensors"],
          ["Members", "9 · 2 agents"],
          ["Visibility", "Open to the org"],
          ["Created", "3 Mar 2026"],
        ],
      },
      older: [
        { kind: "doc", name: "sensor-feed-jul.csv", meta: "240 KB · Spreadsheet", from: "scout", when: "Thu, Jul 30" },
      ],
      msgs: [
        { day: "Thu, Jul 30", by: "you", html: "<p>new SmartClaws board arrived - installing in the server room</p>", time: "2:05 PM" },
        { by: "you", img: { src: "/brand/server.webp", w: 720, h: 479 }, time: "2:38 PM" },
        { by: "scout", html: "<p>First readings are on-chain: 22.4°C, 41% humidity.</p>", time: "3:10 PM" },
        { day: "Fri, Jul 31", by: "you", html: "<p>wired the office temp sensor into the on-chain feed 🌡️</p>", time: "4:02 PM" },
        { by: "mara", html: `<p><span class="mention">@Chris</span> please tell me the server-room sensor is wrong - it says 31°C 😅</p>`, time: "4:20 PM" },
      ],
    },
    {
      id: "clawbits", species: "channel", name: "clawbits", src: "/avatars/channel-2.svg",
      members: 6, preview: "Attachment", time: "3d", clip: true,
      about: {
        rows: [
          ["Topic", "The product itself"],
          ["Members", "6 · 2 agents"],
          ["Visibility", "Open to the org"],
          ["Created", "8 Jan 2026"],
        ],
      },
      older: [
        { kind: "doc", name: "qa-matrix.csv", meta: "18 KB · Spreadsheet", from: "Ivan", when: "Fri, Jul 31" },
        { kind: "doc", name: "hardening-checklist.md", meta: "7 KB · Markdown", from: "atlas", when: "Thu, Jul 30" },
      ],
      msgs: [
        { day: "Thu, Jul 30", by: "you", html: "<p>release branch is cut - hardening only from here</p>", time: "11:20 AM" },
        { by: "atlas", html: "<p>CI is green across the matrix - all 14 targets.</p>", time: "4:40 PM" },
        { by: "you", html: "<p>beautiful</p>", time: "4:41 PM" },
        { day: "Fri, Jul 31", by: "ivan", html: "<p>QA pass is clean on mac + linux</p>", time: "1:58 PM" },
        { by: "you", html: `<p>tagging desktop v${v} in an hour unless someone objects</p>`, time: "2:10 PM" },
        { by: "ivan", html: "<p>go for it - notes are final</p>", time: "2:12 PM" },
        { by: "ivan", file: { name: `release-notes-v${v}.md`, meta: "12 KB · Markdown" }, time: "2:14 PM" },
      ],
    },
    {
      id: "pit", species: "channel", name: "pit", src: "/avatars/channel-1.svg",
      members: 5, preview: "Torque doubled. The big lobster is…", time: "5d",
      about: {
        rows: [
          ["Topic", "The office claw machine"],
          ["Members", "5 · 1 agent"],
          ["Visibility", "Open to the org"],
          ["Created", "19 May 2026"],
        ],
      },
      msgs: [
        { day: "Tue, Jul 28", by: "ivan", html: "<p>claw motor replacement came in</p>", time: "12:40 PM" },
        { by: "ivan", html: "<p>wiring the new joystick tonight</p>", time: "12:41 PM" },
        { by: "you", html: "<p>the plushies stand no chance</p>", time: "12:44 PM" },
        { day: "Wed, Jul 29", by: "you", html: "<p>how's the claw machine rebuild going?</p>", time: "6:00 PM" },
        { by: "atlas", html: `<p><span class="mention">@Ivan</span> made it move! Grabbed 3 of 5 plushies today 🦀</p>`, time: "6:31 PM", reactions: [{ e: "🦀", n: 3, mine: true }] },
        { by: "you", html: "<p>did you fix the grip strength?</p>", time: "6:40 PM" },
        { by: "atlas", html: "<p>Torque doubled. The big lobster is mine tomorrow.</p>", time: "6:52 PM" },
      ],
    },
    dm("josh", {
      id: "josh", preview: "ok, thx!", time: "Jul 24",
      about: {
        rows: [
          ["Email", "josh@clawbits.ai"],
          ["Role", "Hardware"],
          ["Shared channels", "4"],
          ["Notifications", "All messages"],
        ],
      },
      msgs: [
        { day: "Thu, Jul 23", by: "josh", html: "<p>you around tomorrow? want to borrow the pi 5</p>", time: "7:10 PM" },
        { by: "you", html: "<p>yep - grab it after standup</p>", time: "7:12 PM", receipt: "read" },
        { day: "Fri, Jul 24", by: "josh", html: "<p>pi kit arrived 📦</p>", time: "4:02 PM" },
        { by: "you", html: "<p>sweet - flashing the image now</p>", time: "4:05 PM", receipt: "read" },
        { by: "you", html: "<p>sent you the pi 5 image with the wake-word build</p>", time: "5:12 PM", receipt: "read" },
        { by: "josh", html: "<p>what's the wake word?</p>", time: "5:15 PM" },
        { by: "you", html: `<p>"hey clawbits", obviously 🦞</p>`, time: "5:16 PM", receipt: "read", reactions: [{ e: "😂", n: 1 }] },
        { by: "josh", html: "<p>lol perfect</p>", time: "5:18 PM" },
        { by: "josh", html: "<p>trying it tonight</p>", time: "5:20 PM" },
        { by: "josh", html: "<p>ok, thx!</p>", time: "5:30 PM" },
      ],
    }),
    dm("quill", {
      id: "quill", preview: "weekly digest for #all-hands", time: "Jul 23", pinned: true,
      draft: "weekly digest for #all-hands: ship notes, star count",
      about: {
        line: "Agent · digests",
        rows: [
          ["Mailbox", "quill@clawbits.ai"],
          ["Runtime", "Hermes on reef"],
          ["Model", "Claude Opus 5"],
          ["Automations", "1 scheduled · Fridays 09:00"],
        ],
      },
      msgs: [
        { day: "Tue, Jul 21", by: "you", html: "<p>can you summarize today's reef thread?</p>", time: "5:40 PM", receipt: "read" },
        { by: "quill", html: "<p>Done - 5 bullets posted in the thread, action items DM'd.</p>", time: "5:41 PM" },
        { by: "quill", html: "<p>One flag: two action items have no owner.</p>", time: "5:42 PM" },
        { by: "you", html: "<p>assign them to me</p>", time: "5:44 PM", receipt: "read" },
        { day: "Wed, Jul 22", by: "you", html: "<p>your #all-hands summaries are getting really good</p>", time: "2:10 PM", receipt: "read" },
        { by: "quill", html: "<p>Thanks - I tightened the template. Three bullets, one chart, no fluff.</p>", time: "2:11 PM" },
        { day: "Thu, Jul 23", by: "you", html: "<p>quill, start a weekly digest for #all-hands</p>", time: "1:05 PM", receipt: "read" },
        { by: "quill", html: "<p>Happy to. Cadence? I'd suggest Friday mornings.</p>", time: "1:05 PM" },
        { by: "you", html: "<p>friday works</p>", time: "1:06 PM", receipt: "read" },
        { by: "quill", html: "<p>On it - first issue Friday: merged PRs, release metrics, one highlight.</p>", time: "1:06 PM" },
      ],
    }),
    dm("sasha", {
      id: "sasha", preview: "Attachment", time: "Jul 22", clip: true,
      about: {
        rows: [
          ["Email", "sasha@clawbits.ai"],
          ["Role", "Operations · joined July"],
          ["Shared channels", "2"],
          ["Notifications", "All messages"],
        ],
      },
      msgs: [
        { day: "Tue, Jul 21", by: "sasha", html: "<p>settling in! this office is amazing</p>", time: "9:40 AM" },
        { by: "you", html: "<p>welcome aboard 🎉</p>", time: "9:42 AM", receipt: "read" },
        { by: "sasha", html: "<p>how do I get on the tennis ladder? heard Priya runs it</p>", time: "9:50 AM" },
        { by: "you", html: "<p>careful - she's ruthless 😄</p>", time: "9:52 AM", receipt: "read" },
        { by: "sasha", html: "<p>noted 😅</p>", time: "9:55 AM" },
        { day: "Wed, Jul 22", by: "sasha", html: "<p>where does the new desk layout live?</p>", time: "11:20 AM" },
        { by: "you", html: "<p>one sec, grabbing the pdf</p>", time: "11:22 AM", receipt: "read" },
        { by: "you", file: { name: "office-floor-3.pdf", meta: "240 KB · PDF" }, time: "11:24 AM", receipt: "read" },
      ],
    }),
  ];
}

export const authorName = (by: Who): string => (by === "you" ? "You" : CAST[by].name);

export const lastAuthor = (c: Chat): string | null =>
  c.species === "channel" ? authorName(c.msgs[c.msgs.length - 1].by) : null;

/** Shared files, newest first: what the messages carry, dated by their day divider, then `older`. */
export function attachmentsOf(c: Chat): Attachment[] {
  const found: Attachment[] = [];
  let day = "Today";

  for (const m of c.msgs) {
    if (m.day) day = m.day;
    const from = authorName(m.by);
    if (m.img) {
      found.push({ kind: "image", src: m.img.src, name: m.img.src.slice(m.img.src.lastIndexOf("/") + 1), meta: "Photo", from, when: day });
    }
    if (m.file) found.push({ kind: "doc", name: m.file.name, meta: m.file.meta, from, when: day });
  }

  return [...found.reverse(), ...(c.older ?? [])];
}
