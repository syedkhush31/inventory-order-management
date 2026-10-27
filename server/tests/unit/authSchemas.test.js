const { loginSchema, createAdminSchema } = require('../../src/validation/authSchemas');

describe('loginSchema', () => {
  test('trims and lowercases the email', () => {
    const result = loginSchema.safeParse({ email: '  Admin@Example.COM ', password: 'anything' });
    expect(result.success).toBe(true);
    expect(result.data.email).toBe('admin@example.com');
  });

  test('rejects bad emails, empty passwords and non-object input', () => {
    expect(loginSchema.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@example.com', password: '' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@example.com' }).success).toBe(false);
    expect(loginSchema.safeParse(undefined).success).toBe(false);
  });

  test('rejects passwords over 72 bytes (bcrypt limit)', () => {
    expect(loginSchema.safeParse({ email: 'a@example.com', password: 'a'.repeat(73) }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@example.com', password: 'a'.repeat(72) }).success).toBe(true);
  });
});

describe('createAdminSchema', () => {
  test('requires at least 12 characters', () => {
    expect(createAdminSchema.safeParse({ email: 'a@example.com', password: 'a'.repeat(11) }).success).toBe(false);
    expect(createAdminSchema.safeParse({ email: 'a@example.com', password: 'a'.repeat(12) }).success).toBe(true);
  });
});
