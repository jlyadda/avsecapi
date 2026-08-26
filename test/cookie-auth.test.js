const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const config = require('../config');
const db = require('../db');

test.after(() => db.end());

const browserCookieFrom = (response) => {
  const browserCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${config.BROWSER_CONTEXT_COOKIE_NAME}=`));
  assert.ok(browserCookie);
  return browserCookie.split(';', 1)[0];
};

const tabHeaders = (cookie, sessionHandle, extra = {}) => ({
  cookie,
  'x-avsec-session': sessionHandle,
  ...extra
});

test('tab-scoped cookie sessions require CSRF and rotate on refresh', async () => {
  assert.equal(config.AUTH_COOKIE_ENABLED, true);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const origin = config.CORS_ALLOWED_ORIGINS[0];
  const userId = uuidv4();
  const password = 'CookieSessionPassword12!';

  try {
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, full_name, department, user_role, is_active)
       VALUES (?, ?, ?, ?, ?, 'Aviation Security', 'security_assistant', 1)`,
      [
        userId,
        `cookie.${userId.slice(0, 8)}`,
        `${userId}@example.test`,
        await bcrypt.hash(password, 12),
        'Cookie Session User'
      ]
    );

    const loginResponse = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ identifier: `${userId}@example.test`, password })
    });
    assert.equal(loginResponse.status, 200);
    const loginBody = await loginResponse.json();
    assert.ok(loginBody.csrf_token);
    assert.ok(loginBody.tab_session_handle);
    assert.ok(loginBody.token);
    assert.equal(loginResponse.headers.get('cache-control'), 'no-store');
    const initialSetCookie = loginResponse.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${config.BROWSER_CONTEXT_COOKIE_NAME}=`));
    assert.match(initialSetCookie, /HttpOnly/i);
    assert.match(initialSetCookie, /;\s*Path=\/(?:;|$)/i);
    assert.match(initialSetCookie, new RegExp(`SameSite=${config.AUTH_COOKIE_SAME_SITE}`, 'i'));
    if (config.AUTH_COOKIE_SECURE) assert.match(initialSetCookie, /Secure/i);
    const browserCookie = browserCookieFrom(loginResponse);
    const initialHandle = loginBody.tab_session_handle;

    const accountResponse = await fetch(`${baseUrl}/account`, {
      headers: tabHeaders(browserCookie, initialHandle, { origin })
    });
    assert.equal(accountResponse.status, 200);

    const missingCsrfResponse = await fetch(`${baseUrl}/account`, {
      method: 'PATCH',
      headers: tabHeaders(browserCookie, initialHandle, {
        'content-type': 'application/json',
        origin
      }),
      body: JSON.stringify({ full_name: 'Rejected Name' })
    });
    assert.equal(missingCsrfResponse.status, 403);
    assert.equal((await missingCsrfResponse.json()).code, 'CSRF_TOKEN_INVALID');

    const updateResponse = await fetch(`${baseUrl}/account`, {
      method: 'PATCH',
      headers: {
        cookie: browserCookie,
        'x-avsec-session': initialHandle,
        'content-type': 'application/json',
        'x-csrf-token': loginBody.csrf_token,
        origin
      },
      body: JSON.stringify({ full_name: 'Updated Cookie User' })
    });
    assert.equal(updateResponse.status, 200);

    const csrfResponse = await fetch(`${baseUrl}/auth/csrf`, {
      headers: tabHeaders(browserCookie, initialHandle, { origin })
    });
    assert.equal(csrfResponse.status, 200);
    const rotatedCsrfToken = (await csrfResponse.json()).csrf_token;
    assert.notEqual(rotatedCsrfToken, loginBody.csrf_token);

    const refreshResponse = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        cookie: browserCookie,
        'x-avsec-session': initialHandle,
        'x-csrf-token': rotatedCsrfToken,
        origin
      }
    });
    assert.equal(refreshResponse.status, 200);
    const refreshBody = await refreshResponse.json();
    assert.ok(refreshBody.csrf_token);
    assert.ok(refreshBody.tab_session_handle);
    assert.notEqual(refreshBody.tab_session_handle, initialHandle);

    const revokedHandleResponse = await fetch(`${baseUrl}/account`, {
      headers: tabHeaders(browserCookie, initialHandle, { origin })
    });
    assert.equal(revokedHandleResponse.status, 403);

    const logoutResponse = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: {
        cookie: browserCookie,
        'x-avsec-session': refreshBody.tab_session_handle,
        'x-csrf-token': refreshBody.csrf_token,
        origin
      }
    });
    assert.equal(logoutResponse.status, 200);

    const loggedOutResponse = await fetch(`${baseUrl}/account`, {
      headers: tabHeaders(browserCookie, refreshBody.tab_session_handle, { origin })
    });
    assert.equal(loggedOutResponse.status, 403);
  } finally {
    const [contexts] = await db.execute(
      'SELECT DISTINCT browser_context_id FROM auth_tokens WHERE user_id = ?',
      [userId]
    );
    await db.execute('DELETE FROM auth_tokens WHERE user_id = ?', [userId]);
    for (const context of contexts) {
      if (context.browser_context_id) {
        await db.execute('DELETE FROM browser_contexts WHERE id = ?', [context.browser_context_id]);
      }
    }
    await db.execute('DELETE FROM user_profiles WHERE id = ?', [userId]);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('one browser can isolate two independently authenticated tabs', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const origin = config.CORS_ALLOWED_ORIGINS[0];
  const password = 'IndependentTabsPassword12!';
  const users = [uuidv4(), uuidv4()];
  let browserContextId;

  try {
    for (const [index, userId] of users.entries()) {
      await db.execute(
        `INSERT INTO user_profiles
         (id, user_name, email, password_hash, full_name, department, user_role, is_active)
         VALUES (?, ?, ?, ?, ?, 'Aviation Security', 'security_assistant', 1)`,
        [
          userId,
          `tab.${index}.${userId.slice(0, 8)}`,
          `${userId}@example.test`,
          await bcrypt.hash(password, 12),
          `Independent Tab ${index + 1}`
        ]
      );
    }

    const firstLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ identifier: `${users[0]}@example.test`, password })
    });
    assert.equal(firstLogin.status, 200);
    const firstBody = await firstLogin.json();
    const browserCookie = browserCookieFrom(firstLogin);

    const secondLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: browserCookie, origin },
      body: JSON.stringify({ identifier: `${users[1]}@example.test`, password })
    });
    assert.equal(secondLogin.status, 200);
    const secondBody = await secondLogin.json();
    assert.notEqual(firstBody.tab_session_handle, secondBody.tab_session_handle);

    const firstAccount = await fetch(`${baseUrl}/account`, {
      headers: tabHeaders(browserCookie, firstBody.tab_session_handle, { origin })
    });
    const secondAccount = await fetch(`${baseUrl}/account`, {
      headers: tabHeaders(browserCookie, secondBody.tab_session_handle, { origin })
    });
    assert.equal((await firstAccount.json()).account.id, users[0]);
    assert.equal((await secondAccount.json()).account.id, users[1]);

    const logoutFirst = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: tabHeaders(browserCookie, firstBody.tab_session_handle, {
        'x-csrf-token': firstBody.csrf_token,
        origin
      })
    });
    assert.equal(logoutFirst.status, 200);

    const secondStillActive = await fetch(`${baseUrl}/account`, {
      headers: tabHeaders(browserCookie, secondBody.tab_session_handle, { origin })
    });
    assert.equal(secondStillActive.status, 200);

    const logoutBrowser = await fetch(`${baseUrl}/logout-browser`, {
      method: 'POST',
      headers: tabHeaders(browserCookie, secondBody.tab_session_handle, {
        'x-csrf-token': secondBody.csrf_token,
        origin
      })
    });
    assert.equal(logoutBrowser.status, 200);
    const [contextRows] = await db.execute(
      'SELECT browser_context_id FROM auth_tokens WHERE user_id = ? LIMIT 1',
      [users[1]]
    );
    browserContextId = contextRows[0]?.browser_context_id;

    const revokedSecond = await fetch(`${baseUrl}/account`, {
      headers: tabHeaders(browserCookie, secondBody.tab_session_handle, { origin })
    });
    assert.equal(revokedSecond.status, 403);
  } finally {
    await db.query('DELETE FROM auth_tokens WHERE user_id IN (?, ?)', users);
    if (browserContextId) {
      await db.execute('DELETE FROM browser_contexts WHERE id = ?', [browserContextId]);
    }
    await db.query('DELETE FROM user_profiles WHERE id IN (?, ?)', users);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cookie login rejects an untrusted browser origin', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example'
      },
      body: JSON.stringify({ identifier: 'nobody', password: 'not-a-password' })
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'ORIGIN_NOT_ALLOWED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
