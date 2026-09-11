---
name: apple-login
description: Drive Apple Account (idmsa.apple.com) sign-in end-to-end with opencli only — fill email + password inside the same-origin auth iframe, submit via the double-click #sign-in trick that routes to the password SRP flow (not the passkey/SWP challenge), then fill the 2FA verification code. Use when the user wants to log into an Apple Account and land on the CloudKit Dashboard. NEVER click the passkey button; account + password only.
allowed-tools: Bash(opencli:*), Bash(npx tsx:*), Read, Edit, Write
---

# apple-login

Sign in to an Apple Account at idmsa.apple.com using **opencli only** to drive the
browser. The flow lands on the CloudKit Dashboard at
`icloud.developer.apple.com`.

A packaged adapter lives at `clis/apple-login/` and registers the
`apple-login/login` command. This skill is the operator's runbook for invoking
it, debugging a failed login, and re-applying the validated mechanics by hand
when the adapter cannot be run.

## Hard constraints (do not violate)

- **Browser ops only via opencli.** Never drive the page with anything else.
- **Account + password only.** NEVER click the passkey (`#swp`) button. The
  passkey flow does not submit the password and leaves the form stuck. The user
  has been explicit about this repeatedly — do not "helpfully" try the passkey.
- **Credentials in gitignored `.env`, never hardcoded.** `.env` holds
  `APPLE_LOGIN_USERNAME` / `APPLE_LOGIN_PASSWORD` / `APPLE_LOGIN_URL`. It is
  gitignored — verify with `git check-ignore .env` before touching it.

## Where things live

```
clis/apple-login/
  login.js         # cli() adapter: site=apple-login, name=login, Strategy.COOKIE, browser:true
  utils.js         # loadDotEnvOnce + iframe JS builders (fill/click/detect/2FA/pageInfo)
  commands.test.js # vitest (5 tests; mock page matches by first substring marker)
.env               # gitignored — real credentials, NOT committed
.env.example       # committed template
```

