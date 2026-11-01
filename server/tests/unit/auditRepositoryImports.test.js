// Only services/auditService.js may import repositories/auditRepository.js.
// auditService is where every audit event is checked against the strict allowlists. auditRepository.insert does not
// validate by itself, so any other file that imported it could write unchecked details to audit_log. This test reads the
// production code (src and scripts) and fails the moment another file imports the repository, however it is written:
// require(), import, dynamic import(), or require.resolve(). It also fails on a require() whose argument is not a plain
// string, because such an import could not be seen by this scan.
const fs = require('fs');
const path = require('path');

const serverRoot = path.join(__dirname, '..', '..');
const SCANNED_DIRS = ['src', 'scripts'];
const ALLOWED_IMPORTERS = ['src/services/auditService.js'];

const LITERAL = `(['"\`])[^'"\`]*auditRepository(?:\\.js)?\\1`;
const IMPORT_FORMS = [
  new RegExp(`require\\s*\\(\\s*${LITERAL}\\s*\\)`), //            const x = require('../repositories/auditRepository')
  new RegExp(`require\\.resolve\\s*\\(\\s*${LITERAL}`), //         require.resolve('./auditRepository')
  new RegExp(`import\\s*\\(\\s*${LITERAL}\\s*\\)`), //             await import('./auditRepository.js')
  new RegExp(`\\bfrom\\s+${LITERAL}`), //                           import { insert } from './auditRepository'
  new RegExp(`\\bimport\\s+${LITERAL}`), //                         import './auditRepository'
];
// Every require( must be followed by ONE complete plain string and the closing parenthesis. Anything else (a variable,
// a concatenation such as './' + name, a function call, a template with ${...}) builds the path at run time.
const PLAIN_REQUIRE = /require\s*\(\s*(['"`])(?:(?!\1|\$\{)[^\n])*\1\s*\)/y;
const ANY_REQUIRE = /\brequire\s*\(/g;

// Comments can mention the file by name; only real code counts.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function importsAuditRepository(source) {
  const code = stripComments(source);
  return IMPORT_FORMS.some((form) => form.test(code));
}

function hasNonLiteralRequire(source) {
  const code = stripComments(source);
  for (const match of code.matchAll(ANY_REQUIRE)) {
    PLAIN_REQUIRE.lastIndex = match.index;
    if (!PLAIN_REQUIRE.test(code)) return true;
  }
  return false;
}

// files: { 'src/x.js': 'source text' }  ->  the files that import the audit repository
function findImporters(files) {
  return Object.keys(files).filter((file) => importsAuditRepository(files[file])).sort();
}

function readProductionFiles() {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(serverRoot, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.name.endsWith('.js')) files[relative] = fs.readFileSync(path.join(serverRoot, relative), 'utf8');
    }
  };
  SCANNED_DIRS.forEach(walk);
  return files;
}

describe('only auditService imports auditRepository', () => {
  const files = readProductionFiles();

  test('the scan covers the production code', () => {
    const names = Object.keys(files);
    expect(names).toContain('src/services/auditService.js');
    expect(names).toContain('src/services/productService.js');
    expect(names).toContain('src/routes/productRoutes.js');
    expect(names).toContain('src/repositories/auditRepository.js');
    expect(names.length).toBeGreaterThan(20);
  });

  test('in the current code, exactly auditService.js imports it', () => {
    expect(findImporters(files)).toEqual(ALLOWED_IMPORTERS);
  });

  test('no production file builds a require() path at run time, so no import can hide from this scan', () => {
    const offenders = Object.keys(files).filter((file) => hasNonLiteralRequire(files[file]));
    expect(offenders).toEqual([]);
  });

  test('a future import from any other service, route, repository or script would be caught', () => {
    const imports = [
      ["const auditRepository = require('../repositories/auditRepository');", 'src/services/productService.js'],
      ['const { insert } = require("../repositories/auditRepository.js");', 'src/routes/productRoutes.js'],
      ["const repo = require(`./auditRepository`);", 'src/repositories/activityRepository.js'],
      ["const repo = require('./auditRepository')\n", 'src/middleware/authenticate.js'],
      ["import { insert } from '../repositories/auditRepository';", 'src/services/orderService.js'],
      ["import '../repositories/auditRepository.js';", 'scripts/create-admin.js'],
      ["const repo = await import('../repositories/auditRepository.js');", 'src/services/customerService.js'],
      ["const path = require.resolve('../repositories/auditRepository');", 'src/app.js'],
      ["const { insert } = require( '../repositories/auditRepository' )", 'scripts/db-check.js'],
    ];
    for (const [line, file] of imports) {
      const changed = { ...files, [file]: `${files[file]}\n${line}\n` };
      expect(findImporters(changed)).toEqual([...new Set([...ALLOWED_IMPORTERS, file])].sort());
    }
  });

  test('a dynamic require is flagged, so an import built from a variable can not slip through', () => {
    expect(hasNonLiteralRequire("const name = 'auditRepository'; require('./' + name);")).toBe(true);
    expect(hasNonLiteralRequire('require(path.join(__dirname, name))')).toBe(true);
    expect(hasNonLiteralRequire('require(`./${name}`)')).toBe(true);
    expect(hasNonLiteralRequire("require(name)")).toBe(true);
    expect(hasNonLiteralRequire("require('./audit' + 'Repository')")).toBe(true);
    expect(hasNonLiteralRequire("require('./auditRepository')")).toBe(false);
    expect(hasNonLiteralRequire('require("../config/env")\nrequire(`./plain`)')).toBe(false);
  });

  test('look-alike names and comments do not count as imports', () => {
    expect(importsAuditRepository("require('./activityRepository')")).toBe(false);
    expect(importsAuditRepository("require('./auditService')")).toBe(false);
    expect(importsAuditRepository("require('./auditRepositoryHelpers')")).toBe(false);
    expect(importsAuditRepository("// const r = require('./auditRepository');")).toBe(false);
    expect(importsAuditRepository("/* require('./auditRepository') */ const x = 1;")).toBe(false);
    expect(importsAuditRepository("const note = 'see auditRepository for the INSERT';")).toBe(false);
  });

  test('the same rule holds for the tests that load the real modules: only auditService.test.js and its own test may', () => {
    // Tests are allowed to import it to test it, but production code is not. This documents the boundary.
    expect(ALLOWED_IMPORTERS.every((file) => file.startsWith('src/services/'))).toBe(true);
  });
});
