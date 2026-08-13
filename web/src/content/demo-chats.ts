/**
 * The sample conversation set both product demos render.
 *
 * Lifted out of AppDemo.astro when PhoneDemo.astro landed: the desktop window
 * and the phone show the SAME org, so a preview, a timestamp or an unread
 * count that changes in one has to change in the other. One array is the only
 * way to guarantee that.
 *
 * Everything here is invented sample data. The SHAPE is transcribed from the
 * real app (see the audit note at the top of AppDemo.astro for the token and
 * anatomy rules the two demos render it with) - avatars are owner-supplied in
 * /avatars.
 *
 * ONE exception to "invented": the desktop version the release thread talks
 * about is REAL, passed in from GitHub at build time (src/lib/releases.ts).
 * That is why this is a function and not a const - it used to say v0.17.0
 * three releases after 0.17.0 shipped, on the same page whose /download link
 * offered 0.20.0.
 */

export type Species = "human" | "agent" | "channel";

/**
 * One row in the phone's details sheet, Attachments tab.
 *
 * The sheet lists the WHOLE conversation's shared files, which is more than
 * the eight-or-so messages a demo feed has room for - so `attachmentsOf`
 * derives what is visible from the messages themselves and then appends each
 * chat's `older` list. Anything in a bubble is therefore guaranteed to appear
 * in the sheet, and cannot drift out of sync with it.
 */
export interface Attachment {
  kind: "image" | "doc";
  /** Thumbnail source - images only. */
  src?: string;
  name: string;
  /** Second line, e.g. "12 KB - Markdown". */
  meta: string;
  /** Who shared it. */
  from: string;
  /** When, as the sheet dates it - the day divider the message sits under. */
  when: string;
}

/** The details sheet's Info tab. Both fields have per-species defaults in
 *  PhoneDemo; this is the per-chat override where the generic line would be
 *  a wasted opportunity (what hermes actually runs, what #engineering is for). */
export interface About {
  /** Subtitle under the big name. */
  line?: string;
  /** Grouped list rows, label then value. */
  rows?: [string, string][];
}

/** One message. `html` is trusted literal markup (one or more <p>…</p>);
 * `file` renders an attachment-only message (no text bubble), `card` hangs
 * the release link-preview under the bubble. */
export interface Msg {
  /** Renders a day divider above this message (also breaks the group run). */
  day?: string;
  own?: boolean;
  /** Author (channels only; shown on group start). */
  name?: string;
  ava?: string;
  /** Letter-chip fallback when the author has no avatar art (Ivan). */
  letter?: string;
  html?: string;
  file?: { name: string; meta: string };
  /** Image attachment (attachment-only message, like `file`). */
  img?: { src: string; w: number; h: number };
  card?: boolean;
  /** Compact reaction pills in the bubble's meta row (left of the time). */
  reactions?: { e: string; n: number; mine?: boolean }[];
  time: string;
  /** Own DM bubbles only. */
  receipt?: "read" | "delivered";
}

/** One conversation: the sidebar row AND its openable content. Previews
 * mirror each chat's actual last message, like the real sidebar. */
export interface Chat {
  id: string;
  species: Species;
  name: string;
  src: string;
  /** Sidebar row bits. */
  preview: string;
  time: string;
  prefix?: string;
  draftRow?: boolean;
  clip?: boolean;
  unread?: number;
  dot?: boolean;
  presence?: boolean;
  /** Header pills. */
  pin?: number;
  members?: number;
  msgs: Msg[];
  /** Composer: typed draft (live ink send) or resting placeholder. */
  draft?: string;
  ph?: string;
  /** Details sheet: shared files older than the visible message window. */
  older?: Attachment[];
  /** Details sheet: Info tab overrides. */
  about?: About;
}

/**
 * The conversation set, built around a real version number.
 *
 * @param v Bare desktop semver from GitHub at build time, e.g. "0.20.0".
 *          See getDesktopFacts() in src/lib/releases.ts - both demos pass the
 *          same value, which is the whole reason this lives in one file.
 */
