const { v4: uuidv4 } = require('uuid');

const addUsers = async (executor, recipients, sql, parameters) => {
  const [rows] = await executor.execute(sql, parameters);
  for (const user of rows) recipients.set(user.id, user);
};

const createNotification = async (
  executor,
  {
    source,
    type,
    title,
    body,
    priority = 'NORMAL',
    actorId = null,
    requestId,
    resourceType = null,
    resourceId = null,
    channels = ['IN_APP'],
    targets,
    metadata = {},
    scheduledAt = null,
    expiresAt = null,
    excludedRoles = []
  }
) => {
  const notificationId = uuidv4();
  await executor.execute(
    `INSERT INTO notifications
     (id, source, type, title, body, priority, actor_id, request_id,
      resource_type, resource_id, channels, metadata, scheduled_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      notificationId,
      source,
      type,
      title,
      body,
      priority,
      actorId,
      requestId,
      resourceType,
      resourceId ? String(resourceId) : null,
      JSON.stringify(channels),
      JSON.stringify(metadata),
      scheduledAt,
      expiresAt
    ]
  );

  const recipients = new Map();
  const externalEmails = new Set();
  for (const target of targets) {
    await executor.execute(
      `INSERT INTO notification_targets
       (id, notification_id, target_type, target_value)
       VALUES (?, ?, ?, ?)`,
      [uuidv4(), notificationId, target.type, target.value || null]
    );

    const roleExclusion = excludedRoles.length
      ? ` AND user_role NOT IN (${excludedRoles.map(() => '?').join(', ')})`
      : '';
    const exclusions = excludedRoles;
    if (target.type === 'ALL') {
      await addUsers(
        executor,
        recipients,
        `SELECT id, email FROM user_profiles
         WHERE is_active = 1${roleExclusion}`,
        exclusions
      );
    } else if (target.type === 'ROLE') {
      await addUsers(
        executor,
        recipients,
        `SELECT id, email FROM user_profiles
         WHERE is_active = 1 AND user_role = ?${roleExclusion}`,
        [target.value, ...exclusions]
      );
    } else if (target.type === 'DEPARTMENT') {
      await addUsers(
        executor,
        recipients,
        `SELECT id, email FROM user_profiles
         WHERE is_active = 1 AND department = ?${roleExclusion}`,
        [target.value, ...exclusions]
      );
    } else if (target.type === 'GROUP') {
      await addUsers(
        executor,
        recipients,
        `SELECT user.id, user.email
         FROM notification_group_members member
         INNER JOIN notification_groups notification_group
           ON notification_group.id = member.group_id
         INNER JOIN user_profiles user ON user.id = member.user_id
         WHERE member.group_id = ?
           AND notification_group.is_active = 1
           AND user.is_active = 1${roleExclusion}`,
        [target.value, ...exclusions]
      );
    } else if (target.type === 'USER') {
      await addUsers(
        executor,
        recipients,
        `SELECT id, email FROM user_profiles
         WHERE id = ? AND is_active = 1${roleExclusion}`,
        [target.value, ...exclusions]
      );
    } else if (target.type === 'EXTERNAL_EMAIL') {
      externalEmails.add(target.value);
    }
  }

  for (const recipient of recipients.values()) {
    await executor.execute(
      `INSERT INTO notification_recipients (notification_id, user_id)
       VALUES (?, ?)`,
      [notificationId, recipient.id]
    );
    if (channels.includes('IN_APP')) {
      await executor.execute(
        `INSERT INTO notification_deliveries
         (id, notification_id, user_id, channel, status, sent_at)
         VALUES (?, ?, ?, 'IN_APP', 'SENT', NOW(3))`,
        [uuidv4(), notificationId, recipient.id]
      );
    }
    if (channels.includes('EMAIL')) {
      await executor.execute(
        `INSERT INTO notification_deliveries
         (id, notification_id, user_id, recipient_email, channel)
         VALUES (?, ?, ?, ?, 'EMAIL')`,
        [uuidv4(), notificationId, recipient.id, recipient.email]
      );
    }
  }

  if (channels.includes('EMAIL')) {
    for (const email of externalEmails) {
      await executor.execute(
        `INSERT INTO notification_deliveries
         (id, notification_id, recipient_email, channel)
         VALUES (?, ?, ?, 'EMAIL')`,
        [uuidv4(), notificationId, email]
      );
    }
  }

  if (channels.includes('EMAIL') && (recipients.size > 0 || externalEmails.size > 0)) {
    await executor.execute(
      `INSERT INTO notification_outbox
       (id, notification_id, available_at)
       VALUES (?, ?, COALESCE(?, NOW(3)))`,
      [uuidv4(), notificationId, scheduledAt]
    );
  }

  return {
    id: notificationId,
    recipientCount: recipients.size,
    externalEmailCount: externalEmails.size
  };
};

const renderTemplate = (template, values) => (
  template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => (
    values[key] === undefined ? match : String(values[key])
  ))
);

const createSystemNotification = async (
  executor,
  {
    templateCode,
    values,
    requestId,
    resourceType,
    resourceId,
    targets,
    channels = ['IN_APP'],
    metadata = {}
  }
) => {
  const [rows] = await executor.execute(
    `SELECT template.code, template.title_template, template.body_template,
            template.default_priority, category.email_enabled
     FROM notification_templates template
     INNER JOIN notification_email_categories category
       ON category.code = template.category_code
     WHERE template.code = ?
       AND template.is_active = 1
       AND category.is_active = 1`,
    [templateCode]
  );
  const template = rows[0];
  if (!template) throw new Error(`Notification template ${templateCode} is unavailable.`);
  const effectiveChannels = channels.filter(
    (channel) => channel !== 'EMAIL' || Boolean(template.email_enabled)
  );
  if (effectiveChannels.length === 0) {
    return {
      id: null,
      recipientCount: 0,
      externalEmailCount: 0,
      emailDisabled: true
    };
  }
  return createNotification(executor, {
    source: 'SYSTEM',
    type: template.code,
    title: renderTemplate(template.title_template, values),
    body: renderTemplate(template.body_template, values),
    priority: template.default_priority,
    requestId,
    resourceType,
    resourceId,
    targets,
    channels: effectiveChannels,
    metadata
  });
};

module.exports = {
  createNotification,
  createSystemNotification,
  renderTemplate
};
