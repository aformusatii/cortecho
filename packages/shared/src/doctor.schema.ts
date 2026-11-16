import { z } from 'zod';

/** One line of `cortecho doctor` / `GET /api/doctor`. */
export const doctorStatusValues = ['pass', 'warn', 'fail', 'skip'] as const;
export const doctorStatusSchema = z.enum(doctorStatusValues);
export type DoctorStatus = (typeof doctorStatusValues)[number];

export const doctorCheckSchema = z.object({
  name: z.string(),
  status: doctorStatusSchema,
  detail: z.string(),
  /** What to do when the check is not a pass. Never contains a secret. */
  fix: z.string().optional(),
});
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;

export const doctorReportSchema = z.object({
  ok: z.boolean(),
  generatedAt: z.string(),
  checks: z.array(doctorCheckSchema),
});
export type DoctorReport = z.infer<typeof doctorReportSchema>;
