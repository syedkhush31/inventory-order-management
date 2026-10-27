// Pool creation and per-connection UTC initialisation, with everything mocked:
// `mysql2/promise` and the config module are fakes, so no environment file is read and no connection is made.
// These tests prove OUR code's behaviour. They cannot prove how mysql2 queues commands on a real connection;
// that was checked by reading the installed mysql2 source (see the comment in src/config/db.js).

jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));
jest.mock('../../src/config/env', () => ({
  assertDbConfig: jest.fn(),
  db: { host: 'db.example.test', port: 3307, name: 'fake_db', user: 'fake_user', password: 'fake-password-value' },
}));

const SET_UTC = "SET time_zone = '+00:00'";

// A stand-in for the promise pool: records listeners and lets a test announce a "new connection".
function makeFakePool() {
  const listeners = [];
  return {
    listeners,
    on: jest.fn((event, listener) => listeners.push({ event, listener })),
    end: jest.fn().mockResolvedValue(undefined),
    getConnection: jest.fn(),
    announceNewConnection(connection) {
      listeners.filter((l) => l.event === 'connection').forEach((l) => l.listener(connection));
    },
  };
}

// A stand-in for a mysql2 core connection. `outcome` decides how the SET query ends.
function makeFakeConnection(outcome = 'ok') {
  const connection = { query: jest.fn(), destroy: jest.fn() };
  connection.query.mockImplementation((sql, callback) => {
    if (outcome === 'ok') callback(null);
    else if (outcome === 'error') {
      callback(Object.assign(new Error("secret detail: SET time_zone failed for user 'fake_user'@'db.example.test'"), { code: 'ER_SPECIAL_FAILURE' }));
    } else if (outcome === 'throws') throw new Error('query threw: fake-password-value');
    // outcome === 'pending': never calls back
  });
  return connection;
}

let mysql;
let env;
let db;
let consoleError;

