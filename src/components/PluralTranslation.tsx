import { useEffect, useState } from "react";
import type { Locale } from "../shared";
import {
  categories,
  looksPlural,
  readPlural,
  writePlural,
  type PluralMessage,
  type PluralKind,
} from "../messages";

export default function PluralTranslation({
  locale,
  value,
  onChange,
  disabled,
  canChangeStructure = true,
  template,
}: {
  locale: Locale;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  canChangeStructure?: boolean;
  template?: PluralMessage;
}) {
  const parsed = readPlural(value);
  const initial: PluralMessage = parsed ?? {
    ...(template ?? {
      variable: "count",
      type: "cardinal" as const,
      offset: 0,
    }),
    forms: { other: value },
  };
  const [message, setMessage] = useState<PluralMessage>(() => ({
    ...initial,
    forms: {
      ...Object.fromEntries(
        categories(locale, initial.type).map((form) => [form, ""]),
      ),
      ...initial.forms,
    },
  }));
  const [raw, setRaw] = useState(
    !!value &&
      looksPlural(value) &&
      (!parsed || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(parsed.variable)),
  );
  useEffect(() => {
    if (!disabled && !raw) onChange(writePlural(message, false));
  }, []);
  function change(next: PluralMessage) {
    setMessage(next);
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(next.variable))
      onChange(writePlural(next, false));
  }
  const forms = [
    ...new Set([
      ...categories(locale, message.type),
      ...Object.keys(message.forms),
    ]),
  ];
  return (
    <div className="plural-editor">
      <div className="plural-editor-tools">
        <span>
          Plural forms ·{" "}
          {locale.pluralForms ? "project settings" : "Unicode defaults"}
        </span>
        <button
          type="button"
          className="text-button"
          disabled={
            raw &&
            (!readPlural(value) ||
              !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(readPlural(value)!.variable))
          }
          title={
            raw && !readPlural(value)
              ? "Complex or invalid ICU must be edited as raw text."
              : undefined
          }
          onClick={() => {
            if (raw) {
              const next = readPlural(value);
              if (!next) return;
              setMessage(next);
            }
            setRaw(!raw);
          }}
        >
          {raw ? "Form editor" : "Raw ICU"}
        </button>
      </div>
      {raw ? (
        <textarea
          aria-label={`${locale.name} ICU message`}
          value={value}
          lang={locale.code}
          dir="auto"
          onChange={(event) => onChange(event.target.value)}
          rows={5}
          maxLength={20000}
          disabled={disabled}
        />
      ) : (
        <>
          <div className="plural-options">
            <label>
              Variable
              <input
                aria-label={`${locale.name} plural variable`}
                value={message.variable}
                maxLength={60}
                required
                pattern="[a-zA-Z_][a-zA-Z0-9_]*"
                disabled={disabled || !canChangeStructure}
                onChange={(event) =>
                  change({ ...message, variable: event.target.value })
                }
              />
            </label>
            <label>
              Rule
              <select
                aria-label={`${locale.name} plural rule`}
                value={message.type}
                disabled={disabled || !canChangeStructure}
                onChange={(event) => {
                  const type = event.target.value as PluralKind;
                  change({
                    ...message,
                    type,
                    forms: {
                      ...Object.fromEntries(
                        categories(locale, type).map((form) => [form, ""]),
                      ),
                      ...message.forms,
                    },
                  });
                }}
              >
                <option value="cardinal">Cardinal · 1 item, 2 items</option>
                <option value="ordinal">Ordinal · 1st, 2nd, 3rd</option>
              </select>
            </label>
          </div>
          {forms.map((form) => (
            <label className="plural-form-field" key={form}>
              <span>
                {form}
                {!categories(locale, message.type).includes(form as never) && (
                  <small>additional form</small>
                )}
              </span>
              <textarea
                aria-label={`${locale.name} · ${form}`}
                value={message.forms[form] ?? ""}
                lang={locale.code}
                dir="auto"
                rows={2}
                maxLength={20000}
                disabled={disabled}
                placeholder={`Copy for ${form}. Use # for the count.`}
                onChange={(event) =>
                  change({
                    ...message,
                    forms: { ...message.forms, [form]: event.target.value },
                  })
                }
              />
            </label>
          ))}
        </>
      )}
    </div>
  );
}
