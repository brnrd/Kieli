import {
  parse,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";
import { referencePattern } from "../messages";
import { HttpError } from "./errors";

// Compare declarative argument contracts, not generated prose or variable order.
function signature(text: string) {
  const result = new Set<string>();
  let printf = 0;
  let copy = text.replace(referencePattern, (_, name: string) => {
    result.add(`reference:${name}`);
    return "";
  });
  copy = copy.replace(
    /\{\{\s*([\w.-]+)\s*\}\}|\$\{([\w.-]+)\}|%\{([\w.-]+)\}/g,
    (_, a: string, b: string, c: string) => {
      result.add(
        `template:${a ? "mustache" : b ? "dollar" : "percent"}:${a ?? b ?? c}`,
      );
      return "";
    },
  );
  copy = copy.replace(
    /%%|%(?:(\d+)\$)?[-+0#]*\d*(?:\.\d+)?(hh|ll|[hljztL])?([@diuoxXfFeEgGcs])/g,
    (match, index: string, length: string, type: string) => {
      if (match === "%%") return "";
      const position = index ? Number(index) : ++printf;
      result.add(`printf:${position}:${length ?? ""}${type}`);
      return "";
    },
  );
  copy = copy.replace(
    /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*)?\s*\/?>/g,
    (tag) => {
      result.add(`tag:${tag}`);
      return "";
    },
  );
  function visit(nodes: MessageFormatElement[], plural?: string) {
    for (const node of nodes) {
      if (node.type === TYPE.literal) continue;
      if (node.type === TYPE.pound) {
        result.add(`icu:pound:${plural}`);
        continue;
      }
      if (node.type === TYPE.tag)
        throw new Error("Unsupported formatting tag.");
      if (node.type === TYPE.plural)
        result.add(
          `icu:plural:${node.value}:${node.pluralType}:${node.offset}:${Object.keys(
            node.options,
          )
            .filter((key) => key.startsWith("="))
            .sort()
            .join(",")}`,
        );
      else if (node.type === TYPE.select)
        result.add(
          `icu:select:${node.value}:${Object.keys(node.options).sort().join(",")}`,
        );
      else
        result.add(
          `icu:${node.type}:${node.value}:${"style" in node ? JSON.stringify(node.style ?? null, (key, value) => (key === "location" ? undefined : value)) : ""}`,
        );
      if (node.type === TYPE.plural || node.type === TYPE.select)
        for (const option of Object.values(node.options))
          visit(option.value, node.type === TYPE.plural ? node.value : plural);
    }
  }
  visit(parse(copy, { ignoreTag: true }));
  return [...result].sort();
}
export function validatePlaceholders(source: string, target: string) {
  let expected: string[], actual: string[];
  try {
    expected = signature(source);
  } catch {
    throw new HttpError(
      422,
      "Source copy uses unsupported placeholder syntax. Edit it manually or use valid ICU/template placeholders.",
    );
  }
  try {
    actual = signature(target);
  } catch {
    throw new HttpError(
      400,
      "Translation has invalid placeholder syntax. Preserve the source argument contract.",
    );
  }
  const missing = expected.filter((item) => !actual.includes(item)),
    extra = actual.filter((item) => !expected.includes(item));
  if (missing.length || extra.length)
    throw new HttpError(
      400,
      `Placeholder mismatch.${missing.length ? " Missing: " + missing.join(", ") + "." : ""}${extra.length ? " Unexpected: " + extra.join(", ") + "." : ""}`,
    );
}
