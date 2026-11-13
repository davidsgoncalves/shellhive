import { useId } from "react";
import type { TabState } from "../lib/types";

/** A number from a text, the same every time, to pick a drone's colour and timing. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A hue for the seed, kept out of the violets. */
function hueOf(seed: string): number {
  const h = hash(seed) % 300;
  return h >= 260 ? (h + 70) % 360 : h;
}

/** A drone's body colour, so other parts of the app can match its avatar. */
export const beeColor = (seed: string) => `hsl(${hueOf(seed)} 72% 60%)`;

/** How the bee moves: working flaps and looks around, waiting on you bobs, asleep shuts its eyes. */
const MOOD: Record<TabState, string> = {
  working: "work",
  permission: "ask",
  waiting: "awake",
  shell: "sleep",
  dormant: "sleep",
};

const HEX = "32,19 48.5,28.5 48.5,47.5 32,57 15.5,47.5 15.5,28.5";

/**
 * A drone's avatar: a hexagon bee in a colour of its own whose eyes blink and
 * look around, each drone on its own beat. The Queen Bee wears a crown. With a
 * state, the bee shows it: wings beating while it works, a bob while it waits
 * on you, eyes shut while it sleeps.
 */
export function BeeAvatar({
  seed,
  queen = false,
  size = 22,
  state,
}: {
  seed: string;
  queen?: boolean;
  size?: number;
  state?: TabState;
}) {
  const clip = useId();
  const hue = hueOf(seed);
  const body = beeColor(seed);
  const ink = `hsl(${hue} 45% 18%)`;
  // Out of step with the other drones, so a list of them does not blink at once.
  const delay = `-${(hash(seed) % 4000) / 1000}s`;
  const mood = state ? MOOD[state] : "awake";
  return (
    <svg
      className={`bee-avatar bee-${mood}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden
      style={{ ["--bee-delay" as string]: delay }}
    >
      <defs>
        <clipPath id={clip}>
          <polygon points={HEX} />
        </clipPath>
      </defs>
      <g className="bee-move">
        <circle className="bee-wing" cx="19" cy="18" r="8.5" />
        <circle className="bee-wing" cx="45" cy="18" r="8.5" />
        <path d="M27 21 L23 11 M37 21 L41 11" fill="none" stroke={ink} strokeWidth="2.2" strokeLinecap="round" />
        <rect x="20.5" y="7.5" width="5" height="5" rx="1.2" fill={ink} />
        <rect x="38.5" y="7.5" width="5" height="5" rx="1.2" fill={ink} />
        <polygon points={HEX} fill={body} stroke={body} strokeWidth="5" strokeLinejoin="round" />
        <g clipPath={`url(#${clip})`} fill={ink}>
          <rect x="10" y="44" width="44" height="4.5" />
          <rect x="10" y="51.5" width="44" height="4.5" />
        </g>
        <g className="bee-open">
          <g className="bee-eyes">
            <rect x="20" y="28" width="10" height="12" rx="5" fill="#fff" />
            <rect x="34" y="28" width="10" height="12" rx="5" fill="#fff" />
            <g className="bee-pupils">
              <circle cx="25.5" cy="34.5" r="3" fill="#17140f" />
              <circle cx="39.5" cy="34.5" r="3" fill="#17140f" />
            </g>
          </g>
        </g>
        <g className="bee-shut" stroke={ink} strokeWidth="2.2" strokeLinecap="round">
          <path d="M20 35 h10 M34 35 h10" />
        </g>
        <path d="M29 42.5 h6" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      </g>
      {queen && (
        <path d="M24 17 l2 -8 l6 5 l6 -5 l2 8z" fill="#ffd166" stroke="#a87b12" strokeWidth="1" strokeLinejoin="round" />
      )}
    </svg>
  );
}
