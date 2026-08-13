export type ChartImage = {
  id: string;
  title: string;
  dataUrl: string;
  width: number;
  height: number;
};

const PNG_SCALE = 2;

/**
 * Rasterizes a live chart SVG. The SVG is serialized standalone, so any styling
 * that lives in a stylesheet is lost; charts must set colors as attributes.
 */
export async function svgToPngDataUrl(
  svg: SVGSVGElement,
  opts: { scale?: number; background?: string } = {},
): Promise<{ dataUrl: string; width: number; height: number }> {
  const scale = opts.scale ?? PNG_SCALE;
  const background = opts.background ?? "#ffffff";

  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || svg.clientWidth || 640));
  const height = Math.max(1, Math.round(rect.height || svg.clientHeight || 320));

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  clone.style.fontFamily = "Helvetica, Arial, sans-serif";

  const markup = new XMLSerializer().serializeToString(clone);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

  const image = await loadImage(svgUrl);
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  return { dataUrl: canvas.toDataURL("image/png"), width, height };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not rasterize chart"));
    img.src = src;
  });
}

/** Captures every chart rendered inside `root`, keyed by its data-chart-id. */
export async function captureCharts(root: HTMLElement | null): Promise<ChartImage[]> {
  if (!root) return [];
  const holders = Array.from(root.querySelectorAll<HTMLElement>("[data-chart-id]"));
  const images: ChartImage[] = [];
  for (const holder of holders) {
    const svg = holder.querySelector("svg");
    if (!svg) continue;
    try {
      const { dataUrl, width, height } = await svgToPngDataUrl(svg as SVGSVGElement);
      images.push({
        id: holder.dataset.chartId ?? `chart-${images.length}`,
        title: holder.dataset.chartTitle ?? "",
        dataUrl,
        width,
        height,
      });
    } catch {
      // A single unrenderable chart shouldn't fail the whole export.
    }
  }
  return images;
}
