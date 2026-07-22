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
  REVIEW_APPLICATIONS: 'applications:review',
  CHECK_IN_OUT: 'visitors:check-in-out',
  MANAGE_API_KEYS: 'api-keys:manage',
  VIEW_ADMIN_STATS: 'admin:stats:view',
  MANAGE_USERS: 'users:manage',
  MANAGE_ROLES: 'roles:manage'
});

const rolePermissions = Object.freeze({
  security_assistant: [PERMISSIONS.VIEW_APPLICATIONS, PERMISSIONS.CHECK_IN_OUT],
  supervisor: [
    PERMISSIONS.VIEW_APPLICATIONS,
    PERMISSIONS.REVIEW_APPLICATIONS,
    PERMISSIONS.CHECK_IN_OUT
  ],
  audit: [PERMISSIONS.VIEW_APPLICATIONS],
  viewer: [PERMISSIONS.VIEW_APPLICATIONS],
  admin: [
    PERMISSIONS.VIEW_APPLICATIONS,
    PERMISSIONS.REVIEW_APPLICATIONS,
    PERMISSIONS.CHECK_IN_OUT,
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
