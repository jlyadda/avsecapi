const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const config = require('../config');
const db = require('../db');

test.after(() => db.end());

test('CORS preflight permits the configured frontend origin', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'OPTIONS',
      headers: {
        origin: config.CORS_ALLOWED_ORIGINS[0],
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-avsec-session,x-csrf-token'
      }
    });

    assert.equal(response.status, 204);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      config.CORS_ALLOWED_ORIGINS[0]
    );
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);
    assert.match(response.headers.get('access-control-allow-headers'), /Content-Type/i);
    assert.match(response.headers.get('access-control-allow-headers'), /X-AVSEC-Session/i);
    assert.match(response.headers.get('access-control-allow-headers'), /X-CSRF-Token/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
