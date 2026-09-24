# pepe-menus

Live menu data for chefpepe.com, pulled from Toast every 30 minutes by GitHub Actions and served from GitHub Pages.

- `menus/vesuvio.json` is what the website reads. Do not edit by hand; the next sync overwrites it.
- `config/vesuvio.json` maps Toast menu names to website menus, sets the order, hides junk items, and adds the vg / h/s flags.
- `sync/toast-sync.mjs` does the pull. It only writes when Toast reports a change, and it refuses to write a menu with fewer than `minItems` items, so a bad pull never blanks the site.

## Setup (once)

1. Settings, Secrets and variables, Actions: add `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET`, `TOAST_RESTAURANT_GUID`.
2. Settings, Pages: Source = GitHub Actions.
3. Actions tab, "Sync menus from Toast", Run workflow. Check `menus/vesuvio.json` afterwards.

The site reads `https://<user>.github.io/pepe-menus/menus/vesuvio.json`.

## Changing a menu

Change it in Toast. Within 30 minutes it is on the site. Nothing to upload.

To add a menu (say Lunch): add a row to `config/vesuvio.json` with the exact Toast menu name and a slug, then add the slug to the website's menu section.
