import type { Project } from "../shared";
import { HttpError } from "./errors";

export function assertProjectEditable(project: Project) {
  if (project.archivedAt)
    throw new HttpError(
      409,
      "This project is archived and read-only. A manager can restore it from project settings.",
    );
}
