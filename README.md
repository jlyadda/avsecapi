# AVSEC Internal API

This document describes the routes intended for airport security staff applications, administrative dashboards, audit tools, and other trusted internal clients.

Public portal submission routes are intentionally excluded from the main route documentation. They use scoped API keys instead of staff JWTs:

- `POST /api/public/visitor-applications`
- `POST /api/public/vehicle-access-applications`

## Base URL

All examples use:

```text
http://localhost:5000
```

Replace this with the URL of the deployed AVSEC API. JSON requests must include:

```http
Content-Type: application/json
```

Authenticated internal routes require:

```http
Authorization: Bearer <jwt-token>
```

Browser clients must have their exact origin listed in the comma-separated
`CORS_ALLOWED_ORIGINS` environment variable. It defaults to
`http://localhost:3000` for local development. Production deployments should
set only trusted HTTPS frontend origins.

Password-reset email delivery uses Gmail SMTP with an app password:

```env
GMAIL_USER=avsec@example.com
GMAIL_APP_PASSWORD=your-google-app-password
EMAIL_FROM_NAME=AVSEC
PASSWORD_RESET_OTP_TTL_MINUTES=10
API_RATE_LIMIT_MAX=1000
API_RATE_LIMIT_WINDOW_MINUTES=15
NOTIFICATION_WORKER_INTERVAL_MS=10000
```

The deployment also accepts the equivalent lower-camel SMTP names:

```env
gmailUser=avsec@example.com
gmailAppSpecificPassword=google-app-password
gmailSendserver=smtp.gmail.com
gmailPort=587
```

`GMAIL_APP_PASSWORD` must be a Google app password, not the mailbox's normal
password. Restart the API after changing environment variables. Reset requests
return `503` while Gmail delivery is not configured.

Verify Gmail authentication without sending an email:

```bash
npm run email:verify
```

## Authentication Model

Staff sign in with a username or email and password. A successful login returns an HS256 JWT and creates a server-side session in `auth_tokens`.

Every authenticated request verifies:

1. The JWT signature, issuer, audience, and expiry.
2. The corresponding server-side session exists and has not been revoked.
3. The user account is still active.
4. The user’s current database role has the required permission.

Role changes and account deactivation therefore take effect immediately. The default token lifetime is 18,000 seconds (5 hours), configurable with `JWT_TTL_SECONDS`.

### Staff Roles

| Role | View/create applications | Review | Check in/out | View/assign cards | Manage card inventory | Manage users | Manage API keys | Manage roles |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `security_assistant` | Yes | No | Yes | Yes | No | No | No | No |
| `supervisor` | Yes | Yes | Yes | Yes | No | No | No | No |
| `audit` | View only | No | No | View only | No | No | No | No |
| `viewer` | View only | No | No | View only | No | No | No | No |
| `admin` | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No |
| `super_admin` | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

Vehicle permit visibility follows application visibility. Review requires
`supervisor`, `admin`, or `super_admin`; marking a permit used also allows
`security_assistant`. Audit events require `audit`, `admin`, or `super_admin`.
Reconciliation requires `supervisor`, `audit`, `admin`, or `super_admin`.

## Common Responses

### Validation error — `400`

Request bodies are strict. Unknown fields, missing required fields, invalid UUIDs, and invalid enum values return:

```json
{
  "error": "Validation failed.",
  "details": [
    {
      "field": "body.role",
      "message": "Invalid option"
    }
  ]
}
```

### Authentication and authorization

| Status | Meaning |
|---|---|
| `401` | Bearer token was not provided. |
| `403` | Token is invalid, expired, revoked, belongs to an inactive user, or the user lacks permission. |
| `404` | Requested user, application, or active API key does not exist. |
| `409` | The requested operation conflicts with the resource’s current state. |
| `429` | A rate limit was exceeded. |
| `500` | The API or database could not complete the operation. |

Unknown routes return:

```json
{
  "error": "Route not found."
}
```

Every response includes `X-Request-Id`. Clients may provide a UUID in the
request's `X-Request-Id` header; otherwise the API generates one. New endpoint
errors include a stable `code` and a human-readable `error` message.

## Health

### `GET /health`

Checks whether the HTTP application is running. This route does not require authentication.

**Response — `200`**

```json
{
  "status": "ok"
}
```

This is a process-health check; it does not currently query the database.

### `GET /ready`

Checks database connectivity and confirms the latest required migration is
applied. This route does not require authentication.

```json
{
  "status": "ready",
  "database": "ok"
}
```

Database or migration failures return `503` with `status: "not_ready"` and a
machine-readable `code`.

## Account Registration and Login

### `POST /api/register`

Creates a system user. This is not a public self-registration route.

**Allowed roles:** `admin`, `super_admin`

An `admin` may create roles below `admin`. Only `super_admin` may create
`admin` or `super_admin` accounts. Role defaults to `security_assistant`,
activation defaults to `true`, and department defaults to `Aviation Security`.

**Request**

```json
{
  "user_name": "j.lyadda",
  "email": "j.lyadda@example.com",
  "password": "A-Strong-Password-123",
  "full_name": "Jonathan Lyadda",
  "department": "Aviation Security",
  "role": "security_assistant",
  "is_active": true
}
```

Validation:

- `user_name`: 3–50 characters; letters, numbers, `.`, `_`, and `-`
- `email`: valid email, maximum 255 characters
- `password`: 12–128 characters
- `full_name`: optional, 2–255 characters
- `department`: optional, 2–255 characters
- `role`: optional role enum; defaults to `security_assistant`
- `is_active`: optional boolean; defaults to `true`

**Response — `201`**

```json
{
  "user": {
    "id": "7de251af-d19e-42b7-bc72-1640062be565",
    "user_name": "j.lyadda",
    "email": "j.lyadda@example.com",
    "role": "security_assistant",
    "is_active": true
  }
}
```

Possible errors:

- `401`: bearer token missing or invalid
- `403`: caller cannot create the requested role
- `409`: username or email is already registered

### `POST /api/login`

Authenticates an active staff user using either username or email.

**Request**

```json
{
  "identifier": "j.lyadda",
  "password": "A-Strong-Password-123"
}
```

**Response — `200`**

```json
{
  "message": "Login successful",
  "token": "<jwt-token>",
  "user": {
    "id": "7de251af-d19e-42b7-bc72-1640062be565",
    "user_name": "j.lyadda",
    "email": "j.lyadda@example.com",
    "role": "security_assistant"
  }
}
```

