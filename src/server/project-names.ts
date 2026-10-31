import { createHash } from "node:crypto";
import { normalizedProjectName, projectConflicts } from "../project-names";
import type { Project } from "../shared";
import type { Store, Change } from "./store";
import { HttpError } from "./errors";
const claimKey = (name: string) =>
  `PROJECT_NAME#${createHash("sha256").update(normalizedProjectName(name)).digest("hex")}`;
export async function projectNameChanges(
  store: Store,
  id: string,
  name: string,
  previous?: Project,
): Promise<Change[]> {
  if (
    previous &&
    normalizedProjectName(previous.name) === normalizedProjectName(name)
  )
    return [];
  // Include legacy projects that predate claims; do not rewrite existing names.
  const conflicts = projectConflicts(
    await store.list<Project>("WORKSPACE", "PROJECT#"),
    name,
    id,
    previous?.id,
  );
  if (conflicts.id)
    throw new HttpError(
      409,
      "A project with this ID already exists. Choose another ID.",
    );
  if (conflicts.name)
    throw new HttpError(
      409,
      "A project with this name already exists. Choose another name.",
    );
  const changes: Change[] = [
    {
      pk: "WORKSPACE",
      sk: claimKey(name),
      value: { version: 1, projectId: id },
    },
  ];
  if (previous) {
    const old = await store.get<{ version: number; projectId: string }>(
      "WORKSPACE",
      claimKey(previous.name),
    );
    if (old?.projectId === id)
      changes.push({
        pk: "WORKSPACE",
        sk: claimKey(previous.name),
        expectedVersion: old.version,
      });
  }
  return changes;
}
