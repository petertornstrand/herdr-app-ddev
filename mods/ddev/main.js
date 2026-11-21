// DDEV status, one-click start/stop and a `ddev describe` view.
//   mod.open:ddev                          a popup
//   pane.split {mod: "ddev"}               a side pane
// The project of the focused terminal's folder comes first, then running projects,
// then the rest. Click a project's name to see what `ddev describe` says about it.
// Data comes from `ddev list -j` (and `ddev describe <name> -j` for the open project),
// polled gently while a copy is open.
//   herdr-app do ddev.add-button           a DDEV button in the tab bar (see setup.js)
//   herdr-app do ddev.remove-button        take it away again
//   herdr-app do ddev.update-check-off     never look for a newer DDEV mod (update-check-on: again)
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, focused, notify, theme, checking, props, nextCommand, agents, hc } from "herdr";
import { addButton, removeButton } from "./setup.js";
import { newer, installedVersion, checkUpdate, setUpdateCheck, updatePrompt } from "./update.js";

const POLL = 10000;
const START_TIMEOUT = 600000; // exec's cap: ddev start can pull images

/** ddev may print log lines first; the JSON object is the last line that starts with "{". */
function parseRaw(stdout) {
  const line = stdout.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  return JSON.parse(line ?? "{}").raw;
}

function parseList(stdout) {
  const raw = parseRaw(stdout);
  if (!Array.isArray(raw)) throw new Error("Unexpected output from ddev list -j");
  return raw.map((p) => ({ name: p.name, status: p.status, approot: p.approot, shortroot: p.shortroot, type: p.type, url: p.primary_url || null }));
}

/** The project whose folder contains cwd (the deepest one, since projects can nest). */
export function projectFor(projects, cwd) {
  if (!cwd) return null;
  return projects
    .filter((p) => cwd === p.approot || cwd.startsWith(p.approot + "/"))
    .sort((a, b) => b.approot.length - a.approot.length)[0] ?? null;
}

const lastLines = (s, n = 4) => s.trim().split("\n").slice(-n).join("\n");

// "ddev/ddev-webserver:v1.25.5" -> "ddev-webserver:v1.25.5"
const shortImage = (img) => (img ?? "").split("/").slice(-1)[0];

const DB_NAMES = { mariadb: "MariaDB", mysql: "MySQL", postgres: "PostgreSQL" };

