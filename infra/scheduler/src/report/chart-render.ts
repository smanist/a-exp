/** Server-side chart rendering — uses chartjs-node-canvas to render ChartSpec to PNG. */

import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import type { ChartSpec } from "./types.js";

const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 400;

/** Cache canvas instances by dimension to avoid re-creation. */
const canvasCache = new Map<string, ChartJSNodeCanvas>();

function getCanvas(width: number, height: number): ChartJSNodeCanvas {
  const key = `${width}x${height}`;
  let canvas = canvasCache.get(key);
  if (!canvas) {
    canvas = new ChartJSNodeCanvas({
      width,
      height,
      backgroundColour: "#1a1a2e",
    });
    canvasCache.set(key, canvas);
  }
  return canvas;
}

/** Render a ChartSpec to a PNG buffer. */
export async function renderChart(spec: ChartSpec): Promise<Buffer> {
  const width = spec.width ?? DEFAULT_WIDTH;
  const height = spec.height ?? DEFAULT_HEIGHT;
  const canvas = getCanvas(width, height);

  // Apply dark theme defaults
  const config = {
    ...spec.config,
    options: {
      animation: false,
      ...spec.config.options,
      plugins: {
        ...spec.config.options?.plugins,
        title: {
          display: true,
          text: spec.title,
          color: "#e0e0e0",
          font: { size: 14 },
          ...((spec.config.options?.plugins as Record<string, unknown>)?.title as object),
        },
        legend: {
          labels: { color: "#b0b0b0" },
          ...((spec.config.options?.plugins as Record<string, unknown>)?.legend as object),
        },
      },
    },
  };

  return canvas.renderToBuffer(config as Parameters<ChartJSNodeCanvas["renderToBuffer"]>[0]);
}
