import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { isThemeId } from "../lib/theme";
import announcements from "../announcements.json";

interface Announcement {
  id: string;
  date: string;
  title: string;
  body: string;
  /** A button that shows the news in action; `theme` switches to that theme. */
  action?: { label: string; theme?: string };
  note?: string;
  /** Opens by itself once, so the news is seen without looking for it. */
  highlight?: boolean;
  /** Shown only to people in the beta program. */
  beta?: boolean;
}

const ALL = announcements as Announcement[];

/** News the app wants people to see, behind a button in the top bar. */
export function Announcements() {
  const { seenAnnouncements, markAnnouncementsSeen, theme, setTheme, barPosition, betaChannel } = useStore();
  const ITEMS = ALL.filter((a) => betaChannel || !a.beta);
  const unseen = ITEMS.filter((a) => !seenAnnouncements.includes(a.id));
  const [open, setOpen] = useState(() => unseen.some((a) => a.highlight));
  const ref = useRef<HTMLDivElement>(null);

  // Everything listed counts as seen once the panel has been shown.
  useEffect(() => {
    if (open && unseen.length) markAnnouncementsSeen(unseen.map((a) => a.id));
  }, [open, unseen, markAnnouncementsSeen]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (ITEMS.length === 0) return null;

  return (
    <div className={`announce ${barPosition === "bottom" ? "up" : ""}`} ref={ref}>
      <button className="icon-btn announce-btn" title="Novidades" onClick={() => setOpen((o) => !o)}>
        ✦{unseen.length > 0 && <span className="announce-dot" />}
      </button>
      {open && (
        <div className="announce-panel">
          <header>Novidades</header>
          <ul>
            {ITEMS.map((a) => {
              const target = a.action?.theme;
              const applied = isThemeId(target) && theme === target;
              return (
                <li key={a.id}>
                  <h4>{a.title}</h4>
                  <p>{a.body}</p>
                  {a.action && (
                    <button
                      className="primary"
                      disabled={applied}
                      onClick={() => isThemeId(target) && setTheme(target)}
                    >
                      {applied ? "Em uso" : a.action.label}
                    </button>
                  )}
                  {a.note && <p className="announce-note">{a.note}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
