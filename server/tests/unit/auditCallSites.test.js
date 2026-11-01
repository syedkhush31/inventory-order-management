// Every place that calls auditService.record(...) in production code, checked as text.
//  - Only the services listed here may call it. A new caller makes this test fail, so it gets a deliberate review.
//  - A call may never hand over a whole request body or a whole input object: it builds `details` from named values.
// (Only auditService may import auditRepository: auditRepositoryImports.test.js. What `details` may contain at all:
// auditSchemas.test.js.)
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', '..', 'src');
const ALLOWED_CALLERS = [
  'services/accountService.js',
  'services/customerService.js',
  'services/productService.js',
  'services/settingsService.js',
];

function listJs(dir, base = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJs(full, base));
    else if (entry.name.endsWith('.js')) files.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return files;
}

// The text of each auditService.record( ... ) call, found by counting parentheses.
function callsIn(source) {
  const calls = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('auditService.record(', from);
    if (start === -1) return calls;
    let depth = 0;
    let end = start;
    for (let i = start + 'auditService.record'.length; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(source.slice(start, end + 1));
    from = end + 1;
  }
}

const files = listJs(srcDir);
const sources = Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(srcDir, file), 'utf8')]));
const callers = files.filter((file) => file !== 'services/auditService.js' && callsIn(sources[file]).length > 0);

describe('auditService.record call sites', () => {
  test('are only in the services that are meant to audit', () => {
    expect(callers.sort()).toEqual(ALLOWED_CALLERS);
  });

  test('no route, middleware or repository calls it', () => {
    // (comments may mention the name; only a real require() of it counts)
    const bad = files.filter((f) => /^(routes|middleware|repositories|validation|utils|config)\//.test(f) && /require\([^)]*auditService/.test(sources[f]));
    expect(bad).toEqual([]);
  });

  test('every call exists and is non-trivial (the scan really finds them)', () => {
    const all = callers.flatMap((file) => callsIn(sources[file]));
    // products 3 (create, update, activate/deactivate), customers 3, account 2 (profile, password), settings 1.
    // A new call changes this number on purpose, so it is noticed and reviewed.
    expect(all).toHaveLength(9);
    for (const call of all) expect(call).toMatch(/eventType:/);
  });

  test('no call passes a request body, a parsed body or a whole input object as details', () => {
    const offenders = [];
    for (const file of callers) {
      for (const call of callsIn(sources[file])) {
        const wholeObject = /details:\s*(req|request|body|parsed|input|data|payload|params|query)\s*[,}\n)]/;
        const spread = /\.\.\.\s*(req|request|body|parsed|input|data|payload|params|query)\b/;
        const reqAccess = /\breq\.|\brequest\.|\bparsed\.data\b/;
        if (wholeObject.test(call) || spread.test(call) || reqAccess.test(call)) offenders.push(`${file}: ${call.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the services that audit never read a password or hash into a details object', () => {
    for (const file of callers) {
      for (const call of callsIn(sources[file])) {
        // (the event name ACCOUNT_PASSWORD_CHANGED is an event name, not a value)
        const withoutEventName = call.replace(/eventType:\s*['"][A-Z_]+['"]/g, 'eventType: EVENT');
        expect(withoutEventName).not.toMatch(/password|hash|token|secret/i);
      }
    }
  });

  test('the detector itself catches the bad patterns', () => {
    const bad = ['auditService.record(c, { adminId, eventType: "X", details: req.body })', 'auditService.record(c, { details: data })', 'auditService.record(c, { details: { ...input } })'];
    for (const call of bad) {
      const [found] = callsIn(call);
      const flagged = /details:\s*(req|body|parsed|input|data)\s*[,}\n)]/.test(found) || /\.\.\.\s*(input|data)\b/.test(found) || /\breq\./.test(found);
      expect(flagged).toBe(true);
    }
    expect(callsIn('auditService.record(c, { details: { price: normalisePrice(data.price) } })')).toHaveLength(1);
  });
});
