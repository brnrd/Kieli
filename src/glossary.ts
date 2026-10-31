import { z } from "zod";
export const glossaryTermSchema = z
  .object({
    source: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(
        (value) =>
          !/[\r\n\u0000]/.test(value) && termIdentity(value).length <= 400,
        "Use a bounded, single-line term.",
      ),
    translations: z
      .record(z.string().min(2).max(35), z.string().trim().max(300))
      .default({}),
    notes: z.string().max(1000).default(""),
    caseSensitive: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 12000,
    "A glossary term must fit within 12 KB.",
  );
export type GlossaryInput = z.infer<typeof glossaryTermSchema>;
export type GlossaryTerm = GlossaryInput & {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};
export type GlossaryPage = {
  items: GlossaryTerm[];
  total: number;
  nextCursor?: string;
};
export const glossaryFileSchema = z
  .object({
    format: z.literal("keylo-glossary"),
    version: z.literal(1),
    sourceLanguage: z.string().min(2).max(35),
    terms: z.array(glossaryTermSchema).max(1000),
  })
  .strict();
export const glossaryReadSchema = z
  .object({
    query: z.string().max(200).default(""),
    text: z.string().max(20000).optional(),
    language: z.string().min(2).max(35).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
export const normalizedTerm = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ");
export const termIdentity = (value: string) =>
  normalizedTerm(value).toLowerCase();
export function matchingTermIds(
  text: string,
  terms: GlossaryTerm[],
  locale: string,
) {
  const contexts = new Map<
    boolean,
    { text: string; boundaries: Set<number> }
  >();
  const found = new Set<string>();
  for (const term of terms) {
    let context = contexts.get(term.caseSensitive);
    if (!context) {
      const copy = term.caseSensitive
        ? normalizedTerm(text)
        : termIdentity(text);
      const boundaries = new Set<number>([0, copy.length]);
      for (const part of new Intl.Segmenter(locale, {
        granularity: "word",
      }).segment(copy)) {
        boundaries.add(part.index);
        boundaries.add(part.index + part.segment.length);
      }
      context = { text: copy, boundaries };
      contexts.set(term.caseSensitive, context);
    }
    const source = term.caseSensitive
      ? normalizedTerm(term.source)
      : termIdentity(term.source);
    let offset = context.text.indexOf(source);
    while (offset >= 0) {
      if (
        context.boundaries.has(offset) &&
        context.boundaries.has(offset + source.length)
      ) {
        found.add(term.id);
        break;
      }
      offset = context.text.indexOf(source, offset + 1);
    }
  }
  return found;
}
