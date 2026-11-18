# Herdr DDEV

A [Herdr app](https://herdr.dev) mod that shows the status of your [DDEV](https://ddev.com)
projects and starts or stops them with one click.

![Herdr DDEV](preview.png)

- Lists every project from `ddev list`, with a status dot and its location.
- The project of the focused terminal's folder comes first and is highlighted, then
  running projects, then the rest.
- **Start** / **Stop** run `ddev start` / `ddev stop` in the project's folder. A spinner
  shows while it works, and a notification reports the result (or the last lines of
  ddev's error).
- **Open** opens a running project's primary URL with `xdg-open`.
- Click a project's name for what `ddev describe` says: type, PHP, web server, database,
  Node.js, router, performance mode, URLs (clickable when running), database connection
  details and services with their status and image. The database password is not shown.

![The describe view](docs/describe.png)

The screenshots use made-up projects.

## Install

Needs the Herdr desktop app and `ddev` on your `PATH`. Linux/macOS URL opening uses
`xdg-open` (Linux); on macOS change it to `open` in `openUrl()`.

```sh
git clone https://github.com/petertornstrand/herdr-app-ddev
cp -r herdr-app-ddev/mods/ddev ~/.config/herdr-app/mods/ddev
herdr-app check ~/.config/herdr-app/mods/ddev
```

Or ask your agent: *Read ~/.config/herdr-app/AGENTS.md, then add this mod:
herdr.dev/mods/petertornstrand/herdr-app-ddev*.

Open it as a popup with the `mod.open:ddev` command, or as a side pane with
`herdr-app do pane.split --direction right --mod ddev`. To bind a key, add this under
`global` in `~/.config/herdr-app/keys.json`:

```json
"ctrl-shift-d": "mod.open:ddev"
```

## What it runs and reads

Mods are trusted code, so for the record: `ddev list -j`, `ddev describe <name> -j`
(every 10 seconds while open), `ddev start|stop` in a project's folder on click and
`xdg-open <url>` on click. No network access of its own and nothing is written to disk.

## License

MIT
