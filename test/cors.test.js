const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
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
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type'
      }
    });

    assert.equal(response.status, 204);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'http://localhost:5173'
    );
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);
    assert.match(response.headers.get('access-control-allow-headers'), /Content-Type/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
