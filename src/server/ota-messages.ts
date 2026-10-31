import cardinal from "cldr-core/supplemental/plurals.json";
import ordinal from "cldr-core/supplemental/ordinals.json";
import {
  parse,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";

// Portable, declarative CLDR predicates. No client evaluates code from a server.
export type Relation = {
  operand: string;
  mod: number;
  not: boolean;
  ranges: number[][];
};
export type Rules = Record<string, Relation[][]>;
export function compileRules(
  locale: string,
  type: "cardinal" | "ordinal",
): Rules {
  const table = (
    type === "cardinal"
      ? cardinal.supplemental["plurals-type-cardinal"]
      : ordinal.supplemental["plurals-type-ordinal"]
  ) as Record<string, Record<string, string>>;
  const normalized = new Intl.Locale(
    new Intl.PluralRules(locale, { type }).resolvedOptions().locale,
  );
  const rules = table[normalized.baseName] ?? table[normalized.language] ?? {};
  return Object.fromEntries(
    Object.entries(rules)
      .filter(([name]) => !name.endsWith("-other"))
      .map(([name, rule]) => [
        name.replace("pluralRule-count-", ""),
        rule
          .split("@")[0]!
          .trim()
          .split(" or ")
          .map((group) =>
            group.split(" and ").map((text) => {
              const match = /^([nivwftec])(?: % (\d+))? (!?=) ([\d.,]+)$/.exec(
                text,
              );
              if (!match) throw new Error("Unsupported CLDR rule.");
              return {
                operand: match[1]!,
                mod: Number(match[2] ?? 0),
                not: match[3] === "!=",
                ranges: match[4]!.split(",").map((range) => {
                  const parts = range.split("..").map(Number);
                  return [parts[0]!, parts[1] ?? parts[0]!];
                }),
              };
            }),
          ),
      ]),
  );
}
export type MessageNode = {
  type: "text" | "argument" | "pound" | "select" | "plural";
  value?: string;
  offset?: number;
  ordinal?: boolean;
  options?: Record<string, MessageNode[]>;
};
export function compileMessage(text: string): MessageNode[] {
  function visit(elements: MessageFormatElement[], depth = 0): MessageNode[] {
    if (depth > 20) throw new Error("Message nesting exceeds 20 levels.");
    return elements.map((node) => {
      if (node.type === TYPE.literal)
        return { type: "text", value: node.value };
      if (node.type === TYPE.argument)
        return { type: "argument", value: node.value };
      if (node.type === TYPE.pound) return { type: "pound" };
      if (
        node.type === TYPE.plural &&
        (!Number.isSafeInteger(node.offset) || node.offset > 1e12)
      )
        throw new Error("OTA plural offset is too large.");
      if (node.type === TYPE.select || node.type === TYPE.plural)
        return {
          type: node.type === TYPE.select ? "select" : "plural",
          value: node.value,
          ...(node.type === TYPE.plural
            ? { offset: node.offset, ordinal: node.pluralType === "ordinal" }
            : {}),
          options: Object.fromEntries(
            Object.entries(node.options).map(([key, option]) => [
              key,
              visit(option.value, depth + 1),
            ]),
          ),
        };
      throw new Error(
        "OTA supports text, named arguments, select, cardinal and ordinal plurals. Format dates, times and numbers in your application before passing them as named arguments.",
      );
    });
  }
  return visit(parse(text, { ignoreTag: true }));
}
