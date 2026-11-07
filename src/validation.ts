import { z } from "zod";
import { PLURAL_CATEGORIES, validatePlural } from "./messages";
const forms = z
  .array(z.enum(PLURAL_CATEGORIES))
  .min(1)
  .max(6)
  .refine(
    (value) => value.includes("other") && new Set(value).size === value.length,
    "Choose unique plural forms including other.",
  );
const language = z
  .object({
    disabled: z.boolean().optional(),
    code: z
      .string()
      .min(2)
      .max(35)
      .refine((v) => {
        try {
          return Intl.getCanonicalLocales(v)[0] === v;
        } catch {
          return false;
        }
      }, "Use a canonical BCP 47 language code, such as en or pt-BR."),
    name: z.string().trim().min(1).max(60),
    pluralForms: forms.optional(),
    ordinalForms: forms.optional(),
  })
  .strict();
export const projectSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(""),
    sourceLanguage: z.string(),
    languages: z.array(language).min(1).max(30),
    color: z.enum(["sage", "violet", "amber", "blue"]).default("sage"),
    snapshotPolicy: z
      .object({
        enabled: z.boolean(),
        intervalHours: z.union([z.literal(24), z.literal(168)]),
        retention: z.number().int().min(2).max(30),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (!p.languages.some((l) => l.code === p.sourceLanguage))
      ctx.addIssue({
        code: "custom",
        message: "Source language must belong to the project.",
      });
    if (p.languages.some((l) => l.code === p.sourceLanguage && l.disabled))
      ctx.addIssue({
        code: "custom",
        message: "The source language cannot be disabled.",
      });
    if (new Set(p.languages.map((l) => l.code)).size !== p.languages.length)
      ctx.addIssue({
        code: "custom",
        message: "Language codes must be unique.",
      });
  });
const unsafeSegments = new Set(["__proto__", "prototype", "constructor"]);
export const keyNameSchema = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/)
  .refine(
    (name) => !name.split(".").some((s) => !s || unsafeSegments.has(s)),
    "Invalid key segment.",
  );
export const translationSchema = z.record(
  z.string().min(2).max(35),
  z.string().max(20000),
);
export const applePluralTypesSchema = z.record(
  language.shape.code,
  z.enum(["d", "ld", "lld"]),
);
export const keySchema = z
  .object({
    name: keyNameSchema,
    description: z.string().max(1000).default(""),
    namespace: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .refine((v) => !unsafeSegments.has(v), "Invalid namespace.")
      .default("general"),
    tags: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
    translations: translationSchema,
    plural: z.boolean().optional(),
    applePluralTypes: applePluralTypesSchema.optional(),
  })
  .strict()
  .superRefine((key, ctx) => {
    if (key.plural)
      for (const text of Object.values(key.translations)) {
        try {
          validatePlural(text);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: (error as Error).message });
        }
      }
  })
  .refine(
    (key) => new TextEncoder().encode(JSON.stringify(key)).length <= 120000,
    "A key and its translations must fit within 120 KB.",
  );