Possible errors:

- `401`: username/email or password is incorrect
- `403`: account is pending approval or deactivated
- `429`: more than 5 failed login attempts within 15 minutes

Successful logins do not count toward the failed-login limit.

### `POST /api/logout`

Revokes only the JWT session used for the current request.

**Authentication:** any active staff role

**Request body:** none

**Response — `200`**

```json
{
  "message": "Logout successful."
}
```

The token used for logout is rejected immediately on subsequent requests.

### `POST /api/logout-all`

Revokes every active session belonging to the current user, including the token used for this request.

**Authentication:** any active staff role

**Request body:** none

**Response — `200`**

```json
{
  "message": "All sessions revoked successfully."
}
```

### `POST /api/auth/refresh`

**Authentication:** any active staff role

Atomically revokes the current bearer token and returns a replacement. The client must replace its stored token immediately. Refresh works only before the current JWT expires.

```json
{
  "token": "<new-jwt>",
  "expires_at": "2026-07-28T04:00:00.000Z"
}
```

Reusing or concurrently refreshing the old token returns `403` or `409`.

## Current Account

### `GET /api/account`

**Authentication:** any active staff role

Returns `{ "account": {} }` containing `id`, `user_name`, `email`, `full_name`, `department`, `role`, `is_active`, `last_login`, `created_at`, and `updated_at`.

### `PATCH /api/account`

**Authentication:** any active staff role

Updates the signed-in user's `full_name` and/or `email`. Usernames, departments, roles, and activation state remain administrator-controlled.

```json
{
  "full_name": "Jonathan Gift Lyadda",
  "email": "jonathan.lyadda@example.com"
}
```

Returns the updated `{ "account": {} }`. A duplicate email returns `409`.

### `POST /api/account/password`

**Authentication:** any active staff role

```json
{
  "current_password": "CurrentPassword12!",
  "new_password": "ReplacementPassword12!"
}
```

Passwords must contain 12–128 characters. Success revokes every other active session while preserving the session used for the change.

### `POST /api/password-reset/request`

**Authentication:** none

Requests a five-digit password-reset OTP. Unknown, inactive, and valid email
addresses receive the same response to prevent account enumeration.

```json
{
  "email": "j.lyadda@example.com"
}
```

**Response — `202`**

```json
{
  "message": "If an active account matches that email, a reset code will be sent."
}
```

Only one code may be sent to the same account within two minutes. Requesting a
new code invalidates older codes. Codes expire after
`PASSWORD_RESET_OTP_TTL_MINUTES`, which defaults to 10 minutes.

### `POST /api/password-reset/confirm`

**Authentication:** none

```json
{
  "email": "j.lyadda@example.com",
  "otp": "54321",
  "new_password": "ReplacementPassword12!"
}
```

The OTP must contain exactly five digits. It is single-use and becomes invalid
after five incorrect attempts. Success changes the password, consumes all
outstanding reset codes, and revokes every existing JWT session.

**Response — `200`**

```json
{
  "message": "Password reset successful. Sign in with the new password."
}
```

Invalid, expired, consumed, or locked codes return the same `400` error.

## Visitor Applications

### Application statuses

```text
SUBMITTED ──► UNDER_REVIEW ──► APPROVED ──► CHECKED_IN ──► CHECKED_OUT
    │               │
    └───────────────┴──────► REJECTED
```

`SUBMITTED` means the first workflow stage is active. `UNDER_REVIEW` means at
least one stage approved the application and another stage is pending. The
internal API does not allow arbitrary status updates. Clients must use workflow
action, check-in, and check-out routes.

### `GET /api/visitor-applications`

**Allowed roles:** all internal roles

Supports `search`, `status`, `visit_from`, `visit_to`, `page`, and `page_size`. Search covers application number, visitor names, identity number, and company. Visit filters use ISO `YYYY-MM-DD`; `page_size` defaults to `50` and is capped at `100`.

```json
{
  "applications": [],
  "pagination": {
    "page": 1,
    "page_size": 50,
    "total": 0,
    "total_pages": 0
  }
}
```

Each item uses the same shape as the single-application route.

Reviewed applications return the reviewer's display name in `reviewed_by` and
retain the UUID in `reviewed_by_id`.

### `POST /api/visitor-applications`

**Allowed roles:** `security_assistant`, `supervisor`, `admin`, `super_admin`

Creates a staff-entered application with status `SUBMITTED`. Internal dates use ISO `YYYY-MM-DD`.

```json
{
  "first_name": "Jonathan",
  "last_name": "Lyadda",
  "date_of_birth": "2002-08-08",
  "gender": 1,
  "identity_type": "NATIONAL_ID",
  "identity_number": "CM1234567890",
  "issuing_country": "UGANDA",
  "personal_phone": "+256700000000",
  "personal_email": "visitor@example.com",
  "company_name": "Example Limited",
  "company_position": "Technician",
  "visit_reasons": ["Equipment installation"],
  "areas_of_access": ["Terminal"],
  "visit_starts": "2026-07-28",
  "visit_ends": "2026-07-28"
}
```

Optional fields include other names, identity expiry, alternate phone, company contact fields, image/document HTTPS links, and access areas. Identity types are `NATIONAL_ID`, `PASSPORT`, and `DRIVERS_LICENSE`; non-Ugandan applicants must use `PASSPORT`.

**Response — `201`:** `{ "application": {} }`

### `GET /api/visitor-applications/:reference`

Returns one visitor application and its linked identity profile.

`:reference` may be:

- The application UUID
- The application number, such as `AVSEC-20260727-A1B2C3D4`

**Allowed roles:** `security_assistant`, `supervisor`, `audit`, `viewer`, `admin`, `super_admin`

**Example**

```http
GET /api/visitor-applications/AVSEC-20260727-A1B2C3D4
Authorization: Bearer <jwt-token>
```

**Response — `200`**

