import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './login.js';

/** Build a minimal mock page object that records evaluate() calls and answers
 *  scripted results. The FIRST scripted marker (by array order) that is a
 *  substring of the emitted JS wins, so list more-specific markers
 *  (e.g. `codeInputs` for detectStep) before vaguer ones that also appear in
 *  the same JS string. */
function makePage(scripted) {
  const calls = [];
  const page = {
    calls,
    async goto(u) { calls.push(['goto', u]); },
    async wait(o) { calls.push(['wait', o]); },
    async evaluate(js) {
      calls.push(['eval', js]);
      for (const [marker, result] of scripted) {
        if (typeof marker === 'string' && marker !== '' && js.includes(marker)) return result;
      }
      return undefined;
    },
  };
  return page;
}

describe('apple-login/login command', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.APPLE_LOGIN_USERNAME;
    delete process.env.APPLE_LOGIN_PASSWORD;
    delete process.env.APPLE_LOGIN_URL;
  });

  it('is registered as a write/browser command', () => {
    const cmd = getRegistry().get('apple-login/login');
    expect(cmd).toBeTruthy();
    expect(cmd.func).toBeTypeOf('function');
    expect(cmd.access).toBe('write');
    expect(cmd.browser).toBe(true);
  });

  it('rejects a non-6-digit code with a CONFIG error', async () => {
    const cmd = getRegistry().get('apple-login/login');
    await expect(cmd.func({}, { username: 'a@b.com', password: 'pw', code: '12345' }, false, {}))
      .rejects.toThrow(/6 digits/);
  });

  it('fills credentials, reaches 2FA and reports 2fa_required without --code', async () => {
    const cmd = getRegistry().get('apple-login/login');
    const scripted = [
      ['codeInputs', { step: '2fa' }], // detectStep (unique token; ordered before password_text_field so detectStep hits this not the fill marker)
      ['account_name_text_field', { ok: true, value: 'a@b.com' }],
      ['password_text_field', { ok: true, value: 'pw' }],
      ['sign-in', { ok: true, clicked: true }],
      ['location.href', { url: 'https://idmsa.apple.com/IDMSWebAuth/signin', title: '登录 - Apple' }], // pageInfo
    ];
    const page = makePage(scripted);
    const result = await cmd.func(page, { username: 'a@b.com', password: 'pw' }, false, {});
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].status).toBe('2fa_required');
    expect(result[0].message).toMatch(/--code/);
    const evals = page.calls.filter((c) => c[0] === 'eval').map((c) => c[1]);
    expect(evals.some((s) => s.includes('account_name_text_field'))).toBe(true);
    expect(evals.some((s) => s.includes('password_text_field'))).toBe(true);
    expect(evals.some((s) => s.includes('sign-in'))).toBe(true);
  });

  it('treats staying on the password page as an AUTH error', async () => {
    const cmd = getRegistry().get('apple-login/login');
    const scripted = [
      ['codeInputs', { step: 'password' }], // detectStep (unique token; ordered first)
      ['account_name_text_field', { ok: true }],
      ['password_text_field', { ok: true }],
      ['sign-in', { ok: true }],
    ];
    const page = makePage(scripted);
    await expect(cmd.func(page, { username: 'a@b.com', password: 'wrong' }, false, {}))
      .rejects.toThrow(/rejected the password/i);
  });

  it('completes 2FA with --code and reports ok', async () => {
    const cmd = getRegistry().get('apple-login/login');
    // detectStep is called twice: first '2fa', then after fill 'logged_in'
    let stepToggle = 0;
    const scripted = [
      ['#account_name_text_field', { ok: true }],
      ['#password_text_field', { ok: true }],
      ['#sign-in', { ok: true }],
      ['detectStep', () => { stepToggle++; return { step: stepToggle === 1 ? '2fa' : 'logged_in' }; }], // not used as fn; override below
    ];
    // makePage matches by substring; detectStepJs contains 'input[type=tel]'.
    // Use a custom evaluate that toggles based on call count.
    const page = {
      _stepCalls: 0,
      _fillCalls: 0,
      async goto(u) {},
      async wait(o) {},
      async evaluate(js) {
        // detectStep is uniquely identified by `codeInputs` and must be checked
        // before `#password_text_field`, which also appears in detectStep's JS.
        if (js.includes('codeInputs')) {
          this._stepCalls += 1;
          return { step: this._stepCalls === 1 ? '2fa' : 'logged_in' };
        }
        if (js.includes('account_name_text_field')) return { ok: true, value: 'a@b.com' };
        if (js.includes('password_text_field')) return { ok: true, value: 'pw' };
        if (js.includes('sign-in')) return { ok: true, clicked: true };
        if (js.includes('setter.call')) return { ok: true, vals: ['1','2','3','4','5','6'] }; // fill2FACode
        if (js.includes('location.href')) return { url: 'https://icloud.developer.apple.com/dashboard/', title: 'CloudKit' };
        return undefined;
      },
    };
    const result = await cmd.func(page, { username: 'a@b.com', password: 'pw', code: '123456' }, false, {});
    expect(result[0].status).toBe('ok');
    expect(result[0].url).toContain('icloud.developer.apple.com');
  });
});