export function demoChats(v: string): Chat[] {
  return [
    {
      id: "mara", species: "human", name: "Mara", src: "/avatars/human-1.png",
      preview: "can you check the deploy?", time: "48m", unread: 2, presence: true,
      ph: "Message Mara",
      about: {
        rows: [
          ["Email", "mara@clawbits.ai"],
          ["Role", "Infrastructure"],
          ["Shared channels", "5"],
          ["Notifications", "All messages"],
        ],
      },
      older: [
        { kind: "doc", name: "staging-migration.log", meta: "62 KB · Log", from: "Mara", when: "Mon, Jul 28" },
      ],
      msgs: [
        { day: "Yesterday", html: "<p>heads up - taking tomorrow morning for errands</p>", time: "5:12 PM" },
        { own: true, html: "<p>no worries - I'll kick the staging deploy early</p>", time: "5:15 PM", receipt: "read" },
        { own: true, html: "<p>also: staging DB got resized, migrations should be quicker</p>", time: "5:16 PM", receipt: "read" },
        { html: "<p>fingers crossed 🤞</p>", time: "5:20 PM" },
        { day: "Today", own: true, html: "<p>kicked off the staging deploy, migrations included</p>", time: "9:02 AM", receipt: "read" },
        { own: true, html: "<p>ETA ~20 min, I'll post when it's green</p>", time: "9:03 AM", receipt: "read" },
        { html: "<p>morning! it looks stuck at the migration step</p>", time: "9:14 AM" },
        { html: "<p>the progress bar hasn't moved since 9:05</p>", time: "9:15 AM" },
        { html: "<p>can you check the deploy?</p>", time: "9:16 AM" },
      ],
    },
    {
      id: "hermes", species: "agent", name: "hermes", src: "/avatars/agent-1.svg",
      preview: "Replied - the vendor thread is sorted.", time: "1h", presence: true,
      ph: "Message @hermes",
      about: {
        line: "Agent · inbox and voice",
        rows: [
          ["Mailbox", "hermes@clawbits.ai"],
          ["Runtime", "OpenClaw on reef"],
          ["Model", "Claude Opus 5"],
          ["Automations", "3 scheduled"],
          ["Voice", "tts + barge-in"],
        ],
      },
      older: [
        { kind: "doc", name: "invoice-4471.pdf", meta: "84 KB · PDF", from: "hermes", when: "Yesterday" },
        { kind: "doc", name: "vendor-thread.eml", meta: "31 KB · Email", from: "hermes", when: "Mon, Jul 28" },
      ],
      msgs: [
        { day: "Yesterday", own: true, html: "<p>how's the inbox backlog?</p>", time: "4:40 PM", receipt: "read" },
        { html: "<p>Cleared 14 threads - 2 are waiting on you.</p>", time: "4:42 PM" },
        { own: true, html: "<p>watch for the contract renewal email next week</p>", time: "4:45 PM", receipt: "read" },
        { html: "<p>Flagged - I'll surface it the moment it arrives.</p>", time: "4:46 PM" },
        { day: "Today", own: true, html: "<p>hermes, can you chase the vendor invoice thread?</p>", time: "10:20 AM", receipt: "read" },
        { html: "<p>Found it - drafting a reply with the corrected PO number.</p>", time: "10:21 AM" },
        { own: true, html: "<p>cc finance@ when you send it</p>", time: "10:22 AM", receipt: "read" },
        { html: "<p>Done - sent with finance in copy.</p>", time: "10:23 AM" },
        { html: "<p>Replied - the vendor thread is sorted.</p>", time: "10:24 AM" },
      ],
    },
    {
      id: "lena", species: "human", name: "Priya", src: "/avatars/human-3.png",
      preview: "see you tomorrow 👋", time: "2h", presence: true,
      ph: "Message Priya",
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
        { day: "Today", own: true, html: "<p>still on for tennis before work tomorrow?</p>", time: "3:35 PM", receipt: "read" },
        { html: "<p>obviously. courts at 7, coffee after</p>", time: "3:38 PM" },
        { img: { src: "/brand/tennis.jpg", w: 768, h: 960 }, time: "3:39 PM" },
        { own: true, html: "<p>no fair, you've been practicing 😄</p>", time: "3:40 PM", receipt: "read" },
        { html: "<p>design pass is done, the new tokens land tomorrow</p>", time: "3:42 PM" },
        { own: true, html: "<p>perfect - I'll wire them into the theme</p>", time: "3:43 PM", receipt: "read" },
        { html: "<p>see you tomorrow 👋</p>", time: "3:45 PM" },
      ],
    },
    {
      id: "allhands", species: "channel", name: "all-hands", src: "/avatars/channel-1.svg",
      preview: "⭐ Clawbits is open-source! Go star…", time: "2h", prefix: "You:",
      members: 24, ph: "Message #all-hands",
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
        { kind: "doc", name: "weekly-digest-w31.md", meta: "9 KB · Markdown", from: "quill", when: "Fri, Aug 1" },
      ],
      msgs: [
        { day: "Yesterday", name: "Priya", ava: "/avatars/human-3.png", html: "<p>offsite photos are in the drive 📸</p>", time: "4:20 PM" },
        { name: "Mara", ava: "/avatars/human-1.png", html: "<p>already stole one for the launch deck</p>", time: "4:31 PM" },
        { day: "Today", name: "Josh", ava: "/avatars/human-2.png", html: "<p>reminder: demo day is Thursday - bring questions</p>", time: "9:40 AM" },
        { name: "quill", ava: "/avatars/agent-4.svg", html: "<p>Weekly digest drops Friday. Send me highlights by Thursday EOD.</p>", time: "10:30 AM" },
        { name: "Priya", ava: "/avatars/human-3.png", html: "<p>launch post is live on the blog 🚀</p>", time: "11:02 AM" },
        { own: true, html: `<p>⭐ Clawbits is open-source! Go star the repo <span class="lnk">(github.com)</span></p>`, time: "11:05 AM", reactions: [{ e: "🎉", n: 5, mine: true }, { e: "⭐", n: 3 }] },
      ],
    },
    {
      id: "scout", species: "agent", name: "scout", src: "/avatars/agent-3.svg",
      preview: "Merged. The flaky-test fix needs your eyes.", time: "3h", presence: true,
      ph: "Message @scout",
      about: {
        line: "Agent · repos and CI",
        rows: [
          ["Mailbox", "scout@clawbits.ai"],
          ["Runtime", "OpenClaw on reef"],
          ["Model", "Claude Opus 5"],
          ["Repos", "4 connected"],
          ["Automations", "2 scheduled"],
        ],
      },
      msgs: [
        { day: "Yesterday", own: true, html: "<p>scout, watch the repos tonight - release week</p>", time: "11:02 PM", receipt: "read" },
        { html: "<p>On it. I'll triage anything that lands.</p>", time: "11:03 PM" },
        { html: "<p>Heads-up: release-week watch means noisier pings. Mute me if needed.</p>", time: "11:05 PM" },
        { own: true, html: "<p>never 😄</p>", time: "11:06 PM", receipt: "read" },
        { day: "Today", own: true, html: "<p>anything land overnight?</p>", time: "8:12 AM", receipt: "read" },
        { html: "<p>3 new PRs triaged overnight - two dep bumps (green) and a flaky-test fix.</p>", time: "8:13 AM" },
        { own: true, html: "<p>merge the green ones</p>", time: "8:15 AM", receipt: "read" },
        { html: "<p>Merged. The flaky-test fix needs your eyes.</p>", time: "8:16 AM", reactions: [{ e: "🙏", n: 1, mine: true }] },
      ],
    },
    {
      id: "eng", species: "channel", name: "engineering", src: "/avatars/channel-3.svg",
      preview: "perfect - that's well under the bar", time: "9h", prefix: "You:",
      pin: 2, members: 18,
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
        { kind: "doc", name: `release-notes-v${v}.md`, meta: "12 KB · Markdown", from: "Ivan", when: "Thu, Jul 31" },
        { kind: "doc", name: "barge-in-latency.csv", meta: "4 KB · Spreadsheet", from: "hermes", when: "Wed, Jul 30" },
        { kind: "image", src: "/brand/server.jpeg", name: "pi-rack.jpeg", meta: "1.1 MB · Photo", from: "Josh", when: "Tue, Jul 29" },
        { kind: "doc", name: "updater-resume.md", meta: "8 KB · Markdown", from: "atlas", when: "Mon, Jul 28" },
      ],
      msgs: [
        { day: "Yesterday", name: "Josh", ava: "/avatars/human-2.png", html: "<p>who owns the updater resume work? want it in the release notes</p>", time: "6:10 PM" },
        { own: true, html: `<p>atlas does - it's in v${v}</p>`, time: "6:12 PM" },
        { name: "Priya", ava: "/avatars/human-3.png", img: { src: "/brand/tennis.jpg", w: 768, h: 960 }, time: "6:15 PM" },
        { day: "Today", own: true, html: "<p>morning! any word on the desktop release?</p>", time: "8:58 AM" },
        {
          name: "atlas", ava: "/avatars/agent-2.svg", card: true, time: "9:01 AM",
          reactions: [{ e: "🎉", n: 4, mine: true }, { e: "🚀", n: 2 }],
          html: `<p>clawbits desktop v${v} is out on the prod channel <span class="lnk">(github.com)</span></p>`,
        },
        { name: "Josh", ava: "/avatars/human-2.png", html: "<p>nice - does barge-in work on the pi?</p>", time: "10:12 AM" },
        { name: "hermes", ava: "/avatars/agent-1.svg", html: "<p>Yes - tested on the office Pi 5 this morning. Round-trip latency ≈ 180 ms.</p>", time: "10:13 AM" },
        { own: true, html: "<p>perfect - that's well under the bar</p>", time: "10:14 AM" },
      ],
    },
    {
      id: "clawbits", species: "channel", name: "clawbits", src: "/avatars/channel-2.svg",
      preview: "Attachment", time: "4d", prefix: "Ivan:", clip: true,
      members: 6, ph: "Message #clawbits",
      about: {
        rows: [
          ["Topic", "The product itself"],
          ["Members", "6 · 2 agents"],
          ["Visibility", "Open to the org"],
          ["Created", "8 Jan 2026"],
        ],
      },
      older: [
        { kind: "doc", name: "qa-matrix.csv", meta: "18 KB · Spreadsheet", from: "Ivan", when: "Thu, Jul 31" },
        { kind: "doc", name: "hardening-checklist.md", meta: "7 KB · Markdown", from: "atlas", when: "Wed, Jul 30" },
      ],
      msgs: [
        { day: "Wed, Jul 30", own: true, html: "<p>release branch is cut - hardening only from here</p>", time: "11:20 AM" },
        { name: "atlas", ava: "/avatars/agent-2.svg", html: "<p>CI is green across the matrix - all 14 targets.</p>", time: "4:40 PM" },
        { own: true, html: "<p>beautiful</p>", time: "4:41 PM" },
        { day: "Thu, Jul 31", name: "Ivan", letter: "I", html: "<p>QA pass is clean on mac + linux</p>", time: "1:58 PM" },
        { own: true, html: `<p>tagging desktop v${v} in an hour unless someone objects</p>`, time: "2:10 PM" },
        { name: "Ivan", letter: "I", html: "<p>go for it - notes are final</p>", time: "2:12 PM" },
        { name: "Ivan", letter: "I", file: { name: `release-notes-v${v}.md`, meta: "12 KB · Markdown" }, time: "2:14 PM" },
      ],
    },
    {
      id: "smartclaws", species: "channel", name: "smartclaws", src: "/avatars/channel-4.svg",
      preview: "Please tell me the…", time: "4d", prefix: "Mara:", dot: true,
      members: 9, ph: "Message #smartclaws",
      about: {
        rows: [
          ["Topic", "On-chain sensors"],
          ["Members", "9 · 2 agents"],
          ["Visibility", "Open to the org"],
          ["Created", "3 Mar 2026"],
        ],
      },
      older: [
        { kind: "doc", name: "sensor-feed-jul.csv", meta: "240 KB · Spreadsheet", from: "scout", when: "Wed, Jul 30" },
      ],
      msgs: [
        { day: "Wed, Jul 30", own: true, html: "<p>new SmartClaws board arrived - installing in the server room</p>", time: "2:05 PM" },
        { own: true, img: { src: "/brand/server.jpeg", w: 960, h: 638 }, time: "2:38 PM" },
        { name: "scout", ava: "/avatars/agent-3.svg", html: "<p>First readings are on-chain: 22.4°C, 41% humidity.</p>", time: "3:10 PM" },
        { day: "Thu, Jul 31", own: true, html: "<p>wired the office temp sensor into the on-chain feed 🌡️</p>", time: "4:02 PM" },
        { name: "Mara", ava: "/avatars/human-1.png", html: "<p>Please tell me the server-room sensor is wrong - it says 31°C 😅</p>", time: "4:20 PM" },
      ],
    },
    {
      id: "pit", species: "channel", name: "pit", src: "/avatars/channel-1.svg",
      preview: "Torque doubled. The big lobster is…", time: "6d", prefix: "atlas:",
      members: 5, ph: "Message #pit",
      about: {
        rows: [
          ["Topic", "The office claw machine"],
          ["Members", "5 · 1 agent"],
          ["Visibility", "Open to the org"],
          ["Created", "19 May 2026"],
        ],
      },
      msgs: [
        { day: "Mon, Jul 28", name: "Ivan", letter: "I", html: "<p>claw motor replacement came in</p>", time: "12:40 PM" },
        { name: "Ivan", letter: "I", html: "<p>wiring the new joystick tonight</p>", time: "12:41 PM" },
        { own: true, html: "<p>the plushies stand no chance</p>", time: "12:44 PM" },
        { day: "Tue, Jul 29", own: true, html: "<p>how's the claw machine rebuild going?</p>", time: "6:00 PM" },
        { name: "atlas", ava: "/avatars/agent-2.svg", html: `<p><span class="mention">@Ivan</span> made it move! Grabbed 3 of 5 plushies today 🦀</p>`, time: "6:31 PM", reactions: [{ e: "🦀", n: 3, mine: true }] },
        { own: true, html: "<p>did you fix the grip strength?</p>", time: "6:40 PM" },
        { name: "atlas", ava: "/avatars/agent-2.svg", html: "<p>Torque doubled. The big lobster is mine tomorrow.</p>", time: "6:52 PM" },
      ],
    },
    {
      id: "josh", species: "human", name: "Josh", src: "/avatars/human-2.png",
      preview: "ok, thx!", time: "Jul 24",
      ph: "Message Josh",
      about: {
        rows: [
          ["Email", "josh@clawbits.ai"],
          ["Role", "Hardware"],
          ["Shared channels", "4"],
          ["Notifications", "All messages"],
        ],
      },
      msgs: [
        { day: "Wed, Jul 23", html: "<p>you around tomorrow? want to borrow the pi 5</p>", time: "7:10 PM" },
        { own: true, html: "<p>yep - grab it after standup</p>", time: "7:12 PM", receipt: "read" },
        { day: "Thu, Jul 24", html: "<p>pi kit arrived 📦</p>", time: "4:02 PM" },
        { own: true, html: "<p>sweet - flashing the image now</p>", time: "4:05 PM", receipt: "read" },
        { own: true, html: "<p>sent you the pi 5 image with the wake-word build</p>", time: "5:12 PM", receipt: "read" },
        { html: "<p>what's the wake word?</p>", time: "5:15 PM" },
        { own: true, html: `<p>"hey clawbits", obviously 🦞</p>`, time: "5:16 PM", receipt: "read", reactions: [{ e: "😂", n: 1 }] },
        { html: "<p>lol perfect</p>", time: "5:18 PM" },
        { html: "<p>trying it tonight</p>", time: "5:20 PM" },
        { html: "<p>ok, thx!</p>", time: "5:30 PM" },
      ],
    },
    {
      id: "quill", species: "agent", name: "quill", src: "/avatars/agent-4.svg",
      preview: "weekly digest for #all-hands", time: "Jul 23", draftRow: true,
      draft: "weekly digest for #all-hands: ship notes, star count",
      about: {
        line: "Agent · digests",
        rows: [
          ["Mailbox", "quill@clawbits.ai"],
          ["Runtime", "OpenClaw on reef"],
          ["Model", "Claude Opus 5"],
          ["Automations", "1 scheduled · Fridays 09:00"],
        ],
      },
      msgs: [
        { day: "Mon, Jul 21", own: true, html: "<p>can you summarize today's reef thread?</p>", time: "5:40 PM", receipt: "read" },
        { html: "<p>Done - 5 bullets posted in the thread, action items DM'd.</p>", time: "5:41 PM" },
        { html: "<p>One flag: two action items have no owner.</p>", time: "5:42 PM" },
        { own: true, html: "<p>assign them to me</p>", time: "5:44 PM", receipt: "read" },
        { day: "Tue, Jul 22", own: true, html: "<p>your #all-hands summaries are getting really good</p>", time: "2:10 PM", receipt: "read" },
        { html: "<p>Thanks - I tightened the template. Three bullets, one chart, no fluff.</p>", time: "2:11 PM" },
        { day: "Wed, Jul 23", own: true, html: "<p>quill, start a weekly digest for #all-hands</p>", time: "1:05 PM", receipt: "read" },
        { html: "<p>Happy to. Cadence? I'd suggest Friday mornings.</p>", time: "1:05 PM" },
        { own: true, html: "<p>friday works</p>", time: "1:06 PM", receipt: "read" },
        { html: "<p>On it - first issue Friday: merged PRs, release metrics, one highlight.</p>", time: "1:06 PM" },
      ],
    },
    {
      id: "sasha", species: "human", name: "Sasha", src: "/avatars/human-4.png",
      preview: "Attachment", time: "Jul 22", prefix: "You:", clip: true,
      ph: "Message Sasha",
      about: {
        rows: [
          ["Email", "sasha@clawbits.ai"],
          ["Role", "Operations · joined July"],
          ["Shared channels", "2"],
          ["Notifications", "All messages"],
        ],
      },
      msgs: [
        { day: "Mon, Jul 21", html: "<p>settling in! this office is amazing</p>", time: "9:40 AM" },
        { own: true, html: "<p>welcome aboard 🎉</p>", time: "9:42 AM", receipt: "read" },
        { html: "<p>how do I get on the tennis ladder? heard Priya runs it</p>", time: "9:50 AM" },
        { own: true, html: "<p>careful - she's ruthless 😄</p>", time: "9:52 AM", receipt: "read" },
        { html: "<p>noted 😅</p>", time: "9:55 AM" },
        { day: "Tue, Jul 22", html: "<p>where does the new desk layout live?</p>", time: "11:20 AM" },
        { own: true, html: "<p>one sec, grabbing the pdf</p>", time: "11:22 AM", receipt: "read" },
        { own: true, file: { name: "office-floor-3.pdf", meta: "240 KB · PDF" }, time: "11:24 AM", receipt: "read" },
      ],
    },
  ];
}

