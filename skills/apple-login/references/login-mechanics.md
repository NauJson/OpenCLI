# Login Mechanics — Apple Account (idmsa.apple.com)

Validated end-to-end on 2026-09-11 against idmsa.apple.com → CloudKit Dashboard.
All JS here is meant to be passed to `opencli browser <session> eval "<js>"` or
to `page.evaluate(<jsString>)` inside the adapter.

## 1. Same-origin iframe targeting

The sign-in form renders inside `<iframe id="aid-auth-widget-iFrame">` on
idmsa.apple.com. It is same-origin, so `window.frames[0].document` reaches it.
opencli's snapshot refs do NOT cross the iframe boundary — `fill <ref>` and
`click <ref>` against the iframe contents fail with `ref not found`.

Every form interaction is a `page.evaluate` whose JS reaches into
`window.frames[0].document`.

### Fill a single input (email / password)

This is `fillIframeInputJs(selector, value)` from `clis/apple-login/utils.js`.
Apple's Ember components install a getter/setter override on the inputs; the
**native setter** from `HTMLInputElement.prototype.value` bypasses it and lands
the value in Ember's model so the password is actually submitted.

```js
(() => {
  const f = window.frames[0];
  if (!f || !f.document) return { error: 'no iframe' };
  const el = f.document.querySelector('#account_name_text_field');
  if (!el) return { error: 'element not found' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  el.focus();
  setter.call(el, 'zhangheng_nj@163.com');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: el.value };
})()
```

For the password, same thing against `#password_text_field`.

> **Sequence that originally worked** (kept as the committed version in
> `utils.js`): native setter + `Event('input')` + `Event('change')`.
> Per-character key events and InputEvent variants on the password field were
> tried and either failed or were inconsistent — do not regress to them.

### Click a button inside the iframe

`clickIframeButtonJs(selector)`:

```js
(() => {
  const f = window.frames[0];
  if (!f || !f.document) return { error: 'no iframe' };
  const el = f.document.querySelector('#sign-in');
  if (!el) return { error: 'element not found' };
  el.click();
  return { ok: true, clicked: true };
})()
```

### Detect the current step

`detectStepJs()`:

```js
(() => {
  const f = window.frames[0];
  if (!f || !f.document) return { step: 'logged_in' };
  const codeInputs = f.document.querySelectorAll('input[type=tel]');
  if (codeInputs.length >= 6) return { step: '2fa' };
  const pw = f.document.querySelector('#password_text_field');
  if (pw) return { step: 'password' };
  return { step: 'logged_in' };
})()
```

Returns: `'2fa'` (≥6 `input[type=tel]`), `'password'` (still on the form), or
`'logged_in'` (iframe gone / navigated away).

## 2. Submit: double-click `#sign-in` (the key fix)

A **single** click on `#sign-in` routes the backend to the passkey (SWP)
device challenge — `POST /auth/verify/device/key/challenge` — and the password
is **never submitted**. The form stays stuck on the password page. The trace
shows `primaryAuthOptions: ["SWP"]`.

Clicking `#sign-in` **twice** works:
- 1st click → triggers the SWP challenge
- (~4s wait)
- 2nd click → cancels the SWP challenge and posts the password through the SRP
  flow: `POST /appleauth/auth/signin/init` then `/auth/signin/complete`
- → reaches the 2FA step

**Do NOT click `#swp`.** It commits to the passkey flow outright.

Validated sequence (manual, before packaging):

```bash
opencli browser apple eval "window.frames[0].document.querySelector('#sign-in').click()"
sleep 4
opencli browser apple eval "window.frames[0].document.querySelector('#sign-in').click()"
```

In the adapter (`login.js`):

```js
await page.evaluate(clickIframeButtonJs('#sign-in'));
await page.wait({ time: 4 });
await page.evaluate(clickIframeButtonJs('#sign-in'));
// then poll detectStep 8×2s until step !== 'password'
```

Also wait ~2s after filling the password and before the first click, so Ember's
model settles. Clicking too fast submits an empty password.

## 3. 2FA: per-digit InputEvent + KeyboardEvent with keyCode

The 2FA step shows six `<input type=tel>` boxes that **auto-submit** once all
six digits are filled — but only if each digit is set with the full event
sequence. Plain `el.value = d` is not recognized; the boxes will not
auto-submit.

`fill2FACodeJs(code)` from `utils.js`:

```js
(() => {
  const f = window.frames[0];
  if (!f || !f.document) return { error: 'no iframe' };
  const inputs = f.document.querySelectorAll('input[type=tel]');
  if (inputs.length < 6) return { error: 'not enough code inputs', n: inputs.length };
  const code = '338535';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  for (let i = 0; i < 6; i++) {
    const el = inputs[i];
    const ch = code[i] || '';
    el.focus();
    setter.call(el, ch);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const kc = ch ? ch.charCodeAt(0) : 48;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: 'Digit' + ch, keyCode: kc, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, keyCode: kc, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code: 'Digit' + ch, keyCode: kc, bubbles: true }));
  }
  return { ok: true, vals: Array.from(inputs).map((e) => e.value) };
})()
```

After filling, poll `detectStepJs()` until it leaves `'2fa'` (→ `'logged_in'`
on success, or back to `'password'` if the code was rejected). A 2FA code is
bound to the current challenge; if the session already failed (e.g. stuck on
password from a single-click), start a fresh session before retrying — the
same code won't validate twice.

## 4. Credentials & env

`.env` (gitignored, NOT committed):

```
APPLE_LOGIN_USERNAME=zhangheng_nj@163.com
APPLE_LOGIN_PASSWORD=<password>
APPLE_LOGIN_URL=https://idmsa.apple.com/IDMSWebAuth/signin?appIdKey=2bd7197b69c47f19a2230102e44970030ca15dae4afedcf593984ff1ae03e874&offerNativeTakeOver=false&path=%2Fdashboard%2F&rv=4
```

`loadDotEnvOnce()` reads `<repo-root>/.env` into `process.env` (only for keys
not already set), called at the top of the adapter `func`. No dotenv
dependency. CLI args override env; env overrides the built-in default URL.

Verify `.env` stays gitignored after any change:

```bash
git check-ignore .env   # must print ".env"
```