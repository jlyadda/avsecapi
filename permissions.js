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
    PERMISSIONS.ASSIGN_CARDS
  ],
  supervisor: [
    PERMISSIONS.VIEW_APPLICATIONS,
    PERMISSIONS.CREATE_APPLICATIONS,
    PERMISSIONS.REVIEW_APPLICATIONS,
    PERMISSIONS.CHECK_IN_OUT,
    PERMISSIONS.VIEW_CARDS,
    PERMISSIONS.ASSIGN_CARDS
  ],
  audit: [PERMISSIONS.VIEW_APPLICATIONS, PERMISSIONS.VIEW_CARDS],
  viewer: [PERMISSIONS.VIEW_APPLICATIONS, PERMISSIONS.VIEW_CARDS],
  admin: [
    PERMISSIONS.VIEW_APPLICATIONS,
    PERMISSIONS.CREATE_APPLICATIONS,
    PERMISSIONS.REVIEW_APPLICATIONS,
    PERMISSIONS.CHECK_IN_OUT,
    PERMISSIONS.VIEW_CARDS,
    PERMISSIONS.ASSIGN_CARDS,
    PERMISSIONS.MANAGE_CARD_INVENTORY,
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
