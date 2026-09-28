/**
 * Single source of truth for the bonding-curve presets.
 *
 * The preset definitions themselves (ids, names, blurbs, and the multiplier
 * math in `presetCurve`) live in `./launch` alongside the chain-facing curve
 * code. This module re-exports them and adds only presentation helpers that
 * are *derived* from those same constants, so the Presets gallery can never
 * drift from what "Use this preset" on the launch page actually applies.
 *
 * Both `src/pages/create-pool.tsx` and `src/pages/presets.tsx` must read
 * presets from here, never from a copy.
 */
import {
  CURVE_PRESETS,
  presetCurve,
  type CurvePresetId,
} from './launch';

export { CURVE_PRESETS, presetCurve };
export type { CurvePresetId };

export interface PresetView {
  id: CurvePresetId;
  name: string;
  blurb: string;
  /** Number of curve segments (price points minus one). */
  segments: number;
  /** End price as a multiple of the start price (e.g. 10 for exponential). */
  endMultiple: number;
  /** Normalized price multipliers (start = 1) for drawing the curve shape. */
  shape: number[];
}

/** Presentation views for every real preset, derived from the real math. */
export function presetViews(): PresetView[] {
  return CURVE_PRESETS.map((p) => {
    const shape = presetCurve(p.id, 1).prices;
    return {
      id: p.id,
      name: p.name,
      blurb: p.blurb,
      segments: shape.length - 1,
      endMultiple: shape[shape.length - 1] / shape[0],
      shape,
    };
  });
}

/** Narrow an unknown value (e.g. a URL query param) to a real preset id. */
export function asCurvePresetId(value: unknown): CurvePresetId | null {
  return CURVE_PRESETS.some((p) => p.id === value)
    ? (value as CurvePresetId)
    : null;
}