export default class Ddev extends View {
  init(_props, cx) {
    this.projects = [];
    this.busy = new Map(); // name -> "starting" | "stopping"
    this.error = null;
    this.loaded = false;
    this.refreshing = false;
    this.detail = null; // { name, data, error } while a project's describe is open
    this.describing = false;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(POLL, (cx) => { this.refresh(cx); this.loadDetail(cx); });
    // A newer DDEV mod on GitHub (update.js): looked for now and every 6 hours; the
    // answer is shared, so GitHub is asked at most once a day.
    this.version = null;
    this.latest = null;
    this.lookForUpdate = (cx) => cx.spawn(async (cx) => {
      try {
        this.version ??= await installedVersion();
        const { latest } = await checkUpdate();
        if (latest !== this.latest) {
          this.latest = latest;
          cx.notify();
        }
      } catch (_) {}
    });
    this.lookForUpdate(cx);
    cx.timer.every(6 * 3600000, (cx) => this.lookForUpdate(cx));
    // Key and `herdr-app do ddev.<command>` commands reach the shown copies.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "add-button" || c === "remove-button") this.setup(c, cx);
        else if (c === "update-check-off") {
          setUpdateCheck(false);
          this.latest = null;
          cx.notify();
        } else if (c === "update-check-on") {
          setUpdateCheck(true);
          this.lookForUpdate(cx);
        }
      }
    });
  }

  /** The update banner's button: the focused agent does the update, so it reads the new files before they go in. */
  askUpdate(cx) {
    const agent = agents().find((a) => a.focused);
    if (!agent) {
      notify({ title: `DDEV ${this.latest}`, body: "Focus an agent's terminal and click again, or ask any agent to update the DDEV mod.", level: "info", timeout: 8000 });
      return;
    }
    cx.spawn(async () => {
      try {
        const r = await hc(["send", agent.address, updatePrompt(this.latest, this.version)]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `hc send ${r.code}`).trim());
        notify({ title: "Asked the agent to update DDEV", body: `${this.version ?? "?"} → ${this.latest}`, level: "success", timeout: 5000 });
      } catch (err) {
        notify({ title: "Couldn't reach the agent", body: String(err?.message ?? err), level: "error" });
      }
    });
  }

  // The tab bar button: see setup.js.
  setup(c, cx) {
    cx.spawn(async (cx) => {
      const wait = (ms) => new Promise((done) => cx.timer.after(ms, () => done()));
      try {
        const said = await (c === "add-button" ? addButton : removeButton)(wait);
        notify({ title: "DDEV", body: said, level: "success", timeout: 6000 });
      } catch (err) {
        notify({ title: "DDEV", body: String(err?.message ?? err), level: "error" });
      }
    });
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("ddev", ["list", "-j"], { timeout: 20000 });
        if (r.code !== 0) throw new Error(lastLines(r.stderr || r.stdout) || `ddev exited with ${r.code}`);
        this.projects = parseList(r.stdout);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loaded = true;
      this.refreshing = false;
      cx.notify();
    });
  }

  openDetail(p, cx) {
    this.detail = { name: p.name, data: null, error: null };
    this.describing = false;
    this.loadDetail(cx);
    cx.notify();
  }

  closeDetail(cx) {
    this.detail = null;
    cx.notify();
  }

  loadDetail(cx) {
    const d = this.detail;
    if (!d || this.describing) return;
    this.describing = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("ddev", ["describe", d.name, "-j"], { timeout: 20000 });
        if (r.code !== 0) throw new Error(lastLines(r.stderr || r.stdout) || `ddev describe exited with ${r.code}`);
        const raw = parseRaw(r.stdout);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Unexpected output from ddev describe -j");
        if (this.detail === d) { d.data = raw; d.error = null; }
      } catch (e) {
        if (this.detail === d) d.error = String(e?.message ?? e);
      }
      this.describing = false;
      cx.notify();
    });
  }

  act(p, verb, cx) {
    if (this.busy.has(p.name)) return;
    this.busy.set(p.name, verb === "start" ? "starting" : "stopping");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("ddev", [verb], { cwd: p.approot, timeout: START_TIMEOUT });
        if (r.code !== 0) throw new Error(lastLines(r.stderr || r.stdout) || `ddev ${verb} exited with ${r.code}`);
        notify({ title: `DDEV ${verb === "start" ? "started" : "stopped"}: ${p.name}`, level: "success", timeout: 3000 });
      } catch (e) {
        notify({ title: `ddev ${verb} failed: ${p.name}`, body: String(e?.message ?? e), level: "error", timeout: 10000 });
      }
      this.busy.delete(p.name);
      this.refreshing = false;
      this.refresh(cx);
      this.loadDetail(cx);
      cx.notify();
    });
  }

  openUrl(url) {
    if (url) exec("xdg-open", [url]).catch(() => {});
  }

  render() {
    const t = theme();
    const here = projectFor(this.projects, focused()?.cwd);
    const rank = (p) => (p === here ? 0 : p.status === "running" ? 1 : 2);
    const sorted = [...this.projects].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const running = this.projects.filter((p) => p.status === "running").length;

    const statusColor = (s) => (s === "running" ? t.ansi2 : s === "stopped" ? t.dim : t.ansi3);

    const dot = (p) => {
      if (this.busy.has(p.name)) return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
      return div().size(8).mx(3).flex_none().rounded(4).bg(statusColor(p.status));
    };

    const button = (id, label, onClick, strong) =>
      div().id(id).flex_none().px(10).h(22).rounded(4).flex().items_center().text_size(12)
        .border(1).border_color(strong ? t.accent : t.border)
        .text_color(strong ? t.accent : t.foreground)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);

    // Start / Stop / progress for one project, shared by the list and the detail header.
    const actionFor = (p, idPrefix) => {
      const busy = this.busy.get(p.name);
      if (busy) return div().flex_none().text_size(12).text_color(t.dim).child(busy === "starting" ? "Starting…" : "Stopping…");
      if (p.status === "running") return button(`${idPrefix}stop-${p.name}`, "Stop", (cx) => this.act(p, "stop", cx));
      if (p.status === "stopped" || p.status === "paused") return button(`${idPrefix}start-${p.name}`, "Start", (cx) => this.act(p, "start", cx), true);
      return div().flex_none().text_size(11).text_color(t.dim).truncate().child(p.status);
    };

    const row = (p) => {
      const busy = this.busy.get(p.name);
      return h_flex().id(`row-${p.name}`).items_center().gap(8).px(12).h(36).flex_none()
        .when(p === here, (el) => el.bg(t.selected))
        .child(dot(p))
        .child(v_flex().id(`info-${p.name}`).flex_1().min_w(0).h_full().justify_center()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.openDetail(p, cx))
          .child(div().text_size(13).text_color(t.foreground).truncate().child(p.name))
          .child(div().text_size(11).text_color(t.dim).truncate().child(p.shortroot)))
        .when(p.status === "running" && p.url && !busy, (el) =>
          el.child(button(`open-${p.name}`, "Open", () => this.openUrl(p.url))))
        .child(actionFor(p, ""));
    };

    // --- the describe view ---------------------------------------------------

    const section = (title) =>
      div().px(12).pt(12).pb(4).text_size(11).font_semibold().text_color(t.dim).child(title.toUpperCase());

    const kv = (label, value) =>
      value == null || value === ""
        ? null
        : h_flex().px(12).gap(8).min_h(20).items_start()
          .child(div().w(104).flex_none().text_size(12).text_color(t.dim).child(label))
          .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(String(value)));

    const link = (id, url, live) =>
      live
        ? div().id(id).mx(6).px(6).min_h(20).rounded(4).flex().items_center().text_size(12).text_color(t.accent)
          .hover((s) => s.bg(t.hover)).on_click(() => this.openUrl(url)).truncate().child(url)
        : div().px(12).min_h(20).flex().items_center().text_size(12).text_color(t.dim).truncate().child(url);

    const describeBody = () => {
      const d = this.detail;
      if (d.error && !d.data) return div().p(12).text_size(12).text_color(t.ansi1).child(d.error);
      if (!d.data) return div().p(12).text_size(12).text_color(t.dim).child("Loading…");
      const x = d.data;
      const live = x.status === "running";
      const dbName = DB_NAMES[x.database_type] ?? x.database_type;
      const urls = [
        ...(x.hostnames ?? []).map((h) => `https://${h}`),
        ...(live && x.mailpit_https_url ? [x.mailpit_https_url] : []),
        ...(live && x.services?.xhgui?.status === "running" && x.xhgui_https_url ? [x.xhgui_https_url] : []),
      ];
      const services = Object.values(x.services ?? {});
      const db = x.dbinfo;
      return v_flex().pb(12)
        .child(section("Project"))
        .children([
          kv("Status", x.status_desc && x.status_desc !== x.status ? `${x.status} (${x.status_desc})` : x.status),
          kv("Type", x.type),
          kv("Location", x.shortroot),
          kv("Docroot", x.docroot),
          kv("PHP", x.php_version),
          kv("Web server", x.webserver_type),
          kv("Database", dbName ? `${dbName} ${x.database_version ?? ""}`.trim() : null),
          kv("Node.js", x.nodejs_version),
          kv("Router", x.router ? `${x.router}${x.router_status ? ` (${x.router_status})` : ""}` : null),
          kv("Performance", x.mutagen_enabled ? "Mutagen" : x.performance_mode),
          kv("Xdebug", x.xdebug_enabled == null ? null : x.xdebug_enabled ? "on" : "off"),
        ].filter(Boolean))
        .when(urls.length > 0, (el) => el.child(section("URLs")).children(urls.map((u, i) => link(`url-${i}`, u, live))))
        .when(Boolean(db), (el) => el.child(section("Database")).children([
          kv("In container", `${db.host}:${db.dbPort}`),
          kv("From host", db.published_port > 0 ? `127.0.0.1:${db.published_port}` : null), // -1 while stopped
          kv("Name", db.dbname),
          kv("User", db.username),
        ].filter(Boolean)))
        .when(services.length > 0, (el) => el.child(section("Services")).children(services.map((s) =>
          h_flex().px(12).gap(8).min_h(20).items_start()
            .child(div().size(8).mt(5).flex_none().rounded(4).bg(statusColor(s.status === "running" ? "running" : s.status === "stopped" ? "stopped" : "other")))
            .child(div().w(72).flex_none().text_size(12).text_color(t.foreground).child(s.short_name))
            .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate()
              .child([shortImage(s.image), s.describe_url_port || s["describe-url-port"], s["describe-info"]].filter(Boolean).join(" · "))))));
    };

    // --- header and body -----------------------------------------------------

    let header, body;
    const detailProject = this.detail && this.projects.find((p) => p.name === this.detail.name);
    if (this.detail) {
      header = h_flex().h(36).flex_none().px(12).items_center().gap(8).border_b(1).border_color(t.border)
        .child(button("back", "← Back", (cx) => this.closeDetail(cx)))
        .child(div().flex_1().min_w(0).text_size(13).font_semibold().text_color(t.foreground).truncate().child(this.detail.name))
        .child(button("describe-refresh", "Refresh", (cx) => this.loadDetail(cx)))
        .when(Boolean(detailProject), (el) => el.child(actionFor(detailProject, "d-")));
      body = v_flex().id("ddev-describe").flex_1().min_h(0).overflow_y_scrollbar().child(describeBody());
    } else {
      header = h_flex().h(36).flex_none().px(12).items_center().gap(8).border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child("DDEV"))
        .child(div().text_size(11).text_color(t.dim).child(this.loaded ? `${running} running of ${this.projects.length}` : "Loading…"))
        .child(button("refresh", "Refresh", (cx) => this.refresh(cx)));
      body = this.error
        ? div().p(12).text_size(12).text_color(t.ansi1).child(this.error)
        : v_flex().id("ddev-list").flex_1().min_h(0).overflow_y_scrollbar().children(sorted.map(row));
    }

    // A newer version on GitHub (update.js).
    const update = this.latest && newer(this.latest, this.version)
      ? h_flex().flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised)
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).child(`DDEV ${this.latest} is out (you have ${this.version ?? "?"}).`))
        .child(button("update", "Update", (cx) => this.askUpdate(cx), true))
      : null;

    // A popup sizes to its content, so give it a definite height; a pane fills its block.
    const root = props()?.overlay ? v_flex().w_full().h(560) : v_flex().size_full();
    return root.bg(t.surface).child(header).when(Boolean(update), (el) => el.child(update)).child(body);
  }
}