Run the adapter from the repo local entry (not the global install — the global
install's `dist/` does not read repo `clis/`):

```bash
cd /Users/ly/Documents/coderepo/opencli
npx tsx src/main.ts apple-login login                 # stops at 2FA, reports 2fa_required
npx tsx src/main.ts apple-login login --code 338535   # completes 2FA, lands on dashboard
```

Env args (CLI arg wins, env fallback, then built-in default URL):
`--username` / `--password` / `--url` / `--code`.

## Mechanics that make it work

These are the non-obvious bits that were validated end-to-end on 2026-09-11.
Full detail is in [`references/login-mechanics.md`](./references/login-mechanics.md).

1. **Same-origin iframe, not snapshot refs.** The login form is inside
   `<iframe id="aid-auth-widget-iFrame">` on idmsa.apple.com (same origin).
   opencli snapshot refs do NOT cross the iframe boundary. Every form op goes
   through `page.evaluate(js)` using `window.frames[0].document.querySelector(...)`.
   See `fillIframeInputJs` / `clickIframeButtonJs` / `detectStepJs` in `utils.js`.

2. **Password fill = native value setter + Event.** Apple's Ember components
   install a getter/setter override on the inputs; plain `el.value = v` can be
   swallowed. Use the native setter from
   `HTMLInputElement.prototype.value` then dispatch `Event('input')` +
   `Event('change')`. Wait ~2s after filling before clicking, so Ember's model
   settles — clicking too fast submits an empty password and the backend routes
   to the passkey challenge.

3. **THE KEY FIX: double-click `#sign-in`.** A single click routes the backend
   to the passkey (`SWP`) device challenge — `/auth/verify/device/key/challenge` —
   and the password is never submitted. Clicking `#sign-in` TWICE (first click
   triggers the SWP challenge, ~4s wait, second click cancels it and posts the
   password through the SRP flow: `/auth/signin/init` then `/auth/signin/complete`)
   reaches the 2FA step. Do NOT click `#swp`.

4. **2FA = per-digit InputEvent + KeyboardEvent with keyCode.** Six
   `<input type=tel>` boxes auto-submit when all six are filled with the full
   sequence per digit: native setter → `InputEvent('input', {data, inputType:
   'insertText', bubbles})` → `Event('change')` → `KeyboardEvent` keydown /
   keypress / keyup each carrying `keyCode`. Plain `.value=` assignment is NOT
   recognized and the boxes will not auto-submit. The 2FA code is per-session —
   the user reads it off a trusted device and passes it via `--code`.

## Runbook

### Happy path (adapter)

```bash
cd /Users/ly/Documents/coderepo/opencli
npx tsx src/main.ts apple-login login                 # → status: 2fa_required
# user reads the 6-digit code off their trusted device
npx tsx src/main.ts apple-login login --code <code>   # → status: ok, dashboard URL
```

### Manual fallback (drive opencli directly)

Use only if the adapter cannot be run (e.g. editing `utils.js` and needing to
test a single step). Keep the SAME mechanics — same-origin iframe via
`page.evaluate`, double-click `#sign-in`, per-digit 2FA events.

```bash
# fresh session
opencli browser apple open '<APPLE_LOGIN_URL>'

# fill email + password inside the iframe (native setter + input/change events)
opencli browser apple eval "$(cat /tmp/fill-creds.js)"

# wait for Ember, then DOUBLE-click #sign-in (NOT #swp)
opencli browser apple eval "window.frames[0].document.querySelector('#sign-in').click()"
sleep 4
opencli browser apple eval "window.frames[0].document.querySelector('#sign-in').click()"

# detect step: '2fa' | 'password' | 'logged_in'
opencli browser apple eval "(() => { const f = window.frames[0]; if (!f) return 'logged_in'; if (f.document.querySelectorAll('input[type=tel]').length >= 6) return '2fa'; return f.document.querySelector('#password_text_field') ? 'password' : 'logged_in'; })()"

# fill 2FA (per-digit InputEvent + KeyboardEvent with keyCode) — see references/login-mechanics.md
opencli browser apple eval "$(cat /tmp/fill-2fa.js)"
```

### Diagnosing a failure

| Symptom | Likely cause | Fix |
|---|---|---|
| Stuck on `password` step after clicking | Only clicked `#sign-in` once → routed to passkey SWP challenge | Click `#sign-in` a SECOND time (4s after the first) |
| 2FA boxes fill but don't submit | Filled with plain `.value=` only | Use full InputEvent + KeyboardEvent(keyCode) sequence per digit — use `fill2FACodeJs` |
| `ref not found` / `fill 44` / `click 48` errors | Used snapshot ref to reach into the iframe | Use `page.evaluate` with `window.frames[0].document.querySelector(...)` |
| AUTH: password rejected | Password field was empty when submitted (clicked too fast) | Wait 2s after filling before clicking; ensure native setter is used |
| 2FA code "invalid" but you just read it | Code was typed into a stale session that already failed | Start a fresh session; the code is bound to the current challenge |
| `opencli list` missing `apple-login/login` | Ran global install instead of repo entry, or manifest stale | Run via `npx tsx src/main.ts`; rebuild `npx tsx src/build-manifest.ts` after editing |

## After editing the adapter

```bash
cd /Users/ly/Documents/coderepo/opencli
npx vitest run clis/apple-login/        # 5 tests must pass
npx tsx src/build-manifest.ts           # rebuild cli-manifest.json
git add clis/apple-login/ cli-manifest.json
git commit -m "fix(apple-login): ..."
git push origin master
```

## Reference

- [`references/login-mechanics.md`](./references/login-mechanics.md) — the
  validated JS for iframe fill/click, the double-click `#sign-in` rationale,
  and the per-digit 2FA event sequence. Copy-paste source for `/tmp/*.js`
  scripts when driving opencli manually.