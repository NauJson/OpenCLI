/**
 * Apple Account login adapter.
 *
 * Drives the idmsa.apple.com sign-in page: fills email + password inside the
 * same-origin auth iframe, clicks continue, then — when a 2FA code is
 * supplied — fills the six verification boxes and lets the page auto-submit.
 *
 * Credentials are read from CLI args first, then from environment variables
 * (APPLE_LOGIN_USERNAME / APPLE_LOGIN_PASSWORD / APPLE_LOGIN_URL), then from a
 * gitignored <repo-root>/.env (loaded by utils.loadDotEnvOnce). The 2FA code
 * is per-session and must be passed via --code.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import {
  APPLE_LOGIN_DEFAULT_URL,
  loadDotEnvOnce,
  fillIframeInputJs,
  clickIframeButtonJs,
  detectStepJs,
  fill2FACodeJs,
  pageInfoJs,
} from './utils.js';

cli({
  site: 'apple-login',
  name: 'login',
  access: 'write',
  description: 'Sign in to an Apple Account (email + password + 2FA) and land on the CloudKit Dashboard',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'username', type: 'str', required: false, help: 'Apple ID email or phone (or set APPLE_LOGIN_USERNAME)' },
    { name: 'password', type: 'str', required: false, help: 'Apple ID password (or set APPLE_LOGIN_PASSWORD)' },
    { name: 'url', type: 'str', required: false, help: 'Apple ID sign-in URL (or set APPLE_LOGIN_URL)' },
    { name: 'code', type: 'str', required: false, help: '6-digit 2FA code sent to a trusted device; when omitted login stops at the 2FA step' },
  ],
  columns: ['status', 'url', 'title', 'message'],
  func: async (page, kwargs) => {
    loadDotEnvOnce();

    const username = (kwargs.username || process.env.APPLE_LOGIN_USERNAME || '').trim();
    const password = kwargs.password || process.env.APPLE_LOGIN_PASSWORD || '';
    const url = (kwargs.url || process.env.APPLE_LOGIN_URL || APPLE_LOGIN_DEFAULT_URL).trim();
    const code = (kwargs.code || '').trim();

    if (!username) {
      throw new CliError(
        'CONFIG',
        'Apple ID username required',
        'Pass --username or set APPLE_LOGIN_USERNAME (email or phone).',
      );
    }
    if (!password) {
      throw new CliError(
        'CONFIG',
        'Apple ID password required',
        'Pass --password or set APPLE_LOGIN_PASSWORD.',
      );
    }
    if (code && !/^\d{6}$/.test(code)) {
      throw new CliError('CONFIG', '2FA code must be exactly 6 digits', 'Got: ' + code);
    }

    // 1. Navigate to the sign-in page.
    await page.goto(url, { waitUntil: 'load', settleMs: 3000 });

    // 2. Fill email + password inside the auth iframe.
    const emailRes = await page.evaluate(fillIframeInputJs('#account_name_text_field', username));
    if (!emailRes?.ok) {
      throw new CliError('PARSE', 'Could not fill Apple ID email field', emailRes?.error || 'unknown');
    }
    const pwRes = await page.evaluate(fillIframeInputJs('#password_text_field', password));
    if (!pwRes?.ok) {
      throw new CliError('PARSE', 'Could not fill Apple ID password field', pwRes?.error || 'unknown');
    }

    // Let Apple's Ember components process the input events before submitting.
    // Clicking too fast after filling causes Ember to submit with an empty
    // password model and the backend routes to the passkey (SWP) challenge
    // instead of the password SRP flow. (Observed on idmsa.apple.com.)
    await page.wait({ time: 2 });

    // 3. Submit (click "登录"). The #sign-in button needs to be clicked TWICE:
    //    the first click triggers the passkey (SWP) device/challenge flow; the
    //    second click cancels that and submits the password via the SRP flow
    //    (POST /appleauth/auth/signin/init then /signin/complete). With a single
    //    click the backend routes to the passkey challenge and the password is
    //    never submitted, leaving the form stuck. (Validated 2026-09-11.)
    const clickRes = await page.evaluate(clickIframeButtonJs('#sign-in'));
    if (!clickRes?.ok) {
      throw new CliError('PARSE', 'Could not click the continue button', clickRes?.error || 'unknown');
    }
    await page.wait({ time: 4 });
    const clickRes2 = await page.evaluate(clickIframeButtonJs('#sign-in'));
    if (!clickRes2?.ok) {
      throw new CliError('PARSE', 'Could not click the continue button (2nd)', clickRes2?.error || 'unknown');
    }

    // Poll detectStep until it leaves the 'password' step or we time out.
    let step = 'password';
    for (let i = 0; i < 8; i++) {
      await page.wait({ time: 2 });
      step = (await page.evaluate(detectStepJs()))?.step ?? 'password';
      if (step !== 'password') break;
    }

    // Still on the password page after polling ⇒ credentials rejected.
    if (step === 'password') {
      throw new CliError(
        'AUTH',
        'Apple ID rejected the password (or the account is locked)',
        'Verify APPLE_LOGIN_PASSWORD is correct; if locked, use https://iforgot.apple.com.',
      );
    }

    // 4. 2FA step.
    if (step === '2fa') {
      if (!code) {
        const info = await page.evaluate(pageInfoJs()).catch(() => ({}));
        return [{
          status: '2fa_required',
          url: String(info.url || url),
          title: String(info.title || ''),
          message: 'A verification code was sent to your trusted device. Re-run with --code <6-digit>',
        }];
      }

      const fillRes = await page.evaluate(fill2FACodeJs(code));
      if (!fillRes?.ok) {
        throw new CliError('PARSE', 'Could not fill 2FA code boxes', fillRes?.error || 'unknown');
      }

      // Poll: the 2FA boxes auto-submit once all six digits are set; wait for
      // the page to leave the 2FA step (either logged in, or back to password
      // if the code was rejected).
      let after = step;
      for (let i = 0; i < 8; i++) {
        await page.wait({ time: 2 });
        after = (await page.evaluate(detectStepJs()))?.step ?? '2fa';
        if (after !== '2fa') break;
      }
      step = after;

      if (step === 'password' || step === '2fa') {
        // Either the code was wrong, or the page is still verifying.
        const info = await page.evaluate(pageInfoJs()).catch(() => ({}));
        return [{
          status: step === '2fa' ? '2fa_invalid' : 'error',
          url: String(info.url || url),
          title: String(info.title || ''),
          message: 'The 2FA code was not accepted. Request a new code and retry.',
        }];
      }
    }

    // 5. Logged in.
    const info = await page.evaluate(pageInfoJs()).catch(() => ({}));
    return [{
      status: 'ok',
      url: String(info.url || url),
      title: String(info.title || ''),
      message: 'Signed in to Apple Account.',
    }];
  },
});