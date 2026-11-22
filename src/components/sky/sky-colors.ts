// Shared colour scale for the 2D map and the 3D dome.

// Colour encoding (obstruction = 1 - snr):
// - clear sky (snr >= CLEAR_SNR) is a quiet cool slate at low alpha, so a mostly clear
//   sky reads as calm;
// - obstruction uses a warm ramp, orange -> red, fully opaque. The red end is about
//   4:1 against the card surface (WCAG 1.4.11 non-text contrast).
const CLEAR_SNR = 0.7;
const CLEAR = { l: 0.62, c: 0.035, h: 225, alpha: 0.42 };
const WARM_FROM = { l: 0.78, c: 0.15, h: 65 }; // mild obstruction: orange
const WARM_TO = { l: 0.62, c: 0.21, h: 27 }; // full obstruction: red

function oklchToRgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  }) as [number, number, number];
}

export type Rgba = [number, number, number, number];

/** RGBA for an SNR value (0 obstructed .. 1 clear). */
export function snrColor(snr: number): Rgba {
  const v = Math.min(1, Math.max(0, snr));
  if (v >= CLEAR_SNR) {
    const [r, g, b] = oklchToRgb(CLEAR.l, CLEAR.c, CLEAR.h);
    return [r, g, b, Math.round(CLEAR.alpha * 255)];
  }
  const t = 1 - v / CLEAR_SNR; // 0 at the clear threshold, 1 fully obstructed
  const [r, g, b] = oklchToRgb(
    WARM_FROM.l + (WARM_TO.l - WARM_FROM.l) * t,
    WARM_FROM.c + (WARM_TO.c - WARM_FROM.c) * t,
    WARM_FROM.h + (WARM_TO.h - WARM_FROM.h) * t,
  );
  return [r, g, b, 255];
}

