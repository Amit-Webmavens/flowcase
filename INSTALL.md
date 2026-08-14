# Installing flowcase in a project

flowcase is a workspace monorepo that produces four packages. Whichever way you install it, all four must end up resolvable together:

| Package | Role |
| --- | --- |
| `flowcase` | The CLI — provides the `flowcase` binary |
| `@flowcase/core` | Domain model, storage, selector and execution engines, recorder |
| `@flowcase/server` | REST + WebSocket control plane |
| `@flowcase/ui` | The built React interface |

Installing only the CLI will fail, because it depends on the other three.

---

## Prerequisites (any method)

- Node 20.11 or newer
- Playwright browsers, installed once per machine:

```bash
npx playwright install chromium
```

Add `firefox` or `webkit` too if you plan to test against them.

---

# Case 1 — flowcase is not published

## Method A: vendored tarballs (recommended for a team)

The install is recorded in the project's `package.json`, teammates get it from a plain `npm install`, and nothing global is touched.

**1. Build and pack the four packages:**

```bash
cd /path/to/flowcase
npm install
npm run build

mkdir -p /path/to/your-project/vendor/flowcase
for p in core server ui cli; do
  (cd packages/$p && npm pack --pack-destination /path/to/your-project/vendor/flowcase)
done
```

That produces four tarballs, about 700 KB in total:

```
vendor/flowcase/
  flowcase-core-0.1.0.tgz
  flowcase-server-0.1.0.tgz
  flowcase-ui-0.1.0.tgz
  flowcase-0.1.0.tgz
```

**2. Install them in your project:**

```bash
cd /path/to/your-project
npm i -D ./vendor/flowcase/flowcase-core-0.1.0.tgz \
         ./vendor/flowcase/flowcase-server-0.1.0.tgz \
         ./vendor/flowcase/flowcase-ui-0.1.0.tgz \
         ./vendor/flowcase/flowcase-0.1.0.tgz
```

Install the CLI **last** — npm resolves each tarball's dependencies against what is already present.

Your `package.json` now records stable, relative paths:

```json
{
  "devDependencies": {
    "@flowcase/core": "file:vendor/flowcase/flowcase-core-0.1.0.tgz",
    "@flowcase/server": "file:vendor/flowcase/flowcase-server-0.1.0.tgz",
    "@flowcase/ui": "file:vendor/flowcase/flowcase-ui-0.1.0.tgz",
    "flowcase": "file:vendor/flowcase/flowcase-0.1.0.tgz"
  }
}
```

**3. Commit `vendor/flowcase/`.** Teammates then need nothing but `npm install` and `npx playwright install chromium`.

**Upgrading:** re-pack, overwrite the tarballs, and run `npm install`. If the version number changed, update the four paths in `package.json` first.

> Keep the tarballs *inside* the project. If you install from a path outside it, npm records something like `file:../../tmp/flowcase-0.1.0.tgz`, which breaks for everyone else.

## Method B: `npm link` (fastest for one machine)

Best when you are changing flowcase and your project at the same time — edits show up immediately after a rebuild.

```bash
cd /path/to/flowcase
npm install
npm run build
npm link -w flowcase
```

`flowcase` is now on your PATH from any directory:

```bash
cd /path/to/your-project
flowcase --version
```

After changing flowcase, run `npm run build` again; the link already points at the built output.

To remove it: `npm unlink -g flowcase`.

**Trade-offs:** it is global, so only one version exists per machine; it does not appear in your project's `package.json`, so teammates and CI do not get it. Use Method A for anything shared.

## What does not work, and why

| Attempt | Result |
| --- | --- |
| `npm i -D flowcase` | Installs **an unrelated package** — see the warning below |
| `npm i github:Amit-Webmavens/flowcase` | The repo root is `private` with workspaces and exposes no binary |
| `npm i -D file:../flowcase/packages/cli` | The CLI alone; npm then tries to fetch `@flowcase/core` from the registry and fails |
| Installing the four tarballs CLI-first | Dependency resolution fails; install the CLI last |

> ### Do not run `npm i flowcase` yet
>
> The name `flowcase` on npm is already taken by an unrelated package (currently 0.1.2, maintained by `kamalbuildz`, described as "Capture a website login and save it to Flowcase for authenticated demo recording"). Installing it will silently give you someone else's code, not this project.

---

# Case 2 — flowcase is published

## For consumers

```bash
npm i -D <published-name>
npx playwright install chromium

npx flowcase init --base-url http://localhost:3000
npx flowcase ui
```

npm pulls `@flowcase/core`, `@flowcase/server` and `@flowcase/ui` in automatically as dependencies of the CLI — only one package needs to be installed by hand.

The binary is called `flowcase` regardless of the package's published name, so `npx flowcase …` always works.

Pin it like any other dev dependency:

```json
{ "devDependencies": { "@your-scope/flowcase": "^0.1.0" } }
```

## Publishing it in the first place

**The unscoped name `flowcase` is not available**, so publish under a scope you control — for example `@webmavens` or `@amit-webmavens`. Both were free at the time of writing.

**1. Rename the packages.** Four `package.json` `name` fields, plus the internal dependency entries and every `import` — 39 references across 24 files:

```bash
cd /path/to/flowcase
grep -rl "@flowcase/" packages --include="*.ts" --include="*.tsx" --include="*.json" \
  | grep -v node_modules | grep -v dist \
  | xargs sed -i 's|@flowcase/|@webmavens/|g'
```

Then change `packages/cli/package.json` from `"name": "flowcase"` to `"name": "@webmavens/flowcase"`, leaving the `bin` entry as `"flowcase"` so the command name is unchanged. Rebuild and run the tests before going further.

**2. Log in:**

```bash
npm login
npm whoami
```

**3. Publish in dependency order** — a package cannot be published before the packages it depends on:

```bash
cd packages/core   && npm publish --access public
cd ../server       && npm publish --access public
cd ../ui           && npm publish --access public
cd ../cli          && npm publish --access public
```

`--access public` is required: scoped packages default to private, which needs a paid plan.

**4. Verify from a clean directory:**

```bash
cd $(mktemp -d) && npm init -y
npm i -D @webmavens/flowcase
npx flowcase --version
```

### Notes on publishing

- The monorepo root is `private: true` and is never published — only the four workspace packages are.
- Each package's `files` field limits the tarball to `dist/`, so no source or tests are shipped. `@flowcase/ui` also ships `resolve.js`, which tells the server where the built interface lives.
- `npm run build` must succeed first; the tarballs contain build output only.
- Bump all four versions together and publish them together. Mixed versions will not resolve, because each package depends on the others by an exact-ish range.

---

# After installing, either way

```bash
cd /path/to/your-project

flowcase init --name "My app" --base-url http://localhost:3000
flowcase ui        # the no-code interface, http://127.0.0.1:4100
```

Add to your project's `.gitignore`:

```
.flowcase/runs/
.flowcase/sessions/
```

`sessions/` holds real login cookies; `runs/` holds videos and screenshots. Commit everything else under `.flowcase/` — tests, snippets, environments and schedules are readable JSON that diffs cleanly in review.

Then:

```bash
flowcase record    # record a test from the terminal
flowcase list      # execution order, dependencies resolved
flowcase run       # exits non-zero if anything fails
```

`flowcase run --tag smoke` is the usual CI entry point. See `README.md` for what the tool can do once it is set up.
