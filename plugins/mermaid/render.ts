import type { Mermaid } from "mermaid";

let loaded: Promise<Mermaid> | null = null;

/** Mermaid is large, so it loads with the first diagram, not with the app. */
export function mermaid(): Promise<Mermaid> {
  loaded ??= import("mermaid").then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || undefined,
      // Labels as SVG text, not HTML: an SVG with HTML inside cannot be drawn
      // to a canvas, which copying as an image needs.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    return m;
  });
  return loaded;
}

/** The parse error of a definition, or null when it is valid. */
export async function problem(source: string): Promise<string | null> {
  const m = await mermaid();
  try {
    await m.parse(source);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

let seq = 0;

export async function toSvg(source: string): Promise<string> {
  const m = await mermaid();
  const { svg } = await m.render(`shellhive-diagram-${++seq}`, source);
  return svg;
}

/** Draws an SVG at twice its size and returns it as a PNG. */
export async function toPng(svg: string): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth * scale;
  canvas.height = img.naturalHeight * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas indisponível");
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0f1115";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("não consegui gerar a imagem"))), "image/png"),
  );
}
