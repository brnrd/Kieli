import type { Project } from "../shared";
import { HttpError } from "./errors";

export function assertProjectEditable(project: Project) {
  if (project.archivedAt)
    throw new HttpError(
      409,
      "This project is archived and read-only. A manager can restore it from project settings.",
    );
}

export function assertLanguagesEditable(project: Project, codes: string[]) {
  const disabled = project.languages.find(
    (locale) => locale.disabled && codes.includes(locale.code),
  );
  if (disabled)
    throw new HttpError(
      409,
      `Language ${disabled.code} is disabled. Re-enable it in Languages before editing or importing its copy.`,
    );
}
