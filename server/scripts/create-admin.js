// Creates an administrator account. Run by you, in a real terminal:  npm run admin:create
// The password is typed at a hidden prompt (never a command-line argument), hashed with
// bcrypt, and only the hash is stored. Nothing secret is printed.
// Only ever targets inventory_dev, using server/.env. It refuses to run if NODE_ENV is set to
// anything but "development", if the config or live database is not exactly inventory_dev,
// or if you do not type the database name to confirm. It refuses to create a second
// admin unless you pass --allow-additional.
const readline = require('readline');
const target = require('../src/config/adminTarget');

// Must happen before the config is loaded: a NODE_ENV left over from another task
// (for example "test") is refused instead of silently choosing the test database.
try {
  target.assertDevelopmentMode(process.env.NODE_ENV);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
}

const env = require('../src/config/env');
const { getPool, closePool } = require('../src/config/db');
const adminRepository = require('../src/repositories/adminRepository');
const authService = require('../src/services/authService');
const { createAdminSchema } = require('../src/validation/authSchemas');

function promptVisible(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';

    const finish = (fn, value) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      fn(value);
    };

    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          return finish(resolve, input);
        }
        if (char === '\u0003') {
          return finish(reject, new Error('Cancelled.'));
        }
        if (char === '\u007f' || char === '\b') {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    }
    stdin.on('data', onData);
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    throw new Error('This script needs an interactive terminal (passwords are never read from pipes).');
  }
  env.assertDbConfig();
  target.assertConfiguredTarget({ nodeEnv: env.nodeEnv, envFile: env.envFile, dbName: env.db.name });

  // Read-only check of the database the server reports, before any prompt or write.
  const [[live]] = await getPool().query('SELECT DATABASE() AS db');
  target.assertLiveTarget(live.db);

  console.log(`Target database: ${target.DEV_DATABASE_NAME} (development configuration)`);
  target.assertConfirmation(await promptVisible(`Type "${target.DEV_DATABASE_NAME}" to confirm: `));

  const allowAdditional = process.argv.includes('--allow-additional');
  if (!allowAdditional && (await adminRepository.countAll()) > 0) {
    throw new Error('An administrator already exists. Re-run with --allow-additional to add another.');
  }

  const email = await promptVisible('Email: ');
  const password = await promptHidden('Password (min 12 characters, hidden): ');
  const confirm = await promptHidden('Confirm password: ');

  if (password !== confirm) {
    throw new Error('Passwords do not match.');
  }
  const parsed = createAdminSchema.safeParse({ email, password });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid input for: ${fields.join(', ')} (password needs 12 to 72 bytes).`);
  }

  const passwordHash = await authService.hashPassword(parsed.data.password);
  try {
    await adminRepository.create({ email: parsed.data.email, passwordHash });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new Error('An administrator with that email already exists.');
    }
    throw err;
  }
  console.log(`Administrator created: ${parsed.data.email}`);
}

main()
  .catch((err) => {
    // Only our own messages or a short error code are shown, never connection details.
    // Our own errors have no code and are shown as written; database errors show only the code.
    console.error(`Failed: ${err.code ? `database error ${err.code}` : err.message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
