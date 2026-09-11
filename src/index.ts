#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const toolsDir = join(rootDir, "tools");

/**
 * 設定目錄解析順序：
 * 1. DEV_BOOTSTRAP_HOME 環境變數（供 CI 或自訂路徑使用）
 * 2. 當前目錄已存在的 .dev-bootstrap（相容舊版專案內設定）
 * 3. 使用者家目錄 ~/.dev-bootstrap（全域安裝後的預設位置）
 *
 * 不可使用套件所在目錄，否則全域安裝後設定會落在 node_modules 內，
 * 每次升級都會被清除。
 */
function resolveConfigDir(): string {
  const fromEnv = process.env.DEV_BOOTSTRAP_HOME;
  if (fromEnv) return fromEnv;

  const localDir = join(process.cwd(), ".dev-bootstrap");
  if (existsSync(localDir)) return localDir;

  return join(homedir(), ".dev-bootstrap");
}

const configDir = resolveConfigDir();
const updateProfilePath = join(configDir, "update-profile.json");
const VERIFY_TIMEOUT_MS = 10000;
const WINGET_NO_UPGRADE_EXIT_CODE = 43;

type Platform = "windows" | "mac" | "linux";
type InstallSpec = {
  npm?: string;
  bun?: string;
  winget?: string;
  brew?: string;
  apt?: string;
  script?: string;
  powershell?: string;
};
type UpdateSpec = {
  disabled?: boolean;
  note?: string;
  command?: string;
};
type VerifySpec = { command: string; regex?: string };
type Tool = {
  id: string;
  name: string;
  category: string;
  description?: string;
  homepage?: string;
  install?: InstallSpec;
  update?: UpdateSpec;
  verify?: VerifySpec[];
};
type ToolStatusKind = "unchecked" | "installed" | "missing" | "timeout";
type ToolStatus = {
  kind: ToolStatusKind;
  installed: boolean;
  version: string;
  raw?: string;
};

type MenuState = {
  cursor: number;
  scrollOffset: number;
  selected: Set<string>;
  filter: string;
  category: string;
  force: boolean;
};

type UpdateProfile = {
  version: 1;
  toolIds: string[];
  updatedAt: string;
};

const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  clear: "\x1b[2J\x1b[H",
  home: "\x1b[H",
  clearBelow: "\x1b[J",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

function enableRawInput() {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
}

function disableRawInput() {
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
}

function restoreTerminal(newline = false) {
  disableRawInput();
  process.stdout.write(`${ansi.showCursor}${newline ? "\n" : ""}`);
}

function platform(): Platform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function shellCommand(command: string) {
  if (isWindows()) return { cmd: "cmd.exe", args: ["/d", "/s", "/c", command] };
  return { cmd: "bash", args: ["-lc", command] };
}

