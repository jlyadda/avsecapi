const express = require('express');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');

const router = express.Router();

router.get(
  '/admin/stats',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_ADMIN_STATS),
  async (req, res) => {
    try {
      const [[applicationCounts], [pendingUsers]] = await Promise.all([
        db.execute(
          `SELECT COUNT(*) AS total,
                  SUM(status = 'SUBMITTED') AS submitted,
                  SUM(status = 'APPROVED') AS approved,
                  SUM(status = 'CHECKED_IN') AS checked_in
           FROM visitor_applications`
        ),
        db.execute('SELECT COUNT(*) AS pending_users FROM user_profiles WHERE is_active = 0')
      ]);

      return res.json({
        applications: applicationCounts[0],
        pending_users: pendingUsers[0].pending_users
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to load administrative statistics.' });
    }
  }
);

module.exports = router;
