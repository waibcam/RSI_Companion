import { z } from 'zod';

export const ReleaseNoteEntry = z.object({
  version: z.string(),
  date: z.string(),
  notes: z.array(z.string()),
});
export type ReleaseNoteEntry = z.infer<typeof ReleaseNoteEntry>;

export const ReleaseNotesResponse = z.object({
  entries: z.array(ReleaseNoteEntry),
});
export type ReleaseNotesResponse = z.infer<typeof ReleaseNotesResponse>;

export const LoanersResponse = z.object({
  data: z.record(z.string(), z.array(z.string())),
});
export type LoanersResponse = z.infer<typeof LoanersResponse>;

export const ShipNameInfoEntry = z.object({
  id: z.string(),
  name: z.string(),
});
export const ShipNameInfoResponse = z.object({
  ships: z.array(ShipNameInfoEntry),
});
export type ShipNameInfoResponse = z.infer<typeof ShipNameInfoResponse>;
