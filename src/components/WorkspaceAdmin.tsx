import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import type { Bootstrap, ProjectSummary, WorkspaceOverview } from "../shared";
import { api } from "./api";
import UserManagement from "./UserManagement";
import SsoUserManagement from "./SsoUserManagement";
export default function WorkspaceAdmin({
  bootstrap,
  projects,
  section,
  onSection,
  onProject,
  onImport,
  onFiles,
  notify,
}: {
  bootstrap: Bootstrap;
  projects: ProjectSummary[];
  section: string;
  onSection: (section: string) => void;
  onProject: (id: string) => void;
  onImport: () => void;
  onFiles: () => void;
  notify: (text: string) => void;
}) {
  const [data, setData] = useState<WorkspaceOverview>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (section !== "overview") return;
    let active = true;
    setBusy(true);
    setError("");
    void api<WorkspaceOverview>("workspace/overview")
      .then((value) => {
        if (active) setData(value);
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [section, refresh]);
  const mode = bootstrap.authMode;
  const filtered =
    data?.projects.filter((project) =>
      `${project.name} ${project.id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  const pages = Math.max(1, Math.ceil(filtered.length / 25)),
    currentPage = Math.min(page, pages);
  const totals = data?.totals;
  const percent = totals?.targetSlots
    ? Math.round((totals.current / totals.targetSlots) * 100)
    : 0;
  return (
    <section className="workspace-admin">
      <div className="page-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h1>
            Workspace admin<span className="heading-dot">.</span>
          </h1>
          <p>Projects, people and access in one place.</p>
        </div>
        <ShieldCheck size={28} />
      </div>
      <nav className="tabs" aria-label="Workspace administration sections">
        {[
          ["overview", "Overview"],
          ["people", "People & access"],
          ["security", "Security"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={section === id ? "active" : ""}
            onClick={() => onSection(id!)}
          >
            {label}
          </button>
        ))}
      </nav>
      {section === "people" ? (
        mode === "local" ? (
          <UserManagement
            embedded
            identity={bootstrap.identity}
            projects={projects}
            notify={notify}
          />
        ) : mode === "demo" ? (
          <div className="admin-panel">
            <h2>People &amp; access</h2>
            <p>
              This local demo uses a single administrator. Enable built-in
              accounts, Okta OIDC or SAML to manage your team.
            </p>
            <p>
              Built-in accounts support invitations, project roles, session
              revocation and account disabling. SSO accounts use your identity
              provider for provisioning and group assignments.
            </p>
          </div>
        ) : (
          <SsoUserManagement
            embedded
            identity={bootstrap.identity}
            notify={notify}
          />
        )
      ) : section === "security" ? (
        <div className="admin-panel">
          <h2>Authentication &amp; access</h2>
          <dl className="admin-facts">
            <div>
              <dt>Sign-in method</dt>
              <dd>
                {mode === "demo"
                  ? "Local demo · single administrator"
                  : mode === "local"
                    ? "Built-in accounts"
                    : mode === "saml"
                      ? "SAML SSO"
                      : "Okta OIDC"}
              </dd>
            </div>
            <div>
              <dt>Permissions</dt>
              <dd>
                Workspace admins manage all projects. Project roles limit each
                member's access.
              </dd>
            </div>
            <div>
              <dt>Sessions</dt>
              <dd>
                {mode === "demo"
                  ? "Demo access is limited to loopback outside production."
                  : "Server-side sessions can be revoked through People & access."}
              </dd>
            </div>
            <div>
              <dt>Integration credentials</dt>
              <dd>
                Manage export, source-sync, MCP and mobile delivery credentials
                in each project's Developers tab. They have separate scopes and
                revocation controls.
              </dd>
            </div>
          </dl>
          <button className="button" onClick={() => onSection("people")}>
            Manage people &amp; access <ArrowUpRight size={14} />
          </button>
        </div>
      ) : (
        <>
          <div className="admin-toolbar">
            <h2>Workspace overview</h2>
            <button
              className="button"
              disabled={busy}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw size={14} className={busy ? "spin" : ""} />
              {busy ? "Refreshing…" : "Refresh statistics"}
            </button>
          </div>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          {!data && busy && <p role="status">Loading workspace statistics…</p>}
          {data && (
            <>
              <div className="admin-stats">
                {[
                  ["Projects", data.projects.length],
                  ["Keys", totals!.keys.toLocaleString()],
                  ["Current translations", totals!.current.toLocaleString()],
                  [
                    "Needs attention",
                    (totals!.missing + totals!.outdated).toLocaleString(),
                  ],
                ].map(([label, count]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>
              <p className="muted admin-stat-note">
                {percent}% of target-language values are current ·{" "}
                {totals!.missing.toLocaleString()} missing or incomplete ·{" "}
                {totals!.outdated.toLocaleString()} outdated. Source-only
                projects have no target values. Refreshed{" "}
                {new Date(data.generatedAt).toLocaleTimeString()}.
              </p>
              <div className="admin-toolbar">
                <label className="search-field">
                  <input
                    aria-label="Search workspace projects"
                    placeholder="Find a project…"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(1);
                    }}
                  />
                </label>
                <span className="muted">{filtered.length} projects</span>
              </div>
              <div className="table-scroll">
                <table className="project-directory-table admin-project-table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Keys</th>
                      <th>Languages</th>
                      <th>Current</th>
                      <th>Outdated</th>
                      <th>Missing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered
                      .slice((currentPage - 1) * 25, currentPage * 25)
                      .map((project) => (
                        <tr key={project.id}>
                          <td>
                            <button
                              className="directory-project-name"
                              onClick={() => onProject(project.id)}
                            >
                              {project.name} <ArrowUpRight size={13} />
                            </button>
                            <small className="admin-project-id">
                              {project.id}
                            </small>
                          </td>
                          <td>{project.keys.toLocaleString()}</td>
                          <td>{project.languages}</td>
                          <td>{project.current.toLocaleString()}</td>
                          <td>{project.outdated.toLocaleString()}</td>
                          <td>{project.missing.toLocaleString()}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {!filtered.length && (
                <p className="muted">
                  {query
                    ? "No projects match your search."
                    : "Create your first project or import existing copy to get started."}
                </p>
              )}
              {pages > 1 && (
                <div className="admin-toolbar">
                  <button
                    className="button"
                    disabled={currentPage === 1}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    Previous
                  </button>
                  <span>
                    Page {currentPage} of {pages}
                  </span>
                  <button
                    className="button"
                    disabled={currentPage === pages}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
          <div className="admin-panel">
            <h2>Bring your copy into Keylo</h2>
            <p>
              Preview a new project before importing. Update an existing project
              from its own page.
            </p>
            <div className="heading-actions">
              <button className="button" onClick={onFiles}>
                <Upload size={14} />
                Import translation files
              </button>
              <button className="button" onClick={onImport}>
                <Upload size={14} />
                Import from Lokalise
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
