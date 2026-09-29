import { useEffect } from "react";
import { useUpdater } from "../lib/updater";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Offers the update found on GitHub at the top of the window. */
export function UpdateBanner() {
  const { version, phase, progress, message, dismissed, look, install, restart, dismiss } = useUpdater();

  useEffect(() => {
    const quiet = () =>
      // No release yet, or no network: nothing worth interrupting for.
      look().catch((err) => console.warn("update check failed", err));
    void quiet();
    const id = setInterval(() => void quiet(), CHECK_EVERY_MS);
    return () => clearInterval(id);
  }, [look]);

  if (phase === "idle" || dismissed || !version) return null;

  return (
    <div className={`update-bar ${phase}`}>
      {phase === "found" && (
        <>
          <span>
            Versão <strong>{version}</strong> disponível.
          </span>
          <button className="primary" onClick={() => void install()}>
            Atualizar
          </button>
          <button className="ghost auto" onClick={dismiss}>
            Depois
          </button>
        </>
      )}
      {phase === "working" && <span>Baixando atualização… {progress}%</span>}
      {phase === "ready" && (
        <>
          <span>Atualização instalada.</span>
          <button className="primary" onClick={() => void restart()}>
            Reiniciar agora
          </button>
          <button className="ghost auto" onClick={dismiss}>
            Depois
          </button>
        </>
      )}
      {phase === "handed-off" && (
        <>
          <span>O instalador do sistema foi aberto com o pacote novo.</span>
          <button className="ghost auto" onClick={dismiss}>
            Fechar
          </button>
        </>
      )}
      {phase === "restart-failed" && (
        <>
          <span>
            Atualização instalada. Feche e abra o app para concluir.
            {message ? ` (${message})` : ""}
          </span>
          <button className="ghost auto" onClick={dismiss}>
            Fechar
          </button>
        </>
      )}
      {phase === "error" && (
        <>
          <span>Falha ao atualizar: {message}</span>
          <button className="ghost auto" onClick={dismiss}>
            Fechar
          </button>
        </>
      )}
    </div>
  );
}