```json
{
  "application": {
    "id": "180b936c-5913-4f86-b3d5-b16a789741c9",
    "application_number": "AVSEC-20260727-A1B2C3D4",
    "visitor_id": 42,
    "personal_email": "visitor@example.com",
    "personal_phone": "+256700000000",
    "alternative_personal_phone": "+256701000000",
    "company_name": "Example Limited",
    "company_position": "Technician",
    "company_address": "Entebbe, Uganda",
    "company_phone": "+256700000001",
    "company_email": "operations@example.com",
    "areas_of_access": ["Terminal", "Airside"],
    "supporting_documents": {
      "identity_document_url": "https://files.example.com/id.pdf",
      "avsec_endorsed_letter_url": "https://files.example.com/letter.pdf",
      "passport_photograph_url": "https://files.example.com/photo.jpg",
      "other_document_urls": []
    },
    "visit_reasons": ["Equipment installation"],
    "visit_starts": "2026-07-28",
    "visit_ends": "2026-07-30",
    "status": "APPROVED",
    "review_notes": "Identity and supporting documents verified.",
    "first_name": "Jonathan",
    "last_name": "Lyadda",
    "other_names": "Gift",
    "identity_type": "NATIONAL_ID",
    "identity_number": "CM1234567890",
    "issuing_country": "UGANDA",
    "date_of_birth": "2002-08-08",
    "gender": 1,
    "image_url": "https://files.example.com/photo.jpg",
    "within_visit_period": 1
  }
}
```

Notes:

- `gender` is stored as `1` for male and `0` for female.
- `within_visit_period` is calculated using the database date: `1` means today is within the approved visit window.
- JSON columns may be delivered as JSON values or JSON strings depending on the database driver/runtime configuration. Internal clients should tolerate either form.
- The response contains personal identity and document links and must not be exposed to unauthorized users.

Possible errors:

- `400`: invalid reference format
- `404`: application not found

### `PATCH /api/visitor-applications/:reference/decision`

Deprecated compatibility route. It records one decision against the current
workflow stage; it no longer grants final approval in one request. New clients
must use `POST /api/visitor-applications/:reference/workflow/actions`.

**Allowed roles:** `supervisor`, `admin`, `super_admin`

The caller must be assigned to the current stage. A stage approval returns
`UNDER_REVIEW` until the final configured stage approves.

**Approve**

```json
{
  "decision": "APPROVED",
  "notes": "Identity and documents verified."
}
```

**Reject**

```json
{
  "decision": "REJECTED",
  "notes": "Endorsed letter is missing or invalid."
}
```

Validation:

- `decision`: `APPROVED` or `REJECTED`
- `notes`: optional for approval; required for rejection; 3–2,000 characters

**Response — `200`**

```json
{
  "application": {},
  "status": "UNDER_REVIEW",
  "message": "Stage decision recorded and application moved to the next stage."
}
```

Possible errors:

- `404`: application not found
- `403 WORKFLOW_STAGE_NOT_ASSIGNED`: current stage is not assigned to the caller
- `403 WORKFLOW_SELF_APPROVAL_FORBIDDEN`: caller submitted the application
- `403 WORKFLOW_SEPARATION_OF_DUTIES`: caller approved an earlier protected stage
- `409 WORKFLOW_NOT_ACTIVE`: application has no active review stage

## Visitor Approval Workflows

Workflow authorization is separate from login roles. Login roles grant API
permissions; workflow groups and stage assignees determine who may decide a
specific stage.

The seeded workflow is:

1. `MANAGER_REVIEW` — `MANAGERS` group or `admin` role
2. `SENIOR_SECURITY_REVIEW` — `PSO` group, `SSO` group, or `supervisor` role
3. `FACILITATION_DESK` — `FACILITATION_DESK` group or `security_assistant` role

Each stage uses `ANY_ONE`: one eligible officer approves or rejects it. Default
stages prohibit self-approval and require a different officer from officers who
approved earlier stages. Rejection ends the workflow immediately; approval at
the last stage sets the application to `APPROVED`.

Applications retain the workflow version active when they were submitted.
Activating a new version affects only later applications.

### `GET /api/workflow-tasks/mine`

**Allowed roles:** `security_assistant`, `supervisor`, `admin`, `super_admin`

Returns active stages the current user is eligible to complete. Supports
`search`, `page`, and `page_size`. Search covers application number, visitor
name, identity number, and company.

```json
{
  "tasks": [
    {
      "application_id": "uuid",
      "application_number": "AVSEC-20260729-A1B2C3D4",
      "application_status": "UNDER_REVIEW",
      "stage_code": "SENIOR_SECURITY_REVIEW",
      "stage_name": "PSO or SSO Review",
      "sequence_number": 2,
      "activated_at": "2026-07-29T08:00:00.000Z",
      "due_at": "2026-07-30T08:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "page_size": 50,
    "total": 1,
    "total_pages": 1
  }
}
```

Self-submitted tasks and stages that violate separation of duties are excluded.

### `POST /api/visitor-applications/:reference/workflow/actions`

**Allowed roles:** users with workflow task access who are assigned to the
current stage

```json
{
  "action": "APPROVE",
  "notes": "Identity and supporting documents verified.",
  "approved_visit_starts": "2026-08-05",
  "approved_visit_ends": "2026-08-12",
  "approved_areas_of_access": ["PASSENGER_TERMINAL", "AIRSIDE"],
  "document_reviews": [
    { "document_key": "IDENTITY_DOCUMENT", "verdict": "VALID" },
    { "document_key": "AVSEC_ENDORSED_LETTER", "verdict": "VALID" },
    { "document_key": "PASSPORT_PHOTOGRAPH", "verdict": "VALID" },
    { "document_key": "OTHER_DOCUMENT_1", "verdict": "VALID" }
  ]
}
```

`action` is `APPROVE` or `REJECT`. Notes are optional for approval and required
for rejection. At the one stage configured with
`captures_access_approval: true`, the PSO/SSO supervisor must review every
submitted document. The application response exposes `submitted_documents`
with authoritative `document_key` and `document_url` values; clients submit a
verdict for each key and never send the URL back.

Approval also requires `approved_visit_starts`, `approved_visit_ends`, and
`approved_areas_of_access`. Approved dates use `YYYY-MM-DD`, must remain inside
the applicant's requested period, and cannot extend beyond identity expiry.
Areas must be unique active codes from `GET /api/access-areas`. Every document
must be `VALID` before approval can proceed.

To reject because a document is invalid, submit all document reviews, mark the
failed documents `INVALID`, include notes on each invalid verdict, and omit
approved dates and areas:

