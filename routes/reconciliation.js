const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticateToken, authorizePermission } = require('../middleware');
const { PERMISSIONS } = require('../permissions');
const { validate, schemas } = require('../validation');
const { recordAudit, sendError } = require('../audit');
const { snapshotSelect, snapshotParameters } = require('../services/cardSnapshot');

const router = express.Router();

router.get(
  '/reconciliation/cards',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_RECONCILIATION),
  validate(schemas.reconciliation),
  async (req, res) => {
    try {
      const { date, status, page, page_size } = req.validatedQuery;
      const parameters = snapshotParameters(date);
      const [[summaryRow]] = await db.execute(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(snapshot.status = 'AVAILABLE'), 0) AS available,
                COALESCE(SUM(snapshot.status = 'ASSIGNED'), 0) AS assigned,
                COALESCE(SUM(snapshot.status = 'UNAVAILABLE'), 0) AS unavailable,
                COALESCE(SUM(snapshot.status = 'DAMAGED'), 0) AS damaged,
                COALESCE(SUM(snapshot.status = 'LOST'), 0) AS lost
         FROM (${snapshotSelect}) snapshot`,
        parameters
      );
      const statusClause = status ? 'WHERE snapshot.status = ?' : '';
      const cardParameters = status ? [...parameters, status] : parameters;
      const [[countRow]] = await db.execute(
        `SELECT COUNT(*) AS total FROM (${snapshotSelect}) snapshot ${statusClause}`,
        cardParameters
      );
      const total = Number(countRow.total);
      const [cards] = await db.execute(
        `SELECT * FROM (${snapshotSelect}) snapshot
         ${statusClause}
         ORDER BY snapshot.number
         LIMIT ? OFFSET ?`,
        [...cardParameters, page_size, (page - 1) * page_size]
      );
      return res.json({
        summary: Object.fromEntries(
          Object.entries(summaryRow).map(([key, value]) => [key, Number(value)])
        ),
        cards,
        pagination: {
          page,
          page_size,
          total,
          total_pages: Math.ceil(total / page_size)
        }
      });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'CARD_RECONCILIATION_FAILED',
        'Unable to build card reconciliation snapshot.'
      );
    }
  }
);

router.post(
  '/reconciliation/card-reports',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_RECONCILIATION),
  validate(schemas.reconciliationReportCreate),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [cards] = await connection.execute(
        `SELECT * FROM (${snapshotSelect}) snapshot
         ORDER BY snapshot.access_level, snapshot.category, snapshot.number`,
        snapshotParameters(req.body.date)
      );
      if (cards.length > 5000) {
        await connection.rollback();
        return sendError(
          res,
          409,
          'CARD_REPORT_TOO_LARGE',
          'Card inventory exceeds the 5,000-card report limit.'
        );
      }

      const summary = {
        total: cards.length,
        available: 0,
        assigned: 0,
        unavailable: 0,
        damaged: 0,
        lost: 0
      };
      for (const card of cards) {
        summary[card.status.toLowerCase()] += 1;
      }

      const reportId = uuidv4();
      await connection.execute(
        `INSERT INTO card_reconciliation_reports
         (id, report_date, generated_by, request_id, summary, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          reportId,
          req.body.date,
          req.user.id,
          req.requestId,
          JSON.stringify(summary),
          req.body.notes || null
        ]
      );

      for (let index = 0; index < cards.length; index += 250) {
        const chunk = cards.slice(index, index + 250).map((card) => [
          uuidv4(),
          reportId,
          card.id,
          card.number,
          card.access_level,
          card.access_level_name,
          card.category,
          card.category_name,
          card.status,
          card.assignment_id,
          card.application_id,
          card.application_number,
          card.holder_name,
          card.holder_phone,
          card.assigned_at,
          card.last_event_at
        ]);
        if (chunk.length > 0) {
          await connection.query(
            `INSERT INTO card_reconciliation_report_items
             (id, report_id, card_id, card_number, access_level, access_level_name,
              category, category_name, card_status, assignment_id, application_id,
              application_number, holder_name, holder_phone, assigned_at, last_event_at)
             VALUES ?`,
            [chunk]
          );
        }
      }
      await recordAudit(connection, {
        actorId: req.user.id,
        action: 'CARD_RECONCILIATION_REPORT_CREATED',
        resourceType: 'card_reconciliation_report',
        resourceId: reportId,
        requestId: req.requestId,
        metadata: { report_date: req.body.date, summary }
      });
      await connection.commit();
      return res.status(201).json({
        report: {
          id: reportId,
          report_date: req.body.date,
          generated_by: req.user.id,
          request_id: req.requestId,
          summary,
          notes: req.body.notes || null,
          cards
        }
      });
    } catch (error) {
      await connection.rollback();
      console.error(error);
      return sendError(
        res,
        500,
        'CARD_REPORT_CREATE_FAILED',
        'Unable to create card reconciliation report.'
      );
    } finally {
      connection.release();
    }
  }
);