function runCapture(
  command: string,
  timeoutMs = VERIFY_TIMEOUT_MS,
): { ok: boolean; stdout: string; stderr: string; code: number | null; timedOut: boolean } {
  try {
    const sh = shellCommand(command);
    const proc = spawnSync(sh.cmd, sh.args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    return {
      ok: proc.status === 0,
      stdout: (proc.stdout ?? "").trim(),
      stderr: (proc.stderr ?? "").trim(),
      code: proc.status,
      timedOut: (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    };
  } catch (err: any) {
    return { ok: false, stdout: "", stderr: String(err?.message ?? err), code: null, timedOut: false };
  }
}

function runInteractive(command: string): number | null {
  const sh = shellCommand(command);
  const proc = spawnSync(sh.cmd, sh.args, {
    stdio: "inherit",
    windowsHide: false,
  });
  return proc.status;
}

function isWingetUpToDateResult(command: string, code: number | null): boolean {
  if (!command.trim().startsWith("winget upgrade")) return false;
  return code === WINGET_NO_UPGRADE_EXIT_CODE;
}

function loadTools(): Tool[] {
  if (!existsSync(toolsDir)) throw new Error(`Missing tools directory: ${toolsDir}`);
  const files = readdirSync(toolsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const tools: Tool[] = [];
  for (const file of files) {
    const parsed = YAML.parse(readFileSync(join(toolsDir, file), "utf8"));
    if (Array.isArray(parsed)) tools.push(...(parsed as Tool[]));
    else tools.push(parsed as Tool);
  }
  return tools.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function chooseInstallCommand(tool: Tool): string | null {
  const p = platform();
  const install = tool.install ?? {};

  if (p === "windows") {
    if (install.winget) return `winget install --id ${install.winget} -e --accept-package-agreements --accept-source-agreements`;
    if (install.powershell) return install.powershell;
    if (install.npm) return `npm install -g ${install.npm}`;
    if (install.bun) return `bun add -g ${install.bun}`;
    if (install.script) return install.script;
  }
  if (p === "mac") {
    if (install.brew) return `brew install ${install.brew}`;
    if (install.npm) return `npm install -g ${install.npm}`;
    if (install.bun) return `bun add -g ${install.bun}`;
    if (install.script) return install.script;
  }
  if (p === "linux") {
    if (install.apt) return `sudo apt-get update && sudo apt-get install -y ${install.apt}`;
    if (install.npm) return `npm install -g ${install.npm}`;
    if (install.bun) return `bun add -g ${install.bun}`;
    if (install.script) return install.script;
  }
  if (install.npm) return `npm install -g ${install.npm}`;
  if (install.bun) return `bun add -g ${install.bun}`;
  return null;
}

function versionFromOutput(output: string, regex?: string): string {
  const text = output.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? output.trim();
  if (!text) return "installed";
  if (regex) {
    try {
      const m = text.match(new RegExp(regex));
      if (m?.[1]) return m[1];
    } catch { }
  }
  const m = text.match(/v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?/);
  return m?.[0] ?? text.slice(0, 80);
}

function hasVersionInOutput(output: string, regex?: string): boolean {
  const text = output.trim();
  if (!text) return false;
  if (regex) {
    try {
      if (new RegExp(regex).test(text)) return true;
    } catch { }
  }
  return /v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?/.test(text);
}

function commandNameFromVerify(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const quoted = trimmed.match(/^"([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  return trimmed.split(/\s+/)[0] ?? null;
}

function commandExists(command: string): boolean {
  const name = commandNameFromVerify(command);
  if (!name) return false;
  const probe = isWindows() ? `where.exe ${name}` : `command -v ${name}`;
  const result = runCapture(probe, 3000);
  return result.ok && !!result.stdout.trim();
}

function detectStatus(tool: Tool): ToolStatus {
  if (!tool.verify || tool.verify.length === 0) {
    return { kind: "missing", installed: false, version: "no verify" };
  }

  for (const v of tool.verify) {
    const result = runCapture(v.command);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.ok && output.trim()) {
      return {
        kind: "installed",
        installed: true,
        version: versionFromOutput(output, v.regex),
        raw: output,
      };
    }
    if (result.timedOut && output.trim()) {
      return {
        kind: "installed",
        installed: true,
        version: versionFromOutput(output, v.regex),
        raw: output,
      };
    }
    if (result.ok) {
      return { kind: "installed", installed: true, version: "installed" };
    }
    if (commandExists(v.command)) {
      return {
        kind: "installed",
        installed: true,
        version: hasVersionInOutput(output, v.regex) ? versionFromOutput(output, v.regex) : "installed",
        raw: output || undefined,
      };
    }
    if (result.timedOut) {
      return { kind: "timeout", installed: false, version: "timeout" };
    }
  }

  return { kind: "missing", installed: false, version: "not installed" };
}

function uncheckedStatus(): ToolStatus {
  return { kind: "unchecked", installed: false, version: "unchecked" };
}

function detectAllWithProgress(tools: Tool[], label = "Checking installed versions"): Map<string, ToolStatus> {
  const status = new Map<string, ToolStatus>();
  const frames = ["-", "\\", "|", "/"];
  const interactive = !!process.stdout.isTTY;
  if (interactive) process.stdout.write(ansi.hideCursor);
  try {
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      if (interactive) {
        const pct = Math.round(((i + 1) / tools.length) * 24);
        const lines = [
          `${ansi.bold}dev-bootstrap${ansi.reset}`,
          `${ansi.cyan}${frames[i % frames.length]}${ansi.reset} ${label}`,
          `${ansi.dim}${i + 1}/${tools.length}${ansi.reset} ${tool.name}`,
          tool.verify?.[0]?.command ? `${ansi.dim}${tool.verify[0].command}${ansi.reset}` : "",
          "",
          `[${"#".repeat(pct)}${"-".repeat(24 - pct)}] ${i + 1}/${tools.length}`,
        ];
        process.stdout.write(`${i === 0 ? ansi.clear : ansi.home}${lines.join("\n")}${ansi.clearBelow}`);
      }
      status.set(tool.id, detectStatus(tool));
    }
  } finally {
    if (interactive) process.stdout.write(ansi.showCursor);
  }
  return status;
}

function loadUpdateProfile(): UpdateProfile {
  try {
    const parsed = JSON.parse(readFileSync(updateProfilePath, "utf8")) as Partial<UpdateProfile>;
    const toolIds = Array.isArray(parsed.toolIds) ? parsed.toolIds.filter((id): id is string => typeof id === "string") : [];
    return { version: 1, toolIds, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "" };
  } catch {
    return { version: 1, toolIds: [], updatedAt: "" };
  }
}

function saveUpdateProfile(toolIds: string[]) {
  mkdirSync(configDir, { recursive: true });
  const profile: UpdateProfile = { version: 1, toolIds: [...new Set(toolIds)].sort(), updatedAt: new Date().toISOString() };
  writeFileSync(updateProfilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

function updateCommand(tool: Tool): string | null {
  if (tool.update?.disabled) return null;
  if (tool.update?.command) return tool.update.command;

  const p = platform();
  const install = tool.install ?? {};

  if (p === "windows" && install.winget) {
    return `winget upgrade --id ${install.winget} -e --accept-package-agreements --accept-source-agreements`;
  }
  if (p === "mac" && install.brew) return `brew upgrade ${install.brew}`;
  // npm 與 bun 各自只更新自己安裝的那份；yaml 應標註官方推薦的那個管理器。
  if (install.npm) return `npm install -g ${install.npm}@latest`;
  if (install.bun) return `bun add -g ${install.bun}@latest`;
  // Script-based installers do not expose a portable update command. Re-run only when explicitly selected.
  return install.script ?? chooseInstallCommand(tool);
}

function canUseWingetForUpdate(packageId: string): boolean {
  const result = runCapture(
    `winget list --id ${packageId} -e --accept-source-agreements --disable-interactivity`,
    5000,
  );
  return result.ok;
}

function statusText(status?: ToolStatus): string {
  if (!status) return "unchecked";
  if (status.kind === "unchecked") return "unchecked";
  if (status.kind === "timeout") return "timeout";
  return status.installed ? status.version : "not installed";
}

function colorStatus(status?: ToolStatus): string {
  if (!status || status.kind === "unchecked") return `${ansi.dim}unchecked${ansi.reset}`;
  if (status.kind === "timeout") return `${ansi.yellow}timeout${ansi.reset}`;
  if (status.installed) return `${ansi.green}${status.version}${ansi.reset}`;
  return `${ansi.dim}not installed${ansi.reset}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function pad(value: string, width: number): string {
  const length = stripAnsi(value).length;
  return value + " ".repeat(Math.max(1, width - length));
}

function groupedCategories(tools: Tool[]): string[] {
  return ["All", ...Array.from(new Set(tools.map((t) => t.category))).sort()];
}

function filteredTools(tools: Tool[], state: MenuState): Tool[] {
  const q = state.filter.trim().toLowerCase();
  return tools.filter((tool) => {
    const categoryOk = state.category === "All" || tool.category === state.category;
    const querySource = [tool.id, tool.name, tool.category, tool.description ?? ""].join(" ").toLowerCase();
    const queryOk = !q || querySource.includes(q);
    return categoryOk && queryOk;
  });
}

function currentTool(visible: Tool[], state: MenuState): Tool | undefined {
  if (visible.length === 0) return undefined;
  if (state.cursor >= visible.length) state.cursor = visible.length - 1;
  if (state.cursor < 0) state.cursor = 0;
  return visible[state.cursor];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pageSize(): number {
  const rows = process.stdout.rows ?? 30;
  return clamp(rows - 23, 6, 12);
}

function screenWidth(): number {
  const columns = process.stdout.columns ?? 100;
  return clamp(columns - 1, 72, 120);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function ensureCursorVisible(visibleCount: number, state: MenuState) {
  const size = pageSize();
  state.cursor = clamp(state.cursor, 0, Math.max(0, visibleCount - 1));
  state.scrollOffset = clamp(state.scrollOffset, 0, Math.max(0, visibleCount - size));

  if (state.cursor < state.scrollOffset) {
    state.scrollOffset = state.cursor;
  }
  if (state.cursor >= state.scrollOffset + size) {
    state.scrollOffset = state.cursor - size + 1;
  }
}

function renderInstallMenu(tools: Tool[], status: Map<string, ToolStatus>, state: MenuState) {
  const visible = filteredTools(tools, state);
  ensureCursorVisible(visible.length, state);
  const selectedTool = currentTool(visible, state);
  const size = pageSize();
  const windowed = visible.slice(state.scrollOffset, state.scrollOffset + size);
  const width = screenWidth();
  const lines: string[] = [];

  const categoryActionLabel =
    state.category === "All" ? "all category items" : `${state.category} category`;

  const categories = groupedCategories(tools)
    .map((category) => (category === state.category ? `[${category}]` : category))
    .join(" | ");

  lines.push(`${ansi.bold}dev-bootstrap${ansi.reset} ${ansi.dim}v0.2${ansi.reset}`);
  lines.push(
    `${ansi.dim}${truncate(
      `Space toggle | A/Ctrl+A visible items | C ${categoryActionLabel} | Tab category | / search | V refresh versions | F force ${state.force ? "on" : "off"} | Enter install | Backspace back | Q quit`,
      width,
    )}${ansi.reset}`,
  );
  lines.push("");
  lines.push(`Categories: ${truncate(categories, width - 12)}`);
  lines.push(
    truncate(
      `Filter: ${state.filter ? state.filter : "none"}  ` +
      `Selected: ${state.selected.size}  ` +
      `Visible: ${visible.length}/${tools.length}  ` +
      `Showing: ${visible.length === 0 ? 0 : state.scrollOffset + 1}-${Math.min(visible.length, state.scrollOffset + size)}`,
      width,
    ),
  );
  lines.push("=".repeat(width));

  if (visible.length === 0) {
    lines.push(`${ansi.yellow}No tools matched the current filter.${ansi.reset}`);
  } else {
    if (state.scrollOffset > 0) {
      lines.push(`${ansi.dim}... ${state.scrollOffset} tools above${ansi.reset}`);
    }

    let lastCategory = "";
    for (let i = 0; i < windowed.length; i++) {
      const absoluteIndex = state.scrollOffset + i;
      const tool = windowed[i];
      if (tool.category !== lastCategory) {
        lastCategory = tool.category;
        lines.push("");
        lines.push(`${ansi.bold}${tool.category}${ansi.reset}`);
      }

      const pointer = absoluteIndex === state.cursor ? `${ansi.cyan}>${ansi.reset}` : " ";
      const checked = state.selected.has(tool.id) ? `${ansi.green}[x]${ansi.reset}` : "[ ]";
      const labelWidth = Math.min(32, Math.max(22, Math.floor(width * 0.34)));
      const descWidth = Math.min(36, Math.max(18, width - labelWidth - 24));
      const label = pad(`${checked} ${truncate(tool.name, labelWidth - 5)}`, labelWidth);
      const desc = pad(truncate(tool.description ?? "", descWidth), descWidth);
      lines.push(`${pointer} ${label} ${desc} ${colorStatus(status.get(tool.id))}`);
    }

    const hiddenBelow = visible.length - state.scrollOffset - windowed.length;
    if (hiddenBelow > 0) {
      lines.push(`${ansi.dim}... ${hiddenBelow} tools below${ansi.reset}`);
    }
  }

  lines.push("");
  lines.push("-".repeat(width));
  if (selectedTool) {
    const st = status.get(selectedTool.id) ?? uncheckedStatus();
    lines.push(`${ansi.bold}${truncate(selectedTool.name, Math.max(20, width - selectedTool.id.length - 4))}${ansi.reset} ${ansi.dim}(${selectedTool.id})${ansi.reset}`);
    lines.push(truncate(selectedTool.description ?? "No description", width));
    lines.push(`Status: ${colorStatus(st)}  Category: ${selectedTool.category}`);
    if (selectedTool.homepage) lines.push(truncate(`Homepage: ${selectedTool.homepage}`, width));
    const installCommand = chooseInstallCommand(selectedTool);
    if (installCommand) lines.push(`${ansi.dim}${truncate(`Install: ${installCommand}`, width)}${ansi.reset}`);
  } else {
    lines.push(`${ansi.dim}No tool selected.${ansi.reset}`);
  }

  process.stdout.write(`${ansi.home}${lines.join("\n")}${ansi.clearBelow}`);
}

async function readKey(): Promise<string> {
  return await new Promise((resolve) => {
    const onData = (data: Buffer) => {
      process.stdin.off("data", onData);
      resolve(data.toString("utf8"));
    };
    process.stdin.on("data", onData);
  });
}

async function promptLine(label: string): Promise<string> {
  process.stdin.setRawMode?.(false);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write(label ? `\n${label}: ` : "\n");
  const line = await new Promise<string>((resolve) => {
    let buf = "";
    const onData = (data: Buffer) => {
      const text = data.toString("utf8");
      if (text.includes("\n") || text.includes("\r")) {
        process.stdin.off("data", onData);
        buf += text.replace(/[\r\n]+/g, "");
        resolve(buf.trim());
      } else {
        buf += text;
      }
    };
    process.stdin.on("data", onData);
  });
  enableRawInput();
  return line;
}

async function confirmLine(label: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "Y/n" : "y/N";
  const answer = (await promptLine(`${label} (${suffix})`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function withUncheckedStatus(tools: Tool[]): Map<string, ToolStatus> {
  return new Map(tools.map((tool) => [tool.id, uncheckedStatus()]));
}

async function installMenu(tools: Tool[], mode: "install" | "update-profile" = "install") {
  if (!process.stdin.isTTY) {
    console.error("Interactive menu requires a TTY. Try: bun run menu");
    process.exit(1);
  }

  process.stdout.write(ansi.clear);
  process.stdin.setRawMode?.(false);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const isUpdateProfile = mode === "update-profile";
  console.log(`${ansi.bold}${isUpdateProfile ? "Configure automatic updates" : "Install tools"}${ansi.reset}\n`);
  console.log(isUpdateProfile ? "Choose the tools that should be updated by the saved update command." : "You can skip version detection for a faster menu load.");
  // Ask before raw mode. Git Bash can lose the first keypress when switching modes.
  const shouldScan = await confirmLine("Check installed versions now", false);

  let status = shouldScan ? detectAllWithProgress(tools) : withUncheckedStatus(tools);
  const saved = isUpdateProfile ? loadUpdateProfile() : null;
  const state: MenuState = {
    cursor: 0,
    scrollOffset: 0,
    selected: new Set(saved?.toolIds ?? []),
    filter: "",
    category: "All",
    force: isUpdateProfile,
  };
  const categories = groupedCategories(tools);
  enableRawInput();
  process.stdout.write(ansi.clear + ansi.hideCursor);

  try {
    while (true) {
      renderInstallMenu(tools, status, state);
      const visible = filteredTools(tools, state);
      const key = await readKey();

      if (key === "\u0003" || key.toLowerCase() === "q") {
        restoreTerminal(true);
        process.exit(0);
      }

      if (key === "\u001b[A") {
        state.cursor = Math.max(0, state.cursor - 1);
        ensureCursorVisible(visible.length, state);
        continue;
      }
      if (key === "\u001b[B") {
        state.cursor = Math.min(Math.max(0, visible.length - 1), state.cursor + 1);
        ensureCursorVisible(visible.length, state);
        continue;
      }
      if (key === "\u001b[5~") {
        state.cursor = Math.max(0, state.cursor - pageSize());
        ensureCursorVisible(visible.length, state);
        continue;
      }
      if (key === "\u001b[6~") {
        state.cursor = Math.min(Math.max(0, visible.length - 1), state.cursor + pageSize());
        ensureCursorVisible(visible.length, state);
        continue;
      }
      if (key === "\u001b[H" || key === "\u001b[1~") {
        state.cursor = 0;
        ensureCursorVisible(visible.length, state);
        continue;
      }
      if (key === "\u001b[F" || key === "\u001b[4~") {
        state.cursor = Math.max(0, visible.length - 1);
        ensureCursorVisible(visible.length, state);
        continue;
      }
      if (key === "\t") {
        const idx = categories.indexOf(state.category);
        state.category = categories[(idx + 1) % categories.length];
        state.cursor = 0;
        state.scrollOffset = 0;
        continue;
      }
      if (key === " ") {
        const tool = visible[state.cursor];
        if (tool) {
          if (state.selected.has(tool.id)) state.selected.delete(tool.id);
          else state.selected.add(tool.id);
        }
        continue;
      }
      if (key.toLowerCase() === "a" || key === "\u0001") {
        const allSelected = visible.length > 0 && visible.every((tool) => state.selected.has(tool.id));
        for (const tool of visible) {
          if (allSelected) state.selected.delete(tool.id);
          else state.selected.add(tool.id);
        }
        continue;
      }
      if (key.toLowerCase() === "c") {
        const categoryTools = tools.filter((tool) => state.category === "All" || tool.category === state.category);
        const allSelected = categoryTools.length > 0 && categoryTools.every((tool) => state.selected.has(tool.id));
        for (const tool of categoryTools) {
          if (allSelected) state.selected.delete(tool.id);
          else state.selected.add(tool.id);
        }
        continue;
      }
      if (key.toLowerCase() === "f") {
        state.force = !state.force;
        continue;
      }
      if (key.toLowerCase() === "v") {
        status = detectAllWithProgress(tools, "Refreshing installed versions");
        process.stdout.write(ansi.clear + ansi.hideCursor);
        continue;
      }
      if (key === "/") {
        state.filter = await promptLine("Search");
        state.cursor = 0;
        state.scrollOffset = 0;
        process.stdout.write(ansi.clear + ansi.hideCursor);
        continue;
      }
      if (key === "\b" || key === "\x7f" || key === "\u001b") {
        restoreTerminal(false);
        return;
      }
      if (key === "\r" || key === "\n") {
        restoreTerminal(true);
        const selected = tools.filter((tool) => state.selected.has(tool.id));
        if (isUpdateProfile) {
          const save = await confirmLine(`Save ${selected.length} selected tools as the automatic update profile`, true);
          if (save) {
            saveUpdateProfile(selected.map((tool) => tool.id));
            console.log(`Saved update profile: ${updateProfilePath}`);
          } else {
            console.log("Update profile was not changed.");
          }
        } else {
          await installTools(selected, status, state.force);
        }
        return;
      }
    }
  } finally {
    process.stdout.write(ansi.showCursor);
  }
}

async function installTools(tools: Tool[], status = withUncheckedStatus(tools), force = false) {
  if (tools.length === 0) {
    console.log("No tools selected.");
    return;
  }

  const unchecked = tools.filter((tool) => (status.get(tool.id) ?? uncheckedStatus()).kind === "unchecked");
  if (unchecked.length > 0) {
    const refreshed = detectAllWithProgress(unchecked, "Checking selected tools before install");
    for (const [toolId, toolStatus] of refreshed) status.set(toolId, toolStatus);
  }

  const installed = tools.filter((tool) => status.get(tool.id)?.installed);
  if (installed.length > 0 && !force) {
    console.log("Already installed tools will be skipped:");
    for (const tool of installed) {
      console.log(`- ${tool.name} ${status.get(tool.id)?.version ?? ""}`);
    }
    const reinstall = await confirmLine("Install/update already installed tools too", false);
    if (reinstall) force = true;
  }

  for (const tool of tools) {
    const currentStatus = status.get(tool.id);
    if (currentStatus?.installed && !force) {
      console.log(`\nSKIP ${tool.name} (${currentStatus.version})`);
      continue;
    }

    const command = chooseInstallCommand(tool);
    if (!command) {
      console.log(`\nNO INSTALLER ${tool.name} on ${platform()}`);
      if (tool.homepage) console.log(`Homepage: ${tool.homepage}`);
      continue;
    }

    console.log(`\n==> Installing ${tool.name}`);
    console.log(`$ ${command}`);
    const code = runInteractive(command);
    const after = detectStatus(tool);
    status.set(tool.id, after);

    if (code === 0 && after.installed) {
      console.log(`OK ${tool.name}: ${after.version}`);
    } else if (code === 0) {
      console.log(`DONE ${tool.name}, but verify did not detect it. Restart terminal or check PATH.`);
    } else {
      console.log(`FAILED ${tool.name} exit=${code}`);
    }
  }
}

function resolveToolsByIds(tools: Tool[], ids: string[]): Tool[] {
  return tools.filter((tool) => ids.includes(tool.id));
}

async function updateTools(tools: Tool[], status = withUncheckedStatus(tools)) {
  if (tools.length === 0) {
    console.log("No tools selected for update.");
    return;
  }

  const unchecked = tools.filter((tool) => (status.get(tool.id) ?? uncheckedStatus()).kind === "unchecked");
  if (unchecked.length > 0) {
    const refreshed = detectAllWithProgress(unchecked, "Checking saved tools before update");
    for (const [toolId, toolStatus] of refreshed) status.set(toolId, toolStatus);
  }

  const missing = tools.filter((tool) => !status.get(tool.id)?.installed);
  if (missing.length > 0) {
    console.log("Skipping tools that are not installed:");
    for (const tool of missing) console.log(`- ${tool.name}`);
  }

  for (const tool of tools) {
    const before = status.get(tool.id) ?? uncheckedStatus();
    if (!before.installed) continue;

    if (platform() === "windows" && tool.install?.winget && !tool.update?.command) {
      const managedByWinget = canUseWingetForUpdate(tool.install.winget);
      if (!managedByWinget) {
        console.log(`\nSKIP ${tool.name}: installed, but not managed by winget on this machine.`);
        if (tool.update?.note) console.log(tool.update.note);
        else if (tool.homepage) console.log(`Homepage: ${tool.homepage}`);
        continue;
      }
    }

    const command = updateCommand(tool);
    if (!command) {
      console.log(`\nSKIP ${tool.name}: no updater configured on ${platform()}.`);
      if (tool.update?.note) console.log(tool.update.note);
      continue;
    }

    console.log(`\n==> Updating ${tool.name} (current: ${before.version})`);
    console.log(`$ ${command}`);
    const code = runInteractive(command);
    const after = detectStatus(tool);
    status.set(tool.id, after);

    if (code === 0 && after.installed) console.log(`OK ${tool.name}: ${before.version} -> ${after.version}`);
    else if (isWingetUpToDateResult(command, code) && after.installed) console.log(`UP-TO-DATE ${tool.name}: ${after.version}`);
    else if (code === 0) console.log(`DONE ${tool.name}, but verify did not detect it. Restart terminal or check PATH.`);
    else console.log(`FAILED ${tool.name} exit=${code}`);
  }
}

function listTools(tools: Tool[], withStatus = false) {
  const status = withStatus ? detectAllWithProgress(tools, "Checking installed versions") : withUncheckedStatus(tools);
  let lastCategory = "";

  for (const tool of tools) {
    if (tool.category !== lastCategory) {
      lastCategory = tool.category;
      console.log(`\n${tool.category}`);
    }
    const suffix = withStatus ? ` - ${statusText(status.get(tool.id))}` : "";
    console.log(`  ${tool.id.padEnd(18)} ${tool.name}${suffix}`);
  }
}

function doctor(tools: Tool[]) {
  const status = detectAllWithProgress(tools, "Doctor: checking installed tools");
  let installed = 0;

  for (const tool of tools) {
    const st = status.get(tool.id) ?? uncheckedStatus();
    if (st.installed) installed++;
    const mark = st.installed ? `${ansi.green}OK${ansi.reset}` : st.kind === "timeout" ? `${ansi.yellow}??${ansi.reset}` : "--";
    console.log(`${mark} ${pad(tool.name, 24)} ${statusText(st)}`);
  }

  console.log(`\n${installed}/${tools.length} tools detected.`);
}

async function mainMenu(tools: Tool[]) {
  const options = [
    "Install tools",
    "Configure automatic update list",
    "Update saved tools now",
    "Doctor",
    "List tools",
    "List tools with versions",
    "Exit",
  ];
  let cursor = 0;

  enableRawInput();

  while (true) {
    process.stdout.write(ansi.clear);
    console.log(`${ansi.bold}dev-bootstrap${ansi.reset}`);
    console.log(`${ansi.dim}Arrow keys move | Enter select | Q quit${ansi.reset}\n`);
    console.log(`${ansi.magenta}Platform:${ansi.reset} ${platform()}\n`);
    for (let i = 0; i < options.length; i++) {
      const pointer = i === cursor ? `${ansi.cyan}>${ansi.reset}` : " ";
      console.log(`${pointer} ${options[i]}`);
    }

    const key = await readKey();
    if (key === "\u0003" || key.toLowerCase() === "q") {
      restoreTerminal(true);
      return;
    }
    if (key === "\u001b[A") {
      cursor = Math.max(0, cursor - 1);
      continue;
    }
    if (key === "\u001b[B") {
      cursor = Math.min(options.length - 1, cursor + 1);
      continue;
    }
    if (key === "\r" || key === "\n") {
      disableRawInput();
      process.stdout.write("\n");
      if (cursor === 0) await installMenu(tools);
      else if (cursor === 1) await installMenu(tools, "update-profile");
      else if (cursor === 2) {
        const profile = loadUpdateProfile();
        const selected = resolveToolsByIds(tools, profile.toolIds);
        if (profile.toolIds.length === 0) {
          console.log("No saved update profile. Choose 'Configure automatic update list' first.");
        } else {
          const unknown = profile.toolIds.filter((id) => !selected.some((tool) => tool.id === id));
          if (unknown.length > 0) console.log(`Ignoring removed/unknown tool ids: ${unknown.join(", ")}`);
          await updateTools(selected);
        }
      }
      else if (cursor === 3) doctor(tools);
      else if (cursor === 4) listTools(tools, false);
      else if (cursor === 5) listTools(tools, true);
      else break;

      if (cursor !== 0) {
        console.log("\nPress Enter to return.");
        await promptLine("");
      }
      enableRawInput();
    }
  }

  restoreTerminal(false);
}

async function main() {
  const tools = loadTools();
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "menu") {
    return await mainMenu(tools);
  }
  if (cmd === "list") {
    return listTools(tools, args.includes("--versions"));
  }
  if (cmd === "doctor") {
    return doctor(tools);
  }
  if (cmd === "install") {
    const force = args.includes("--force");
    const ids = args.filter((arg) => arg !== "--force");
    const selected = tools.filter((tool) => ids.includes(tool.id));
    const missing = ids.filter((id) => !selected.some((tool) => tool.id === id));
    if (missing.length > 0) console.log(`Unknown tool ids: ${missing.join(", ")}`);
    return await installTools(selected, detectAllWithProgress(selected, "Checking installed versions"), force);
  }
  if (cmd === "update") {
    const useAll = args.includes("--all");
    const ids = args.filter((arg) => arg !== "--all");
    const profile = loadUpdateProfile();
    const requestedIds = useAll ? tools.map((tool) => tool.id) : ids.length > 0 ? ids : profile.toolIds;
    const selected = resolveToolsByIds(tools, requestedIds);
    const missing = requestedIds.filter((id) => !selected.some((tool) => tool.id === id));
    if (missing.length > 0) console.log(`Unknown tool ids: ${missing.join(", ")}`);
    if (requestedIds.length === 0) {
      console.log("No saved update profile. Run: dev-bootstrap menu, then choose 'Configure automatic update list'.");
      process.exitCode = 1;
      return;
    }
    return await updateTools(selected);
  }

  console.log(`Usage:
  dev-bootstrap menu
  dev-bootstrap list [--versions]
  dev-bootstrap doctor
  dev-bootstrap install <tool-id...> [--force]
  dev-bootstrap update [<tool-id...> | --all]
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
