import { useEffect, useRef } from "react";
import { ChevronDown, ShieldCheck, Upload, Users } from "lucide-react";

export default function AdminMenu({
  manageUsers,
  onWorkspace,
  onImport,
  onFiles,
  onUsers,
}: {
  manageUsers: boolean;
  onWorkspace: () => void;
  onImport: () => void;
  onFiles: () => void;
  onUsers: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target))
        menu.current?.removeAttribute("open");
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  function select(action: () => void) {
    if (menu.current) menu.current.open = false;
    action();
  }

  return (
    <details ref={menu} className="admin-menu">
      <summary className="button admin-menu-trigger">
        <ShieldCheck size={14} />
        <span>Admin</span>
        <ChevronDown size={12} />
      </summary>
      <nav className="admin-menu-panel" aria-label="Administration">
        <span className="admin-menu-label">Workspace administration</span>
        <button onClick={() => select(onWorkspace)}>
          <ShieldCheck size={15} />
          Workspace overview
        </button>
        {manageUsers && (
          <button onClick={() => select(onUsers)}>
            <Users size={15} />
            People &amp; access
          </button>
        )}
        <button onClick={() => select(onFiles)}>
          <Upload size={15} />
          Import translation files
        </button>
        <button onClick={() => select(onImport)}>
          <Upload size={15} />
          Import from Lokalise
        </button>
      </nav>
    </details>
  );
}
