import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Link2,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { Identity, LocalUserView, ProjectSummary, Role } from "../shared";
import { api } from "./api";
import { IconButton, ModalShell } from "./ui";
type UserPage = { items: LocalUserView[]; nextCursor?: string };
type AuditEvent = {
  action: string;
  actor: string;
  target?: string;
  at: string;
};
type LinkResult = { user: LocalUserView; url: string; expiresAt: string };

function ProjectAssignments({
  projects,
  value,
  onChange,
}: {
  projects: ProjectSummary[];
  value: Record<string, Role>;
  onChange: (roles: Record<string, Role>) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(
    () =>
      projects
        .filter((p) =>
          [p.name, p.id].some((t) =>
            t.toLowerCase().includes(search.toLowerCase()),
          ),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects, search],
  );
  return (
    <div className="project-assignments">
      <div className="assignment-heading">
        <strong>Project access</strong>
        <span>{Object.keys(value).length} assigned</span>
      </div>
      <label className="search-field">
        <Search size={14} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a project to assign…"
          aria-label="Search projects to assign"
        />
      </label>
      <div className="assignment-list">
        {filtered.slice(0, 60).map((project) => (
          <div key={project.id}>
            <label>
              <input
                type="checkbox"
                checked={Object.hasOwn(value, project.id)}
                onChange={(e) => {
                  const next = { ...value };
                  if (e.target.checked) next[project.id] = "user";
                  else delete next[project.id];
                  onChange(next);
                }}
              />
              <span className={`project-dot ${project.color}`} />
              <span>
                {project.name}
                <small>{project.id}</small>
              </span>
            </label>
            {Object.hasOwn(value, project.id) && (
              <select
                aria-label={`Role for ${project.name}`}
                value={value[project.id]}
                onChange={(e) =>
                  onChange({ ...value, [project.id]: e.target.value as Role })
                }
              >
                <option value="user">User</option>
                <option value="manager">Manager</option>
                <option value="admin">Project admin</option>
              </select>
            )}
          </div>
        ))}
        {!filtered.length && <p>No projects found.</p>}
      </div>
      {filtered.length > 60 && (
        <p className="assignment-hint">
          Showing 60 of {filtered.length} projects. Search to find another
          project.
        </p>
      )}
    </div>
  );
}
function UserForm({
  user,
  projects,
  busy,
  error,
  onSave,
  onClose,
}: {
  user?: LocalUserView;
  projects: ProjectSummary[];
  busy: boolean;
  error: string;
  onSave: (data: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [workspaceRole, setRole] = useState<"admin" | "member">(
    user?.workspaceRole ?? "member",
  );
  const [status, setStatus] = useState(user?.status ?? "invited");
  const [assignments, setAssignments] = useState<Record<string, Role>>(
    user?.projects ?? {},
  );
  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave({
      name,
      workspaceRole,
      projects: assignments,
      ...(user ? { version: user.version, status } : { email }),
    });
  }
  return (
    <form onSubmit={submit}>
      <fieldset className="form-fieldset" disabled={busy}>
        <div className="dialog-body">
          <div className="field-grid">
            <label className="field-label">
              Full name
              <input
                autoFocus
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="field-label">
              Email address
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!!user}
                autoComplete="off"
              />
            </label>
          </div>
          <div className="field-grid">
            <label className="field-label">
              Workspace role
              <select
                value={workspaceRole}
                onChange={(e) => setRole(e.target.value as "admin" | "member")}
              >
                <option value="member">Member — assigned projects</option>
                <option value="admin">Admin — all projects and users</option>
              </select>
            </label>
            {user && (
              <label className="field-label">
                Account status
                <select
                  value={status}
                  onChange={(e) =>
                    setStatus(e.target.value as LocalUserView["status"])
                  }
                >
                  {user.hasPassword ? (
                    <option value="active">Active</option>
                  ) : (
                    <option value="invited">
                      Invited — activation required
                    </option>
                  )}
                  <option value="disabled">Disabled</option>
                </select>
              </label>
            )}
          </div>
          {workspaceRole === "member" ? (
            <ProjectAssignments
              projects={projects}
              value={assignments}
              onChange={setAssignments}
            />
          ) : (
            <div className="info-note">
              <ShieldCheck size={18} />
              <p>
                Workspace admins can access every project and manage users. Keep
                this role limited to the people who need it.
              </p>
            </div>
          )}
          <p className="user-form-note">
            {user
              ? "Saving changes signs this user out and invalidates outstanding activation/reset links. Disabling an account preserves their translation contributions."
              : "A one-time activation link lets this person set their own password. Share it privately with them."}
          </p>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit">
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Check size={15} />
            )}{" "}
            {user ? "Save changes" : "Create activation link"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
export default function UserManagement({
  projects,
  identity,
  notify,
}: {
  projects: ProjectSummary[];
  identity: Identity;
  notify: (message: string) => void;
}) {
  const [mode, setMode] = useState<"users" | "audit">("users");
  const [page, setPage] = useState<UserPage>({ items: [] });
  const [events, setEvents] = useState<{
    items: AuditEvent[];
    nextCursor?: string;
  }>({ items: [] });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<LocalUserView>();
  const [form, setForm] = useState(false);
  const [link, setLink] = useState<LinkResult>();
  const [revoking, setRevoking] = useState<LocalUserView>();
  const version = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setCursor(undefined);
      setHistory([]);
    }, 220);
    return () => clearTimeout(timer);
  }, [search]);
  async function load() {
    const run = ++version.current;
    setLoading(true);
    try {
      if (mode === "users") {
        const result = await api<UserPage>(
          `users?${new URLSearchParams({ limit: "50", q: query, ...(cursor ? { cursor } : {}) })}`,
        );
        if (run === version.current) setPage(result);
      } else {
        const result = await api<{ items: AuditEvent[]; nextCursor?: string }>(
          `users/audit?${new URLSearchParams(cursor ? { cursor } : {})}`,
        );
        if (run === version.current) setEvents(result);
      }
      if (run === version.current) setError("");
    } catch (error) {
      if (run === version.current) setError((error as Error).message);
    } finally {
      if (run === version.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      version.current++;
    };
  }, [query, cursor, mode]);
  async function save(data: Record<string, unknown>) {
    setBusy(true);
    setFormError("");
    try {
      if (editing) {
        await api(`users/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        });
        notify("User access updated. Existing sessions have been revoked.");
      } else {
        const result = await api<LinkResult>("users", {
          method: "POST",
          body: JSON.stringify(data),
        });
        setLink(result);
      }
      setForm(false);
      setEditing(undefined);
      await load();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function action(user: LocalUserView, type: "link" | "revoke") {
    setBusy(true);
    setError("");
    try {
      const result = await api<LinkResult>(`users/${user.id}/${type}`, {
        method: "POST",
        body: JSON.stringify({ version: user.version }),
      });
      if (type === "link") setLink(result);
      else {
        setRevoking(undefined);
        notify("User sessions revoked.");
      }
      await load();
    } catch (error) {
      setError((error as Error).message);
      setRevoking(undefined);
    } finally {
      setBusy(false);
    }
  }
  const next = mode === "users" ? page.nextCursor : events.nextCursor;
  return (
    <section className="users-page">
      <div className="page-heading">
        <div>
          <h1>People & access</h1>
          <p>Built-in accounts, workspace roles, and project access.</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setEditing(undefined);
            setFormError("");
            setForm(true);
          }}
        >
          <Plus size={16} />
          Add user
        </button>
      </div>
      <nav className="tabs" aria-label="User management sections">
        <button
          className={mode === "users" ? "active" : ""}
          onClick={() => {
            setMode("users");
            setCursor(undefined);
            setHistory([]);
          }}
        >
          <Users size={15} />
          Users
        </button>
        <button
          className={mode === "audit" ? "active" : ""}
          onClick={() => {
            setMode("audit");
            setCursor(undefined);
            setHistory([]);
          }}
        >
          <ShieldCheck size={15} />
          Security events
        </button>
      </nav>
      {error && (
        <div className="error-box" role="alert">
          {error}
          <button className="text-button" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      )}
      {mode === "users" ? (
        <>
          <div className="directory-toolbar">
            <label className="search-field">
              <Search size={15} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search people by name or email…"
                aria-label="Search users"
              />
            </label>
            <span>Admin-managed accounts · 50 per page</span>
          </div>
          <div className="table-scroll">
            <table className="user-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Workspace role</th>
                  <th>Projects</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>
                        {user.name}
                        {identity.sub === `local:${user.id}` && (
                          <span className="you-pill">YOU</span>
                        )}
                      </strong>
                      <span>{user.email}</span>
                    </td>
                    <td>
                      <span className="role-pill">{user.workspaceRole}</span>
                    </td>
                    <td>
                      {user.workspaceRole === "admin"
                        ? "All projects"
                        : `${Object.keys(user.projects).length} assigned`}
                    </td>
                    <td>
                      <span className={`user-status ${user.status}`}>
                        {user.status}
                      </span>
                    </td>
                    <td>
                      <div className="user-actions">
                        <IconButton
                          label={`Edit ${user.name}`}
                          disabled={busy}
                          onClick={() => {
                            setEditing(user);
                            setFormError("");
                            setForm(true);
                          }}
                        >
                          <Pencil size={14} />
                        </IconButton>
                        <IconButton
                          label={`${user.hasPassword ? "Password reset" : "Activation"} link for ${user.name}`}
                          disabled={busy || user.status === "disabled"}
                          onClick={() => void action(user, "link")}
                        >
                          <Link2 size={15} />
                        </IconButton>
                        <IconButton
                          label={`Revoke sessions for ${user.name}`}
                          disabled={busy || user.status !== "active"}
                          onClick={() => setRevoking(user)}
                        >
                          <LogOut size={14} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {loading && (
              <div className="users-loading">
                <Loader2 className="spin" size={18} />
                Loading people…
              </div>
            )}
            {!loading && !page.items.length && (
              <p className="directory-empty">No users match this search.</p>
            )}
          </div>
        </>
      ) : (
        <div className="table-scroll">
          <table className="audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Actor</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {events.items.map((event, i) => (
                <tr key={`${event.at}-${i}`}>
                  <td>{new Date(event.at).toLocaleString("en-GB")}</td>
                  <td>
                    <code>{event.action}</code>
                  </td>
                  <td>
                    <code>
                      {page.items.find((u) => u.id === event.actor)?.name ??
                        event.actor}
                    </code>
                  </td>
                  <td>
                    <code>
                      {page.items.find((u) => u.id === event.target)?.name ??
                        event.target ??
                        "—"}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && (
            <div className="users-loading">
              <Loader2 className="spin" size={18} />
              Loading events…
            </div>
          )}
          {!loading && !events.items.length && (
            <p className="directory-empty">No security events yet.</p>
          )}
        </div>
      )}
      <div className="table-footer">
        <span>
          {mode === "users" ? page.items.length : events.items.length}{" "}
          {mode === "users" ? "people" : "events"} on this page
        </span>
        <div className="pagination">
          <IconButton
            label="Previous users page"
            disabled={!history.length || loading}
            onClick={() => {
              setCursor(history.at(-1) || undefined);
              setHistory((v) => v.slice(0, -1));
            }}
          >
            <ChevronLeft size={15} />
          </IconButton>
          <span>Page {history.length + 1}</span>
          <IconButton
            label="Next users page"
            disabled={!next || loading}
            onClick={() => {
              setHistory((v) => [...v, cursor ?? ""]);
              setCursor(next);
            }}
          >
            <ChevronRight size={15} />
          </IconButton>
        </div>
      </div>
      <div className="info-note">
        <ShieldCheck size={18} />
        <p>
          Access changes and account disabling revoke sessions immediately. Keep
          at least one active workspace admin. Managing users requires a sign-in
          within the last 15 minutes.
        </p>
      </div>
      {form && (
        <ModalShell
          title={editing ? "Edit user access" : "Add a person"}
          subtitle={
            editing
              ? "Update workspace and project permissions."
              : "Create an account and a private activation link."
          }
          onClose={() => {
            if (!busy) setForm(false);
          }}
          wide
        >
          <UserForm
            key={editing?.id ?? "new"}
            user={editing}
            projects={projects}
            busy={busy}
            error={formError}
            onSave={(data) => void save(data)}
            onClose={() => {
              if (!busy) setForm(false);
            }}
          />
        </ModalShell>
      )}
      {link && (
        <ModalShell
          title={
            link.user.hasPassword
              ? "Password reset link"
              : "Activation link ready"
          }
          subtitle={`For ${link.user.name} · ${link.user.email}`}
          onClose={() => setLink(undefined)}
        >
          <div className="dialog-body">
            <p className="user-form-note">
              Share this link privately with the intended person. It is shown
              only here and can be used once.
            </p>
            <label className="field-label">
              One-time link
              <textarea
                readOnly
                rows={3}
                value={link.url}
                aria-label="One-time account link"
              />
            </label>
            <p className="link-expiry">
              Expires {new Date(link.expiresAt).toLocaleString("en-GB")}.
            </p>
            <button
              className="button primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link.url);
                  notify("One-time link copied.");
                } catch {
                  notify("Select and copy the link manually.");
                }
              }}
            >
              <Copy size={15} />
              Copy link
            </button>
          </div>
          <div className="dialog-footer">
            <button className="button" onClick={() => setLink(undefined)}>
              Done
            </button>
          </div>
        </ModalShell>
      )}
      {revoking && (
        <ModalShell
          title={`Sign out ${revoking.name}?`}
          subtitle="All of this person's current sessions will stop working. They can sign in again with their password."
          onClose={() => {
            if (!busy) setRevoking(undefined);
          }}
        >
          <div className="dialog-footer">
            <button
              className="button"
              disabled={busy}
              onClick={() => setRevoking(undefined)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void action(revoking, "revoke")}
            >
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <LogOut size={15} />
              )}
              Sign out everywhere
            </button>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
