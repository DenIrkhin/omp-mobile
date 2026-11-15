// The projects the dashboard sorts chats into: on the cmux sidebar (cmux-groups.ts) and on the
// phone's Long tasks tab. A folder under the map's root belongs to a project by its folder
// family; the map is `projects` in the config file (config.ts).
import { basename, relative } from "node:path";

export type ProjectMap = {
  /** Folders below it have a project; folders elsewhere have none. */
  root: string;
  /** The project of the root itself and of every folder under it that no listed project claims. */
  otherName: string;
  /**
   * The projects in the order the sidebar and the phone show them. A family also counts when a
   * folder family starts with it plus `-`, so `797vega-wt` (family `vega-wt`) is in the project of `vega`.
   */
  list: { name: string; families: string[] }[];
};

/** Every project, in the order the sidebar and the phone show them: the listed ones, then otherName. */
export function projectNames(map: ProjectMap): string[] {
  return [...map.list.map((project) => project.name), map.otherName];
}

/**
 * The folder family of `folder`: its first path segment under `root` without leading digits
 * (`751orion-web` → `orion-web`), the segment itself when it is all digits, and the
 * root's own name for the root. Null for folders outside `root`.
 */
export function folderFamily(folder: string, root: string): string | null {
  const rel = relative(root, folder);
  if (rel === "") return basename(root);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return null;
  const segment = rel.split("/")[0];
  return segment.replace(/^\d+/, "") || segment;
}

/** The project a folder family belongs to: the first listed project that claims it, else otherName. */
export function familyProject(family: string, map: ProjectMap): string {
  for (const project of map.list) {
    if (project.families.some((name) => family === name || family.startsWith(`${name}-`))) return project.name;
  }
  return map.otherName;
}

/** The project of `folder`: the root and every folder under it have one, folders elsewhere none (null). */
export function projectOf(folder: string, map: ProjectMap): string | null {
  const family = folderFamily(folder, map.root);
  if (family === null) return null;
  return relative(map.root, folder) === "" ? map.otherName : familyProject(family, map);
}
