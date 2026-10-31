import { ShieldCheck, Users } from "lucide-react";
import type { AuthMode, ProjectSummary } from "../shared";

export default function AccessInfo({
  mode,
  project,
  onManage,
}: {
  mode: AuthMode;
  project: ProjectSummary;
  onManage?: () => void;
}) {
  return (
    <>
      <span className="eyebrow">PROJECT ACCESS</span>
      <h2>
        {mode === "okta" || mode === "saml"
          ? "Managed by your identity provider."
          : mode === "local"
            ? "Managed in your workspace."
            : "Local demo access."}
      </h2>
      <p>
        {mode === "local"
          ? "Workspace admins assign people to projects and choose their roles. Access changes sign the affected user out immediately."
          : mode === "okta" || mode === "saml"
            ? "Project access comes from your organization’s SSO groups. Role changes take effect when a new session is created, within one hour."
            : "The demo uses a workspace admin identity. Choose built-in accounts, OIDC, or SAML for a real deployment."}
      </p>
      <div className="role-table">
        {[
          {
            role: "Admin",
            group: "keylo-admin",
            text: "Workspace admins manage all projects, users, settings, keys, translations, and export tokens.",
          },
          {
            role: "Manager",
            group: `keylo:${project.id}:manager`,
            text: "Project settings, key creation and deletion, source copy, translations, and export tokens.",
          },
          {
            role: "User",
            group: `keylo:${project.id}:user`,
            text: "Read project copy and edit target translations.",
          },
        ].map((item) => (
          <div key={item.role}>
            <span className="role-pill">{item.role}</span>
            <p>{item.text}</p>
            {(mode === "okta" || mode === "saml") && <code>{item.group}</code>}
          </div>
        ))}
      </div>
      <div className="info-note">
        <ShieldCheck size={18} />
        <p>
          Your role in this project is <strong>{project.role}</strong>.{" "}
          {mode === "local"
            ? "Ask a workspace admin to update your assignments."
            : mode === "okta" || mode === "saml"
              ? "Ask your identity-provider administrator to update group assignments."
              : "The demo has full access."}
        </p>
      </div>
      {mode === "local" && onManage && (
        <button className="button" onClick={onManage}>
          <Users size={15} />
          Manage people & access
        </button>
      )}
    </>
  );
}
