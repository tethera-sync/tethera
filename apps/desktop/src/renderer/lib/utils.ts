import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
export function cn(...inputs:ClassValue[]){return twMerge(clsx(inputs))}

/** Clamps a progress fraction into the 0–1 range. Non-finite values become 0. */
export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
}
