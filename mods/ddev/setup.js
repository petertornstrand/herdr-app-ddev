// The tab bar button next to Files and Changes that opens DDEV as a side panel.
// Herdr's own `main` layout and `tabs` mod are read-only (replaced on every start),
// so this clones them as main-ddev and tabs-ddev, patches the clones and switches
// the window to them. It runs on Herdr's own JS runtime: no shell, no Python.
//
//   herdr-app do ddev.add-button      (with a DDEV pane or popup open)
//   herdr-app do ddev.remove-button
//
// Clones are the person's and never updated by Herdr. After a Herdr release changes
// the tab bar or the main layout: remove-button, then add-button. Running either twice
// is fine: steps already done are skipped.

import * as fs from "fs/promises";
import { appHome, run, shared } from "herdr";

const LAYOUT = "main-ddev", TABS = "tabs-ddev";
const app = () => appHome().replace(/\\/g, "/");
const previousFile = () => `${app()}/data/ddev/previous-layout.txt`;

// run() only queues a command; wait for what it makes.
async function appears(path, wait) {
  for (let i = 0; i < 50; i++) {
    if (await fs.exists(path)) return;
    await wait(100);
  }
  throw new Error(`${path} did not appear`);
}

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

// The tab bar: "ddev" among the panels and its button after Changes.
export function patchTabs(s) {
  if (s.includes('"ddev"')) return s;
  const enabled = 'const enabled = shared("workspace.panels") ?? ["files", "changes"];';
  const changes = 'el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))';
  if (!s.includes(enabled) || !s.includes(changes)) throw new Error("This Herdr's tab bar changed: add the button by hand (see mods/ddev/setup.js)");
  return s.replace(enabled, 'const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "ddev"];')
    .replace(changes, `${changes}\n      .child(panelButton("ddev", "DDEV", "mods/ddev/icon.svg"))`);
}

// The layout: the cloned tab bar, and DDEV as one more side panel.
export function patchLayout(d) {
  const tabs = find(d, "tabs"), body = find(d, "panel-body");
  if (!tabs?.content || !body?.children) throw new Error("This Herdr's main layout changed: add the panel by hand (see mods/ddev/setup.js)");
  tabs.content.mod = TABS;
  if (!body.children.some((c) => c.id === "ddev")) {
    body.children.push({ id: "ddev", type: "block", content: { mod: "ddev" } });
  }
  return d;
}

export async function addButton(wait) {
  const now = shared("layout");
  if (now && now !== LAYOUT) {
    await fs.mkdir(`${app()}/data/ddev`, { recursive: true });
    await fs.writeFile(previousFile(), String(now));
  }
  const tabsMain = `${app()}/mods/${TABS}/main.js`;
  if (!(await fs.exists(tabsMain))) {
    run("mod.clone", { name: "tabs", as: TABS });
    await appears(tabsMain, wait);
  }
  const src = await fs.readFile(tabsMain, "utf8");
  const patched = patchTabs(src);
  if (patched !== src) await fs.writeFile(tabsMain, patched);
  // The layout file is written here rather than with layout.clone, which switches to
  // it before it has the panel. It starts from main's file; clicks made on main
  // (sizes, theme) stay with main.
  const file = `${app()}/layouts/${LAYOUT}.json`;
  const base = (await fs.exists(file)) ? file : `${app()}/layouts/main.json`;
  const d = JSON.parse(await fs.readFile(base, "utf8"));
  const text = `${JSON.stringify(patchLayout(d), null, 2)}\n`;
  if (base !== file || text !== (await fs.readFile(file, "utf8"))) await fs.writeFile(file, text);
  run("layout.switch", { name: LAYOUT });
  return `DDEV button added: layout ${LAYOUT} (ctrl-shift-l switches back)`;
}

export async function removeButton(wait) {
  let back = "main";
  try {
    back = (await fs.readFile(previousFile(), "utf8")).trim() || "main";
  } catch (_) {}
  if (back === LAYOUT) back = "main";
  if (shared("layout") === LAYOUT) {
    run("layout.switch", { name: back });
    await wait(500); // let the window leave the clones before they go
  }
  await fs.unlink(`${app()}/layouts/${LAYOUT}.json`).catch(() => {});
  const dir = `${app()}/mods/${TABS}`;
  if (await fs.exists(dir)) {
    for (const f of await fs.readdir(dir)) await fs.unlink(`${dir}/${f}`).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
  }
  await fs.unlink(previousFile()).catch(() => {});
  return `DDEV button removed: back to layout ${back}`;
}
