import { useState, type SyntheticEvent } from "react";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import type { Project, TranslationKey } from "../shared";
import KeyHistory from "./KeyHistory";
import { LanguageMark } from "./ui";
import PluralTranslation from "./PluralTranslation";
import { translationComplete, readPlural } from "../messages";
export default function KeyForm({
  project,
  editing,
  manager,
  busy,
  error,
  onSubmit,
  onClose,
  onReload,
  onRestored,
}: {
  project: Project;
  editing: TranslationKey | null;
  manager: boolean;
  busy: boolean;
  error: string;
  onSubmit: (data: Record<string, unknown>) => void;
  onClose: () => void;
  onReload: () => Promise<void>;
  onRestored: () => Promise<void>;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [namespace, setNamespace] = useState(editing?.namespace ?? "general");
  const [tags, setTags] = useState(editing?.tags.join(", ") ?? "");
  const [plural, setPlural] = useState(!!editing?.plural);
  const [translations, setTranslations] = useState<Record<string, string>>(
    editing?.translations ?? {},
  );
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const sourceChanged =
    !!editing &&
    ((translations[project.sourceLanguage] ?? "") !==
      (editing.translations[project.sourceLanguage] ?? "") ||
      plural !== !!editing.plural);
  const draftOutdated = project.languages
    .filter(
      (locale) =>
        locale.code !== project.sourceLanguage &&
        !!translations[locale.code]?.trim() &&
        (translations[locale.code] ?? "") ===
          (editing?.translations[locale.code] ?? "") &&
        (sourceChanged ||
          (!!editing?.outdatedLanguages?.includes(locale.code) &&
            !confirmed.has(locale.code))),
    )
    .map((locale) => locale.code);
  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetTranslations = Object.fromEntries(
      Object.entries(translations).filter(
        ([code, text]) =>
          (manager || code !== project.sourceLanguage) &&
          (!editing ||
            text !== (editing.translations[code] ?? "") ||
            confirmed.has(code)),
      ),
    );
    onSubmit({
      ...(editing
        ? {
            version: editing.version,
            expectedSourceContext: editing.sourceContext,
          }
        : { name }),
      ...(manager
        ? {
            description,
            namespace,
            plural,
            tags: tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          }
        : {}),
      translations: targetTranslations,
    });
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy} className="form-fieldset">
        <div className="dialog-body key-form">
          <label className="field-label">
            Key name
            <span>Stable and descriptive. Your developers will thank you.</span>
            <input
              autoFocus
              name="keyName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. home.hero.title"
              required
              maxLength={180}
              pattern="[a-zA-Z0-9_][a-zA-Z0-9_.\-]*"
              disabled={!!editing}
              className="mono-input"
            />
          </label>
          <div className="field-grid">
            <label className="field-label">
              Namespace
              <input
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                placeholder="general"
                disabled={!manager}
                maxLength={60}
              />
            </label>
            <label className="field-label">
              Tags <small>optional, comma separated</small>
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="e.g. homepage, buttons"
                disabled={!manager}
                maxLength={360}
              />
            </label>
          </div>
          <label className="field-label">
            Context <small>optional</small>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A little context goes a long way. Where does this copy appear?"
              maxLength={1000}
              rows={2}
              disabled={!manager}
            />
          </label>
          <div className="form-divider">
            <span>THE WORDS</span>
            <span>{project.languages.length} languages</span>
          </div>
          <label className="checkbox-label plural-key-toggle">
            <input
              type="checkbox"
              checked={plural}
              disabled={!manager}
              onChange={(event) => setPlural(event.target.checked)}
            />
            <span>
              This key has plural forms
              <small>
                Forms follow each language's Unicode rules. Disabling the form
                editor keeps the ICU text intact.
              </small>
            </span>
          </label>
          {!plural && (
            <p className="reference-hint">
              Reuse another key with <code>[%key:other.key%]</code>. It can
              appear inside a sentence.
              {editing && (
                <>
                  {" "}
                  Reference this key: <code>{`[%key:${editing.name}%]`}</code>.
                </>
              )}
            </p>
          )}
          {sourceChanged && (
            <p className="field-warning">
              Changing the source will mark unchanged target translations as
              outdated. Their copy will be kept.
            </p>
          )}
          {project.languages.map((l) => (
            <div className="translation-field" key={l.code}>
              <div className="translation-language-heading">
                <LanguageMark code={l.code} small />
                <strong>{l.name}</strong>
                <span className="locale-code">{l.code}</span>
                {l.code === project.sourceLanguage && (
                  <span className="source-pill">SOURCE</span>
                )}
                {draftOutdated.includes(l.code) && (
                  <span className="freshness-badge">Outdated</span>
                )}
                {translationComplete(
                  {
                    translations,
                    plural,
                    outdatedLanguages: draftOutdated,
                  } as TranslationKey,
                  l,
                ) && <Check size={14} className="translation-check" />}
              </div>
              {plural ? (
                <PluralTranslation
                  key={`plural-${l.code}`}
                  locale={l}
                  canChangeStructure={manager}
                  template={readPlural(
                    translations[project.sourceLanguage] ?? "",
                  )}
                  value={translations[l.code] ?? ""}
                  disabled={!manager && l.code === project.sourceLanguage}
                  onChange={(value) =>
                    setTranslations((current) => ({
                      ...current,
                      [l.code]: value,
                    }))
                  }
                />
              ) : (
                <textarea
                  aria-label={l.name}
                  value={translations[l.code] ?? ""}
                  onChange={(e) =>
                    setTranslations((t) => ({ ...t, [l.code]: e.target.value }))
                  }
                  placeholder={
                    l.code === project.sourceLanguage
                      ? "Write your source copy…"
                      : `Add a ${l.name.toLowerCase()} translation…`
                  }
                  lang={l.code}
                  dir="auto"
                  rows={2}
                  maxLength={20000}
                  disabled={!manager && l.code === project.sourceLanguage}
                />
              )}
              {editing?.outdatedLanguages?.includes(l.code) &&
                l.code !== project.sourceLanguage && (
                  <label className="checkbox-label freshness-confirm">
                    <input
                      type="checkbox"
                      checked={confirmed.has(l.code)}
                      disabled={sourceChanged}
                      onChange={(event) =>
                        setConfirmed((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(l.code);
                          else next.delete(l.code);
                          return next;
                        })
                      }
                    />
                    <span>
                      {sourceChanged
                        ? "Save the source change before confirming existing translations."
                        : "Use this translation for the current source"}
                    </span>
                  </label>
                )}
              {editing?.referenceErrors?.[l.code] && (
                <p className="field-warning">
                  {editing.referenceErrors[l.code]}
                </p>
              )}
            </div>
          ))}
          {editing && (
            <p className="edit-metadata">
              Last updated{" "}
              {new Date(editing.updatedAt).toLocaleDateString("en-GB")} by{" "}
              {editing.updatedBy} · Version {editing.version}
            </p>
          )}
          {editing && (
            <KeyHistory
              project={project}
              editing={editing}
              manager={manager}
              onRestored={onRestored}
            />
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
              {error.includes("changed") && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void onReload()}
                >
                  Load latest version
                </button>
              )}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <span className="footer-note">
            <ShieldCheck size={14} />
            {manager
              ? "You can edit all languages."
              : "You can edit target languages."}
          </span>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}{" "}
            {editing ? "Save changes" : "Add key"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