beforeEach(() => {
  jest.resetModules(); // db.js keeps the pool in a module variable, so each test needs a fresh copy
  mysql = require('mysql2/promise');
  env = require('../../src/config/env');
  mysql.createPool.mockImplementation(() => makeFakePool());
  db = require('../../src/config/db');
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('lazy creation and reuse', () => {
  test('importing the module neither creates a pool nor validates configuration', () => {
    expect(mysql.createPool).not.toHaveBeenCalled();
    expect(env.assertDbConfig).not.toHaveBeenCalled();
  });

  test('the first getPool() validates the configuration and creates exactly one pool', () => {
    const pool = db.getPool();
    expect(env.assertDbConfig).toHaveBeenCalledTimes(1);
    expect(mysql.createPool).toHaveBeenCalledTimes(1);
    expect(pool).toBe(mysql.createPool.mock.results[0].value);
  });

  test('later calls reuse the same pool and do not register the listener again', () => {
    const first = db.getPool();
    const second = db.getPool();
    expect(second).toBe(first);
    expect(mysql.createPool).toHaveBeenCalledTimes(1);
    expect(first.on).toHaveBeenCalledTimes(1);
  });

  test('a failed configuration check creates no pool and the next call tries again', () => {
    env.assertDbConfig.mockImplementationOnce(() => {
      throw new Error('Missing required environment variable(s): DB_HOST.');
    });
    expect(() => db.getPool()).toThrow(/Missing required environment variable/);
    expect(mysql.createPool).not.toHaveBeenCalled();
    expect(() => db.getPool()).not.toThrow();
    expect(mysql.createPool).toHaveBeenCalledTimes(1);
  });

  test('keeps the existing pool options, including timezone "Z"', () => {
    db.getPool();
    expect(mysql.createPool).toHaveBeenCalledWith({
      host: 'db.example.test',
      port: 3307,
      database: 'fake_db',
      user: 'fake_user',
      password: 'fake-password-value',
      charset: 'utf8mb4',
      timezone: 'Z',
      connectionLimit: 10,
      waitForConnections: true,
      queueLimit: 0,
      decimalNumbers: false,
    });
  });
});

describe('UTC session initialisation', () => {
  test('registers exactly one listener, for the pool "connection" event', () => {
    const pool = db.getPool();
    expect(pool.on.mock.calls.map(([event]) => event)).toEqual(['connection']);
    expect(typeof pool.on.mock.calls[0][1]).toBe('function');
  });

  test('the session offset is UTC and agrees with the mysql2 "Z" setting', () => {
    expect(db.SESSION_TIME_ZONE).toBe('+00:00');
    db.getPool();
    expect(mysql.createPool.mock.calls[0][0].timezone).toBe('Z');
  });

  test('a new connection gets exactly one SET time_zone statement, with the UTC offset', () => {
    const pool = db.getPool();
    const connection = makeFakeConnection('ok');
    pool.announceNewConnection(connection);

    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.query.mock.calls[0][0]).toBe(SET_UTC);
    expect(typeof connection.query.mock.calls[0][1]).toBe('function');
  });

  test('successful initialisation keeps the connection and logs nothing', () => {
    const pool = db.getPool();
    const connection = makeFakeConnection('ok');
    pool.announceNewConnection(connection);

    expect(connection.destroy).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('every new connection is initialised separately', () => {
    const pool = db.getPool();
    const connections = [makeFakeConnection('ok'), makeFakeConnection('ok'), makeFakeConnection('ok')];
    connections.forEach((connection) => pool.announceNewConnection(connection));

    for (const connection of connections) {
      expect(connection.query).toHaveBeenCalledTimes(1);
      expect(connection.query.mock.calls[0][0]).toBe(SET_UTC);
    }
  });

  test('the statement is a fixed string: nothing from the environment is placed in it', () => {
    const pool = db.getPool();
    const connection = makeFakeConnection('ok');
    pool.announceNewConnection(connection);
    const sql = connection.query.mock.calls[0][0];
    expect(sql).not.toMatch(/fake_user|fake_db|db\.example|fake-password-value/);
  });

  test('an in-flight SET does not discard the connection while it is still pending', () => {
    const pool = db.getPool();
    const connection = makeFakeConnection('pending');
    pool.announceNewConnection(connection);
    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
  });
});

describe('initialisation failure', () => {
  test('a failed SET destroys that connection so it is never reused', () => {
    const pool = db.getPool();
    const bad = makeFakeConnection('error');
    const good = makeFakeConnection('ok');
    pool.announceNewConnection(bad);
    pool.announceNewConnection(good);

    expect(bad.destroy).toHaveBeenCalledTimes(1);
    expect(good.destroy).not.toHaveBeenCalled(); // other connections are unaffected
  });

  test('the failure is logged as a short code only: no SQL, user, host or password', () => {
    const pool = db.getPool();
    pool.announceNewConnection(makeFakeConnection('error'));

    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toBe('Database session setup failed: ER_SPECIAL_FAILURE');
    expect(logged).not.toMatch(/SET|secret detail|fake_user|db\.example|fake-password-value/);
  });

  test('an error without a code is logged by its name', () => {
    const pool = db.getPool();
    const connection = { query: jest.fn((sql, cb) => cb(new TypeError('x'))), destroy: jest.fn() };
    pool.announceNewConnection(connection);
    expect(consoleError.mock.calls[0][0]).toBe('Database session setup failed: TypeError');
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  test('a query() that throws is handled: the connection is destroyed and the error does not escape', () => {
    const pool = db.getPool();
    const connection = makeFakeConnection('throws');
    expect(() => pool.announceNewConnection(connection)).not.toThrow();
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toMatch(/^Database session setup failed: Error$/);
    expect(logged).not.toMatch(/fake-password-value/); // the thrown message is never logged
  });

  test('initialisation never throws into the pool code that emits the event', () => {
    const pool = db.getPool();
    expect(() => pool.announceNewConnection(makeFakeConnection('error'))).not.toThrow();
  });
});

describe('shutdown and recreation', () => {
  test('closePool() ends the pool once, and a second call does nothing', async () => {
    const pool = db.getPool();
    await db.closePool();
    await db.closePool();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  test('closePool() without a pool is a no-op', async () => {
    await expect(db.closePool()).resolves.toBeUndefined();
    expect(mysql.createPool).not.toHaveBeenCalled();
  });

  test('after shutdown getPool() builds a new pool that is initialised the same way', async () => {
    const first = db.getPool();
    await db.closePool();
    const second = db.getPool();

    expect(second).not.toBe(first);
    expect(mysql.createPool).toHaveBeenCalledTimes(2);
    expect(second.on).toHaveBeenCalledTimes(1);

    const connection = makeFakeConnection('ok');
    second.announceNewConnection(connection);
    expect(connection.query.mock.calls[0][0]).toBe(SET_UTC);
  });

  test('the old pool is not touched again after shutdown', async () => {
    const first = db.getPool();
    await db.closePool();
    db.getPool();
    expect(first.end).toHaveBeenCalledTimes(1);
  });
});

describe('withTransaction (unchanged behaviour, protected because this file was edited)', () => {
  function poolWithConnection() {
    const pool = db.getPool();
    const connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(connection);
    return connection;
  }

  test('commits and releases on success, returning the callback result', async () => {
    const connection = poolWithConnection();
    const result = await db.withTransaction(async (conn) => {
      expect(conn).toBe(connection);
      return 42;
    });
    expect(result).toBe(42);
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  test('rolls back, releases and rethrows the original error on failure', async () => {
    const connection = poolWithConnection();
    const failure = new Error('boom');
    await expect(
      db.withTransaction(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });
});
