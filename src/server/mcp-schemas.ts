import { z } from "zod";
import { keyNameSchema, translationSchema } from "../validation";

export const listKeysSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(1024).optional(),
    query: z.string().max(200).optional(),
    namespace: z.string().max(60).optional(),
    language: z.string().min(2).max(35).optional(),
    missingOnly: z.boolean().default(true),
  })
  .strict();
export const translationBatchSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            key: keyNameSchema,
            expectedVersion: z.number().int().positive(),
            expectedSourceContext: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            translations: translationSchema.refine(
              (value) => Object.keys(value).length > 0,
              "Provide at least one translation.",
            ),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    overwriteExisting: z.boolean().default(false),
  })
  .strict();
