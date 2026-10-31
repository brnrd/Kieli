import { useEffect, useState } from "react";
import { BookOpen, Search } from "lucide-react";
import type { Project } from "../shared";
import type { GlossaryPage } from "../glossary";
import { api } from "./api";
export default function GlossaryLookup({
  project,
  source,
  language,
}: {
  project: Project;
  source: string;
  language: string;
}) {
  const [query, setQuery] = useState(""),
    [page, setPage] = useState<GlossaryPage>(),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setError("");
      void api<GlossaryPage>(`projects/${project.id}/glossary/lookup`, {
        method: "POST",
        body: JSON.stringify({
          ...(query.trim()
            ? { query: query.trim() }
            : { text: source.slice(0, 20000) }),
          ...(language !== "all" && language !== project.sourceLanguage
            ? { language }
            : {}),
          limit: 20,
        }),
      })
        .then((value) => {
          if (active) setPage(value);
        })
        .catch((error) => {
          if (active) setError(error.message);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [project.id, source, query, language]);
  return (
    <details className="glossary-lookup">
      <summary>
        <BookOpen size={14} />
        Glossary{" "}
        <span>
          {page
            ? `${page.total} ${query ? "results" : "matching terms"}`
            : "Lookup terms"}
        </span>
      </summary>
      <div className="glossary-lookup-content">
        <label className="search-field">
          <Search size={13} />
          <input
            type="search"
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            aria-label="Look up a glossary term"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={200}
            placeholder="Search all glossary terms…"
          />
        </label>
        <p className="muted">
          {query
            ? "Search results within this project."
            : "Suggested from the source copy using word and phrase matching."}{" "}
          Terms are guidance; applying wording is your choice.
        </p>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        {page?.items.map((term) => (
          <article className="glossary-lookup-term" key={term.id}>
            <strong lang={project.sourceLanguage} dir="auto">
              {term.source}
            </strong>
            {term.caseSensitive && (
              <span className="glossary-case">Exact case</span>
            )}
            {Object.entries(term.translations)
              .filter(([, value]) => value)
              .map(([code, value]) => (
                <div className="glossary-target" key={code}>
                  <span>{code}</span>
                  <span lang={code} dir="auto">
                    {value}
                  </span>
                </div>
              ))}
            {term.notes && <p>{term.notes}</p>}
          </article>
        ))}
        {page && !page.total && (
          <p className="muted">
            {query
              ? "No terms match this search."
              : "No glossary terms match the current source copy."}
          </p>
        )}
        {page && page.total > page.items.length && (
          <p className="muted">
            Showing the first {page.items.length} results. Narrow your search to
            find more.
          </p>
        )}
        <a
          className="text-button"
          href={`/projects/${project.id}/glossary`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open project glossary in a new tab ↗
        </a>
      </div>
    </details>
  );
}
