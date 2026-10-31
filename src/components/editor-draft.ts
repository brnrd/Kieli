import { readPlural } from "../messages";
// The plural form editor prepares empty Unicode categories and normalizes ICU
// serialization on mount. Neither is a translation edit or freshness acceptance.
export function sameTranslation(
  before: string,
  after: string,
  plural: boolean,
) {
  if (before === after) return true;
  if (!plural) return false;
  const a = readPlural(before),
    b = readPlural(after);
  const empty = (text: string, parsed: ReturnType<typeof readPlural>) =>
    !text.trim() ||
    (!!parsed && Object.values(parsed.forms).every((value) => !value.trim()));
  if (empty(before, a) && empty(after, b)) return true;
  if (
    !a ||
    !b ||
    a.variable !== b.variable ||
    a.type !== b.type ||
    a.offset !== b.offset
  )
    return false;
  const forms = new Set([...Object.keys(a.forms), ...Object.keys(b.forms)]);
  return [...forms].every(
    (form) => (a.forms[form] ?? "") === (b.forms[form] ?? ""),
  );
}
