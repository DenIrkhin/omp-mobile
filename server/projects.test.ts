import { describe, expect, it } from "bun:test";
import { familyProject, folderFamily, type ProjectMap, projectNames, projectOf } from "./projects";

const ROOT = "/Users/you/dev";
const MAP: ProjectMap = {
  root: ROOT,
  otherName: "dev",
  list: [
    { name: "orion", families: ["orion-web"] },
    { name: "vega", families: ["vega"] },
    { name: "lyra", families: ["lyra"] },
    { name: "nova", families: ["nova"] },
    { name: "atlas", families: ["atlas"] },
  ],
};

describe("folderFamily", () => {
  it("strips the leading digits of the first folder under the root", () => {
    expect(folderFamily(`${ROOT}/751orion-web`, ROOT)).toBe("orion-web");
    expect(folderFamily(`${ROOT}/797vega`, ROOT)).toBe("vega");
    expect(folderFamily(`${ROOT}/791lyra`, ROOT)).toBe("lyra");
    expect(folderFamily(`${ROOT}/005nova`, ROOT)).toBe("nova");
    expect(folderFamily(`${ROOT}/753orion-web/packages/web`, ROOT)).toBe("orion-web");
    expect(folderFamily(`${ROOT}/omp-sessions`, ROOT)).toBe("omp-sessions");
  });

  it("keeps an all-digit folder name and names the root after itself", () => {
    expect(folderFamily(`${ROOT}/2024`, ROOT)).toBe("2024");
    expect(folderFamily(ROOT, ROOT)).toBe("dev");
    expect(folderFamily(`${ROOT}/`, ROOT)).toBe("dev");
  });

  it("gives folders outside the root no family", () => {
    expect(folderFamily("/Users/you/dev2/751x", ROOT)).toBeNull();
    expect(folderFamily("/Users/you", ROOT)).toBeNull();
    expect(folderFamily("/tmp/751orion-web", ROOT)).toBeNull();
  });
});

describe("projectOf", () => {
  it("lists the projects in sidebar order", () => {
    expect(projectNames(MAP)).toEqual(["orion", "vega", "lyra", "nova", "atlas", "dev"]);
  });

  it("maps the folder families to their projects", () => {
    expect(projectOf(`${ROOT}/751orion-web`, MAP)).toBe("orion");
    expect(projectOf(`${ROOT}/775orion-web/packages/web`, MAP)).toBe("orion");
    expect(projectOf(`${ROOT}/795vega`, MAP)).toBe("vega");
    expect(projectOf(`${ROOT}/799vega`, MAP)).toBe("vega");
    expect(projectOf(`${ROOT}/797vega-wt`, MAP)).toBe("vega");
    expect(projectOf(`${ROOT}/791lyra`, MAP)).toBe("lyra");
    expect(projectOf(`${ROOT}/791lyra/apps/bank`, MAP)).toBe("lyra");
    expect(projectOf(`${ROOT}/005nova`, MAP)).toBe("nova");
    expect(projectOf(`${ROOT}/005nova/009onedrive-backup`, MAP)).toBe("nova");
    expect(projectOf(`${ROOT}/725atlas`, MAP)).toBe("atlas");
    expect(projectOf(`${ROOT}/724atlas-nightly`, MAP)).toBe("atlas");
  });

  it("puts the root and every other folder under it in dev", () => {
    expect(projectOf(ROOT, MAP)).toBe("dev");
    expect(projectOf(`${ROOT}/`, MAP)).toBe("dev");
    for (const folder of ["500mono", "501agent-config", "503infra", "503infra-log-watch", "792acme.io", "800google_workspace_mcp", "solidity-sandbox", "2024"]) {
      expect(projectOf(`${ROOT}/${folder}`, MAP)).toBe("dev");
    }
    // Only a whole family name, or one followed by `-`, counts.
    expect(projectOf(`${ROOT}/790vegax`, MAP)).toBe("dev");
    expect(projectOf(`${ROOT}/700nova2`, MAP)).toBe("dev");
  });

  it("gives folders outside the root no project", () => {
    expect(projectOf("/tmp/751orion-web", MAP)).toBeNull();
    expect(projectOf("/Users/you/dev2/797vega", MAP)).toBeNull();
    expect(projectOf("/Users/you", MAP)).toBeNull();
  });

  it("maps a family name the same way, whatever the root", () => {
    expect(familyProject("orion-web", MAP)).toBe("orion");
    expect(familyProject("lyra", MAP)).toBe("lyra");
    expect(familyProject("vega-wt", MAP)).toBe("vega");
    expect(familyProject("nova", MAP)).toBe("nova");
    expect(familyProject("dev", MAP)).toBe("dev");
    expect(familyProject("mono", MAP)).toBe("dev");
    expect(projectOf("/tmp/zz-root/797vega-wt", { ...MAP, root: "/tmp/zz-root" })).toBe("vega");
    expect(projectOf("/tmp/zz-root/791lyra", { ...MAP, root: "/tmp/zz-root" })).toBe("lyra");
    expect(projectOf("/tmp/zz-root", { ...MAP, root: "/tmp/zz-root" })).toBe("dev");
  });

  it("puts every folder under the root in otherName when the map lists no project", () => {
    const empty: ProjectMap = { root: "/tmp/zz-root", otherName: "dev", list: [] };
    expect(projectNames(empty)).toEqual(["dev"]);
    expect(projectOf("/tmp/zz-root/751orion-web", empty)).toBe("dev");
  });
});
