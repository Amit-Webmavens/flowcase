# flowcase

A no-code, React-based end-to-end test runner built on Playwright.

Testers record a flow by using the app, and flowcase turns it into steps they can edit, chain, parameterise and schedule — without writing test code. Engineers can export any test back out as a plain Playwright spec, so nothing is locked in.

```bash
npm install -D flowcase
npx playwright install chromium
npx flowcase init --base-url http://localhost:3000
npx flowcase ui
```

## What it does

**Record instead of write.** `flowcase record` (or the Recorder screen) opens a real browser with a small toolbar. Click through your app; every click, entry and selection becomes a step. It handles dynamic sites — late-mounted DOM, SPA route changes, iframes and shadow DOM — because capture is delegated from `document` and re-injected on every navigation and in every frame.

**Selectors that survive a redesign.** Each recorded element keeps a ranked list of selectors (test id, role + accessible name, label, placeholder, text, CSS, XPath) plus a fingerprint of what the element looked like. When the primary selector stops matching, flowcase tries the fallbacks and only accepts one whose element still resembles what was recorded — so a renamed button heals, and an unrelated match does not.

**Tests that build on each other.** A test can depend on others. Running one alone pulls in its dependencies in the right order, hands down the browser session so logins are not repeated, and passes along captured values. Cycles are detected and reported rather than hanging.

**Runtime values.** Capture the id from a redirect URL, from page text, from an element attribute, or from a JSON API response, and use it as `{{orderId}}` in later steps and in dependent tests.

**Parameterised and data-driven.** Any field accepts `{{variables}}`, filters (`{{name | upper}}`) and generators (`{{$uuid}}`, `{{$randomEmail}}`, `{{$date}}`). Attach a data set to repeat a step per row, or to run a whole test once per row.

**When it fails, you can see why.** Failures keep a video, a screenshot taken at the failing step, a Playwright trace, and the console and network logs — all linked from the run report.

## Commands

| Command | What it does |
| --- | --- |
| `flowcase init` | Create a project in the current directory |
| `flowcase ui` | Open the no-code interface (default `http://127.0.0.1:4100`) |
| `flowcase record` | Record a test from the terminal |
| `flowcase run [tests...]` | Run tests; exits non-zero if any fail |
| `flowcase list` | List tests in the order they would run |

`flowcase run` is the CI entry point:

```bash
flowcase run --tag smoke --approved-only
flowcase run --tag smoke --dry-run     # resolve everything, run nothing
flowcase run -c 4                      # run independent tests in parallel
```

## Features

- Action recorder with dynamic-site support, plus an in-page pause/assert toolbar
- Test dependency graph — run one test and its chain resolves automatically
- Repeats: fixed count, from a variable, per data-set row, or until an element appears/disappears
- Runtime extraction from URL, text, attributes, field values, page title, API responses, storage
- Data-driven runs and parameterised field values with generators and filters
- Per-step retry, timeout and failure policy (stop / soft / ignore)
- Soft assertions — the run continues and reports every problem
- Selector self-healing with confidence scoring
- Network mocking and stubbing, per test or toggled mid-test
- Session reuse across chained tests, and named saved sessions
- Visual regression against approved screenshot baselines
- Environment profiles, with secrets referenced from the process environment
- Reusable snippets shared across tests
- Versioning with a step-level diff view, and an approval workflow
- Tagging and filtering, dry-run preview, step comments
- Scheduling with Slack or webhook notifications on failure
- Live run dashboard over a WebSocket, including parallel runs
- Export any test as a standalone Playwright spec

## How a project is stored

Everything lives in a `.flowcase` directory next to your app. Test definitions are readable JSON under slug file names, so changes show up in a git diff and can be reviewed like code.

```
.flowcase/
  flowcase.json           project config
  tests/<slug>.json       test definitions
  snippets/<slug>.json    reusable fragments
  environments/<slug>.json
  schedules/<slug>.json
  history/<testId>/v<n>.json   superseded versions, for the diff view
  runs/index.ndjson       append-only run history
  runs/<runId>/           run.json plus screenshots, video, trace, logs
  baselines/<testId>/     approved screenshots
  sessions/<name>.json    saved logins
```

Run history is an append-only NDJSON index rather than a database, so listing and filtering stay fast while the whole project remains plain files.

Commit `tests/`, `snippets/`, `environments/` and `schedules/`. Add `runs/` and `sessions/` to `.gitignore` — they hold artifacts and credentials.

## Secrets

Environment profiles never store secret values. They map a variable name to the name of a process environment variable:

```json
{ "secretRefs": { "adminPassword": "STAGING_ADMIN_PASSWORD" } }
```

`{{adminPassword}}` then resolves from `process.env.STAGING_ADMIN_PASSWORD` at run time.

## Exporting to Playwright

Any test can be rendered as an ordinary `@playwright/test` spec — locators become `getByRole`/`getByTestId` calls, groups become `test.step`, repeats become loops, and captured values become assignments. The output has no dependency on flowcase.

## Packages

| Package | Purpose |
| --- | --- |
| `flowcase` | The CLI; this is what you install |
| `@flowcase/core` | Domain model, storage, selector engine, execution engine, recorder |
| `@flowcase/server` | REST + WebSocket control plane |
| `@flowcase/ui` | The React interface |

`@flowcase/core` is usable on its own if you want to drive runs from your own code:

```ts
import { ProjectStore, startRun } from '@flowcase/core';

const store = await ProjectStore.open();
const run = await startRun({ store, tags: ['smoke'] });
```

## Development

```bash
npm install
npx playwright install chromium
npm run build
npm test
```

## Requirements

Node 20.11 or newer. Playwright browsers are installed separately with `npx playwright install`.

## Licence

MIT
