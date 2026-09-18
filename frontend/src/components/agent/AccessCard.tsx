import { useState, type CSSProperties, type PointerEvent } from "react";
import { Squircle } from "@/components/home/tiles";
import { useActiveOrg } from "@/hooks/useActiveOrg";
import { useAvatarBaseColor } from "@/hooks/useAvatarBaseColor";
import { useResilientImage } from "@/hooks/useResilientImage";
import { agentDisplay } from "@/lib/agentDisplay";
import type { AgentProfile, SkillRuntime } from "@/lib/api";
import { mentionHandle } from "@/lib/messageHelpers";
import { prefersReducedMotion } from "@/lib/motion";
import { RUNTIME_LABELS } from "@/lib/skills";
import { BAND_LABEL, bandCount, formatMarkDate, progressText, type TidemarkState } from "@/lib/tidemarks";

const CLAWBITS_PATH =
  "M597.017 49.8097C627.658 44.7498 658.462 41.7116 689.495 46.1457C701.748 47.8963 713.603 51.1293 724.713 56.8039C750.259 69.8515 762.399 93.8956 758.207 122.268C755.121 143.161 745.529 161.052 733.592 177.917C712.87 207.194 686.902 231.726 661.578 256.81C628.188 289.882 595.054 323.18 564.53 358.977C526.096 404.049 491.204 451.742 458.792 501.281C416.397 566.079 379.72 634.057 346.239 703.81C345.519 705.31 344.761 706.801 343.898 708.222C338.714 716.76 328.905 718.104 321.905 711.005C314.516 703.511 310.099 694.096 306.036 684.591C296.083 661.309 290.106 636.954 287.04 611.86C283.96 586.646 283.627 561.384 286.141 536.109C286.849 528.996 288.024 521.929 289.031 514.407C289.989 508.965 290.901 503.957 292.017 497.834C282.921 506.095 275.672 514.534 268.161 522.696C227.375 567.015 190.063 614.136 155.192 663.214C153.263 665.929 151.464 668.738 149.495 671.423C145.649 676.666 140.387 678.899 135.274 677.363C129.406 675.601 126.856 671.077 126.142 665.415C124.726 654.187 123.005 642.967 122.272 631.689C119.397 587.445 123.622 543.883 136.169 501.277C144.045 474.534 154.622 448.844 168.31 422.892C153.634 432.361 140.813 441.993 127.997 451.629C93.0939 477.873 59.6465 505.896 26.7572 534.599C21.3664 539.303 15.8722 543.908 8.02673 540.277C0.4498 536.772 0.218354 529.727 0.0560314 522.794C-0.794043 486.485 8.09795 452.198 21.9984 419.03C40.7225 374.354 68.4808 335.654 101.389 300.47C151.351 247.053 209.631 204.354 272.868 168.142C331.756 134.42 393.74 107.566 457.942 85.797C503.399 70.3841 549.598 57.6404 597.017 49.8097Z";

const STRAPS = [
  [300, "max-sm:hidden"],
  [252, "sm:hidden"],
] as const;

