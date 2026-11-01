import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Braces,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Code2,
  FolderClosed,
  Globe2,
  KeyRound,
  UserRound,
  Languages,
  LayoutGrid,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type {
  Bootstrap,
  Project,
  TranslationKey,
  KeyPage,
  ProjectStats,
} from "../shared";
import { isComplete } from "../shared";

type Tab =
  | "translations"
  | "languages"
  | "glossary"
  | "developers"
  | "settings"
  | "access";
type Modal =
  | "import"
  | "files"
  | "update-files"
  | "key"
  | "project"
  | "export"
  | "delete"
  | "help"
  | null;
const initials = (name: string) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();

import { api } from "./api";
import { IconButton, ModalShell, Empty, LanguageMark } from "./ui";
import ProjectUpdate from "./ProjectUpdate";
import ProjectForm from "./ProjectForm";
import InlineTranslation from "./InlineTranslation";
import { canEditInline } from "./inline-edit";
import ProjectArchive from "./ProjectArchive";
import ProjectGlossary from "./ProjectGlossary";
import KeyEditor, { type EditorHandle, type EditorFilters } from "./KeyEditor";
import {
  editorDefaults,
  editorPreferenceKey,
  parseEditorPreferences,
  isTypingTarget,
} from "./editor-preferences";
import ExportForm from "./ExportForm";
import Developers from "./Developers";
import ProjectDirectory from "./ProjectDirectory";
import LokaliseImport from "./LokaliseImport";
import WorkspaceAdmin from "./WorkspaceAdmin";
import Account from "./Account";
import AccessInfo from "./AccessInfo";
import Appearance from "./Appearance";
import AdminMenu from "./AdminMenu";
import DeletedKeys from "./DeletedKeys";
import ProjectSnapshots from "./ProjectSnapshots";
import { readPlural, references } from "../messages";
const emptyStats = (): ProjectStats => ({
  totalKeys: 0,
  byLanguage: {},
  coverage: {},
  namespaces: {},
  version: 1,
});
export default function App({
  bootstrap,
  initialPath,
}: {
  bootstrap: Bootstrap;
  initialPath: string;
}) {
  const initialId =
    initialPath.split("/")[1] ?? bootstrap.projects[0]?.id ?? "";
  const [projects, setProjects] = useState(bootstrap.projects);
  const [projectId, setProjectId] = useState(initialId);
  const [overview, setOverview] = useState(!initialPath);
  const [workspacePage, setWorkspacePage] = useState<
    "projects" | "admin" | "account"
  >(
    initialPath === "users" || initialPath.startsWith("admin")
      ? "admin"
      : initialPath === "account"
        ? "account"
        : "projects",
  );
  const [adminSection, setAdminSection] = useState(
    initialPath === "users"
      ? "people"
      : initialPath.split("/")[1] || "overview",
  );
  function workspaceNavigate(
    page: "users" | "account" | "admin",
    section = "overview",
  ) {
    leaveInline(() => {
      const admin = page !== "account";
      const nextSection = page === "users" ? "people" : section;
      setWorkspacePage(admin ? "admin" : "account");
      if (admin) setAdminSection(nextSection);
      setOverview(false);
      setSidebarOpen(false);
      window.history.pushState(
        {},
        "",
        admin
          ? `/admin${nextSection === "overview" ? "" : `/${nextSection}`}`
          : "/account",
      );
    });
  }
  const [tab, setTab] = useState<Tab>(
    (initialPath.split("/")[2] as Tab) || "translations",
  );
  const project = projects.find((p) => p.id === projectId);
  const manager = project?.role !== "user";
  const editable = manager && !project?.archivedAt;
  const [keys, setKeys] = useState<TranslationKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>(editorDefaults.status);
  const [namespace, setNamespace] = useState("all");
  const [focusLanguage, setFocusLanguage] = useState("all");
  const filterLanguage = project?.languages.some(
    (locale) => locale.code === focusLanguage,
  )
    ? focusLanguage
    : "all";
  const [pageSize, setPageSize] = useState(50);
  const [preferencesReady, setPreferencesReady] = useState(false);
  useEffect(() => {
    try {
      const stored = parseEditorPreferences(
        JSON.parse(localStorage.getItem(editorPreferenceKey) ?? "null"),
      );
      setStatus(stored.status);
      setFocusLanguage(stored.language);
      setPageSize(stored.pageSize);
    } catch {
      /* Storage may be unavailable; keep defaults. */
    }
    setPreferencesReady(true);
  }, []);
  useEffect(() => {
    if (!preferencesReady) return;
    try {
      localStorage.setItem(
        editorPreferenceKey,
        JSON.stringify(
          parseEditorPreferences({ status, language: focusLanguage, pageSize }),
        ),
      );
    } catch {
      /* Preferences are optional. */
    }
  }, [preferencesReady, status, focusLanguage, pageSize]);
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState<ProjectStats>(emptyStats);
  const [projectSearch, setProjectSearch] = useState("");
  function resetPage() {
    setPage(1);
    setCursor(undefined);
    setCursorHistory([]);
  }
  function changeStatus(value: string) {
    leaveInline(() => {
      setStatus(value);
      resetPage();
    });
  }
  function changeNamespace(value: string) {
    leaveInline(() => {
      setNamespace(value);
      resetPage();
    });
  }

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visibleLanguages, setVisibleLanguages] = useState<string[]>([]);
  const [languageMenu, setLanguageMenu] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [editing, setEditing] = useState<TranslationKey | null>(null);
  const [inline, setInline] = useState<{
    key: TranslationKey;
    language: string;
  } | null>(null);
  const inlineRef = useRef<EditorHandle>(null);
  function leaveInline(action: () => void) {
    if (inlineRef.current) inlineRef.current.requestLeave(action);
    else action();
  }
  function toggleVisibleLanguage(code: string) {
    const update = () =>
      setVisibleLanguages((current) =>
        current.includes(code)
          ? current.filter((item) => item !== code)
          : [...current, code],
      );
    if (inline?.language === code) leaveInline(update);
    else update();
  }
  const [editorLanguage, setEditorLanguage] = useState<string>();
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const requestVersion = useRef(0);
  const identity = bootstrap.identity;
  const editorRef = useRef<EditorHandle>(null);
  const glossaryRef = useRef<EditorHandle>(null);
  const [editorFilters, setEditorFilters] = useState<EditorFilters>({
    query: "",
    status: "all",
    namespace: "all",
    language: "all",
  });
  const editorOrigin = useRef<{
    element: HTMLElement | null;
    scroll: number;
  } | null>(null);
  const lastPath = useRef(`/${initialPath}`);
  const allowHistory = useRef(false);
  useEffect(() => {
    lastPath.current = window.location.pathname;
  });
  useEffect(() => {
    if (modal || !editorOrigin.current) return;
    const origin = editorOrigin.current;
    editorOrigin.current = null;
    const frame = requestAnimationFrame(() => {
      const target = origin.element?.isConnected
        ? origin.element
        : document.getElementById("key-list-heading");
      target?.focus({ preventScroll: true });
      window.scrollTo(0, origin.scroll);
    });
    return () => cancelAnimationFrame(frame);
  }, [modal]);
  function finishEditorClose() {
    setModal(null);
    setEditing(null);
    setError("");
  }

  function notify(message: string) {
    setToast(message);
  }
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(id);
    }
  }, [toast]);
  function closeModal() {
    if (modal === "key" && editorRef.current) {
      editorRef.current.requestClose();
      return;
    }
    if (!busy) {
      setModal(null);
      setEditing(null);
      setError("");
    }
  }
  function openModal(value: Modal, language?: string) {
    leaveInline(() => {
      if (value === "key") {
        setEditorLanguage(language);
        editorOrigin.current = {
          element:
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null,
          scroll: window.scrollY,
        };
        setEditorFilters({
          query,
          status,
          namespace,
          language: filterLanguage,
        });
      }
      setError("");
      setModal(value);
    });
  }
  function navigate(id: string, nextTab: Tab = "translations") {
    leaveInline(() => {
      setWorkspacePage("projects");
      if (id !== projectId) {
        setKeys([]);
        setLoading(true);
        setSelected(new Set());
        setSearch("");
        setNamespace("all");
        setQuery("");
        setStats(emptyStats());
        resetPage();
      }
      setOverview(false);
      setProjectId(id);
      setTab(nextTab);
      setSidebarOpen(false);
      window.history.pushState(
        {},
        "",
        `/projects/${id}${nextTab === "translations" ? "" : `/${nextTab}`}`,
      );
    });
  }
  useEffect(() => {
    const handler = () => {
      const navigationGuard =
        inlineRef.current ?? editorRef.current ?? glossaryRef.current;
      if (navigationGuard && !allowHistory.current) {
        window.history.pushState({}, "", lastPath.current);
        navigationGuard.requestLeave(() => {
          allowHistory.current = true;
          editorOrigin.current = null;
          finishEditorClose();
          window.history.back();
        });
        return;
      }
      allowHistory.current = false;
      const parts = window.location.pathname.split("/").filter(Boolean);
      if (
        parts[0] === "users" ||
        parts[0] === "admin" ||
        parts[0] === "account"
      ) {
        setWorkspacePage(parts[0] === "account" ? "account" : "admin");
        setAdminSection(
          parts[0] === "users" ? "people" : parts[1] || "overview",
        );
        setOverview(false);
      } else if (parts[0] === "projects" && parts[1]) {
        setWorkspacePage("projects");
        resetPage();
        setProjectId(parts[1]);
        setTab((parts[2] as Tab) || "translations");
        setOverview(false);
      } else {
        setWorkspacePage("projects");
        setOverview(true);
      }
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);
  async function refreshKeys(id = projectId) {
    const version = ++requestVersion.current;
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        q: query,
        status,
        ...(namespace !== "all" ? { namespace } : {}),
        ...(filterLanguage !== "all" ? { language: filterLanguage } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const data = await api<KeyPage>(`projects/${id}/keys?${params}`);
      if (version === requestVersion.current) {
        setKeys(data.items);
        setNextCursor(data.nextCursor);
        setStats(data.stats);
        setLoadError("");
      }
    } catch (e) {
      if (version === requestVersion.current)
        setLoadError((e as Error).message);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!projectId || overview || workspacePage !== "projects") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError("");
    setSelected(new Set());
    void refreshKeys(projectId);
    return () => {
      requestVersion.current++;
    };
  }, [
    projectId,
    query,
    status,
    namespace,
    cursor,
    pageSize,
    filterLanguage,
    overview,
    workspacePage,
  ]);
  useEffect(() => {
    setVisibleLanguages(project?.languages.map((l) => l.code) ?? []);
  }, [projectId, project?.languages.length]);
  useEffect(() => {
    if (inline || search === query) return;
    const timer = setTimeout(() => {
      setQuery(search);
      resetPage();
    }, 220);
    return () => clearTimeout(timer);
  }, [search, inline, query]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        event.defaultPrevented ||
        isTypingTarget(event.target) ||
        inline ||
        modal ||
        overview ||
        workspacePage !== "projects" ||
        tab !== "translations"
      )
        return;
      event.preventDefault();
      setLanguageMenu(false);
      document
        .querySelector<HTMLInputElement>(
          'input[aria-label="Search keys and translations"]',
        )
        ?.focus();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [inline, modal, overview, workspacePage, tab]);
  const pageKeys = keys;
  const completed = project
    ? Object.entries(stats.coverage).reduce(
        (sum, [filled, amount]) =>
          sum +
          (project.languages.every((l) => filled.split(",").includes(l.code))
            ? amount
            : 0),
        0,
      )
    : 0;
  const countedLanguages =
    project?.languages.filter(
      (l) =>
        project.languages.length === 1 || l.code !== project.sourceLanguage,
    ) ?? [];
  const totalTranslations = stats.totalKeys * countedLanguages.length;
  const translated = countedLanguages.reduce(
    (sum, l) => sum + (stats.byLanguage[l.code] ?? 0),
    0,
  );
  const percent = totalTranslations
    ? Math.round((translated / totalTranslations) * 100)
    : 0;
  const languageProgress = (code: string) =>
    stats.totalKeys
      ? Math.round(((stats.byLanguage[code] ?? 0) / stats.totalKeys) * 100)
      : 0;
  const activeLanguages =
    project?.languages.filter((l) => visibleLanguages.includes(l.code)) ?? [];
  const namespaces = Object.keys(stats.namespaces).sort();
  const sidebarProjects = projects
    .filter((p) => !p.archivedAt)
    .filter((p) =>
      [p.name, p.id].some((v) =>
        v.toLowerCase().includes(projectSearch.toLowerCase()),
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  function editKey(key: TranslationKey, language?: string) {
    setEditing(key);
    openModal("key", language);
  }
  function editTranslation(key: TranslationKey, language: string) {
    if (project && canEditInline(project, key, language, manager))
      leaveInline(() => setInline({ key, language }));
    else editKey(key, language);
  }
  async function saveProject(data: Record<string, unknown>, existing = false) {
    setBusy(true);
    setError("");
    try {
      const saved = await api<Project>(
        `projects${existing ? `/${projectId}` : ""}`,
        { method: existing ? "PATCH" : "POST", body: JSON.stringify(data) },
      );
      setProjects((previous) =>
        existing
          ? previous.map((p) =>
              p.id === saved.id ? { ...saved, role: p.role } : p,
            )
          : [...previous, { ...saved, role: "admin" }],
      );
      notify(existing ? "Project settings saved." : "Your project is ready.");
      setModal(null);
      if (!existing) navigate(saved.id);
      else await refreshKeys();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteKeys() {
    setBusy(true);
    setError("");
    const deleted: string[] = [];
    try {
      for (const key of keys.filter((k) => selected.has(k.name))) {
        await api(
          `projects/${projectId}/keys/${encodeURIComponent(key.name)}?version=${key.version}`,
          { method: "DELETE" },
        );
        deleted.push(key.name);
      }
      setModal(null);
      notify(
        `${deleted.length} ${deleted.length === 1 ? "key" : "keys"} deleted.`,
      );
    } catch (e) {
      setError(
        `${deleted.length ? `${deleted.length} keys deleted. ` : ""}${(e as Error).message}`,
      );
    } finally {
      await refreshKeys();
      setSelected(new Set());
      setBusy(false);
    }
  }
  function selectKey(name: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }
  function allProjects() {
    leaveInline(() => {
      setWorkspacePage("projects");
      setOverview(true);
      setSidebarOpen(false);
      window.history.pushState({}, "", "/");
    });
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <button
          className="brand"
          onClick={allProjects}
          aria-label="Keylo projects"
        >
          <img src="/favicon.svg" width="32" height="32" alt="" />
          <span>
            keylo<span className="wordmark-dot">.</span>
          </span>
          <span className="open-source">OPEN SOURCE</span>
        </button>
        <div className="workspace-switch">
          <span className="workspace-avatar">K</span>
          <div>
            <strong>Your workspace</strong>
          </div>
        </div>
        <div className="nav-section-label">WORKSPACE</div>
        <button
          className={`nav-item ${overview && workspacePage === "projects" ? "active" : ""}`}
          onClick={allProjects}
        >
          <LayoutGrid size={17} />
          All projects
          <span className="nav-count">
            {projects.filter((p) => !p.archivedAt).length}
          </span>
        </button>
        <div className="nav-section-label projects-label">
          YOUR PROJECTS
          {identity.admin && (
            <IconButton
              label="Create project"
              onClick={() => openModal("project")}
            >
              <Plus size={15} />
            </IconButton>
          )}
        </div>
        <label className="sidebar-project-search">
          <Search size={13} />
          <input
            aria-label="Search project navigation"
            placeholder="Find a project…"
            value={projectSearch}
            onChange={(e) => setProjectSearch(e.target.value)}
          />
        </label>
        <nav className="project-nav" aria-label="Projects">
          {sidebarProjects.slice(0, 30).map((p) => (
            <button
              key={p.id}
              className={`nav-item project-item ${projectId === p.id && !overview && workspacePage === "projects" ? "active" : ""}`}
              onClick={() => navigate(p.id)}
            >
              <span className={`project-dot ${p.color}`} />
              <span className="project-nav-name">{p.name}</span>
              {projectId === p.id &&
                !overview &&
                workspacePage === "projects" && <ChevronRight size={14} />}
            </button>
          ))}
          {sidebarProjects.length > 30 && (
            <button className="nav-item" onClick={allProjects}>
              View all {sidebarProjects.length} projects{" "}
              <ArrowRight size={13} />
            </button>
          )}
          {identity.admin && (
            <button
              className="nav-item add-project"
              onClick={() => openModal("project")}
            >
              <Plus size={16} />
              New project
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          {identity.admin && (
            <button
              className={`nav-item ${workspacePage === "admin" ? "active" : ""}`}
              onClick={() => workspaceNavigate("admin")}
            >
              <ShieldCheck size={16} />
              Workspace admin
            </button>
          )}
          <button
            className={`nav-item ${workspacePage === "account" ? "active" : ""}`}
            onClick={() => workspaceNavigate("account")}
          >
            <UserRound size={16} />
            Your account
          </button>
          <button
            className="nav-item help-item"
            onClick={() => openModal("help")}
          >
            <CircleHelp size={17} />
            Help
            <ArrowUpRight size={14} />
          </button>
          <Appearance />
          <div className="profile">
            <span className="avatar">{initials(identity.name)}</span>
            <div>
              <strong>{identity.name}</strong>
              <span>{identity.admin ? "Workspace admin" : "Team member"}</span>
            </div>
            {bootstrap.authMode !== "demo" ? (
              <form action="/auth/logout" method="POST">
                <button
                  type="submit"
                  className="icon-button"
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut size={16} />
                </button>
              </form>
            ) : (
              <span className="demo-pill">LOCAL</span>
            )}
          </div>
        </div>
      </aside>
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <IconButton
              label="Toggle navigation"
              className="mobile-menu"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <LayoutGrid size={18} />
            </IconButton>
            <FolderClosed size={15} />
            <button onClick={allProjects}>Projects</button>
            {workspacePage !== "projects" && (
              <>
                <ChevronRight size={13} />
                <span>
                  {workspacePage === "admin"
                    ? "Workspace admin"
                    : "Your account"}
                </span>
              </>
            )}
            {workspacePage === "projects" && !overview && project && (
              <>
                <ChevronRight size={13} />
                <span>{project.name}</span>
              </>
            )}
          </div>
          <div className="topbar-right">
            <span className="workspace-connection">
              <span className="connection-dot" />
              {bootstrap.authMode === "demo"
                ? "Local workspace"
                : bootstrap.authMode === "local"
                  ? "Built-in accounts"
                  : bootstrap.authMode === "saml"
                    ? "SAML SSO"
                    : "Connected with Okta"}
              <span className="version">v0.1</span>
            </span>
            {identity.admin && (
              <AdminMenu
                manageUsers={bootstrap.authMode !== "demo"}
                onWorkspace={() => workspaceNavigate("admin")}
                onImport={() => openModal("import")}
                onFiles={() => openModal("files")}
                onUsers={() => workspaceNavigate("users")}
              />
            )}
          </div>
        </header>
        <main id="main-content" className="main-content">
          {workspacePage === "account" ? (
            <Account
              identity={identity}
              mode={bootstrap.authMode}
              samlLogoutEnabled={bootstrap.samlLogoutEnabled}
              notify={notify}
            />
          ) : workspacePage === "admin" ? (
            identity.admin ? (
              <WorkspaceAdmin
                bootstrap={bootstrap}
                projects={projects}
                section={adminSection}
                onSection={(section) => workspaceNavigate("admin", section)}
                onProject={(id) => navigate(id)}
                onImport={() => openModal("import")}
                onFiles={() => openModal("files")}
                notify={notify}
              />
            ) : (
              <Empty
                title="Access unavailable"
                description="Only workspace admins can manage this workspace."
              />
            )
          ) : overview || !projects.length ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>
                    Projects<span className="heading-dot">.</span>
                  </h1>
                </div>
                {identity.admin && (
                  <div className="heading-actions">
                    <button
                      className="button primary"
                      onClick={() => openModal("project")}
                    >
                      <Plus size={16} />
                      New project
                    </button>
                  </div>
                )}
              </div>
              {projects.length ? (
                <ProjectDirectory
                  projects={projects}
                  onOpen={(id) => navigate(id)}
                />
              ) : (
                <Empty
                  icon={<FolderClosed size={30} />}
                  title="No projects"
                  description={
                    identity.admin
                      ? "Create your first project, choose its languages, and add your product copy."
                      : bootstrap.authMode === "local"
                        ? "You do not have project access yet. Ask a workspace admin to assign you to a project."
                        : "You do not have access to any projects yet. Ask your identity-provider administrator to assign a project group."
                  }
                  action={
                    identity.admin && (
                      <button
                        className="button primary"
                        onClick={() => openModal("project")}
                      >
                        <Plus size={16} />
                        Create a project
                      </button>
                    )
                  }
                />
              )}
            </>
          ) : !project ? (
            <Empty
              title="Project unavailable"
              description="This project does not exist or you do not have access to it."
              action={
                <button className="button" onClick={allProjects}>
                  Back to projects
                </button>
              }
            />
          ) : (
            <>
              {project.archivedAt && (
                <div className="project-archive-banner" role="status">
                  <strong>Archived · Read-only</strong>
                  <span>
                    Existing exports and published mobile releases remain
                    available.
                  </span>
                  {manager && (
                    <button
                      className="button"
                      onClick={() => navigate(projectId, "settings")}
                    >
                      Manage archive
                    </button>
                  )}
                </div>
              )}
              <div className="page-heading project-heading">
                <div className="project-title">
                  <span className={`project-icon ${project.color}`}>
                    <Globe2 size={26} />
                  </span>
                  <div>
                    <div className="project-title-line">
                      <h1>{project.name}</h1>
                      <span className="project-type">PROJECT</span>
                    </div>
                    {project.description && <p>{project.description}</p>}
                  </div>
                </div>
                <div className="heading-actions">
                  <button
                    className="button"
                    onClick={() => openModal("export")}
                  >
                    <ArrowDownToLine size={16} />
                    Export
                  </button>
                  {editable && (
                    <button
                      className="button"
                      onClick={() => openModal("update-files")}
                    >
                      Update from files
                    </button>
                  )}
                  {editable && (
                    <button
                      className="button primary"
                      onClick={() => {
                        setEditing(null);
                        openModal("key");
                      }}
                    >
                      <Plus size={17} />
                      Add key
                    </button>
                  )}
                </div>
              </div>
              <nav className="tabs" aria-label="Project sections">
                {(
                  [
                    { id: "translations", label: "Translations", icon: Braces },
                    { id: "languages", label: "Languages", icon: Languages },
                    { id: "glossary", label: "Glossary", icon: BookOpen },
                    { id: "developers", label: "Developers", icon: Code2 },
                    { id: "settings", label: "Settings", icon: Settings2 },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    className={
                      tab === t.id || (tab === "access" && t.id === "settings")
                        ? "active"
                        : ""
                    }
                    onClick={() => navigate(project.id, t.id)}
                  >
                    <t.icon size={16} />
                    {t.label}
                    {t.id === "translations" && (
                      <span>{stats.totalKeys.toLocaleString()}</span>
                    )}
                  </button>
                ))}
              </nav>
              {loadError && (
                <div className="error-box page-error" role="alert">
                  {loadError}
                  <button
                    className="text-button"
                    onClick={() => {
                      leaveInline(() => {
                        setLoading(true);
                        void refreshKeys();
                      });
                    }}
                  >
                    Try again
                  </button>
                </div>
              )}
              {tab === "translations" && (
                <>
                  <section
                    className="stats-bar"
                    aria-label="Project statistics"
                  >
                    <div className="stat">
                      <span>
                        <KeyRound size={15} />
                        Total keys
                      </span>
                      <div>
                        <strong>
                          {loading ? "—" : stats.totalKeys.toLocaleString()}
                        </strong>
                      </div>
                    </div>
                    <div className="stat">
                      <span>
                        <Languages size={15} />
                        Languages
                      </span>
                      <div>
                        <strong>{project.languages.length}</strong>
                        <small>
                          including{" "}
                          {
                            project.languages.find(
                              (l) => l.code === project.sourceLanguage,
                            )?.name
                          }
                        </small>
                      </div>
                    </div>
                    <div className="stat completion-stat">
                      <span>
                        <CheckCheck size={15} />
                        Current translations
                      </span>
                      <div>
                        <strong>{loading ? "—" : `${percent}%`}</strong>
                        <small>
                          {translated} of {totalTranslations} translations
                        </small>
                      </div>
                      <progress
                        max="100"
                        value={percent}
                        aria-label="Translation completion"
                      />
                    </div>
                    <button
                      className={`stat missing-stat ${status === "incomplete" ? "stat-selected" : ""}`}
                      onClick={() =>
                        changeStatus(
                          status === "incomplete" ? "all" : "incomplete",
                        )
                      }
                    >
                      <span>
                        <span className="status-dot amber-dot" />
                        Needs attention
                        <ArrowUpRight size={14} />
                      </span>
                      <div>
                        <strong>
                          {loading
                            ? "—"
                            : (stats.totalKeys - completed).toLocaleString()}
                        </strong>
                        <small>
                          {stats.outdatedKeys ?? 0}{" "}
                          {stats.outdatedKeys === 1
                            ? "key includes"
                            : "keys include"}{" "}
                          outdated copy
                        </small>
                      </div>
                    </button>
                  </section>
                  <section
                    className="translations-section"
                    aria-label="Translation keys"
                  >
                    <div className="section-title">
                      <div>
                        <h2 id="key-list-heading" tabIndex={-1}>
                          Translation keys
                          <span>{stats.totalKeys.toLocaleString()}</span>
                        </h2>
                      </div>
                    </div>
                    <div className="table-toolbar">
                      <label className="search-field">
                        <Search size={17} />
                        <input
                          value={search}
                          onChange={(e) => {
                            const value = e.target.value;
                            leaveInline(() => setSearch(value));
                          }}
                          placeholder="Find a key or translation…"
                          aria-label="Search keys and translations"
                        />
                        <kbd
                          className="search-shortcut"
                          title="Press / to focus search"
                        >
                          /
                        </kbd>
                        {search && (
                          <IconButton
                            label="Clear search"
                            onClick={() => leaveInline(() => setSearch(""))}
                          >
                            <X size={13} />
                          </IconButton>
                        )}
                      </label>
                      <div className="table-filters">
                        <label className="select-filter">
                          <Languages size={13} />
                          <select
                            aria-label="Focus language"
                            value={filterLanguage}
                            onChange={(event) => {
                              const value = event.target.value;
                              leaveInline(() => {
                                setFocusLanguage(value);
                                resetPage();
                              });
                            }}
                          >
                            <option value="all">All languages</option>
                            {project.languages.map((locale) => (
                              <option value={locale.code} key={locale.code}>
                                {locale.name} ({locale.code})
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={12} />
                        </label>
                        <label className="select-filter">
                          <SlidersHorizontal size={14} />
                          <select
                            aria-label="Filter by completion"
                            value={status}
                            onChange={(e) => changeStatus(e.target.value)}
                          >
                            <option value="all">All statuses</option>
                            <option value="complete">Current</option>
                            <option value="incomplete">Needs attention</option>
                            <option value="outdated">
                              Outdated translations
                            </option>
                            <option value="missing">
                              Missing translations
                            </option>
                          </select>
                          <ChevronDown size={13} />
                        </label>
                        <label className="select-filter namespace-filter">
                          <FolderClosed size={14} />
                          <select
                            aria-label="Filter by namespace"
                            value={namespace}
                            onChange={(e) => changeNamespace(e.target.value)}
                          >
                            <option value="all">All namespaces</option>
                            {namespaces.map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={13} />
                        </label>
                        <div className="language-filter-wrap">
                          <button
                            className={`button filter-button ${languageMenu ? "selected" : ""}`}
                            onClick={() => setLanguageMenu(!languageMenu)}
                            aria-expanded={languageMenu}
                            aria-label={`Visible languages: ${activeLanguages.length} of ${project.languages.length}`}
                          >
                            <Languages size={15} />
                            <span>
                              {activeLanguages.length}{" "}
                              {activeLanguages.length === 1
                                ? "language"
                                : "languages"}
                            </span>
                            <ChevronDown size={13} />
                          </button>
                          {languageMenu && (
                            <>
                              <button
                                className="popover-dismiss"
                                aria-label="Close language menu"
                                onClick={() => setLanguageMenu(false)}
                              />
                              <div className="language-popover">
                                <strong>Visible languages</strong>
                                <p>
                                  Choose which languages to show for each key.
                                </p>
                                {activeLanguages.length <
                                  project.languages.length && (
                                  <button
                                    className="text-button"
                                    onClick={() =>
                                      setVisibleLanguages(
                                        project.languages.map((l) => l.code),
                                      )
                                    }
                                  >
                                    Show all languages
                                  </button>
                                )}
                                {project.languages.map((l) => (
                                  <label key={l.code}>
                                    <input
                                      type="checkbox"
                                      checked={visibleLanguages.includes(
                                        l.code,
                                      )}
                                      disabled={
                                        visibleLanguages.includes(l.code) &&
                                        visibleLanguages.length === 1
                                      }
                                      onChange={() =>
                                        toggleVisibleLanguage(l.code)
                                      }
                                    />
                                    <LanguageMark code={l.code} small />
                                    {l.name}
                                    {l.code === project.sourceLanguage && (
                                      <small>Source</small>
                                    )}
                                  </label>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    {selected.size > 0 && (
                      <div className="selection-bar">
                        <span>
                          {selected.size} {selected.size === 1 ? "key" : "keys"}{" "}
                          selected
                        </span>
                        <button
                          className="text-button"
                          onClick={() => setSelected(new Set())}
                        >
                          Clear selection
                        </button>
                        {editable && (
                          <button
                            className="text-button danger-text"
                            onClick={() => openModal("delete")}
                          >
                            <Trash2 size={14} />
                            Delete selected
                          </button>
                        )}
                      </div>
                    )}
                    <div className="table-scroll">
                      <table className="translation-table">
                        <thead>
                          <tr>
                            <th className="checkbox-column">
                              <input
                                type="checkbox"
                                aria-label="Select all keys on this page"
                                disabled={!!project.archivedAt}
                                checked={
                                  pageKeys.length > 0 &&
                                  pageKeys.every((k) => selected.has(k.name))
                                }
                                onChange={() => {
                                  const all = pageKeys.every((k) =>
                                    selected.has(k.name),
                                  );
                                  setSelected((previous) => {
                                    const next = new Set(previous);
                                    pageKeys.forEach((k) =>
                                      all
                                        ? next.delete(k.name)
                                        : next.add(k.name),
                                    );
                                    return next;
                                  });
                                }}
                              />
                            </th>
                            <th className="key-column" scope="col">
                              Key
                            </th>
                            <th className="translations-heading" scope="col">
                              Translations
                            </th>
                            <th className="row-action-column">
                              <span className="sr-only">
                                {project.archivedAt ? "View key" : "Edit key"}
                              </span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {loading
                            ? Array.from({ length: 6 }, (_, i) => (
                                <tr key={i}>
                                  <td colSpan={4} className="loading-column">
                                    <div className="skeleton-row" />
                                  </td>
                                </tr>
                              ))
                            : pageKeys.map((key) => (
                                <tr
                                  key={key.name}
                                  className={
                                    inline?.key.name === key.name
                                      ? "row-inline-edit"
                                      : selected.has(key.name)
                                        ? "row-selected"
                                        : ""
                                  }
                                >
                                  <td className="checkbox-column">
                                    <input
                                      type="checkbox"
                                      aria-label={`Select ${key.name}`}
                                      disabled={!!project.archivedAt}
                                      checked={selected.has(key.name)}
                                      onChange={() => selectKey(key.name)}
                                    />
                                  </td>
                                  <td className="key-column">
                                    <button
                                      className="key-name"
                                      onClick={() => editKey(key)}
                                    >
                                      {key.name}
                                    </button>
                                    <div className="key-meta">
                                      {key.namespace &&
                                        key.namespace !== "general" && (
                                          <span className="namespace-tag">
                                            {key.namespace}
                                          </span>
                                        )}
                                      {key.tags.slice(0, 1).map((tag) => (
                                        <span className="key-tag" key={tag}>
                                          {tag}
                                        </span>
                                      ))}
                                    </div>
                                    {!isComplete(key, project) && (
                                      <span
                                        className={`key-status status-badge ${key.outdatedLanguages?.length ? "outdated" : "missing"}`}
                                      >
                                        <span />
                                        {key.outdatedLanguages?.length
                                          ? "Outdated"
                                          : "Missing"}
                                      </span>
                                    )}
                                  </td>
                                  <td className="translations-column">
                                    <div className="translation-stack">
                                      {activeLanguages.map((l) => (
                                        <div
                                          key={l.code}
                                          className={`translation-cell ${l.code === project.sourceLanguage ? "source-cell" : ""}`}
                                        >
                                          <div className="translation-language">
                                            <LanguageMark code={l.code} small />
                                            <span>{l.name}</span>
                                            {l.code ===
                                              project.sourceLanguage && (
                                              <span className="source-pill">
                                                SOURCE
                                              </span>
                                            )}
                                            {key.outdatedLanguages?.includes(
                                              l.code,
                                            ) && (
                                              <span className="freshness-badge">
                                                Outdated
                                              </span>
                                            )}
                                          </div>
                                          {inline?.key.name === key.name &&
                                          inline.language === l.code ? (
                                            <InlineTranslation
                                              ref={inlineRef}
                                              project={project}
                                              entry={inline.key}
                                              language={inline.language}
                                              onClose={() => setInline(null)}
                                              onSaved={() => refreshKeys()}
                                              onFullEditor={(latest) =>
                                                editKey(latest, l.code)
                                              }
                                              notify={notify}
                                            />
                                          ) : (
                                            <button
                                              className="translation-value"
                                              onClick={() =>
                                                editTranslation(key, l.code)
                                              }
                                              aria-label={`${project.archivedAt ? "View" : "Edit"} ${l.name} translation for ${key.name}`}
                                              lang={l.code}
                                              dir="auto"
                                            >
                                              {(key.resolvedTranslations ??
                                                key.translations)[
                                                l.code
                                              ]?.trim() ? (
                                                key.plural &&
                                                readPlural(
                                                  (key.resolvedTranslations ??
                                                    key.translations)[l.code]!,
                                                ) ? (
                                                  <span className="plural-copy">
                                                    {Object.entries(
                                                      readPlural(
                                                        (key.resolvedTranslations ??
                                                          key.translations)[
                                                          l.code
                                                        ]!,
                                                      )!.forms,
                                                    ).map(([form, text]) => (
                                                      <span key={form}>
                                                        <small>{form}</small>
                                                        <span>
                                                          {text || (
                                                            <em>
                                                              Add translation
                                                            </em>
                                                          )}
                                                        </span>
                                                      </span>
                                                    ))}
                                                  </span>
                                                ) : (
                                                  (key.resolvedTranslations ??
                                                    key.translations)[l.code]
                                                )
                                              ) : (
                                                <span className="missing-copy">
                                                  {!project.archivedAt && (
                                                    <Plus size={12} />
                                                  )}
                                                  {project.archivedAt
                                                    ? "Missing translation"
                                                    : "Add translation"}
                                                </span>
                                              )}
                                            </button>
                                          )}
                                          {references(
                                            key.translations[l.code] ?? "",
                                          ).length > 0 && (
                                            <span
                                              className="reference-indicator"
                                              title={key.translations[l.code]}
                                            >
                                              Linked copy
                                            </span>
                                          )}
                                          {key.referenceErrors?.[l.code] && (
                                            <span className="field-warning">
                                              {key.referenceErrors[l.code]}
                                            </span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="row-action-column">
                                    <IconButton
                                      label={`${project.archivedAt ? "View" : "Open full editor for"} ${key.name}`}
                                      onClick={() => editKey(key)}
                                    >
                                      <Pencil size={15} />
                                    </IconButton>
                                  </td>
                                </tr>
                              ))}
                        </tbody>
                      </table>
                      {!loading && !keys.length && (
                        <Empty
                          icon={
                            search || status !== "all" ? (
                              <Search size={28} />
                            ) : (
                              <Braces size={28} />
                            )
                          }
                          title={
                            stats.totalKeys ? "No matching keys" : "No keys yet"
                          }
                          description={
                            stats.totalKeys
                              ? "Try another search or clear your filters."
                              : "Add your first key and its translations to get things moving."
                          }
                          action={
                            stats.totalKeys ? (
                              <button
                                className="button"
                                onClick={() => {
                                  setSearch("");
                                  changeStatus("all");
                                  changeNamespace("all");
                                }}
                              >
                                Clear filters
                              </button>
                            ) : (
                              editable && (
                                <button
                                  className="button primary"
                                  onClick={() => openModal("key")}
                                >
                                  <Plus size={16} />
                                  Add your first key
                                </button>
                              )
                            )
                          }
                        />
                      )}
                    </div>
                    <div className="table-footer">
                      <span>
                        {keys.length
                          ? `${(page - 1) * pageSize + 1}–${(page - 1) * pageSize + keys.length}`
                          : 0}{" "}
                        displayed · {stats.totalKeys.toLocaleString()} total
                        keys
                      </span>
                      <div className="pagination">
                        <label className="page-size-label">
                          Rows{" "}
                          <select
                            aria-label="Rows per page"
                            value={pageSize}
                            onChange={(e) => {
                              const size = Number(e.target.value);
                              leaveInline(() => {
                                setPageSize(size);
                                resetPage();
                              });
                            }}
                          >
                            <option value={25}>25</option>
                            <option value={50}>50</option>
                            <option value={100}>100</option>
                          </select>
                        </label>
                        <IconButton
                          label="Previous page"
                          disabled={page <= 1 || loading}
                          onClick={() => {
                            leaveInline(() => {
                              setCursor(cursorHistory.at(-1) || undefined);
                              setCursorHistory((h) => h.slice(0, -1));
                              setPage((p) => p - 1);
                            });
                          }}
                        >
                          <ChevronLeft size={16} />
                        </IconButton>
                        <span>
                          Page <strong>{page}</strong>
                        </span>
                        <IconButton
                          label="Next page"
                          disabled={!nextCursor || loading}
                          onClick={() => {
                            leaveInline(() => {
                              setCursorHistory((h) => [...h, cursor ?? ""]);
                              setCursor(nextCursor);
                              setPage((p) => p + 1);
                            });
                          }}
                        >
                          <ChevronRight size={16} />
                        </IconButton>
                      </div>
                    </div>
                  </section>
                </>
              )}
              {tab === "languages" && (
                <>
                  <div className="section-title standalone">
                    <div>
                      <h2>Project languages</h2>
                      <p>Manage the languages your project speaks.</p>
                    </div>
                    {editable && (
                      <button
                        className="button"
                        onClick={() => navigate(projectId, "settings")}
                      >
                        <Plus size={16} />
                        Add a language
                      </button>
                    )}
                  </div>
                  <div className="language-cards">
                    {project.languages.map((l) => (
                      <div className="language-card" key={l.code}>
                        <div className="language-card-top">
                          <LanguageMark code={l.code} />
                          <div>
                            <h3>{l.name}</h3>
                            <span>{l.code}</span>
                          </div>
                          {l.code === project.sourceLanguage && (
                            <span className="source-pill">SOURCE</span>
                          )}
                        </div>
                        <div className="language-progress">
                          <strong>
                            {languageProgress(l.code)}
                            <span>%</span>
                          </strong>
                          <span>
                            {stats.byLanguage[l.code] ?? 0} of{" "}
                            {stats.totalKeys.toLocaleString()} keys
                          </span>
                        </div>
                        <progress value={languageProgress(l.code)} max="100" />
                        <button
                          className="text-button"
                          onClick={() => {
                            navigate(projectId);
                            setVisibleLanguages(
                              [project.sourceLanguage, l.code].filter(
                                (v, i, a) => a.indexOf(v) === i,
                              ),
                            );
                          }}
                        >
                          View translations
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="info-note">
                    <Languages size={19} />
                    <p>
                      Your source language is{" "}
                      <strong>
                        {
                          project.languages.find(
                            (l) => l.code === project.sourceLanguage,
                          )?.name
                        }
                      </strong>
                      . New languages start with empty translations.
                    </p>
                  </div>
                </>
              )}
              {tab === "glossary" && (
                <ProjectGlossary
                  key={project.id}
                  project={project}
                  manager={editable}
                  navigationRef={glossaryRef}
                  notify={notify}
                />
              )}
              {tab === "developers" && (
                <Developers
                  authMode={bootstrap.authMode}
                  project={project}
                  manager={manager}
                  notify={notify}
                />
              )}
              {(tab === "settings" || tab === "access") && (
                <div className="settings-layout">
                  <nav className="settings-nav" aria-label="Settings sections">
                    <button
                      className={tab === "settings" ? "active" : ""}
                      onClick={() => navigate(projectId, "settings")}
                    >
                      <Settings2 size={16} />
                      General
                    </button>
                    <button
                      className={tab === "access" ? "active" : ""}
                      onClick={() => navigate(projectId, "access")}
                    >
                      <ShieldCheck size={16} />
                      Access & roles
                    </button>
                  </nav>
                  <div className="settings-panel">
                    {tab === "access" ? (
                      <>
                        <AccessInfo
                          mode={bootstrap.authMode}
                          project={project}
                          onManage={
                            identity.admin
                              ? () => workspaceNavigate("users")
                              : undefined
                          }
                        />
                      </>
                    ) : (
                      <>
                        <h2>Project settings</h2>
                        <p>
                          The basics, and the languages that bring them to life.
                        </p>
                        <ProjectForm
                          projects={projects}
                          project={project}
                          busy={busy}
                          error={error}
                          readOnly={!editable}
                          onSave={(data) => void saveProject(data, true)}
                          onCancel={() => navigate(projectId)}
                        />
                        {manager && (
                          <ProjectArchive
                            project={project}
                            onChanged={(saved) => {
                              setProjects((current) =>
                                current.map((item) =>
                                  item.id === saved.id
                                    ? { ...saved, role: item.role }
                                    : item,
                                ),
                              );
                              setSelected(new Set());
                              notify(
                                saved.archivedAt
                                  ? "Project archived."
                                  : "Project restored.",
                              );
                            }}
                          />
                        )}
                        {manager && (
                          <DeletedKeys project={project} notify={notify} />
                        )}
                        {manager && (
                          <ProjectSnapshots
                            project={project}
                            notify={notify}
                            onProject={(saved) =>
                              setProjects((current) =>
                                current.map((item) =>
                                  item.id === saved.id
                                    ? { ...saved, role: item.role }
                                    : item,
                                ),
                              )
                            }
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
          <IconButton label="Dismiss notification" onClick={() => setToast("")}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {identity.admin && (modal === "import" || modal === "files") && (
        <ModalShell
          title={
            modal === "import"
              ? "Import from Lokalise"
              : "Import translation files"
          }
          subtitle="Bring a project and its translations. Existing projects stay untouched."
          onClose={closeModal}
          wide
        >
          <LokaliseImport
            kind={modal === "import" ? "lokalise" : "files"}
            onBusyChange={setBusy}
            onCancel={closeModal}
            onComplete={(saved) => {
              setProjects((p) => [
                ...p.filter((v) => v.id !== saved.id),
                { ...saved, role: "admin" },
              ]);
              setBusy(false);
              setModal(null);
              navigate(saved.id);
              notify(
                modal === "import"
                  ? "Project imported from Lokalise."
                  : "Translation files imported.",
              );
            }}
          />
        </ModalShell>
      )}
      {modal === "update-files" && project && editable && (
        <ModalShell
          title="Update project from files"
          subtitle={project.name}
          onClose={closeModal}
          wide
        >
          <ProjectUpdate
            project={project}
            onBusyChange={setBusy}
            onCancel={closeModal}
            onComplete={async () => {
              await refreshKeys();
              setBusy(false);
              setModal(null);
              notify("Project files updated.");
            }}
          />
        </ModalShell>
      )}
      {modal === "key" && project && (
        <ModalShell
          className="key-editor-dialog"
          title={
            project.archivedAt ? "View key" : editing ? "Edit key" : "Add key"
          }
          onClose={closeModal}
          wide
        >
          <KeyEditor
            ref={editorRef}
            project={project}
            initial={editing}
            manager={editable}
            filters={editorFilters}
            initialLanguage={editorLanguage}
            onSaved={() => refreshKeys()}
            onClose={finishEditorClose}
            onBusyChange={setBusy}
            notify={notify}
          />
        </ModalShell>
      )}
      {modal === "project" && (
        <ModalShell title="Create project" onClose={closeModal}>
          <ProjectForm
            projects={projects}
            busy={busy}
            error={error}
            onSave={(data) => void saveProject(data)}
            onCancel={closeModal}
          />
        </ModalShell>
      )}
      {modal === "export" && project && (
        <ModalShell title="Export translations" onClose={closeModal}>
          <ExportForm project={project} onClose={closeModal} notify={notify} />
        </ModalShell>
      )}
      {modal === "delete" && (
        <ModalShell
          title={`Delete ${selected.size} ${selected.size === 1 ? "key" : "keys"}?`}
          subtitle="Keys and their translations can be restored from Settings → Deleted keys for 30 days."
          onClose={closeModal}
        >
          <div className="dialog-body">
            <div className="delete-key-list">
              {[...selected].map((name) => (
                <code key={name}>{name}</code>
              ))}
            </div>
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
          </div>
          <div className="dialog-footer">
            <button className="button" disabled={busy} onClick={closeModal}>
              Keep keys
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void deleteKeys()}
            >
              {busy ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Trash2 size={16} />
              )}
              Delete keys
            </button>
          </div>
        </ModalShell>
      )}
      {modal === "help" && (
        <ModalShell title="Help" onClose={closeModal}>
          <div className="dialog-body help-content">
            <div>
              <Braces />
              <h3>Keys</h3>
              <p>
                Use stable names like <code>home.hero.title</code>. Developers
                use these names to retrieve translations.
              </p>
            </div>
            <div>
              <Languages />
              <h3>Languages</h3>
              <p>
                Set a source language and add your target languages. Click any
                translation to edit it. Empty translations stay visible as
                missing.
              </p>
            </div>
            <div>
              <Terminal />
              <h3>Export and CLI</h3>
              <p>
                Export flat or nested JSON. Use the CLI with a project-scoped
                token to pull locale files directly into your repository.
              </p>
            </div>
            <div className="info-note">
              <BookOpen size={18} />
              <p>
                Setup, API, and AWS deployment instructions live in the
                repository's README and docs directory.
              </p>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
