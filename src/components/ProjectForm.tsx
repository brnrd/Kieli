import { projectConflicts } from "../project-names";
import { useState, type SyntheticEvent } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import type { Project, Locale } from "../shared";
import { LANGUAGES } from "../shared";
import { IconButton, LanguageMark } from "./ui";
import {
  categories,
  PLURAL_CATEGORIES,
  type PluralCategory,
} from "../messages";
export default function ProjectForm({
  project,
  busy,
  error,
  readOnly = false,
  projects = [],
  onSave,
  onCancel,
}: {
  project?: Project;
  projects?: { id: string; name: string }[];
  busy: boolean;
  error: string;
  readOnly?: boolean;
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [id, setId] = useState(project?.id ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [source, setSource] = useState(project?.sourceLanguage ?? "en");
  const [languages, setLanguages] = useState<Locale[]>(
    project?.languages ?? [LANGUAGES[0]!],
  );
  const [color, setColor] = useState(project?.color ?? "sage");
  const [adding, setAdding] = useState("");
  const [customCode, setCustomCode] = useState("");
  const [customName, setCustomName] = useState("");
  const [localError, setLocalError] = useState("");
  const [custom, setCustom] = useState(false);
  const conflicts = projectConflicts(projects, name, id, project?.id);
  function addLanguage() {
    setLocalError("");
    let locale = LANGUAGES.find((l) => l.code === adding);
    if (custom) {
      try {
        const code = Intl.getCanonicalLocales(customCode)[0];
        if (!code || !customName.trim()) throw new Error();
        locale = { code, name: customName.trim() };
      } catch {
        setLocalError("Enter a valid language code and name.");
        return;
      }
    }
    if (locale && !languages.some((l) => l.code === locale!.code))
      setLanguages((l) => [...l, locale!]);
    else {
      setLocalError("Choose a language that is not already in your project.");
      return;
    }
    setAdding("");
    setCustomCode("");
    setCustomName("");
    setCustom(false);
  }
  function submit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (conflicts.name || conflicts.id || busy || readOnly) return;
    onSave({
      id,
      name,
      description,
      sourceLanguage: source,
      languages,
      color,
      ...(project ? { version: project.version } : {}),
    });
  }
  return (
    <form onSubmit={submit} className={project ? "settings-form" : ""}>
      <fieldset className="form-fieldset" disabled={busy || readOnly}>
        <div className="dialog-body">
          <label className="field-label">
            Project name
            <input
              aria-invalid={conflicts.name || undefined}
              aria-describedby={
                conflicts.name ? "project-name-conflict" : undefined
              }
              autoFocus={!project}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!project)
                  setId(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/^-|-$/g, "")
                      .slice(0, 48),
                  );
              }}
              placeholder="e.g. Acme website"
              required
              maxLength={80}
            />
          </label>
          {conflicts.name && (
            <p className="field-error" id="project-name-conflict" role="status">
              A project with this name already exists. Choose another name.
            </p>
          )}
          <label className="field-label">
            Project ID
            <input
              aria-invalid={conflicts.id || undefined}
              aria-describedby={
                conflicts.id ? "project-id-conflict" : undefined
              }
              value={id}
              onChange={(e) => setId(e.target.value)}
              required
              pattern="[a-z0-9][a-z0-9-]{0,47}"
              maxLength={48}
              disabled={!!project}
              className="mono-input"
              placeholder="acme-website"
            />
            <span>Used in API requests, CLI commands, and SSO groups.</span>
          </label>
          {conflicts.id && (
            <p className="field-error" id="project-id-conflict" role="status">
              This project ID is already in use.
            </p>
          )}
          <label className="field-label">
            Description (optional)
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Project purpose and context"
              maxLength={500}
              rows={2}
            />
          </label>
          <div className="field-grid">
            <label className="field-label">
              Source language
              <select
                value={source}
                disabled={!!project}
                onChange={(e) => {
                  setSource(e.target.value);
                  const locale = LANGUAGES.find(
                    (l) => l.code === e.target.value,
                  );
                  if (locale && !languages.some((l) => l.code === locale.code))
                    setLanguages((l) => [...l, locale]);
                }}
              >
                {[
                  ...LANGUAGES,
                  ...languages.filter(
                    (l) => !LANGUAGES.some((k) => k.code === l.code),
                  ),
                ].map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name} ({l.code})
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Project color
              <select value={color} onChange={(e) => setColor(e.target.value)}>
                <option value="sage">Sage</option>
                <option value="violet">Lilac</option>
                <option value="amber">Amber</option>
                <option value="blue">Sky</option>
              </select>
            </label>
          </div>
          <details className="plural-forms-settings">
            <summary>Plural forms per language</summary>
            <p>
              Unicode defaults apply automatically. Override the forms below
              when your application needs a different set. Existing copy is
              retained when a form is hidden.
            </p>
            {languages.map((locale) => (
              <div className="language-plural-settings" key={locale.code}>
                <strong>
                  {locale.name} ({locale.code})
                </strong>
                {(["cardinal", "ordinal"] as const).map((type) => {
                  const field =
                    type === "cardinal" ? "pluralForms" : "ordinalForms";
                  const current = categories(locale, type);
                  return (
                    <fieldset key={type}>
                      <legend>{type}</legend>
                      <div className="plural-category-options">
                        {PLURAL_CATEGORIES.map((form) => (
                          <label key={form}>
                            <input
                              type="checkbox"
                              checked={current.includes(form)}
                              disabled={form === "other"}
                              onChange={() =>
                                setLanguages((all) =>
                                  all.map((item) =>
                                    item.code === locale.code
                                      ? {
                                          ...item,
                                          [field]: PLURAL_CATEGORIES.filter(
                                            (candidate) =>
                                              candidate === form
                                                ? !current.includes(candidate)
                                                : current.includes(candidate),
                                          ) as PluralCategory[],
                                        }
                                      : item,
                                  ),
                                )
                              }
                            />
                            {form}
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          setLanguages((all) =>
                            all.map((item) => {
                              if (item.code !== locale.code) return item;
                              const next = { ...item };
                              delete next[field];
                              return next;
                            }),
                          )
                        }
                      >
                        Use Unicode defaults
                      </button>
                    </fieldset>
                  );
                })}
              </div>
            ))}
          </details>
          <div className="form-divider">
            <span>PROJECT LANGUAGES</span>
            <span>{languages.length} / 30</span>
          </div>
          <div className="locale-list">
            {languages.map((l) => (
              <div key={l.code}>
                <LanguageMark code={l.code} small />
                <strong>{l.name}</strong>
                <span>{l.code}</span>
                {l.code === source ? (
                  <span className="source-pill">SOURCE</span>
                ) : (
                  !project?.languages.some((p) => p.code === l.code) && (
                    <IconButton
                      label={`Remove ${l.name}`}
                      onClick={() =>
                        setLanguages((v) => v.filter((n) => n.code !== l.code))
                      }
                    >
                      <X size={14} />
                    </IconButton>
                  )
                )}
              </div>
            ))}
          </div>
          {languages.length < 30 && (
            <>
              <div className="add-language-row">
                {custom ? (
                  <>
                    <input
                      value={customCode}
                      onChange={(e) => setCustomCode(e.target.value)}
                      placeholder="e.g. en-GB"
                      aria-label="Custom language code"
                      maxLength={35}
                    />
                    <input
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      placeholder="Language name"
                      aria-label="Custom language name"
                      maxLength={60}
                    />
                  </>
                ) : (
                  <select
                    aria-label="Choose a language to add"
                    value={adding}
                    onChange={(e) => setAdding(e.target.value)}
                  >
                    <option value="">Choose a language…</option>
                    {LANGUAGES.filter(
                      (l) => !languages.some((p) => p.code === l.code),
                    ).map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.name} ({l.code})
                      </option>
                    ))}
                  </select>
                )}
                <button type="button" className="button" onClick={addLanguage}>
                  <Plus size={15} />
                  Add
                </button>
              </div>
              <button
                type="button"
                className="text-button custom-locale"
                onClick={() => setCustom(!custom)}
              >
                {custom
                  ? "Choose from common languages"
                  : "Use a custom language code"}
              </button>
            </>
          )}
          {(error || localError) && (
            <div className="error-box" role="alert">
              {error || localError}
            </div>
          )}
          {readOnly && (
            <p className="muted">
              A project manager can update these settings.
            </p>
          )}
        </div>
        {!readOnly && (
          <div className="dialog-footer">
            <button type="button" className="button" onClick={onCancel}>
              Cancel
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={busy || conflicts.name || conflicts.id}
            >
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Check size={16} />
              )}{" "}
              {project ? "Save settings" : "Create project"}
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