const DEFS = (
  <svg className="absolute size-0 overflow-hidden" aria-hidden="true">
    <defs>
      <symbol id="access-claw" viewBox="0 0 760 760">
        <path d={CLAWBITS_PATH} />
      </symbol>
      <path id="access-loop" d="M234 36H306Q314 36 314 28V-20C314-46 292-60 270-60S226-46 226-20V28Q226 36 234 36Z" />
      <path id="access-loop-front" d="M226-8V28Q226 36 234 36H306" />
      <path
        id="access-crimp"
        d="M226-184H314A6 6 0 0 1 320-178V-158C320-151 317-146 311-142L294-130C290-127 286-126 281-126H259C254-126 250-127 246-130L229-142C223-146 220-151 220-158V-178A6 6 0 0 1 226-184Z"
      />
      <linearGradient id="access-g-fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="0" />
        <stop offset=".14" stopColor="#fff" />
      </linearGradient>
      <mask id="access-m-fade" maskContentUnits="objectBoundingBox">
        <rect width="1" height="1" fill="url(#access-g-fade)" />
      </mask>
      <linearGradient id="access-g-web" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopOpacity=".4" />
        <stop offset=".14" stopOpacity="0" />
        <stop offset=".42" stopColor="#fff" stopOpacity=".09" />
        <stop offset=".6" stopColor="#fff" stopOpacity="0" />
        <stop offset=".86" stopOpacity="0" />
        <stop offset="1" stopOpacity=".42" />
      </linearGradient>
      <linearGradient id="access-g-tuck" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopOpacity="0" />
        <stop offset="1" stopOpacity=".45" />
      </linearGradient>
      <linearGradient id="access-g-face" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity=".6" />
        <stop offset=".3" stopColor="#fff" stopOpacity=".08" />
        <stop offset=".62" stopOpacity=".05" />
        <stop offset="1" stopOpacity=".38" />
      </linearGradient>
      <linearGradient id="access-g-barrel" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopOpacity=".35" />
        <stop offset=".3" stopColor="#fff" stopOpacity=".55" />
        <stop offset=".55" stopColor="#fff" stopOpacity="0" />
        <stop offset="1" stopOpacity=".42" />
      </linearGradient>
      <linearGradient id="access-g-plat" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#eaeff4" />
        <stop offset=".4" stopColor="#b4e2ea" />
        <stop offset=".7" stopColor="#cfc5f2" />
        <stop offset="1" stopColor="#eef1f5" />
      </linearGradient>
      <pattern id="access-p-weave" width="5" height="5" patternUnits="userSpaceOnUse">
        <path d="M0 1.2H5" stroke="#000" strokeOpacity=".16" strokeWidth="1.3" />
        <path d="M1.2 2.4V5" stroke="#fff" strokeOpacity=".07" strokeWidth="1.2" />
      </pattern>
      <pattern id="access-p-jacq" x="230" y="69" width="80" height="112" patternUnits="userSpaceOnUse">
        <use href="#access-claw" x="25" y="23" width="30" height="30" fill="#000" fillOpacity=".16" />
        <use href="#access-claw" x="25" y="22" width="30" height="30" fill="#fff" fillOpacity=".08" />
        <path d="M5 0V112M75 0V112" stroke="#fff" strokeOpacity=".1" />
        <path d="M28 84H52" stroke="#fff" strokeOpacity=".07" strokeWidth="2" strokeDasharray="2 2" />
      </pattern>
    </defs>
  </svg>
);

const FINISH = (
  <>
    <i className="access-fx" />
    <i className="access-sheen" />
    <i className="access-slot" />
  </>
);

const wire = (href: string) => (
  <>
    <use href={`#${href}`} className="access-wire-lo" transform="translate(.8 1)" />
    <use href={`#${href}`} className="access-wire" />
    <use href={`#${href}`} className="access-wire-hi" transform="translate(-1.3 -.8)" />
  </>
);

const viewBox = (s: number) => `0 ${-s} 540 ${s + 44}`;

function Strap({ s, className }: { s: number; className: string }) {
  const web = { x: 230, y: -s, width: 80, height: s - 178 };
  return (
    <svg className={`access-strap ${className}`} viewBox={viewBox(s)} aria-hidden="true">
      <g mask="url(#access-m-fade)">
        <rect className="access-web" {...web} />
        <rect {...web} fill="url(#access-p-weave)" />
        <rect {...web} fill="url(#access-p-jacq)" />
        <path className="access-thread" d={`M238 ${-s}V-178M302 ${-s}V-178`} />
        <rect {...web} fill="url(#access-g-web)" />
        <path className="access-stitch" d="M238-204H302M238-197H302" />
        <rect x="230" y="-198" width="80" height="14" fill="url(#access-g-tuck)" />
      </g>
      <rect className="access-metal" x="265" y="-130" width="10" height="20" />
      <use href="#access-crimp" className="access-metal" />
      <use href="#access-crimp" fill="url(#access-g-face)" />
      <path className="access-groove" d="M221-171H319M221-164H319" />
      <path className="access-groove-hi" d="M221-169.9H319M221-162.9H319" />
      <rect className="access-metal" x="258" y="-114" width="24" height="30" rx="6" />
      <rect x="258" y="-114" width="24" height="30" rx="6" fill="url(#access-g-barrel)" />
      <path className="access-groove" d="M258.5-104H281.5M258.5-94H281.5" />
      <rect className="access-metal" x="266.5" y="-86" width="7" height="14" />
      <circle className="access-wire access-eye" cx="270" cy="-66" r="8" />
      {wire("access-loop")}
      <path className="access-wire access-eye" d="M270-58A8 8 0 0 0 278-66" />
    </svg>
  );
}

function seedHue(seed: string): number {
  let hue = 0;
  for (let i = 0; i < seed.length; i++) hue = (hue * 31 + seed.charCodeAt(i)) % 360;
  return hue;
}

