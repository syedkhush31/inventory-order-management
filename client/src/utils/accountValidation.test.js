import { describe, expect, test } from 'vitest';
import { byteLength, validatePasswordForm, validateProfileForm, validateThreshold } from './accountValidation.js';

const SAVED = { displayName: 'Sam', email: 'admin@example.com' };
const profile = (overrides = {}) => ({ displayName: 'Sam', email: 'admin@example.com', currentPassword: '', ...overrides });

describe('byteLength', () => {
  test('counts bytes the way the server does', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('é')).toBe(2);
    expect(byteLength('€')).toBe(3);
    expect(byteLength('😀')).toBe(4);
    expect(byteLength('')).toBe(0);
  });
});

describe('validateProfileForm', () => {
  test('nothing changed is not saved, and says so', () => {
    const result = validateProfileForm(profile(), SAVED);
    expect(result.values).toBeNull();
    expect(result.errors.form).toMatch(/Nothing has changed/);
    expect(result.changed).toEqual({ displayName: false, email: false });
  });

  test('a changed display name needs no password and sends only the display name', () => {
    const result = validateProfileForm(profile({ displayName: '  Sam Lee ' }), SAVED);
    expect(result.errors).toEqual({});
    expect(result.values).toEqual({ displayName: 'Sam Lee' });
    expect(result.changed).toEqual({ displayName: true, email: false });
  });

  test('clearing the display name sends null; a name that was never set stays unchanged when left empty', () => {
    expect(validateProfileForm(profile({ displayName: '   ' }), SAVED).values).toEqual({ displayName: null });
    expect(validateProfileForm(profile({ displayName: '' }), { displayName: null, email: 'admin@example.com' }).values).toBeNull();
  });

  test('a changed email needs the current password and sends the lower-cased address with it', () => {
    const missing = validateProfileForm(profile({ email: 'new@example.com' }), SAVED);
    expect(missing.values).toBeNull();
    expect(missing.errors.currentPassword).toMatch(/current password/i);

    const ok = validateProfileForm(profile({ email: '  NEW@Example.COM ', currentPassword: 'my-current-password' }), SAVED);
    expect(ok.errors).toEqual({});
    expect(ok.values).toEqual({ email: 'new@example.com', currentPassword: 'my-current-password' });
  });

  test('email and display name together send both, with the password', () => {
    const result = validateProfileForm(profile({ displayName: 'Other', email: 'new@example.com', currentPassword: 'pw' }), SAVED);
    expect(result.values).toEqual({ displayName: 'Other', email: 'new@example.com', currentPassword: 'pw' });
  });

  test('the email written in capitals or with spaces, but the same address, is not a change and needs no password', () => {
    const result = validateProfileForm(profile({ email: '  ADMIN@Example.com ', displayName: 'Other' }), SAVED);
    expect(result.changed.email).toBe(false);
    expect(result.values).toEqual({ displayName: 'Other' });
  });

  test.each([
    ['empty', '', /Enter an email/],
    ['no at sign', 'nope', /valid email/],
    ['no dot after the at sign', 'a@b', /valid email/],
    ['a space inside', 'a b@example.com', /valid email/],
    ['too long', `${'a'.repeat(250)}@example.com`, /255 characters/],
  ])('an email that is %s is refused', (_label, email, message) => {
    const result = validateProfileForm(profile({ email, currentPassword: 'pw' }), SAVED);
    expect(result.values).toBeNull();
    expect(result.errors.email).toMatch(message);
  });

  test('a display name that is too long or has a control character is refused', () => {
    expect(validateProfileForm(profile({ displayName: 'x'.repeat(101) }), SAVED).errors.displayName).toMatch(/100 characters/);
    expect(validateProfileForm(profile({ displayName: 'bad\u0007name' }), SAVED).errors.displayName).toMatch(/control/);
    expect(validateProfileForm(profile({ displayName: 'x'.repeat(100) }), SAVED).errors).toEqual({});
  });

  test('a current password longer than 72 bytes is refused', () => {
    const result = validateProfileForm(profile({ email: 'new@example.com', currentPassword: 'x'.repeat(73) }), SAVED);
    expect(result.errors.currentPassword).toBeTruthy();
    expect(validateProfileForm(profile({ email: 'new@example.com', currentPassword: 'x'.repeat(72) }), SAVED).errors).toEqual({});
  });
});

