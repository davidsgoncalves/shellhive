import { useEffect, useState } from "react";
import { submit, typeText } from "../lib/typing";
import type { CacheInfo } from "../lib/cache";
import { useStore } from "../lib/store";

/** Sent by Keep warm; any request renews the cache, so the reply can be short. */
const KEEP_WARM_PROMPT = "Mensagem automática do Shellhive para manter o cache aquecido. Responda só: ok";
/** How long the cost confirmation stays up before Keep warm asks again. */
const CONFIRM_MS = 6000;

const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

const countdown = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

interface Props {
  tabId: string;
  info: CacheInfo;
  style: React.CSSProperties;
}

/**
 * Over a waiting session: how long its prompt cache lasts and what the next
 * message costs. Expressive is a card with the explanation in view; minimal
 * is only a countdown badge over the terminal, whose hover explains the cost
 * and offers Keep warm.
 */
export function CacheCard({ tabId, info, style }: Props) {
  const look = useStore((s) => s.cacheStyle);
  const [now, setNow] = useState(Date.now());
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  const left = info.at + info.ttl - now;
  const warm = left > 0;
  const tokens = kTokens(info.tokens);
  const lifetime = info.ttl >= 3_600_000 ? "1 hora" : "5 minutos";
  const explain = warm
    ? `Cache de ${lifetime}, definido pela última resposta. Respondendo agora, os ${tokens} tokens do contexto saem por cerca de 10% do custo.`
    : `O cache expirou. A próxima mensagem processa os ${tokens} tokens do contexto a preço cheio. Se o assunto mudou, uma sessão nova sai mais barata.`;

  const keepWarm = async () => {
    if (!confirming) return setConfirming(true);
    setConfirming(false);
    await typeText(tabId, KEEP_WARM_PROMPT);
    await submit(tabId);
  };

  const fill = `${Math.min(100, (left / info.ttl) * 100)}%`;
  const action = confirming ? `Gastar ~${kTokens(info.tokens / 10)}?` : "Keep warm";

  if (look === "expressive") {
    return (
      <div className={`cache-card ${warm ? "warm" : "cold"}`} style={style}>
        <div className="cache-card-head">
          <span className="cache-card-state">
            {warm ? (
              <>
                Cache warm <strong>{countdown(left)}</strong>
              </>
            ) : (
              "Cache cold"
            )}
          </span>
          {warm && (
            <span className="cache-card-bar">
              <span style={{ width: fill }} />
            </span>
          )}
          {warm && (
            <button className={`ghost auto ${confirming ? "danger" : ""}`} onClick={() => void keepWarm()}>
              {confirming ? `Gastar ~${kTokens(info.tokens / 10)} tokens da cota?` : "Keep warm"}
            </button>
          )}
        </div>
        <p className="cache-card-text">{explain}</p>
      </div>
    );
  }

  return (
    <div className={`cache-line ${warm ? "warm" : "cold"}`} style={style}>
      <div className="cache-badge" title={explain}>
        <span className="cache-badge-dot" />
        {warm ? countdown(left) : "cold"}
        {warm && (
          <button className={`cache-badge-action ${confirming ? "danger" : ""}`} onClick={() => void keepWarm()}>
            {action}
          </button>
        )}
      </div>
    </div>
  );
}