```json
{
  "action": "REJECT",
  "notes": "The endorsed letter could not be authenticated.",
  "document_reviews": [
    { "document_key": "IDENTITY_DOCUMENT", "verdict": "VALID" },
    {
      "document_key": "AVSEC_ENDORSED_LETTER",
      "verdict": "INVALID",
      "notes": "Issuer signature could not be verified."
    },
    { "document_key": "PASSPORT_PHOTOGRAPH", "verdict": "VALID" },
    { "document_key": "OTHER_DOCUMENT_1", "verdict": "VALID" }
  ]
}
```

The seeded capture stage is `SENIOR_SECURITY_REVIEW`. The acting user must have
the `supervisor` role. Other stages must omit dates, areas, and document reviews.

```json
{
  "application": {},
  "workflow": {
    "status": "UNDER_REVIEW",
    "completed": false,
    "current_stage": {
      "code": "SENIOR_SECURITY_REVIEW",
      "name": "PSO or SSO Review"
    }
  }
}
```

The transaction locks the application and workflow instance, records document
verdicts with reviewer identity and timestamp, stores the approved access grant,
records an append-only action and audit event, activates the next stage, and
creates notifications for its assignees. Final approval or rejection emails the
external applicant. URLs are not copied into audit metadata.

### `GET /api/visitor-applications/:reference/workflow`

**Allowed roles:** all internal roles that can view visitor applications

Returns the fixed workflow version, ordered stage history, reviewer display
names, notes, timestamps, request IDs, append-only actions, approved dates,
approved areas, and document verdicts.

### Workflow Group Administration

**Allowed role:** `super_admin`

- `GET /api/workflow-groups` — list groups and active members
- `POST /api/workflow-groups` — create an operational group
- `PATCH /api/workflow-groups/:id` — update name, description, or active state
- `PUT /api/workflow-groups/:id/members` — atomically replace members

```json
{
  "code": "TERMINAL_MANAGERS",
  "name": "Terminal Managers",
  "description": "Managers responsible for terminal access",
  "user_ids": ["user-uuid"]
}
```

Only active users may be members. Disabling a group immediately removes its
members from task eligibility without altering historical records.

### Workflow Version Administration

**Allowed role:** `super_admin`

- `GET /api/application-workflows` — list workflows and versions
- `POST /api/application-workflows` — create a workflow container
- `PATCH /api/application-workflows/:id` — update metadata or active state
- `POST /api/application-workflows/:id/versions` — create a complete draft
- `POST /api/application-workflows/:id/versions/:versionId/activate` — activate a draft

Create a draft version:

```json
{
  "stages": [
    {
      "code": "SENIOR_SECURITY_REVIEW",
      "name": "PSO or SSO Review",
      "description": "Security review and access grant",
      "allow_submitter_action": false,
      "require_different_actor": true,
      "sla_hours": 24,
      "captures_access_approval": true,
      "assignees": [
        {
          "type": "GROUP",
          "value": "workflow-group-uuid"
        },
        {
          "type": "ROLE",
          "value": "supervisor"
        }
      ]
    }
  ]
}
```

Stages execute in array order. Assignee types are `ROLE`, `GROUP`, and `USER`.
Group and user values must be UUIDs; role values must be known system roles.
Every stage needs at least one assignee.
Every workflow version must have exactly one stage with
`captures_access_approval: true`. That supervisor's dates and areas become the
authoritative access grant used for validity checks and pass assignment.
Requested dates, requested areas, submitted links, and review verdicts remain
available separately for audit and comparison.

Versions are immutable after activation. To change a live workflow, create and
activate a new draft. Activation retires the previously active visitor workflow
version atomically and is audited.

### `POST /api/visitor-applications/:reference/check-in`

Creates a visit session and moves an approved application to `CHECKED_IN`.

**Allowed roles:** `security_assistant`, `supervisor`, `admin`, `super_admin`

Requirements:

- Application status must be `APPROVED`.
- The database date must be between `approved_visit_starts` and
  `approved_visit_ends`.
- An application can have only one visit session.

**Request**

```json
{
  "gate": "Main Gate"
}
```

`gate` is optional and may contain 1–100 characters.

**Response — `200`**

```json
{
  "status": "CHECKED_IN",
  "message": "Visitor checked in."
}
```

Possible errors:

- `404`: application not found
- `409`: invalid status or the approved date range is not currently valid

### `POST /api/visitor-applications/:reference/check-out`

Closes the active visit session, records the security officer performing checkout, moves the application to `CHECKED_OUT`, and updates the visitor’s `last_visit`.

**Allowed roles:** `security_assistant`, `supervisor`, `admin`, `super_admin`

The application must currently be `CHECKED_IN`.

**Request**

```json
{}
```

**Response — `200`**

```json
{
  "status": "CHECKED_OUT",
  "message": "Visitor checked out."
}
```

Possible errors:

- `404`: application not found
- `409`: application is not currently checked in

## Vehicle Access Permits

Vehicle permit statuses are `SUBMITTED`, `APPROVED`, `REJECTED`, `CANCELLED`,
and `USED`.

### `GET /api/vehicle-access-applications`

**Allowed roles:** all internal roles

Supports `search`, `status`, `visit_from`, `visit_to`, `page`, and `page_size`.
Search covers reference, driver name/NIN, registration number, and company.
Dates use `YYYY-MM-DD`; page size defaults to 50 and is capped at 100.

```json
{
  "applications": [],
  "pagination": {
    "page": 1,
    "page_size": 50,
    "total": 0,
    "total_pages": 0
  }
}
```

### `GET /api/vehicle-access-applications/:reference`

**Allowed roles:** all internal roles

`:reference` may be the UUID or short `VAP-XXXXXXXX` reference. Returns
`{ "application": {} }`, including driver identity reference, review fields,
and permit-use fields.

### `PATCH /api/vehicle-access-applications/:reference/decision`

**Allowed roles:** `supervisor`, `admin`, `super_admin`

```json
{
  "decision": "APPROVED",
  "notes": "Driver and vehicle verified."
}
```

Decision is `APPROVED` or `REJECTED`; rejection notes are required. Only a
`SUBMITTED` permit may be reviewed. The transition and audit event commit in
one transaction. Returns `{ "application": {} }`.

### `POST /api/vehicle-access-applications/:reference/mark-used`

**Allowed roles:** `security_assistant`, `supervisor`, `admin`, `super_admin`

