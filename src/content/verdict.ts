export interface Measurement {
  /** Share of sampled points sitting on a dark surface (0..1), or null if too few samples. */
  darkRatio: number | null;
  /** Share of sampled points sitting on a light surface (0..1), or null if too few samples. */
  lightRatio: number | null;
  /** Share of sampled text that is light (0..1), or null if no text was sampled. */
  lightText: number | null;
  samples: number;
}

/**
 * Decide whether a measurement looks like an already-dark page that should be left alone.
 * Any sizeable light area (a white login panel next to a dark hero, a light content column)
 * means the page still glares at night, so it gets converted; converting barely changes the
 * parts that are already dark. `previous` provides hysteresis so pages near the threshold
 * don't flip back and forth.
 */
export function looksDark(m: Measurement, previous?: boolean): boolean {
  if (m.darkRatio !== null && m.lightRatio !== null && m.samples >= 4) {
    if (m.lightRatio >= 0.3) return false;
    if (m.darkRatio >= 0.55 && m.lightRatio <= 0.2) return true;
    if (m.darkRatio <= 0.4) return false;
    if (previous !== undefined) return previous;
    return (m.lightText ?? 0) >= 0.5;
  }
  if (m.darkRatio !== null) return m.darkRatio >= 0.5 || (m.lightText ?? 0) >= 0.6;
  return (m.lightText ?? 0) >= 0.6;
}
