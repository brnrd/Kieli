import test from "node:test";
import assert from "node:assert/strict";
import { validatePlaceholders } from "../src/server/placeholder-validation";
test("named arguments preserve types while allowing translation and argument order", () => {
  validatePlaceholders("Hello {first} {last}", "{last}, bonjour {first}");
  assert.throws(
    () => validatePlaceholders("Hello {name}", "Bonjour"),
    /Missing/,
  );
  assert.throws(
    () => validatePlaceholders("Hello {name}", "Bonjour {other}"),
    /Unexpected/,
  );
  assert.throws(
    () => validatePlaceholders("{count,number}", "{count}"),
    /mismatch/,
  );
  validatePlaceholders(
    "{count,plural,one {One} other {# items}}",
    "{count,plural,zero {None} one {Un} many {# articles} other {# articles}}",
  );
});
test("mustache, dollar, percent-named placeholders and references preserve their syntax", () => {
  validatePlaceholders("Hello {{name}}", "Bonjour {{name}}");
  validatePlaceholders("Hello ${name}", "Bonjour ${name}");
  validatePlaceholders("Hello %{name}", "Bonjour %{name}");
  assert.throws(
    () => validatePlaceholders("Hello {{name}}", "Bonjour ${name}"),
    /mismatch/,
  );
  validatePlaceholders("Welcome [%key:brand%]", "Bienvenue [%key:brand%]");
  assert.throws(
    () => validatePlaceholders("Welcome [%key:brand%]", "Bienvenue brand"),
    /reference/,
  );
});
test("printf arguments can be reordered with explicit positions, but cannot change types", () => {
  validatePlaceholders("%s has %d items", "%2$d articles pour %1$s");
  assert.throws(
    () => validatePlaceholders("%s has %d items", "%d articles pour %s"),
    /mismatch/,
  );
  validatePlaceholders("100%% %s", "%s 100%%");
  validatePlaceholders("%lld %@", "%2$@ %1$lld");
  assert.throws(() => validatePlaceholders("%lld", "%d"), /mismatch/);
  assert.throws(() => validatePlaceholders("%@", "%s"), /mismatch/);
});
test("ICU selectors, exact plural branches and numeric substitutions remain intact", () => {
  assert.throws(
    () =>
      validatePlaceholders(
        "{gender,select,male {He} female {She} other {They}}",
        "{gender,select,male {Il} other {Iel}}",
      ),
    /mismatch/,
  );
  assert.throws(
    () =>
      validatePlaceholders(
        "{n,plural,=0 {None} other {# items}}",
        "{n,plural,other {# articles}}",
      ),
    /mismatch/,
  );
  assert.throws(
    () =>
      validatePlaceholders(
        "{n,plural,other {# items}}",
        "{n,plural,other {articles}}",
      ),
    /mismatch/,
  );
});

test("formatting tags and ICU syntax are checked deterministically", () => {
  validatePlaceholders("<b>{name}</b>", "<b>{name}</b>");
  assert.throws(
    () =>
      validatePlaceholders("<b>{name}</b>", '<b onclick="evil()">{name}</b>'),
    /mismatch/,
  );
  assert.throws(
    () => validatePlaceholders("Hello {name}", "Bonjour {name"),
    /invalid placeholder/,
  );
});