The request body must be `{}`. Only an `APPROVED` permit may become `USED`, and
the current database time must fall within `access_starts_at` and
`access_ends_at`. Returns `{ "application": {} }`.

## User Administration

### `GET /api/users`

**Allowed roles:** `admin`, `super_admin`

Supports `search`, `role`, `is_active=true|false`, `page`, and `page_size`. Search covers username, email, full name, and department.

```json
{
  "users": [],
  "pagination": {
    "page": 1,
    "page_size": 50,
    "total": 0,
    "total_pages": 0
  }
}
```

### `PATCH /api/users/:id/status`

Activates or deactivates a staff account.

**Allowed roles:** `admin`, `super_admin`

**Request**

```json
{
  "is_active": true
}
```

Rules:

- An administrator cannot deactivate their own account.
- `admin` may manage roles below `admin`, but cannot manage another `admin` or `super_admin`.
- `super_admin` may manage any role.
- Deactivation revokes all active sessions belonging to the target user.

**Response — `200`**

```json
{
  "message": "User activated."
}
```

or:

```json
{
  "message": "User deactivated."
}
```

Possible errors:

- `400`: attempted self-deactivation
- `403`: target user is outside the caller’s management authority
- `404`: user not found

### `PATCH /api/users/:id/role`

Changes a staff user’s role.

**Allowed role:** `super_admin`

**Request**

```json
{
  "role": "supervisor"
}
```

Accepted roles:

- `security_assistant`
- `supervisor`
- `audit`
- `viewer`
- `admin`
- `super_admin`

Rules:

- A super administrator cannot change their own role through this endpoint.
- All sessions belonging to the target user are revoked after the role change.
- The target must log in again to obtain a new session under the new role.

**Response — `200`**

```json
{
  "message": "User role updated; existing sessions were revoked."
}
```

Possible errors:

- `400`: attempted self-role change
- `404`: user not found

### `POST /api/users/:id/sessions/revoke`

Revokes every active JWT session belonging to another staff user without changing account status.

**Allowed roles:** `admin`, `super_admin`

Management hierarchy is the same as the status endpoint:

- `admin` can revoke sessions for roles below `admin`
- `super_admin` can revoke sessions for any role

**Request body:** none

**Response — `200`**

```json
{
  "message": "User sessions revoked.",
  "revokedSessions": 2
}
```

Possible errors:

- `403`: target user is outside the caller’s authority
- `404`: user not found

## System Session Monitoring

Super administrators can monitor currently logged-in users and historical
sessions without exposing JWT values, password data, or credential hashes.

### `GET /api/admin/system-sessions`

**Allowed role:** `super_admin`

The default `status` is `ACTIVE`, which returns currently logged-in users.
Supported filters are `status`, `search`, `role`, `user_id`, `ip_address`,
`page`, and `page_size`. Status values are `ACTIVE`, `REVOKED`, `EXPIRED`, and
`ALL`.

```json
{
  "summary": {
    "logged_in_users": 3,
    "active_sessions": 4,
    "revoked_sessions": 10,
    "expired_sessions": 25
  },
  "sessions": [
    {
      "session_id": "session-uuid",
      "user_id": "user-uuid",
      "user_name": "j.lyadda",
      "full_name": "Jonathan Lyadda",
      "email": "j.lyadda@example.com",
      "department": "Aviation Security",
      "role": "security_assistant",
      "account_active": true,
      "status": "ACTIVE",
      "session_started_at": "2026-08-02T08:00:00.000Z",
      "last_seen_at": "2026-08-02T09:15:00.000Z",
      "expires_at": "2026-08-02T13:00:00.000Z",
      "configured_duration_seconds": 18000,
      "elapsed_duration_seconds": 4500,
      "remaining_seconds": 13500,
      "ip_address": "192.0.2.25",
      "last_ip_address": "192.0.2.25",
      "user_agent": "Mozilla/5.0 ...",
      "parent_jti": null,
      "is_current_session": false
    }
  ],
  "pagination": {}
}
```

`ip_address` is the login IP. `last_ip_address` is refreshed with session
activity. `parent_jti` links a refreshed session to the session it replaced.
Activity timestamps are updated at most once per minute to avoid unnecessary
database writes. Viewing session information is audited.

### `POST /api/admin/system-sessions/:jti/revoke`

**Allowed role:** `super_admin`

```json
{
  "reason": "Unrecognized device reported by the account owner."
}
```

Revocation takes effect on the target’s next request and is audited with the
actor, target user, request ID, and optional human reason. A super administrator
must use `/api/logout` instead of this route to revoke their current session.

## Approved Visitors

The visitor data model now separates three concerns:

- `avsec_visitors` is the reusable identity profile and security record.
- `visitor_applications` stores every submitted access request and its workflow.
- `visitors` is the operational register containing only applications that
  completed final approval.

Final workflow approval inserts the visitor into `visitors` in the same
database transaction. Existing approved applications were backfilled during
migration `018_approved_visitors.sql`. Check-in and check-out keep the approved
visitor status synchronized.

### `GET /api/visitors`

**Allowed roles:** `security_assistant`, `supervisor`, `audit`, `viewer`,
`admin`, `super_admin`

Supports `search`, `status`, `valid_on`, `page`, and `page_size`. Search covers
application number, visitor name, identity number, company, and assigned card.
`valid_on` uses ISO `YYYY-MM-DD`.

Each visitor includes identity details, approved access-area codes and dates,
approver display name, current card details, `within_valid_period`, and
`pass_assignment_eligible`.

```json
{
  "visitors": [
    {
      "id": "approved-visitor-uuid",
      "application_id": "application-uuid",
      "application_number": "AVSEC-20260802-A1B2C3D4",
      "full_name": "Jonathan Gift Lyadda",
      "identity_number": "CM1234567890",
      "company": "Example Limited",
      "approved_areas_of_access": ["PASSENGER_TERMINAL", "AIRSIDE"],
      "valid_from": "2026-08-02",
      "valid_until": "2026-08-05",
      "status": "APPROVED",
      "card_number": null,
      "pass_assignment_eligible": 1
    }
  ],
  "pagination": {
    "page": 1,
    "page_size": 50,
    "total": 1,
    "total_pages": 1
  }
}
```

### `GET /api/visitors/:id`

Returns one approved visitor using the UUID from the `visitors` table.

