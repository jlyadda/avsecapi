const crypto = require('node:crypto');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');

const router = express.Router();

router.post(
  '/external-api-keys',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_API_KEYS),
  validate(schemas.externalApiKeyCreate),
  async (req, res) => {
    try {
      const id = uuidv4();
      const apiKey = `avsec_${crypto.randomBytes(32).toString('base64url')}`;
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const keyPrefix = apiKey.slice(0, 16);

      await db.execute(
        `INSERT INTO external_api_keys
         (id, name, purpose, api_role, key_hash, key_prefix, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          req.body.name,
          req.body.purpose,
          req.body.role,
          keyHash,
          keyPrefix,
          req.body.expires_at || null,
          req.user.id
        ]
      );

      return res.status(201).json({
        apiKey: {
          id,
          name: req.body.name,
          purpose: req.body.purpose,
          role: req.body.role,
          keyPrefix,
          expiresAt: req.body.expires_at || null
        },
        secret: apiKey,
        warning: 'Store this secret securely. It cannot be retrieved again.'
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to create external API key.' });
    }
  }
);

router.get(
  '/external-api-keys',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_API_KEYS),
  async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT id, name, purpose, api_role AS role, key_prefix, is_active,
                expires_at, last_used_at, revoked_at, created_by, revoked_by, created_at
         FROM external_api_keys
         ORDER BY created_at DESC`
      );
      return res.json({ apiKeys: rows });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to list external API keys.' });
    }
  }
);

router.delete(
  '/external-api-keys/:id',
  authenticateToken,
  authorizePermission(PERMISSIONS.MANAGE_API_KEYS),
  validate(schemas.externalApiKeyId),
  async (req, res) => {
    try {
      const [result] = await db.execute(
        `UPDATE external_api_keys
         SET is_active = 0, revoked_at = NOW(), revoked_by = ?
         WHERE id = ? AND is_active = 1`,
        [req.user.id, req.params.id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Active API key not found.' });
      }
      return res.json({ message: 'External API key revoked.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Unable to revoke external API key.' });
    }
  }
);

module.exports = router;
