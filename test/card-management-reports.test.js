const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = require('../app');
const config = require('../config');
const db = require('../db');

test.after(() => db.end());

const createToken = async (userId) => {
  const jti = uuidv4();
  await db.execute(
    'INSERT INTO auth_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)',
    [jti, userId, new Date(Date.now() + 300000)]
  );
  return jwt.sign({ id: userId }, config.JWT_SECRET, {
    algorithm: 'HS256',
    audience: 'avsec-clients',
    issuer: 'avsecapi',
    jwtid: jti,
    expiresIn: 300
  });
};

test('admins manage card taxonomy, bulk inventory and persisted reports', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const adminId = uuidv4();
  const suffix = uuidv4().slice(0, 8).toUpperCase();
  const accessCode = `RAMP_${suffix}`;
  const categoryCode = `ESCORT_${suffix}`;
  let accessLevelId;
  let categoryId;
  let reportId;
  const cardIds = [];

  try {
    await db.execute(
      `INSERT INTO user_profiles
       (id, user_name, email, password_hash, user_role, is_active)
       VALUES (?, ?, ?, ?, 'admin', 1)`,
      [
        adminId,
        `cards.admin.${suffix.toLowerCase()}`,
        `${adminId}@example.test`,
        await bcrypt.hash('AdminPassword12!', 12)
      ]
    );
    const token = await createToken(adminId);
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    };
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api`;

    const levelResponse = await fetch(`${baseUrl}/card-access-levels`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: accessCode,
        name: 'Ramp Test Access',
        sort_order: 90
      })
    });
    assert.equal(levelResponse.status, 201);
    accessLevelId = (await levelResponse.json()).item.id;

    const categoryResponse = await fetch(`${baseUrl}/card-categories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: categoryCode,
        name: 'Escorted Test Visitor',
        sort_order: 90
      })
    });
    assert.equal(categoryResponse.status, 201);
    categoryId = (await categoryResponse.json()).item.id;

    const bulkResponse = await fetch(`${baseUrl}/access-cards/bulk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cards: [
          {
            number: `RAMP${suffix}A`,
            access_level: accessCode,
            category: categoryCode
          },
          {
            number: `RAMP${suffix}B`,
            access_level: accessCode,
            category: categoryCode
          }
        ]
      })
    });
    assert.equal(bulkResponse.status, 201);
    cardIds.push(...(await bulkResponse.json()).cards.map((card) => card.id));

    const inventory = await fetch(
      `${baseUrl}/access-cards?access_level=${accessCode}&include_inactive=true`,
      { headers }
    );
    assert.equal(inventory.status, 200);
    const inventoryCards = (await inventory.json()).cards;
    assert.equal(inventoryCards.length, 2);
    assert.equal(inventoryCards[0].access_level_name, 'Ramp Test Access');

    const blockedTaxonomyDeactivation = await fetch(
      `${baseUrl}/card-access-levels/${accessLevelId}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ is_active: false })
      }
    );
    assert.equal(blockedTaxonomyDeactivation.status, 409);

    for (const cardId of cardIds) {
      const deactivated = await fetch(`${baseUrl}/access-cards/${cardId}/activation`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ is_active: false })
      });
      assert.equal(deactivated.status, 200);
    }

    const taxonomyDeactivation = await fetch(
      `${baseUrl}/card-access-levels/${accessLevelId}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ is_active: false })
      }
    );
    assert.equal(taxonomyDeactivation.status, 200);

    const [[clock]] = await db.query(
      "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today"
    );
    const reportResponse = await fetch(`${baseUrl}/reconciliation/card-reports`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        date: clock.today,
        notes: 'Automated authoritative snapshot test.'
      })
    });
    assert.equal(reportResponse.status, 201);
    const createdReport = (await reportResponse.json()).report;
    reportId = createdReport.id;
    assert.equal(
      createdReport.cards.some((card) => card.id === cardIds[0]),
      true
    );

    const storedReportResponse = await fetch(
      `${baseUrl}/reconciliation/card-reports/${reportId}?page=1&page_size=500`,
      { headers }
    );
    assert.equal(storedReportResponse.status, 200);
    const storedReport = await storedReportResponse.json();
    assert.equal(
      storedReport.report.cards.some((card) => card.card_id === cardIds[0]),
      true
    );
  } finally {
    if (reportId) {
      await db.execute(
        'DELETE FROM card_reconciliation_reports WHERE id = ?',
        [reportId]
      );
    }
    await db.query(
      'DELETE FROM audit_events WHERE actor_id = ?',
      [adminId]
    );
    if (cardIds.length > 0) {
      await db.query('DELETE FROM card_events WHERE card_id IN (?)', [cardIds]);
      await db.query('DELETE FROM access_cards WHERE id IN (?)', [cardIds]);
    }
    if (accessLevelId) {
      await db.execute('DELETE FROM card_access_levels WHERE id = ?', [accessLevelId]);
    }
    if (categoryId) {
      await db.execute('DELETE FROM card_categories WHERE id = ?', [categoryId]);
    }
    await db.execute('DELETE FROM auth_tokens WHERE user_id = ?', [adminId]);
    await db.execute('DELETE FROM user_profiles WHERE id = ?', [adminId]);
    await new Promise((resolve) => server.close(resolve));
  }
});