describe('validatePasswordForm', () => {
  const NEW = 'a-new-password-1';
  const form = (overrides = {}) => ({ currentPassword: 'the-old-password', newPassword: NEW, confirmPassword: NEW, ...overrides });

  test('a complete, matching form is accepted and sends the two passwords untouched', () => {
    expect(validatePasswordForm(form())).toEqual({ values: { currentPassword: 'the-old-password', newPassword: NEW }, errors: {} });
  });

  test('passwords are never trimmed: spaces are part of a password', () => {
    const result = validatePasswordForm(form({ currentPassword: ' old with spaces ', newPassword: '  new with spaces 1 ', confirmPassword: '  new with spaces 1 ' }));
    expect(result.values).toEqual({ currentPassword: ' old with spaces ', newPassword: '  new with spaces 1 ' });
  });

  test('every empty field is named', () => {
    const result = validatePasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    expect(result.values).toBeNull();
    expect(Object.keys(result.errors).sort()).toEqual(['confirmPassword', 'currentPassword', 'newPassword']);
  });

  test('the new password needs at least 12 characters: 11 is refused, 12 is accepted', () => {
    expect(validatePasswordForm(form({ newPassword: 'abcdefghij1', confirmPassword: 'abcdefghij1' })).errors.newPassword).toMatch(/at least 12/);
    expect(validatePasswordForm(form({ newPassword: 'abcdefghij12', confirmPassword: 'abcdefghij12' })).errors).toEqual({});
  });

  test('the new password may be at most 72 bytes: 72 is accepted, 73 is refused, and accented letters count double', () => {
    expect(validatePasswordForm(form({ newPassword: 'x'.repeat(72), confirmPassword: 'x'.repeat(72) })).errors).toEqual({});
    expect(validatePasswordForm(form({ newPassword: 'x'.repeat(73), confirmPassword: 'x'.repeat(73) })).errors.newPassword).toMatch(/too long/);
    expect(validatePasswordForm(form({ newPassword: 'é'.repeat(37), confirmPassword: 'é'.repeat(37) })).errors.newPassword).toMatch(/too long/); // 74 bytes
  });

  test('the confirmation must match exactly', () => {
    expect(validatePasswordForm(form({ confirmPassword: `${NEW}x` })).errors.confirmPassword).toMatch(/do not match/);
    expect(validatePasswordForm(form({ confirmPassword: NEW.toUpperCase() })).errors.confirmPassword).toMatch(/do not match/);
  });

  test('the new password must differ from the current one', () => {
    const same = 'the-same-password-1';
    expect(validatePasswordForm(form({ currentPassword: same, newPassword: same, confirmPassword: same })).errors.newPassword).toMatch(/different/);
  });

  test('a current password over 72 bytes is refused', () => {
    expect(validatePasswordForm(form({ currentPassword: 'x'.repeat(73) })).errors.currentPassword).toBeTruthy();
  });
});

describe('validateThreshold', () => {
  test.each([['0', 0], ['5', 5], ['12', 12], ['1000', 1000], ['  7  ', 7], ['007', 7]])('%p is accepted as %i', (text, value) => {
    expect(validateThreshold(text)).toEqual({ value, error: '' });
  });

  test.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['negative', '-1'],
    ['a decimal', '1.5'],
    ['a comma decimal', '1,5'],
    ['letters', 'abc'],
    ['a number with letters', '12abc'],
    ['an exponent', '1e3'],
    ['a plus sign', '+5'],
    ['one over the maximum', '1001'],
    ['far over the maximum', '99999'],
    ['five digits of zeros', '00000'],
  ])('%s is refused', (_label, text) => {
    const result = validateThreshold(text);
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/whole number|between/);
  });
});
