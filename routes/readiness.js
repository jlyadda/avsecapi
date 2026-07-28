const express = require('express');
const db = require('../db');

const router = express.Router();
const requiredMigration = '012_card_taxonomy_and_reports.sql';

router.get('/ready', async (req, res) => {
  try {
    await db.query('SELECT 1');
    const [rows] = await db.execute(
      'SELECT name FROM schema_migrations WHERE name = ?',
      [requiredMigration]
    );
    if (!rows[0]) {
      return res.status(503).json({
        status: 'not_ready',
        database: 'migration_required',
        code: 'DATABASE_MIGRATION_REQUIRED'
      });
    }
    return res.json({ status: 'ready', database: 'ok' });
  } catch (error) {
    console.error('Readiness check failed:', error.message);
    return res.status(503).json({
      status: 'not_ready',
      database: 'unavailable',
      code: 'DATABASE_UNAVAILABLE'
    });
  }
});

module.exports = router;
