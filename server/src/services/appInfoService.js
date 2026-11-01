// Safe, public-to-admins facts about the application for the Settings page. NOTHING here comes from the environment
// except one label ("development" or "production"): no database name, host, user, password, secret, URL or path is
// ever included, and no other environment variable is read.
const fs = require('fs');
const path = require('path');
const env = require('../config/env');

const APP_NAME = 'ShelfSync';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_VERSION_LENGTH = 40;

function cleanVersion(value) {
  return typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && VERSION_PATTERN.test(value) ? value : null;
}

// Reads the "version" of a package.json. Returns null if the file is missing, unreadable, or has no proper version.
// Only the version field is used; nothing else from the file is ever returned.
function readPackageVersion(file) {
  try {
    return cleanVersion(JSON.parse(fs.readFileSync(file, 'utf8')).version);
  } catch (err) {
    return null;
  }
}

const SERVER_PACKAGE = path.join(__dirname, '..', '..', 'package.json');
const CLIENT_PACKAGE = path.join(__dirname, '..', '..', '..', 'client', 'package.json');

// Anything other than "production" (a normal local run is "development") is reported as "development".
function environmentLabel(nodeEnv = env.nodeEnv) {
  return nodeEnv === 'production' ? 'production' : 'development';
}

// clientVersion is best effort: it is read from the client's package.json when the client folder sits next to the
// server (as in this repository) and is null when it does not. The Settings page can then show the version of the
// client build it is itself running.
function getAppInfo({ serverPackage = SERVER_PACKAGE, clientPackage = CLIENT_PACKAGE, nodeEnv } = {}) {
  return {
    name: APP_NAME,
    serverVersion: readPackageVersion(serverPackage),
    clientVersion: readPackageVersion(clientPackage),
    environment: environmentLabel(nodeEnv),
  };
}

module.exports = { getAppInfo, environmentLabel, readPackageVersion, cleanVersion, APP_NAME };