function track(e: PointerEvent<HTMLDivElement>) {
  if (e.pointerType !== "mouse" || prefersReducedMotion()) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.dataset.hover = "";
  el.style.setProperty("--mx", ((e.clientX - r.left) / r.width).toFixed(3));
  el.style.setProperty("--my", ((e.clientY - r.top) / r.height).toFixed(3));
  el.style.setProperty("--tilt", "1");
}

function release(e: PointerEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  delete el.dataset.hover;
  for (const name of ["--mx", "--my", "--tilt"]) el.style.removeProperty(name);
}

export function AccessCard({ profile, tide }: { profile: AgentProfile; tide: TidemarkState }) {
  const [flipped, setFlipped] = useState(false);
  const { org } = useActiveOrg();
  const avatar = useResilientImage(profile.avatar?.url);
  const hue = useAvatarBaseColor(profile.avatar?.url) ?? seedHue(profile.agent_id);
  const name = agentDisplay(profile);
  const runtime = profile.agent_type && RUNTIME_LABELS[profile.agent_type as SkillRuntime];
  const { tier, full_set: full } = profile.tidemarks;
  const operator = profile.operator;
  const owner = operator?.display_name;
  const handle =
    operator && mentionHandle({ agent_id: null, human_id: operator.human_id, display_name: operator.display_name ?? null });
  const ownerAvatar = useResilientImage(operator?.avatar?.url);
  const issued = profile.creation_time && `Issued ${formatMarkDate(profile.creation_time)}`;

  return (
    <div className="access" onPointerMove={track} onPointerLeave={release}>
      {DEFS}
      <button
        type="button"
        className="access-card"
        data-tier={tier}
        data-full={full || undefined}
        aria-pressed={flipped}
        aria-label={`${name} card, press to flip`}
        style={{ "--access-h": hue } as CSSProperties}
        onClick={() => {
          setFlipped((f) => !f);
        }}
      >
        {STRAPS.map(([s, hide]) => (
          <Strap key={s} s={s} className={hide} />
        ))}
        <span className="access-tilt">
          <span className="access-flip">
            <span className="access-face access-front">
              {FINISH}
              <span className="access-top">
                <i className="access-logo" />
                <span className="access-org">{org?.display_name || org?.name}</span>
              </span>
              <Squircle size="36cqw" glass={false} className="access-avatar">
                {avatar && <img src={avatar} alt="" />}
              </Squircle>
              <span className="access-id">
                <span className="access-name">{name}</span>
                <span className="access-sub">
                  @{profile.agent_id}
                  {runtime && ` · ${runtime}`}
                </span>
              </span>
              <span className="access-foot">
                <span className="access-owner">
                  {handle && <span className="access-handle">@{handle}</span>}
                  <i className="access-star" />
                </span>
                <svg className="access-nfc" viewBox="5 1.5 13.5 21" aria-hidden="true">
                  <path d="M6.06 9.43A4 4 0 0 1 6.06 14.57M8.75 7.18A7.5 7.5 0 0 1 8.75 16.82M11.43 4.93A11 11 0 0 1 11.43 19.07M14.11 2.68A14.5 14.5 0 0 1 14.11 21.32" />
                </svg>
              </span>
            </span>
            <span className="access-face access-back">
              {FINISH}
              <span className="access-bhead">
                <span className="access-btitle">Tidemarks</span>
                {`${tide.label} · ${tide.count} of ${tide.total}`}
              </span>
              <span className="access-marks">
                {tide.bands.map((band) => (
                  <span key={band.id}>
                    <span className="access-band">
                      <b>{BAND_LABEL[band.id]}</b>
                      {bandCount(band)}
                    </span>
                    <span className="access-pips">
                      {band.marks.map(({ kind, mark }) => (
                        <i key={kind} data-on={mark ? "" : undefined} />
                      ))}
                    </span>
                  </span>
                ))}
              </span>
              <span className="access-next">{progressText(tide)}</span>
              {(owner || issued) && (
                <span className="access-issued">
                  {ownerAvatar && <img src={ownerAvatar} alt="" />}
                  <span>
                    {owner && <span className="access-issued-name">{owner}</span>}
                    {issued && <span className="access-issued-line">{issued}</span>}
                  </span>
                </span>
              )}
            </span>
          </span>
        </span>
        {STRAPS.map(([s, hide]) => (
          <svg key={s} className={`access-hook ${hide}`} viewBox={viewBox(s)} aria-hidden="true">
            {wire("access-loop-front")}
          </svg>
        ))}
      </button>
    </div>
  );
}