### `POST /api/visitors/:id/card-assignment`

**Allowed roles:** `security_assistant`, `supervisor`, `admin`, `super_admin`

```json
{
  "card_number": "PVG001"
}
```

The visitor must be `APPROVED` or `CHECKED_IN`, within the approved access
period, and have no active card. The selected card, access level, and category
must all be active and available. Its access level must cover every area
approved by the PSO/SSO. Assignment is transactional and audited. A card that
does not cover the complete approved set returns `409
CARD_ACCESS_LEVEL_MISMATCH` with `missing_areas`; an approved visitor without an
area decision returns `409 VISITOR_HAS_NO_APPROVED_ACCESS_AREAS`.

### `POST /api/visitors/:id/card-return`

**Allowed roles:** `security_assistant`, `supervisor`, `admin`, `super_admin`

Request body: `{}`. This closes the active assignment, returns the card to
available inventory, records the returning officer, and creates audit/card
events atomically.

The original application-based assignment and return routes remain available
for backward compatibility.

## Access Cards

Card numbers are unique. Creation, assignment, return, and condition changes run in database transactions. `card_assignments` records issuance/return officers and timestamps; `card_events` records inventory events.

Access-level and category codes are managed by the API. Frontends should load
them dynamically rather than maintaining a fixed enum.

### `GET /api/card-access-levels`

### `GET /api/card-categories`

**Allowed roles:** all internal roles

Both routes accept `include_inactive=true|false`. Responses contain stable
`code`, editable `name`, `description`, `sort_order`, and `is_active`.

### Access Area Administration

- `GET /api/access-areas?include_inactive=false` - all internal roles can load
  the PSO/SSO approval choices.
- `POST /api/access-areas` - `admin` and `super_admin` create an area.
- `PATCH /api/access-areas/:code` - `admin` and `super_admin` edit or deactivate
  an area. Areas used by active approved visitors cannot be deactivated.
- `GET /api/card-access-levels/:code/areas` - all internal roles can inspect the
  physical areas covered by an access level.
- `PUT /api/card-access-levels/:code/areas` - `admin` and `super_admin`
  atomically replace the level's active area mappings.

Create an area:

```json
{
  "code": "MAINTENANCE_HANGAR",
  "name": "Maintenance Hangar",
  "description": "Restricted engineering maintenance area",
  "sort_order": 70
}
```

Replace an access level's coverage:

```json
{
  "area_codes": ["PUBLIC_AREAS", "PASSENGER_TERMINAL"]
}
```

Area codes are stable identifiers. Renaming an area changes only its display
name. Mapping changes affect future assignments; active assignment history
remains append-only and unchanged.

### `POST /api/card-access-levels`

### `POST /api/card-categories`

**Allowed roles:** `admin`, `super_admin`

```json
{
  "code": "RAMP_ESCORT",
  "name": "Ramp Escort",
  "description": "Escorted ramp access",
  "sort_order": 60
}
```

Codes are uppercase machine identifiers and cannot be renamed after creation.

### `PATCH /api/card-access-levels/:id`

### `PATCH /api/card-categories/:id`

**Allowed roles:** `admin`, `super_admin`

Editable fields are `name`, `description`, `sort_order`, and `is_active`.
Deactivation returns `409` while active cards still reference the value.

### `GET /api/access-cards`

**Allowed roles:** all internal roles; `audit` and `viewer` are read-only

Supports `access_level`, `category`, `status`, and `search`. Status values are `AVAILABLE`, `ASSIGNED`, `DAMAGED`, `LOST`, and `UNAVAILABLE`.

```json
{
  "cards": [
    {
      "id": "uuid",
      "number": "PVG001",
      "access_level": "LEVEL_1",
      "category": "VISITOR",
      "status": "AVAILABLE",
      "current_application_id": null,
      "last_returned_at": null
    }
  ]
}
```

Seeded access levels are `LEVEL_1`, `LEVEL_2`, `LEVEL_3`, `LEVEL_4`, and `ALL`.
Seeded categories are `VISITOR`, `STAFF`, `CONTRACTOR`, `ONE_DAY_DUTY`, and
`PUBLIC_AREAS`. Administrators may add more values.

### `POST /api/access-cards`

**Allowed roles:** `admin`, `super_admin`

```json
{
  "number": "PVG001",
  "access_level": "LEVEL_1",
  "category": "VISITOR"
}
```

Returns `{ "card": {} }` with status `201`; duplicate card numbers return `409`.

### `POST /api/access-cards/bulk`

**Allowed roles:** `admin`, `super_admin`

Creates up to 500 cards atomically:

```json
{
  "cards": [
    {
      "number": "PVG001",
      "access_level": "LEVEL_1",
      "category": "VISITOR"
    }
  ]
}
```

Every card must use active taxonomy values. Any duplicate or invalid card rolls
back the complete request.

### `PATCH /api/access-cards/:id`

**Allowed roles:** `admin`, `super_admin`

Updates `number`, `access_level`, and/or `category`. Assigned cards cannot be
renumbered or reclassified.

### `PATCH /api/access-cards/:id/activation`

**Allowed roles:** `admin`, `super_admin`

```json
{
  "is_active": false
}
```

This soft-decommissions or reactivates a card. Assigned cards cannot be
deactivated, and reactivation requires active taxonomy values.

### `PATCH /api/access-cards/:id/status`

**Allowed roles:** `admin`, `super_admin`

```json
{
  "status": "DAMAGED"
}
```

Allowed values are `AVAILABLE`, `UNAVAILABLE`, `DAMAGED`, and `LOST`. An assigned card cannot change inventory condition and returns `409`.

### `GET /api/access-cards/:id/assignments`

**Allowed roles:** all internal roles

Supports `page` and `page_size`; page size defaults to 50 and is capped at 100.
Returns historical assignment and return officers, timestamps, application
number, return condition, and assignment status.

```json
{
  "assignments": [],
  "pagination": {
    "page": 1,
    "page_size": 50,
    "total": 0,
    "total_pages": 0
  }
}
```

### `POST /api/visitor-applications/:reference/card-assignment`

**Allowed roles:** `security_assistant`, `supervisor`, `admin`, `super_admin`

```json
{
  "card_number": "PVG001"
}
```

The application must be `APPROVED` or `CHECKED_IN` and inside its approved date
period. The card must be available, neither damaged nor lost, and its access
level must cover every approved access area. Conflicts return `409`.

