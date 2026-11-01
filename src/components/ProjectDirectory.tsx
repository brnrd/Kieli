import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Search,
} from "lucide-react";
import type { ProjectSummary } from "../shared";
import { IconButton } from "./ui";

export default function ProjectDirectory({
  projects,
  onOpen,
}: {
  projects: ProjectSummary[];
  onOpen: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("active");
  const filtered = useMemo(
    () =>
      projects
        .filter(
          (p) =>
            status === "all" ||
            (status === "archived" ? !!p.archivedAt : !p.archivedAt),
        )
        .filter((p) =>
          [p.name, p.id, p.description].some((v) =>
            v.toLowerCase().includes(search.toLowerCase()),
          ),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects, search, status],
  );
  const size = 40;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(page, pages);
  return (
    <section className="project-directory">
      <div className="directory-toolbar">
        <label className="search-field">
          <Search size={15} />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search projects by name or ID…"
            aria-label="Search project directory"
          />
        </label>
        <label className="directory-status">
          Status
          <select
            aria-label="Project status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All projects</option>
          </select>
        </label>
        <span>
          {filtered.length} of {projects.length} projects
        </span>
      </div>
      <div className="table-scroll">
        <table className="project-directory-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Project ID</th>
              <th>Languages</th>
              <th>Your role</th>
              <th>
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice((current - 1) * size, current * size).map((p) => (
              <tr key={p.id}>
                <td>
                  <button
                    onClick={() => onOpen(p.id)}
                    className="directory-project-name"
                  >
                    <span className={`project-dot ${p.color}`} />
                    {p.name}
                    {p.archivedAt && (
                      <span className="role-pill">Archived</span>
                    )}
                  </button>
                </td>
                <td>
                  <code>{p.id}</code>
                </td>
                <td>
                  <div className="directory-locales">
                    <Globe2 size={13} />
                    {p.languages
                      .slice(0, 5)
                      .map((l) => l.code.toUpperCase())
                      .join(" · ")}
                    {p.languages.length > 5 && ` +${p.languages.length - 5}`}
                  </div>
                </td>
                <td>
                  <span className="role-pill">{p.role}</span>
                </td>
                <td>
                  <IconButton
                    label={`Open ${p.name}`}
                    onClick={() => onOpen(p.id)}
                  >
                    <ArrowUpRight size={15} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <p className="directory-empty">
            {!search && status === "active"
              ? "No active projects. Choose Archived to find retired projects."
              : "No projects match this search and status."}
          </p>
        )}
      </div>
      <div className="table-footer">
        <span>
          {filtered.length
            ? `${(current - 1) * size + 1}–${Math.min(current * size, filtered.length)}`
            : 0}{" "}
          of {filtered.length} projects
        </span>
        <div className="pagination">
          <IconButton
            label="Previous project page"
            disabled={current <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={15} />
          </IconButton>
          <span>
            Page {current} of {pages}
          </span>
          <IconButton
            label="Next project page"
            disabled={current >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={15} />
          </IconButton>
        </div>
      </div>
    </section>
  );
}
