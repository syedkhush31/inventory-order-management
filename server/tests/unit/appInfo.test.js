// The safe application information. Files are temporary and fake; no database and no real environment values are shown.
const fs = require('fs');
const os = require('os');
const path = require('path');
const appInfoService = require('../../src/services/appInfoService');

let dir;
const write = (name, content) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfsync-appinfo-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('getAppInfo', () => {
  test('returns exactly the name, the two versions and the environment label', () => {
    const info = appInfoService.getAppInfo({
      serverPackage: write('server.json', { version: '1.2.3' }),
      clientPackage: write('client.json', { version: '0.4.5' }),
      nodeEnv: 'production',
    });
    expect(info).toEqual({ name: 'ShelfSync', serverVersion: '1.2.3', clientVersion: '0.4.5', environment: 'production' });
  });

  test('reads the real package.json files of this repository', () => {
    const info = appInfoService.getAppInfo();
    expect(info.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.clientVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(Object.keys(info).sort()).toEqual(['clientVersion', 'environment', 'name', 'serverVersion']);
  });

  test('the environment is only ever "development" or "production"', () => {
    expect(appInfoService.environmentLabel('production')).toBe('production');
    for (const other of ['development', 'test', 'staging', '', undefined, null, 'PRODUCTION', 'prod', 42, { a: 1 }]) {
      expect(appInfoService.environmentLabel(other)).toBe('development');
    }
  });

  test('only the version field of a package.json is used: nothing else from the file can leak', () => {
    const file = write('package.json', {
      name: 'secret-project-name',
      version: '2.0.0',
      scripts: { deploy: 'ssh root@example.com' },
      config: { DB_PASSWORD: 'super-secret-value', token: 'abc' },
    });
    const info = appInfoService.getAppInfo({ serverPackage: file, clientPackage: file });
    const text = JSON.stringify(info);
    expect(text).not.toMatch(/secret|deploy|ssh|DB_PASSWORD|token|root@/i);
    expect(info.serverVersion).toBe('2.0.0');
  });

  test('a missing, unreadable or broken file gives null, never an error', () => {
    const missing = path.join(dir, 'nope.json');
    expect(appInfoService.readPackageVersion(missing)).toBeNull();
    expect(appInfoService.readPackageVersion(write('bad.json', '{not json'))).toBeNull();
    expect(appInfoService.readPackageVersion(write('empty.json', ''))).toBeNull();
    expect(appInfoService.readPackageVersion(write('nover.json', { name: 'x' }))).toBeNull();
    expect(appInfoService.readPackageVersion(dir)).toBeNull(); // a folder, not a file
    expect(appInfoService.getAppInfo({ serverPackage: missing, clientPackage: missing })).toMatchObject({ serverVersion: null, clientVersion: null });
  });

  test.each([
    ['text that is not a version', 'hello'],
    ['a version with a script in it', '1.0.0; rm -rf /'],
    ['a number', 1.5],
    ['an object', { a: 1 }],
    ['an array', ['1.0.0']],
    ['a very long string', `1.0.0-${'a'.repeat(100)}`],
    ['text with a line break', '1.0.0\nSECRET'],
  ])('%s is not shown as a version', (_label, version) => {
    expect(appInfoService.readPackageVersion(write('v.json', { version }))).toBeNull();
  });

  test('ordinary versions, with a pre-release tag, are accepted', () => {
    for (const version of ['0.1.0', '1.2.3', '10.20.30', '1.0.0-beta.1', '1.0.0+build.5']) {
      expect(appInfoService.cleanVersion(version)).toBe(version);
    }
  });

  test('never contains values from the environment, whatever is set there', () => {
    const saved = { ...process.env };
    process.env.DB_PASSWORD = 'zz-super-secret-db-password';
    process.env.DB_NAME = 'zz-secret-db-name';
    process.env.DB_HOST = 'zz-secret-host.example';
    process.env.JWT_SECRET_EXTRA = 'zz-secret-jwt';
    try {
      const text = JSON.stringify(appInfoService.getAppInfo());
      expect(text).not.toMatch(/zz-/);
    } finally {
      Object.keys(process.env).forEach((key) => { if (!(key in saved)) delete process.env[key]; });
      Object.assign(process.env, saved);
    }
  });
});