**Response — `200`:** `{ "application": {} }`

### `POST /api/visitor-applications/:reference/card-return`

**Allowed roles:** `security_assistant`, `supervisor`, `admin`, `super_admin`

The request body must be `{}`. This closes the assignment, records the returning officer and timestamp, and makes the card available atomically. Visitor checkout returns `409` until the card is returned.

**Response — `200`:** `{ "application": {} }`

## Audit Events

### `GET /api/audit-events`

**Allowed roles:** `audit`, `admin`, `super_admin`

Supports `actor_id`, `action`, `resource_type`, `resource_id`, `from`, `to`,
`page`, and `page_size`. Time filters require ISO 8601 values with an offset.
Page size defaults to and is capped at 100.

```json
{
  "events": [
    {
      "id": "uuid",
      "occurred_at": "2026-07-28T08:00:00.000Z",
      "actor_id": "uuid",
      "actor_user_name": "j.lyadda",
      "action": "VISITOR_CHECKED_IN",
      "resource_type": "visitor_application",
      "resource_id": "uuid",
      "request_id": "uuid",
      "metadata": {}
    }
  ],
  "pagination": {
    "page": 1,
    "page_size": 100,
    "total": 1,
    "total_pages": 1
  }
}
```

Audit rows are append-only through the API. Metadata contains operational
references only and never stores passwords, JWTs, reset OTPs, API-key secrets,
credential hashes, or identity-document content.

## Card Reconciliation

### `GET /api/reconciliation/cards`

**Allowed roles:** `supervisor`, `audit`, `admin`, `super_admin`

Requires `date=YYYY-MM-DD`. Optional parameters are `status`, `page`, and
`page_size`. The snapshot reconstructs each card's state from append-only card
events as of the end of the requested database-local date.

```json
{
  "summary": {
    "total": 555,
    "available": 520,
    "assigned": 20,
    "unavailable": 5,
    "damaged": 8,
    "lost": 2
  },
  "cards": [],
  "pagination": {}
}
```

The summary always covers the full snapshot. `status` filters only the paginated
`cards` collection.

For cards classified as `ASSIGNED`, each item also includes `assignment_id`,
`application_id`, `application_number`, `holder_name`, `holder_phone`, and
`assigned_at`. New cards and returned cards are both `AVAILABLE`; return history
is not a current status.

### `POST /api/reconciliation/card-reports`

**Allowed roles:** `supervisor`, `audit`, `admin`, `super_admin`

Creates an immutable authoritative report snapshot:

```json
{
  "date": "2026-07-28",
  "notes": "End-of-day card reconciliation."
}
```

The API calculates the summary, copies every card/holder row, records the
reporter from the JWT, stores the request ID, and writes an audit event in one
transaction. The response contains the complete snapshot for immediate PDF
rendering.

### `GET /api/reconciliation/card-reports`

Lists saved reports with optional `date`, `page`, and `page_size`.

### `GET /api/reconciliation/card-reports/:id`

Returns one saved report and paginated immutable card items. Use this endpoint
to regenerate or download a historical PDF instead of reading live card state.

Recommended frontend report flow:

1. Refresh taxonomy and inventory for operational display.
2. Call `GET /api/reconciliation/cards` for a live preview.
3. Call `POST /api/reconciliation/card-reports` to freeze the report.
4. Render the PDF only from the returned saved snapshot.

## External API-Key Administration

These are internal administrative routes. The keys they create are used by approved external portals.

### API-key roles

| API-key role | Permitted external route |
|---|---|
| `VISITOR_APPLICATION` | `POST /api/public/visitor-applications` |
| `VEHICLE_ACCESS_APPLICATION` | `POST /api/public/vehicle-access-applications` |

An API key has one role. Create separate keys when an integration requires separate scopes.

### `POST /api/external-api-keys`

Creates a scoped external API key.

**Allowed roles:** `admin`, `super_admin`

**Request**

```json
{
  "name": "Public visitor portal",
  "purpose": "Submit visitor access applications from the approved public portal.",
  "role": "VISITOR_APPLICATION",
  "expires_at": "2027-07-27T23:59:59+03:00"
}
```

Validation:

- `name`: 3–100 characters
- `purpose`: 10–500 characters
- `role`: one of the two API-key roles listed above
- `expires_at`: optional ISO 8601 timestamp with offset; must be in the future

**Response — `201`**

```json
{
  "apiKey": {
    "id": "81eb2523-f6ac-4897-9e72-09b090e8c6b6",
    "name": "Public visitor portal",
    "purpose": "Submit visitor access applications from the approved public portal.",
    "role": "VISITOR_APPLICATION",
    "keyPrefix": "avsec_a1b2c3d4e5",
    "expiresAt": "2027-07-27T20:59:59.000Z"
  },
  "secret": "avsec_<secret-value>",
  "warning": "Store this secret securely. It cannot be retrieved again."
}
```

The `secret` is returned only once. The database stores a SHA-256 hash, not the plaintext key.

### `GET /api/external-api-keys`

Lists external API-key metadata without exposing secrets.

**Allowed roles:** `admin`, `super_admin`

**Response — `200`**

```json
{
  "apiKeys": [
    {
      "id": "81eb2523-f6ac-4897-9e72-09b090e8c6b6",
      "name": "Public visitor portal",
      "purpose": "Submit visitor access applications from the approved public portal.",
      "role": "VISITOR_APPLICATION",
      "key_prefix": "avsec_a1b2c3d4e5",
      "is_active": 1,
      "expires_at": "2027-07-27T20:59:59.000Z",
      "last_used_at": null,
      "revoked_at": null,
      "created_by": "7de251af-d19e-42b7-bc72-1640062be565",
      "revoked_by": null,
      "created_at": "2026-07-27T09:00:00.000Z"
    }
  ]
}
```

### `DELETE /api/external-api-keys/:id`

Revokes an active external API key immediately.

**Allowed roles:** `admin`, `super_admin`

`:id` must be the API key UUID.

**Response — `200`**

```json
{
  "message": "External API key revoked."
}
```

Possible errors:

- `404`: active key not found, already revoked, or ID does not exist

Revocation is irreversible through the current API. Create a new key if access must be restored.

## Administrative Statistics

### `GET /api/admin/stats`

Returns summary counts for the internal administrative dashboard.