/**
 * The last message in a conversation - what the sidebar preview and the phone
 * row's sender line are both derived from. `at(-1)` rather than a stored
 * field, so adding a message to a chat updates its row for free.
 */
export const lastMsg = (c: Chat): Msg => c.msgs[c.msgs.length - 1];

/** Who wrote the last message, as the native phone row prints it above the
 *  preview. Channels only - a DM row names its counterpart in the title. */
export const lastAuthor = (c: Chat): string | null =>
  c.species !== "channel" ? null : (lastMsg(c).own ? "You" : (lastMsg(c).name ?? null));

/**
 * Everything a conversation has ever shared, newest first - what the phone's
 * details sheet lists under Attachments.
 *
 * Derived from the messages rather than duplicated beside them, so a bubble
 * and its row in the sheet can never disagree; `older` then carries the part
 * of the history the demo feed is too short to show, which is why a chat with
 * one visible photo still reads as a real conversation when you open it.
 *
 * `when` is the day divider in force at that message - the sheet dates rows by
 * day, and the divider is the only date the transcript actually states.
 */
export function attachmentsOf(c: Chat): Attachment[] {
  const found: Attachment[] = [];
  let day = "Today";

  for (const m of c.msgs) {
    if (m.day) day = m.day;
    const from = m.own ? "You" : (m.name ?? c.name);

    if (m.img) {
      found.push({
        kind: "image",
        src: m.img.src,
        // The real file, not an invented one: these are the assets the demo
        // actually renders, so the sheet names what the bubble shows.
        name: m.img.src.split("/").pop() ?? "photo.jpg",
        meta: "Photo",
        from,
        when: day,
      });
    }
    if (m.file) found.push({ kind: "doc", name: m.file.name, meta: m.file.meta, from, when: day });
  }

  return [...found.reverse(), ...(c.older ?? [])];
}
