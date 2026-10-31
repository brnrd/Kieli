// Shared by the editor and server; IDs remain case-sensitive ASCII identifiers.
export const normalizedProjectName = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
export function projectConflicts(
  projects: { id: string; name: string }[],
  name: string,
  id: string,
  except?: string,
) {
  const others = projects.filter((project) => project.id !== except);
  const unchanged = projects.some(
    (project) =>
      project.id === except &&
      normalizedProjectName(project.name) === normalizedProjectName(name),
  );
  return {
    name:
      !unchanged &&
      !!name.trim() &&
      others.some(
        (project) =>
          normalizedProjectName(project.name) === normalizedProjectName(name),
      ),
    id: !!id && others.some((project) => project.id === id),
  };
}