**Allowed roles:** `admin`, `super_admin`

**Response — `200`**

```json
{
  "applications": {
    "total": 12,
    "submitted": 3,
    "approved": 5,
    "checked_in": 2
  },
  "pending_users": 4
}
```

The current statistics cover visitor applications and pending staff accounts. Vehicle-permit statistics are not yet included.

## Notifications

Notifications support `IN_APP` and `EMAIL` channels and snapshot recipients at
creation time. Sources are `USER` for administrator broadcasts and `SYSTEM` for
domain-triggered messages.

### `POST /api/notifications`

**Allowed roles:** `admin`, `super_admin`

```json
{
  "type": "SHIFT_NOTICE",
  "title": "Night shift briefing",
  "body": "Report to the briefing room.",
  "priority": "HIGH",
  "channels": ["IN_APP", "EMAIL"],
  "targets": [
    {
      "type": "ROLE",
      "value": "security_assistant"
    }
  ],
  "scheduled_at": null,
  "expires_at": "2026-07-29T18:00:00.000Z"
}
```

Target types are:

- `ALL`
- `ROLE`
- `DEPARTMENT`
- `GROUP`
- `USER`

An `admin` broadcast excludes `super_admin` recipients. A `super_admin` may
target every active account.

### `GET /api/notifications`

Returns the authenticated user's non-archived inbox. Supports `unread`,
`priority`, `page`, and `page_size`.

### `GET /api/notifications/unread-count`

Returns `{ "unread": 0 }`. Poll this every 30–60 seconds for notification badges.

### `PATCH /api/notifications/:id/read`

Marks one recipient notification as read.

### `POST /api/notifications/read-all`

Marks every notification for the authenticated user as read. Body must be `{}`.

### `PATCH /api/notifications/:id/archive`

Archives one notification for the authenticated user.

### `GET /api/notifications/:id/deliveries`

**Allowed roles:** `admin`, `super_admin`

Returns paginated channel status, recipient, attempt count, and sent timestamp.
Provider error details are intentionally not returned.

### Notification Groups

```http
GET /api/notification-groups
POST /api/notification-groups
PATCH /api/notification-groups/:id
PUT /api/notification-groups/:id/members
```

**Allowed roles:** `admin`, `super_admin`

Create a group:

```json
{
  "name": "Night Shift",
  "description": "Current night-shift security team",
  "user_ids": ["user-uuid"]
}
```

Replacing members uses `{ "user_ids": [] }`. Administrators cannot add
`admin` or `super_admin` accounts to groups; super administrators can.

### System Triggers

The API currently creates notifications for:

- Visitor applications submitted.
- Visitor applications approved or rejected.
- Vehicle access applications submitted.
- Cards marked damaged or lost.
- New active system users.

Application decisions and account creation may target external or user email
addresses. Submission and card-alert events target relevant internal roles.

Business data, audit rows, recipient snapshots, and outbox records commit in the
same transaction.

### Email Worker

Email is never sent inside the HTTP request. `notificationWorker.js` processes
the transactional outbox every `NOTIFICATION_WORKER_INTERVAL_MS`, records each
delivery attempt, retries transient failures with exponential delay, and stops
retrying permanent Gmail authentication failures.

Run `npm run email:verify` before enabling email notifications in production.

## Rate Limits

| Scope | Limit |
|---|---|
| All `/api` routes | Configurable; default 1,000 requests per 15 minutes per client |
| Failed login attempts | 5 per 15 minutes |
| Public visitor/vehicle submissions | 10 per hour |
| Password-reset requests | 3 per 15 minutes |
| Password-reset confirmations | 10 per 15 minutes |

The API uses standard rate-limit response headers. In a multi-instance deployment, the current in-memory limiter should be replaced with a shared store.

## Internal Client Guidance

- Store JWTs in secure application storage and never log them.
- Clear local authentication state after `401` or token/session-related `403` responses.
- Do not cache identity numbers, document links, or application responses longer than operationally necessary.
- Treat API key secrets as credentials. The key-creation response is the only time the secret is available.
- Use action routes for workflow transitions; never infer that a local UI state means the server transition succeeded.
- Display server-provided validation messages beside the corresponding field.
- Use application UUIDs internally. Show the shorter application number to operators.
- Parse all timestamps as ISO 8601 and treat date-only fields as airport-local calendar dates.

## Current Internal API Gaps

No frontend-blocking internal route gaps are currently documented. Internal
applications must continue to use authenticated API routes and must not query
the database directly.
## System Email Category Settings

System notification email delivery can be enabled or disabled per category
without affecting in-app delivery.

### `GET /api/notification-settings/email-categories`

**Allowed role:** `super_admin`

Returns notification categories with their code, description, active state,
and `email_enabled` state.

### `PATCH /api/notification-settings/email-categories/:code`

**Allowed role:** `super_admin`

```json
{
  "email_enabled": false
}
```

Changes are audited. When email is disabled, every template in that category
continues to create in-app deliveries when `IN_APP` was requested, but email is
suppressed. Email-only triggers are skipped without rolling back the business
transaction. Administrator-created broadcasts are not affected by category
settings unless they use the template delivery service.

## Notification Email Templates

Admins and super admins can create reusable email templates under an active
notification category.

### `GET /api/notification-email-templates`

**Allowed roles:** `admin`, `super_admin`

Supports `category_code`, `is_active`, `page`, and `page_size`. Each template
includes category details, email-enabled state, priority, system/custom status,
creator, and timestamps.

### `POST /api/notification-email-templates`

**Allowed roles:** `admin`, `super_admin`

```json
{
  "code": "ACCESS_CARD_RETURN_REMINDER",
  "category_code": "ACCESS_CARDS",
  "name": "Access card return reminder",
  "title_template": "Return access card {{number}}",
  "body_template": "Please return card {{number}} before {{deadline}}.",
  "default_priority": "HIGH",
  "is_active": true
}
```

Template codes are immutable uppercase identifiers. Placeholder names use
double braces and are rendered when the template is invoked.

### `PATCH /api/notification-email-templates/:code`

**Allowed roles:** `admin`, `super_admin`

Admins can update custom templates. Only super admins can update seeded system
templates. Editable fields are category, name, title/body templates, default
priority, and active state. All changes are audited.

When a category is disabled, email is suppressed for all templates assigned to
it while requested in-app notifications remain available.
