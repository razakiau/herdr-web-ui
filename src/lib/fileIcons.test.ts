import { describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";

import { fileIcon, fileIconKind, folderIcon, folderIconKind } from "./fileIcons.ts";
import { FALLBACK_ICONS, render } from "../../scripts/generate-file-icons.ts";

describe("fileIconKind", () => {
  it("tells code, data, text and media apart by extension, whatever its case", () => {
    expect(fileIconKind("App.tsx")).toBe("code");
    expect(fileIconKind("main.go")).toBe("code");
    expect(fileIconKind("index.html")).toBe("code");
    expect(fileIconKind("styles.css")).toBe("code");
    expect(fileIconKind("settings.json")).toBe("json");
    expect(fileIconKind("ci.yml")).toBe("config");
    expect(fileIconKind("Cargo.toml")).toBe("config");
    expect(fileIconKind("notes.MD")).toBe("text");
    expect(fileIconKind("Photo.PNG")).toBe("image");
    expect(fileIconKind("logo.svg")).toBe("image");
    expect(fileIconKind("clip.mp4")).toBe("video");
    expect(fileIconKind("song.flac")).toBe("audio");
    expect(fileIconKind("site.tar.gz")).toBe("archive");
    expect(fileIconKind("run.sh")).toBe("shell");
    expect(fileIconKind("fix.patch")).toBe("diff");
    expect(fileIconKind("Inter.woff2")).toBe("font");
    expect(fileIconKind("server.pem")).toBe("key");
    expect(fileIconKind("tool.exe")).toBe("binary");
    expect(fileIconKind("rows.csv")).toBe("spreadsheet");
  });

  it("knows the names that have no extension to speak of", () => {
    expect(fileIconKind("README")).toBe("text");
    expect(fileIconKind("LICENSE")).toBe("text");
    expect(fileIconKind("Makefile")).toBe("config");
    expect(fileIconKind("CMakeLists.txt")).toBe("config");
    expect(fileIconKind("Dockerfile")).toBe("config");
    expect(fileIconKind("Dockerfile.dev")).toBe("config");
    expect(fileIconKind("api.Dockerfile")).toBe("config");
    expect(fileIconKind(".gitignore")).toBe("config");
    expect(fileIconKind(".env")).toBe("config");
    expect(fileIconKind(".env.local")).toBe("config");
    expect(fileIconKind(".zshrc")).toBe("shell");
  });

  it("marks a lockfile whatever its extension says", () => {
    expect(fileIconKind("package-lock.json")).toBe("lock");
    expect(fileIconKind("pnpm-lock.yaml")).toBe("lock");
    expect(fileIconKind("bun.lock")).toBe("lock");
    expect(fileIconKind("bun.lockb")).toBe("lock");
    expect(fileIconKind("Cargo.lock")).toBe("lock");
    expect(fileIconKind("go.sum")).toBe("lock");
  });

  it("reads the name off a path with either separator", () => {
    expect(fileIconKind("src/components/RepoChanges.tsx")).toBe("code");
    expect(fileIconKind("/Users/me/Pictures/cat.jpeg")).toBe("image");
    expect(fileIconKind("C:\\repo\\package.json")).toBe("json");
    expect(fileIconKind("docs/README")).toBe("text");
  });

  it("gives an unknown name, a dotfile and a trailing dot the plain file", () => {
    expect(fileIconKind("notes.xyz")).toBe("file");
    expect(fileIconKind(".DS_Store")).toBe("file");
    expect(fileIconKind("name.")).toBe("file");
    expect(fileIconKind("noext")).toBe("file");
    expect(fileIconKind("")).toBe("file");
  });
});

describe("folderIconKind", () => {
  it("marks a repository's .git and no other folder", () => {
    expect(folderIconKind(".git")).toBe("git");
    expect(folderIconKind("src")).toBe("folder");
    expect(folderIconKind(".github")).toBe("folder");
    expect(folderIconKind("node_modules")).toBe("folder");
  });
});

describe("fileIcon", () => {
  it("draws VS Code's Material icon for a file's language", () => {
    expect(fileIcon("App.tsx")).toBe("react_ts");
    expect(fileIcon("index.ts")).toBe("typescript");
    expect(fileIcon("main.py")).toBe("python");
    expect(fileIcon("main.go")).toBe("go");
    expect(fileIcon("lib.rs")).toBe("rust");
    expect(fileIcon("notes.MD")).toBe("markdown");
    expect(fileIcon("ci.yml")).toBe("yaml");
    expect(fileIcon("run.sh")).toBe("console");
    expect(fileIcon("Photo.PNG")).toBe("image");
  });

  it("knows a file by its whole name before its extension, whatever its case", () => {
    expect(fileIcon("package.json")).toBe("nodejs");
    expect(fileIcon("tsconfig.json")).toBe("tsconfig");
    expect(fileIcon("Dockerfile")).toBe("docker");
    expect(fileIcon("README.md")).toBe("readme");
    expect(fileIcon("CLAUDE.md")).toBe("claude");
    expect(fileIcon("src/vite.config.ts")).toBe("vite");
    expect(fileIcon("C:\\repo\\bun.lock")).toBe("bun");
  });

  it("tries the longest dotted ending first", () => {
    expect(fileIcon("a.test.ts")).toBe("test-ts");
    expect(fileIcon("types.d.ts")).toBe("typescript-def");
    expect(fileIcon("x.spec.tsx")).toBe("test-jsx");
  });

  it("falls back to the kind's icon for a name the theme does not know", () => {
    expect(fileIcon(".env")).toBe("tune");
    expect(fileIcon(".env.local")).toBe("tune");
    expect(fileIcon(".zshrc")).toBe("console");
    expect(fileIcon("Dockerfile.dev")).toBe("docker");
    expect(fileIcon("yarn.lockb")).toBe("lock");
    expect(fileIcon("notes.xyz")).toBe("file");
    expect(fileIcon("noext")).toBe("file");
    expect(fileIcon("name.")).toBe("file");
    expect(fileIcon("")).toBe("file");
  });

  it("uses the light theme's variant when there is one", () => {
    expect(fileIcon("t.jinja")).toBe("jinja");
    expect(fileIcon("t.jinja", true)).toBe("jinja_light");
    expect(fileIcon("a.ts", true)).toBe("typescript");
  });

  it("only names icons the URL table can draw", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../node_modules/material-icon-theme/dist/material-icons.json", import.meta.url), "utf8"));
    const urls = render(manifest, "x").urls;
    for (const icon of [...FALLBACK_ICONS, folderIcon("a"), folderIcon("a", true), folderIcon(".git", true)]) expect(urls).toContain(`"${icon}": `);
    for (const name of [".env", ".zshrc", "bun.lockb", "notes.xyz", "Dockerfile.dev", "a.pfx", "tool.dylib", "a.war"]) expect(urls).toContain(`"${fileIcon(name)}": `);
  });
});

describe("folderIcon", () => {
  it("draws a folder, and .git as the git folder", () => {
    expect(folderIcon("src")).toBe("folder");
    expect(folderIcon(".git")).toBe("folder-git");
    expect(folderIcon("src", true)).toBe("folder-open");
    expect(folderIcon(".git", true)).toBe("folder-git-open");
  });
});
