/* type-only extraction of v1's lib/server/term-pins.ts (decision 14):
   BrainEvent's termPins shapes, verbatim from v1. */

export type TermPin = { cmd: string; addedAt: number };
export type TermPinsDoc = { hosts: Record<string, TermPin[]> };
