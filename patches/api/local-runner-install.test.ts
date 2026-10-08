import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installCommands,
  NODE_SHA256,
  renderInstallPs1,
  renderInstallSh,
  renderWindowsCmd,
  safeOrigin,
  type RunnerBundle,
} from "./local-runner-install.js";

const bundle: RunnerBundle = {
  version: "0.2.0-test",
  files: [
    { name: "index.ts", path: "src/index.ts", sha256: "a".repeat(64), body: Buffer.from("x") },
    { name: "package.json", path: "package.json", sha256: "b".repeat(64), body: Buffer.from("{}") },
  ],
};

describe("installers", () => {
  it("install.sh is valid POSIX sh and pins every checksum", () => {
    const sh = renderInstallSh("http://127.0.0.1:5173", bundle);
    const dir = mkdtempSync(join(tmpdir(), "rk-install-"));
    writeFileSync(join(dir, "install.sh"), sh);
    execFileSync("sh", ["-n", join(dir, "install.sh")]); // throws on syntax error
    expect(sh).toContain(`fetch_file 'index.ts' 'src/index.ts' '${"a".repeat(64)}'`);
    expect(sh).toContain(NODE_SHA256["linux-x64"]);
    expect(sh).toContain("SERVER='http://127.0.0.1:5173'");
    expect(sh).not.toMatch(/\$\{origin\}|undefined/);
  });

  it("install.ps1 pins checksums and uses CRLF", () => {
    const ps = renderInstallPs1("https://rk.example", bundle);
    expect(ps).toContain("'src\\index.ts'");
    expect(ps).toContain(NODE_SHA256["win-x64"]);
    expect(ps.includes("\r\n")).toBe(true);
    expect(ps.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("the Windows .cmd bakes in only the one-time code", () => {
    const cmd = renderWindowsCmd("https://rk.example", "K7QF-3MZD", false);
    expect(cmd).toContain('set "RAKAZO_PAIR_CODE=K7QF-3MZD"');
    expect(cmd).toContain('set "RAKAZO_NO_AUTOSTART=1"');
    expect(cmd).toContain("https://rk.example/api/local-runners/install.ps1");
    expect(() => renderWindowsCmd("https://rk.example", 'K7QF"&calc', true)).toThrow();
  });

  it("commands keep the code out of URLs", () => {
    const c = installCommands("https://rk.example", "K7QF-3MZD");
    expect(c.unix).toBe("curl -fsSL 'https://rk.example/api/local-runners/install.sh' | sh -s -- --code K7QF-3MZD");
    expect(c.unixNoAutostart.endsWith("--no-autostart")).toBe(true);
    for (const v of Object.values(c)) expect(v).not.toMatch(/install\.(sh|ps1)\?/);
  });

  it("rejects odd origins", () => {
    expect(safeOrigin("https://rk.example/some/path")).toBe("https://rk.example");
    expect(() => safeOrigin("javascript:alert(1)")).toThrow();
  });
});
