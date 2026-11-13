import { useEffect, type ReactNode } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** A column beside the content, for navigation between pages. */
  aside?: ReactNode;
}

export function Modal({ title, onClose, children, footer, className, aside }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const main = (
    <>
      <header>
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} title="Fechar (Esc)">
          ×
        </button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </>
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${aside ? "with-aside" : ""} ${className ?? ""}`} onMouseDown={(e) => e.stopPropagation()}>
        {aside ? (
          <>
            <nav className="modal-aside">{aside}</nav>
            <div className="modal-main">{main}</div>
          </>
        ) : (
          main
        )}
      </div>
    </div>
  );
}
