import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import type { Project } from "../shared";
import type {
  MemoryIndexStatus,
  MemoryPage,
  MemorySuggestion,
} from "../translation-memory";
import { api } from "./api";

export default function TranslationMemory({
  project,
  source,
  plural,
  focusLanguage,
  translations,
  manager,
  onApply,
}: {
  project: Project;
  source: string;
  plural: boolean;
  focusLanguage: string;
  translations: Record<string, string>;
  manager: boolean;
  onApply: (language: string, text: string) => void;
}) {
  const targets = project.languages.filter(
    (locale) => locale.code !== project.sourceLanguage,
  );
  const preferred =
    targets.find((locale) => locale.code === focusLanguage)?.code ??
    targets[0]?.code ??
    "";
  const [language, setLanguage] = useState(preferred),
    [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string>(),
    [back, setBack] = useState<(string | undefined)[]>([]);
  const [page, setPage] = useState<{ scope: string; value: MemoryPage }>();
  const [pending, setPending] = useState<{
    scope: string;
    suggestion: MemorySuggestion;
  }>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [index, setIndex] = useState<MemoryIndexStatus>(),
    [indexing, setIndexing] = useState(false);
  const [indexError, setIndexError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const sequence = useRef(0),
    indexingRef = useRef(false);
  const scope = JSON.stringify([project.id, source, plural, language]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    setLanguage(preferred);
  }, [preferred]);
  useEffect(() => {
    setCursor(undefined);
    setBack([]);
    setPending(undefined);
  }, [scope]);
  useEffect(
    () => () => {
      indexingRef.current = false;
      sequence.current++;
    },
    [],
  );
  useEffect(() => {
    const seq = ++sequence.current;
    if (!open || !source.trim() || !language) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api<MemoryPage>(`projects/${project.id}/translation-memory`, {
        method: "POST",
        body: JSON.stringify({ source, plural, language, cursor }),
      })
        .then((value) => {
          if (seq !== sequence.current || currentScope.current !== scope)
            return;
          setPage({ scope, value });
          setIndex(value.index);
        })
        .catch((error) => {
          if (seq === sequence.current) setError(error.message);
        })
        .finally(() => {
          if (seq === sequence.current) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      sequence.current++;
    };
  }, [scope, open, cursor, refresh]);
  async function prepare() {
    indexingRef.current = true;
    setIndexing(true);
    setIndexError("");
    try {
      while (indexingRef.current) {
        const status = await api<MemoryIndexStatus>(
          `projects/${project.id}/translation-memory/index`,
          { method: "POST", body: "{}" },
        );
        if (!indexingRef.current) return;
        setIndex(status);
        if (status.done) {
          setRefresh((value) => value + 1);
          break;
        }
      }
    } catch (error) {
      if (indexingRef.current) setIndexError((error as Error).message);
    } finally {
      indexingRef.current = false;
      setIndexing(false);
    }
  }
  const result = page?.scope === scope ? page.value : undefined;
  function apply(suggestion: MemorySuggestion) {
    if (currentScope.current !== scope || loading) return;
    if (
      translations[language]?.trim() &&
      translations[language] !== suggestion.text
    ) {
      setPending({ scope, suggestion });
      return;
    }
    onApply(language, suggestion.text);
    setPending(undefined);
  }
  return (
    <details
      className="glossary-lookup memory-lookup"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <History size={14} />
        Previous translations <span>Exact source matches</span>
      </summary>
      <div className="glossary-lookup-content">
        <p>
          Reuse wording from this project's history. Applying changes only your
          draft; save when ready.
        </p>
        <label className="memory-language">
          Target language
          <select
            aria-label="Previous translations target language"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            {targets.map((locale) => (
              <option key={locale.code} value={locale.code}>
                {locale.name} ({locale.code})
              </option>
            ))}
          </select>
        </label>
        {!source.trim() && <p>Write source copy to find exact matches.</p>}
        {loading && <p role="status">Finding previous translations…</p>}
        {error && (
          <p className="field-warning" role="alert">
            {error}
          </p>
        )}
        {!loading && result && (
          <>
            {!result.items.length && (
              <p className="muted">
                No eligible translations on this history page.
                {result.nextCursor ? " Continue to search older records." : ""}
              </p>
            )}
            <div className="memory-suggestions">
              {result.items.map((suggestion) => (
                <article className="memory-suggestion" key={suggestion.id}>
                  <p className="memory-copy" lang={language} dir="auto">
                    {suggestion.text}
                  </p>
                  <p className="memory-origin">
                    <strong>{suggestion.keyName}</strong> · v
                    {suggestion.keyVersion} ·{" "}
                    {new Date(suggestion.savedAt).toLocaleDateString("en-GB")} ·{" "}
                    {suggestion.savedBy}
                    <br />
                    Recorded via {suggestion.origin} · {suggestion.side} edit
                  </p>
                  <button
                    type="button"
                    className="button"
                    onClick={() => apply(suggestion)}
                    disabled={translations[language] === suggestion.text}
                  >
                    Use this translation
                  </button>
                  {pending?.scope === scope &&
                    pending.suggestion.id === suggestion.id && (
                      <div
                        className="memory-confirm"
                        role="group"
                        aria-label="Replace draft translation"
                      >
                        <p>
                          This replaces your current {language} draft. Nothing
                          is saved yet.
                        </p>
                        <button
                          className="button"
                          type="button"
                          onClick={() => setPending(undefined)}
                        >
                          Keep draft
                        </button>{" "}
                        <button
                          className="button primary"
                          type="button"
                          onClick={() => {
                            onApply(language, suggestion.text);
                            setPending(undefined);
                          }}
                        >
                          Replace draft translation
                        </button>
                      </div>
                    )}
                </article>
              ))}
            </div>
            <div className="memory-pagination">
              <button
                className="text-button"
                type="button"
                disabled={!back.length}
                onClick={() => {
                  setCursor(back.at(-1));
                  setBack((value) => value.slice(0, -1));
                  setPending(undefined);
                }}
              >
                Newer history
              </button>
              <button
                className="text-button"
                type="button"
                disabled={!result.nextCursor}
                onClick={() => {
                  setBack((value) => [...value, cursor]);
                  setCursor(result.nextCursor);
                  setPending(undefined);
                }}
              >
                Older history
              </button>
            </div>
          </>
        )}
        {manager && index && !index.done && (
          <div className="memory-index">
            <p>
              New edits are indexed automatically. Include history recorded
              before this feature for more suggestions. {index.scanned} records
              checked.
            </p>
            {indexing ? (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  indexingRef.current = false;
                }}
              >
                Pause after current batch
              </button>
            ) : (
              <button
                type="button"
                className="text-button"
                onClick={() => void prepare()}
              >
                Include older history
              </button>
            )}
            {indexError && (
              <p role="alert" className="field-warning">
                {indexError} You can resume without changing translations.
              </p>
            )}
          </div>
        )}
        {!manager && index && !index.done && (
          <p className="muted">
            A project manager can include history recorded before this feature.
          </p>
        )}
      </div>
    </details>
  );
}
