'use strict';

const http = require('node:http');

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function activeLicense() {
  return {
    token: 'chrome-mirror-local-test-token',
    valid: true,
    license: {
      plan: 'lifetime',
      status: 'active',
      label: 'Local test access',
    },
  };
}

function createMockLicenseServer(port = 0) {
  let retryVerifyCalls = 0;
  let releaseCalls = 0;
  let activationCalls = 0;
  let resumeCalls = 0;
  let released = false;
  const server = http.createServer((request, response) => {
    const path = new URL(request.url, `http://${request.headers.host}`).pathname;

    if (path === '/health') {
      send(response, 200, { ok: true, retryVerifyCalls });
      return;
    }

    if (path === '/api/v1/license-success/activate') {
      activationCalls += 1;
      released = false;
      send(response, 200, activeLicense());
      return;
    }

    if (path === '/api/v1/license-expired-session/activate') {
      activationCalls += 1;
      send(response, 200, activeLicense());
      return;
    }

    if (path === '/api/v1/license-expired-session/verify') {
      send(response, 401, { error: 'Short access token expired.', code: 'BAD_TOKEN' });
      return;
    }

    if (path === '/api/v1/license-expired-session/resume') {
      resumeCalls += 1;
      send(response, 200, activeLicense());
      return;
    }

    if (path === '/api/v1/license-expired-session/heartbeat') {
      send(response, 200, activeLicense());
      return;
    }

    if (path === '/api/v1/license-expired-no-resume/activate') {
      activationCalls += 1;
      send(response, 200, activeLicense());
      return;
    }

    if (path === '/api/v1/license-expired-no-resume/verify') {
      send(response, 401, { error: 'Short access token expired.', code: 'BAD_TOKEN' });
      return;
    }

    if (path === '/api/v1/license-expired-no-resume/resume') {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
      return;
    }

    if (path === '/api/v1/license-expired-no-resume/heartbeat') {
      send(response, 200, activeLicense());
      return;
    }

    if (path === '/api/v1/license-success/verify'
      || path === '/api/v1/license-success/heartbeat'
      || path === '/api/v1/license-retry-sequence/heartbeat') {
      if (released) {
        send(response, 401, { error: 'Activation session was released.', code: 'BAD_TOKEN' });
        return;
      }
      send(response, 200, activeLicense());
      return;
    }

    if (path === '/api/v1/license-success/release'
      || path === '/api/v1/license-retry-sequence/release') {
      releaseCalls += 1;
      released = true;
      send(response, 200, { ok: true });
      return;
    }

    if (path === '/api/v1/license-retry-sequence/verify') {
      retryVerifyCalls += 1;
      if (retryVerifyCalls <= 2) {
        send(response, 503, {
          error: 'Local test server is temporarily unavailable.',
          code: 'NETWORK',
        });
        return;
      }
      send(response, 200, activeLicense());
      return;
    }

    send(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        stats: () => ({ retryVerifyCalls, releaseCalls, activationCalls, resumeCalls, released }),
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { createMockLicenseServer };

if (require.main === module) {
  const port = Number(process.env.PORT || 43129);
  createMockLicenseServer(port).then(({ baseUrl, close }) => {
    console.log(`mock-license-server listening on ${baseUrl}`);
    const shutdown = () => close().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
