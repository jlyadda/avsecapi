const ROLES = Object.freeze([
  'security_assistant',
  'admin',
  'supervisor',
  'audit',
  'viewer',
  'super_admin'
]);

const PERMISSIONS = Object.freeze({
  VIEW_APPLICATIONS: 'applications:view',
  CREATE_APPLICATIONS: 'applications:create',
  REVIEW_APPLICATIONS: 'applications:review',
  CHECK_IN_OUT: 'visitors:check-in-out',
  VIEW_CARDS: 'cards:view',
  ASSIGN_CARDS: 'cards:assign',
  MANAGE_CARD_INVENTORY: 'cards:inventory:manage',
  VIEW_VEHICLE_APPLICATIONS: 'vehicle-applications:view',
  REVIEW_VEHICLE_APPLICATIONS: 'vehicle-applications:review',
  USE_VEHICLE_PERMITS: 'vehicle-applications:use',
  VIEW_AUDIT_EVENTS: 'audit-events:view',
  VIEW_RECONCILIATION: 'reconciliation:view',
  SEND_NOTIFICATIONS: 'notifications:send',
  MANAGE_NOTIFICATION_GROUPS: 'notification-groups:manage',
  VIEW_NOTIFICATION_DELIVERIES: 'notification-deliveries:view',
  MANAGE_API_KEYS: 'api-keys:manage',
  VIEW_ADMIN_STATS: 'admin:stats:view',
  MANAGE_USERS: 'users:manage',
  MANAGE_ROLES: 'roles:manage'
});

const rolePermissions = Object.freeze({
  security_assistant: [
    PERMISSIONS.VIEW_APPLICATIONS,
    PERMISSIONS.CREATE_APPLICATIONS,
    PERMISSIONS.CHECK_IN_OUT,
    PERMISSIONS.VIEW_CARDS,
    PERMISSIONS.ASSIGN_CARDS,
    PERMISSIONS.VIEW_VEHICLE_APPLICATIONS,
    PERMISSIONS.USE_VEHICLE_PERMITS
  ],
  supervisor: [
    PERMISSIONS.VIEW_APPLICATIONS,
    PERMISSIONS.CREATE_APPLICATIONS,
    PERMISSIONS.REVIEW_APPLICATIONS,
    PERMISSIONS.CHECK_IN_OUT,
    PERMISSIONS.VIEW_CARDS,
    PERMISSIONS.ASSIGN_CARDS,
    PERMISSIONS.VIEW_VEHICLE_APPLICATIONS,
    PERMISSIONS.REVIEW_VEHICLE_APPLICATIONS,
    PERMISSIONS.USE_VEHICLE_PERMITS,
    PERMISSIONS.VIEW_RECONCILIATION
  ],
  audit: [
    PERMISSIONS.VIEW_APPLICATIONS,
    PERMISSIONS.VIEW_CARDS,
    PERMISSIONS.VIEW_VEHICLE_APPLICATIONS,
    PERMISSIONS.VIEW_AUDIT_EVENTS,
    PERMISSIONS.VIEW_RECONCILIATION
  ],
  viewer: [
    PERMISSIONS.VIEW_APPLICATIONS,
    PERMISSIONS.VIEW_CARDS,
    PERMISSIONS.VIEW_VEHICLE_APPLICATIONS
  ],
  admin: [
    PERMISSIONS.VIEW_APPLICATIONS,
    PERMISSIONS.CREATE_APPLICATIONS,
    PERMISSIONS.REVIEW_APPLICATIONS,
    PERMISSIONS.CHECK_IN_OUT,
    PERMISSIONS.VIEW_CARDS,
    PERMISSIONS.ASSIGN_CARDS,
    PERMISSIONS.MANAGE_CARD_INVENTORY,
    PERMISSIONS.VIEW_VEHICLE_APPLICATIONS,
    PERMISSIONS.REVIEW_VEHICLE_APPLICATIONS,
    PERMISSIONS.USE_VEHICLE_PERMITS,
    PERMISSIONS.VIEW_AUDIT_EVENTS,
    PERMISSIONS.VIEW_RECONCILIATION,
    PERMISSIONS.SEND_NOTIFICATIONS,
    PERMISSIONS.MANAGE_NOTIFICATION_GROUPS,
    PERMISSIONS.VIEW_NOTIFICATION_DELIVERIES,
    PERMISSIONS.VIEW_ADMIN_STATS,
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.MANAGE_API_KEYS
  ],
  super_admin: Object.values(PERMISSIONS)
});

const hasPermission = (role, permission) => (
  rolePermissions[role]?.includes(permission) === true
);

const canManageRole = (actorRole, targetRole) => {
  if (actorRole === 'super_admin') return true;
  return actorRole === 'admin' && !['admin', 'super_admin'].includes(targetRole);
};

module.exports = { ROLES, PERMISSIONS, hasPermission, canManageRole };
