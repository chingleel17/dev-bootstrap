#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const toolsDir = join(rootDir, "tools");
const VERIFY_TIMEOUT_MS = 2500;

type Platform = "windows" | "mac" | "linux";
type InstallSpec = {
  bun?: string;
  winget?: string;
  brew?: string;
  apt?: string;
  script?: string;
};
type VerifySpec = { command: string; regex?: string };
type Tool = {
  id: string;
  name: string;
  category: string;
  description?: string;
  homepage?: string;
  install?: InstallSpec;
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
  selected: Set<string>;
  filter: string;
  category: string;
  force: boolean;
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
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

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
      timedOut: proc.error?.name === "Error" && String(proc.error.message).toLowerCase().includes("timed out"),
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
    if (install.bun) return `bun add -g ${install.bun}`;
    if (install.script) return install.script;
  }
  if (p === "mac") {
    if (install.brew) return `brew install ${install.brew}`;
    if (install.bun) return `bun add -g ${install.bun}`;
    if (install.script) return install.script;
  }
  if (p === "linux") {
    if (install.apt) return `sudo apt-get update && sudo apt-get install -y ${install.apt}`;
    if (install.bun) return `bun add -g ${install.bun}`;
    if (install.script) return install.script;
  }
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
    } catch {}
  }
  const m = text.match(/v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?/);
  return m?.[0] ?? text.slice(0, 80);
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
    if (result.ok) {
      return { kind: "installed", installed: true, version: "installed" };
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
  process.stdout.write(ansi.hideCursor);
  try {
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      process.stdout.write(ansi.clear);
      console.log(`${ansi.bold}dev-bootstrap${ansi.reset}`);
      console.log(`${ansi.cyan}${frames[i % frames.length]}${ansi.reset} ${label}`);
      console.log(`${ansi.dim}${i + 1}/${tools.length}${ansi.reset} ${tool.name}`);
      if (tool.verify?.[0]?.command) {
        console.log(`${ansi.dim}${tool.verify[0].command}${ansi.reset}`);
      }
      const pct = Math.round(((i + 1) / tools.length) * 24);
      console.log(`\n[${"#".repeat(pct)}${"-".repeat(24 - pct)}] ${i + 1}/${tools.length}`);
      status.set(tool.id, detectStatus(tool));
    }
  } finally {
    process.stdout.write(ansi.showCursor);
  }
  return status;
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

