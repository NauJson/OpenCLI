/**
 * Apple Account login adapter utilities.
 *
 * The Apple ID sign-in form (idmsa.apple.com) renders inside a same-origin
 * <iframe id="aid-auth-widget-iFrame">. opencli's snapshot refs do not cross
 * the iframe boundary, so every form interaction is driven through
 * page.evaluate(jsString) targeting window.frames[0].document.
 *
 * The 2FA code uses six <input type=tel> boxes that auto-submit when all six
 * are filled with an InputEvent + keydown/keyup sequence carrying a keyCode.
 * Plain .value= assignment is not recognized by Apple's Ember components.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const APPLE_LOGIN_DEFAULT_URL =
  'https://idmsa.apple.com/IDMSWebAuth/signin?appIdKey=2bd7197b69c47f19a2230102e44970030ca15dae4afedcf593984ff1ae03e874&offerNativeTakeOver=false&path=%2Fdashboard%2F&rv=4';

let dotEnvLoaded = false;

/**
 * Load KEY=VALUE pairs from <repo-root>/.env into process.env.
 * Only sets keys that are not already defined in the real environment, so an
 * explicit `export` always wins. No-op if the file is missing or already
 * loaded. Implemented inline (no dotenv dependency) — handles simple
 * `KEY=VALUE` and `KEY="quoted value"` lines, ignores comments/blank lines.
 */
export function loadDotEnvOnce() {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  // Resolve repo root by walking up from this file: clis/apple-login/ -> clis/ -> root.
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 4 && dir !== path.dirname(dir); i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) break;
    dir = path.dirname(dir);
  }
  const envPath = path.join(dir, '.env');
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // no .env — fine, rely on real env
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Fill a single <input> inside the login iframe via the native value setter
 * plus a plain input/change event.
 *
 * This is the exact sequence that successfully drove the Apple sign-in flow
 * on 2026-09-11: native setter (bypasses any getter/setter override Apple's
 * Ember components install) + a vanilla Event('input') + Event('change').
 */
export function fillIframeInputJs(selector, value) {
  const safeSelector = JSON.stringify(selector);
  const safeValue = JSON.stringify(String(value));
  return `
    (() => {
      const f = window.frames[0];
      if (!f || !f.document) return { error: 'no iframe' };
      const el = f.document.querySelector(${safeSelector});
      if (!el) return { error: 'element not found', selector: ${safeSelector} };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      el.focus();
      setter.call(el, ${safeValue});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value };
    })()
  `;
}

/** Click an element inside the login iframe. */
export function clickIframeButtonJs(selector) {
  const safeSelector = JSON.stringify(selector);
  return `
    (() => {
      const f = window.frames[0];
      if (!f || !f.document) return { error: 'no iframe' };
      const el = f.document.querySelector(${safeSelector});
      if (!el) return { error: 'element not found', selector: ${safeSelector} };
      el.click();
      return { ok: true, clicked: true };
    })()
  `;
}

/**
 * Probe the login iframe and report the current step:
 * - '2fa'        : six <input type=tel> verification boxes present
 * - 'password'   : still on the email/password form (#password_text_field present)
 * - 'logged_in'  : iframe gone / navigated away (auth completed)
 */
export function detectStepJs() {
  return `
    (() => {
      const f = window.frames[0];
      if (!f || !f.document) return { step: 'logged_in' };
      const codeInputs = f.document.querySelectorAll('input[type=tel]');
      if (codeInputs.length >= 6) return { step: '2fa' };
      const pw = f.document.querySelector('#password_text_field');
      if (pw) return { step: 'password' };
      return { step: 'logged_in' };
    })()
  `;
}

/**
 * Fill all six 2FA <input type=tel> boxes with the given 6-digit code and
 * fire the full InputEvent + keydown/keyup sequence that Apple's front-end
 * requires to auto-submit. Returns the per-box values.
 */
export function fill2FACodeJs(code) {
  const safeCode = JSON.stringify(String(code).slice(0, 6));
  return `
    (() => {
      const f = window.frames[0];
      if (!f || !f.document) return { error: 'no iframe' };
      const inputs = f.document.querySelectorAll('input[type=tel]');
      if (inputs.length < 6) return { error: 'not enough code inputs', n: inputs.length };
      const code = ${safeCode};
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
  `;
}

/** Read current page url + title via evaluate. */
export function pageInfoJs() {
  return `({ url: location.href, title: document.title })`;
}