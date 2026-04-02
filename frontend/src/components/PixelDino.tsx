/**
 * Pixel-art Dino running animation.
 * Uses CSS box-shadow technique — each "pixel" is a 1×1 box-shadow on a tiny element.
 * Two overlapping elements alternate visibility to create a running cycle.
 * Colors are randomized per instance — different body, shell, and boot colors each time.
 */

import { useMemo } from "react";

const SCALE = 2; // scale: each pixel = 2×2 CSS pixels

// Symbolic pixel identifiers (not colors — mapped at render time)
type PixelId = "G" | "D" | "W" | "B" | "R" | "S" | "O" | null;
const G: PixelId = "G"; // body
const D: PixelId = "D"; // body dark
const W: PixelId = "W"; // white (belly / eye)
const B: PixelId = "B"; // black (eye)
const R: PixelId = "R"; // shell
const S: PixelId = "S"; // saddle (same as shell)
const O: PixelId = "O"; // boots
const _: PixelId = null; // transparent

// Color palettes for each Dino part — [body, bodyDark, shell, boots]
const BODY_COLORS = [
  { body: "#4caf50", dark: "#2e7d32" }, // green
  { body: "#e53935", dark: "#b71c1c" }, // red
  { body: "#42a5f5", dark: "#1565c0" }, // blue
  { body: "#ab47bc", dark: "#6a1b9a" }, // purple
  { body: "#fdd835", dark: "#f9a825" }, // yellow
  { body: "#26c6da", dark: "#00838f" }, // cyan
  { body: "#ff7043", dark: "#d84315" }, // orange
  { body: "#ec407a", dark: "#ad1457" }, // pink
  { body: "#78909c", dark: "#37474f" }, // grey
  { body: "#66bb6a", dark: "#388e3c" }, // light green
];

const SHELL_COLORS = [
  { shell: "#e65100", saddle: "#e65100" }, // orange
  { shell: "#d32f2f", saddle: "#d32f2f" }, // red
  { shell: "#1976d2", saddle: "#1976d2" }, // blue
  { shell: "#7b1fa2", saddle: "#7b1fa2" }, // purple
  { shell: "#f57f17", saddle: "#f57f17" }, // gold
  { shell: "#00695c", saddle: "#00695c" }, // teal
  { shell: "#c62828", saddle: "#c62828" }, // dark red
  { shell: "#4527a0", saddle: "#4527a0" }, // deep purple
];

const BOOT_COLORS = [
  "#ff8a65", // orange
  "#ef5350", // red
  "#42a5f5", // blue
  "#ab47bc", // purple
  "#ffa726", // amber
  "#26a69a", // teal
  "#8d6e63", // brown
  "#78909c", // grey
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface ColorMap {
  G: string;
  D: string;
  W: string;
  B: string;
  R: string;
  S: string;
  O: string;
}

function sampleColors(): ColorMap {
  const body = pick(BODY_COLORS);
  const shell = pick(SHELL_COLORS);
  const boots = pick(BOOT_COLORS);
  return {
    G: body.body,
    D: body.dark,
    W: "#ffffff",
    B: "#000000",
    R: shell.shell,
    S: shell.saddle,
    O: boots,
  };
}

// Frame 1: right leg forward  (13 wide × 17 tall)
const frame1: PixelId[][] = [
  [_, _, _, _, _, _, G, G, _, _, _, _, _],
  [_, _, _, _, _, G, G, _, _, _, _, _, _],
  [_, _, _, _, G, G, W, B, G, G, G, G, _],
  [_, _, _, _, G, G, W, B, G, G, G, B, G],
  [_, _, _, R, G, G, G, G, G, G, G, G, G],
  [_, _, R, D, W, W, W, G, G, G, G, G, G],
  [_, _, R, D, W, W, W, W, G, G, G, G, G],
  [_, _, _, R, W, W, W, W, W, G, G, G, _],
  [_, _, _, R, R, W, W, W, G, _, _, _, _],
  [_, _, _, _, R, G, G, G, _, _, _, _, _],
  [G, W, S, S, W, G, G, G, _, G, G, _, _],
  [G, G, W, W, G, G, G, G, G, G, G, _, _],
  [_, G, G, G, G, G, G, _, _, _, _, _, _],
  [_, _, G, G, G, G, _, _, _, _, _, _, _],
  [_, _, _, _, G, G, G, _, _, _, _, _, _],
  [_, _, _, O, O, O, _, _, _, _, _, _, _],
  [_, _, _, O, O, O, O, _, _, _, _, _, _],
];

// Frame 2: left leg forward  (13 wide × 17 tall)
const frame2: PixelId[][] = [
  [_, _, _, _, _, _, G, G, _, _, _, _, _],
  [_, _, _, _, _, G, G, _, _, _, _, _, _],
  [_, _, _, _, G, G, W, B, G, G, G, G, _],
  [_, _, _, _, G, G, W, B, G, G, G, B, G],
  [_, _, _, R, G, G, G, G, G, G, G, G, G],
  [_, _, R, D, W, W, W, G, G, G, G, G, G],
  [_, _, R, D, W, W, W, W, G, G, G, G, G],
  [_, _, _, R, W, W, W, W, W, G, G, G, _],
  [_, _, _, R, R, W, W, W, G, _, _, _, _],
  [_, _, _, _, R, G, G, G, _, _, _, _, _],
  [G, W, S, S, W, G, G, G, _, G, G, _, _],
  [G, G, W, W, G, G, G, G, G, G, G, _, _],
  [_, G, G, G, G, G, G, _, _, _, _, _, _],
  [_, _, G, G, G, G, _, _, _, _, _, _, _],
  [_, _, _, _, G, G, G, _, _, _, _, _, _],
  [_, _, _, _, O, O, O, _, _, _, _, _, _],
  [_, _, _, O, O, O, O, _, _, _, _, _, _],
];

const WIDTH = 13 * SCALE;
const HEIGHT = 17 * SCALE;

function frameShadow(frame: PixelId[][], colors: ColorMap): string {
  const shadows: string[] = [];
  for (let y = 0; y < frame.length; y++) {
    for (let x = 0; x < frame[y].length; x++) {
      const id = frame[y][x];
      if (id) shadows.push(`${x * SCALE}px ${y * SCALE}px 0 0 ${colors[id]}`);
    }
  }
  return shadows.join(",");
}

const pixelStyle: React.CSSProperties = {
  display: "block",
  width: SCALE,
  height: SCALE,
  position: "absolute",
  top: 0,
  left: 0,
  imageRendering: "pixelated",
};

export function PixelDino({ title }: { title?: string }) {
  const { shadow1, shadow2 } = useMemo(() => {
    const colors = sampleColors();
    return {
      shadow1: frameShadow(frame1, colors),
      shadow2: frameShadow(frame2, colors),
    };
  }, []);

  return (
    <span
      className="pixel-dino-container"
      title={title}
      style={{
        display: "inline-block",
        width: WIDTH,
        height: HEIGHT,
        position: "relative",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    >
      <span
        className="pixel-dino-f1"
        style={{ ...pixelStyle, boxShadow: shadow1 }}
      />
      <span
        className="pixel-dino-f2"
        style={{ ...pixelStyle, boxShadow: shadow2 }}
      />
    </span>
  );
}