function renderInstallMenu(tools: Tool[], status: Map<string, ToolStatus>, state: MenuState) {
  const visible = filteredTools(tools, state);
  const selectedTool = currentTool(visible, state);
  process.stdout.write(ansi.clear);

  const categories = groupedCategories(tools)
    .map((category) => (category === state.category ? `${ansi.cyan}[${category}]${ansi.reset}` : category))
    .join(` ${ansi.dim}|${ansi.reset} `);

  console.log(`${ansi.bold}dev-bootstrap${ansi.reset} ${ansi.dim}v0.2${ansi.reset}`);
  console.log(`${ansi.dim}Space toggle | A/Ctrl+A visible all | C category all | Tab category | / search | V refresh versions | F force ${state.force ? "on" : "off"} | Enter install | Backspace back | Q quit${ansi.reset}`);
  console.log("");
  console.log(`Categories: ${categories}`);
  console.log(
    `Filter: ${state.filter ? ansi.yellow + state.filter + ansi.reset : ansi.dim + "none" + ansi.reset}  ` +
      `Selected: ${state.selected.size}  ` +
      `Visible: ${visible.length}/${tools.length}`,
  );
  console.log("=".repeat(104));

  if (visible.length === 0) {
    console.log(`${ansi.yellow}No tools matched the current filter.${ansi.reset}`);
  } else {
    let lastCategory = "";
    for (let i = 0; i < visible.length; i++) {
      const tool = visible[i];
      if (tool.category !== lastCategory) {
        lastCategory = tool.category;
        console.log(`\n${ansi.bold}${tool.category}${ansi.reset}`);
      }

      const pointer = i === state.cursor ? `${ansi.cyan}>${ansi.reset}` : " ";
      const checked = state.selected.has(tool.id) ? `${ansi.green}[x]${ansi.reset}` : "[ ]";
      const label = pad(`${checked} ${tool.name}`, 36);
      const desc = pad((tool.description ?? "").slice(0, 38), 40);
      console.log(`${pointer} ${label} ${desc} ${colorStatus(status.get(tool.id))}`);
    }
  }

  console.log("\n" + "-".repeat(104));
  if (selectedTool) {
    const st = status.get(selectedTool.id) ?? uncheckedStatus();
    console.log(`${ansi.bold}${selectedTool.name}${ansi.reset} ${ansi.dim}(${selectedTool.id})${ansi.reset}`);
    console.log(`${selectedTool.description ?? "No description"}`);
    console.log(`Status: ${colorStatus(st)}  Category: ${selectedTool.category}`);
    if (selectedTool.homepage) console.log(`Homepage: ${selectedTool.homepage}`);
    const installCommand = chooseInstallCommand(selectedTool);
    if (installCommand) console.log(`${ansi.dim}Install: ${installCommand}${ansi.reset}`);
  } else {
    console.log(`${ansi.dim}No tool selected.${ansi.reset}`);
  }
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
  process.stdout.write(label ? `\n${label}: ` : "\n");
  const line = await new Promise<string>((resolve) => {
    let buf = "";
    const onData = (data: Buffer) => {
      const text = data.toString("utf8");
      if (text.includes("\n") || text.includes("\r")) {
        process.stdin.off("data", onData);
        resolve(buf.trim());
      } else {
        buf += text;
      }
    };
    process.stdin.on("data", onData);
  });
  process.stdin.setRawMode?.(true);
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

async function installMenu(tools: Tool[]) {
  if (!process.stdin.isTTY) {
    console.error("Interactive menu requires a TTY. Try: bun run menu");
    process.exit(1);
  }

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdout.write(ansi.clear);
  console.log(`${ansi.bold}Install tools${ansi.reset}\n`);
  console.log("You can skip version detection for a faster menu load.");
  const shouldScan = await confirmLine("Check installed versions now", false);

  let status = shouldScan ? detectAllWithProgress(tools) : withUncheckedStatus(tools);
  const state: MenuState = { cursor: 0, selected: new Set(), filter: "", category: "All", force: false };
  const categories = groupedCategories(tools);

  while (true) {
    renderInstallMenu(tools, status, state);
    const visible = filteredTools(tools, state);
    const key = await readKey();

    if (key === "\u0003" || key.toLowerCase() === "q") {
      process.stdin.setRawMode?.(false);
      process.stdout.write(ansi.showCursor + "\n");
      process.exit(0);
    }

    if (key === "\u001b[A") {
      state.cursor = Math.max(0, state.cursor - 1);
      continue;
    }
    if (key === "\u001b[B") {
      state.cursor = Math.min(Math.max(0, visible.length - 1), state.cursor + 1);
      continue;
    }
    if (key === "\t") {
      const idx = categories.indexOf(state.category);
      state.category = categories[(idx + 1) % categories.length];
      state.cursor = 0;
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
      continue;
    }
    if (key === "/") {
      state.filter = await promptLine("Search");
      state.cursor = 0;
      continue;
    }
    if (key === "\b" || key === "\x7f" || key === "\u001b") {
      process.stdin.setRawMode?.(false);
      process.stdout.write(ansi.showCursor);
      return;
    }
    if (key === "\r" || key === "\n") {
      process.stdin.setRawMode?.(false);
      process.stdout.write("\n");
      const selected = tools.filter((tool) => state.selected.has(tool.id));
      await installTools(selected, status, state.force);
      return;
    }
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
    "Doctor",
    "List tools",
    "List tools with versions",
    "Exit",
  ];
  let cursor = 0;

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

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
    if (key === "\u0003" || key.toLowerCase() === "q") break;
    if (key === "\u001b[A") {
      cursor = Math.max(0, cursor - 1);
      continue;
    }
    if (key === "\u001b[B") {
      cursor = Math.min(options.length - 1, cursor + 1);
      continue;
    }
    if (key === "\r" || key === "\n") {
      process.stdin.setRawMode?.(false);
      process.stdout.write("\n");
      if (cursor === 0) await installMenu(tools);
      else if (cursor === 1) doctor(tools);
      else if (cursor === 2) listTools(tools, false);
      else if (cursor === 3) listTools(tools, true);
      else break;

      if (cursor !== 0) {
        console.log("\nPress Enter to return.");
        await promptLine("");
      }
      process.stdin.setRawMode?.(true);
    }
  }

  process.stdin.setRawMode?.(false);
  process.stdout.write(ansi.showCursor);
}

async function main() {
  const tools = loadTools();
  const [cmd, ...args] = Bun.argv.slice(2);

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

  console.log(`Usage:
  bun run menu
  bun run list
  bun run list -- --versions
  bun run doctor
  bun run src/index.ts install <tool-id...> [--force]
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