router.get(
  '/reconciliation/card-reports',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_RECONCILIATION),
  validate(schemas.reconciliationReportList),
  async (req, res) => {
    try {
      const { date, page, page_size } = req.validatedQuery;
      const whereClause = date ? 'WHERE report.report_date = ?' : '';
      const parameters = date ? [date] : [];
      const [[countRow]] = await db.execute(
        `SELECT COUNT(*) AS total
         FROM card_reconciliation_reports report
         ${whereClause}`,
        parameters
      );
      const total = Number(countRow.total);
      const [reports] = await db.execute(
        `SELECT report.id, report.report_date, report.generated_by,
                user.user_name AS generated_by_user_name,
                user.full_name AS generated_by_full_name,
                report.request_id, report.summary, report.notes, report.created_at
         FROM card_reconciliation_reports report
         LEFT JOIN user_profiles user ON user.id = report.generated_by
         ${whereClause}
         ORDER BY report.created_at DESC
         LIMIT ? OFFSET ?`,
        [...parameters, page_size, (page - 1) * page_size]
      );
      return res.json({
        reports,
        pagination: {
          page,
          page_size,
          total,
          total_pages: Math.ceil(total / page_size)
        }
      });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'CARD_REPORT_LIST_FAILED',
        'Unable to list card reconciliation reports.'
      );
    }
  }
);

router.get(
  '/reconciliation/card-reports/:id',
  authenticateToken,
  authorizePermission(PERMISSIONS.VIEW_RECONCILIATION),
  validate(schemas.reconciliationReportId),
  async (req, res) => {
    try {
      const [reportRows] = await db.execute(
        `SELECT report.id, report.report_date, report.generated_by,
                user.user_name AS generated_by_user_name,
                user.full_name AS generated_by_full_name,
                report.request_id, report.summary, report.notes, report.created_at
         FROM card_reconciliation_reports report
         LEFT JOIN user_profiles user ON user.id = report.generated_by
         WHERE report.id = ?`,
        [req.params.id]
      );
      const report = reportRows[0];
      if (!report) {
        return sendError(res, 404, 'CARD_REPORT_NOT_FOUND', 'Card report not found.');
      }
      const { page, page_size } = req.validatedQuery;
      const [[countRow]] = await db.execute(
        `SELECT COUNT(*) AS total
         FROM card_reconciliation_report_items
         WHERE report_id = ?`,
        [report.id]
      );
      const total = Number(countRow.total);
      const [cards] = await db.execute(
        `SELECT id, card_id, card_number AS number, access_level, access_level_name,
                category, category_name, card_status AS status, assignment_id,
                application_id, application_number, holder_name, holder_phone,
                assigned_at, last_event_at
         FROM card_reconciliation_report_items
         WHERE report_id = ?
         ORDER BY access_level, category, card_number
         LIMIT ? OFFSET ?`,
        [report.id, page_size, (page - 1) * page_size]
      );
      return res.json({
        report: { ...report, cards },
        pagination: {
          page,
          page_size,
          total,
          total_pages: Math.ceil(total / page_size)
        }
      });
    } catch (error) {
      console.error(error);
      return sendError(
        res,
        500,
        'CARD_REPORT_LOAD_FAILED',
        'Unable to load card reconciliation report.'
      );
    }
  }
);

module.exports = router;
