// Small monochrome marks for the session kinds, shared by the usage rings and the + menu.

/** Claude's mark: a plain eight-ray burst. */
export function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" className="mark-claude" aria-hidden>
      {[0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5].map((a) => (
        <line key={a} x1="12" y1="2.5" x2="12" y2="21.5" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  );
}

/** Codex's mark: a plain hexagon. */
export function CodexMark() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" className="mark-codex" aria-hidden>
      <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
      <path d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z" />
    </svg>
  );
}

/** OpenCode's mark: a page with two lines. */
export function OpencodeMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" className="mark-codex" aria-hidden>
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <path d="M9 9h6M9 13h6" />
    </svg>
  );
}

/** A plain shell: a prompt sign. */
export function TerminalMark() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" className="mark-codex" aria-hidden>
      <path d="M5 7l5 5-5 5M12 17h7" />
    </svg>
  );
}
