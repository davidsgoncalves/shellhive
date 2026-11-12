/** A number from a text, the same every time, to pick a drone's colour and timing. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A drone's avatar: a bee in a colour of its own whose eyes blink and look
 * around, each drone on its own beat. The Queen Bee wears a crown.
 */
export function BeeAvatar({ seed, queen = false, size = 22 }: { seed: string; queen?: boolean; size?: number }) {
  const h = hash(seed);
  const hue = h % 360;
  const body = `hsl(${hue} 78% 62%)`;
  const stripe = `hsl(${hue} 45% 22%)`;
  // Out of step with the other drones, so a list of them does not blink at once.
  const delay = `-${(h % 4000) / 1000}s`;
  return (
    <svg className="bee-avatar" width={size} height={size} viewBox="0 0 32 32" aria-hidden style={{ ["--bee-delay" as string]: delay }}>
      <ellipse className="bee-wing" cx="10" cy="9" rx="6" ry="4.5" transform="rotate(-25 10 9)" />
      <ellipse className="bee-wing" cx="22" cy="9" rx="6" ry="4.5" transform="rotate(25 22 9)" />
      <ellipse cx="16" cy="19" rx="11" ry="10" fill={body} />
      <path d="M7 21.5h18M8.5 25.5h15" stroke={stripe} strokeWidth="2.4" strokeLinecap="round" />
      <g className="bee-eyes">
        <ellipse cx="12.2" cy="16" rx="2.6" ry="3" fill="#fff" />
        <ellipse cx="19.8" cy="16" rx="2.6" ry="3" fill="#fff" />
        <g className="bee-pupils">
          <circle cx="12.6" cy="16.4" r="1.35" fill="#14161c" />
          <circle cx="20.2" cy="16.4" r="1.35" fill="#14161c" />
        </g>
      </g>
      {queen && <path d="M10 6.5l2.2 2.6L16 4.5l3.8 4.6L22 6.5l-1 4H11z" fill="#ffd166" stroke="#a87b12" strokeWidth=".8" strokeLinejoin="round" />}
    </svg>
  );
}
