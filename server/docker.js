'use strict';

const http = require('http');
const fs = require('fs');

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const DMS_CONTAINER = process.env.DMS_CONTAINER || '';

function isAvailable() {
  try {
    return Boolean(DMS_CONTAINER) && fs.existsSync(SOCKET);
  } catch {
    return false;
  }
}

function request(method, apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path: apiPath, method, timeout: 30_000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ? JSON.parse(data) : null);
          } else if (res.statusCode === 304) {
            resolve(null); // bereits im gewünschten Zustand
          } else {
            let msg = `Docker API ${res.statusCode}`;
            try { msg = JSON.parse(data).message || msg; } catch { /* ignore */ }
            reject(new Error(msg));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Docker API Timeout')));
    req.end();
  });
}

async function inspect() {
  if (!isAvailable()) return null;
  try {
    const info = await request('GET', `/containers/${encodeURIComponent(DMS_CONTAINER)}/json`);
    return {
      name: DMS_CONTAINER,
      running: info.State.Running,
      status: info.State.Status,
      startedAt: info.State.StartedAt
    };
  } catch (err) {
    return { name: DMS_CONTAINER, error: err.message };
  }
}

async function stop() {
  await request('POST', `/containers/${encodeURIComponent(DMS_CONTAINER)}/stop?t=30`);
}

async function start() {
  await request('POST', `/containers/${encodeURIComponent(DMS_CONTAINER)}/start`);
}

module.exports = { isAvailable, inspect, stop, start };
