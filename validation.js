const { z } = require('zod');
const { ROLES } = require('./permissions');

const email = z.string().trim().toLowerCase().email().max(255);
const uuid = z.uuid();
const applicationReference = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9-]+$/);

const registerSchema = z.object({
  body: z.object({
    user_name: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9._-]+$/),
    email,
    password: z.string().min(12).max(128),
    full_name: z.string().trim().min(2).max(255).optional(),
    department: z.string().trim().min(2).max(255).optional()
  }).strict()
});

const loginSchema = z.object({
  body: z.object({
    identifier: z.string().trim().min(1).max(255),
    password: z.string().min(1).max(128)
  }).strict()
});

const visitorSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(255),
    company: z.string().trim().min(2).max(255),
    email,
    phone: z.string().trim().min(7).max(30).regex(/^[+0-9().\-\s]+$/),
    purpose: z.string().trim().min(3).max(2000),
    host_name: z.string().trim().min(2).max(255),
    host_email: email,
    access_pass_id: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9/_-]+$/),
    expected_arrival: z.iso.datetime({ offset: true }).transform((value) => new Date(value))
  }).strict()
});

const publicApplicationBody = z.object({
  first_name: z.string().trim().min(2).max(255),
  last_name: z.string().trim().min(2).max(255),
  identity_type: z.enum(['NIN', 'PASSPORT', 'OTHER']),
  identity_number: z.string().trim().toUpperCase().min(6).max(100).regex(/^[A-Z0-9/-]+$/),
  issuing_country: z.string().trim().toUpperCase().length(2).regex(/^[A-Z]{2}$/).default('UG'),
  date_of_birth: z.iso.date(),
  gender: z.enum(['MALE', 'FEMALE']).optional(),
  company: z.string().trim().min(2).max(255).optional(),
  company_position: z.string().trim().min(2).max(255).optional(),
  image_url: z.url().refine((value) => value.startsWith('https://'), 'Image URL must use HTTPS.').optional(),
  email,
  phone: z.string().trim().min(7).max(30).regex(/^[+0-9().\-\s]+$/),
  purpose: z.string().trim().min(3).max(2000),
  host_name: z.string().trim().min(2).max(255),
  host_email: email,
  expected_arrival: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  expected_departure: z.iso.datetime({ offset: true }).transform((value) => new Date(value))
}).strict().refine(
  (body) => body.expected_departure > body.expected_arrival,
  { path: ['expected_departure'], message: 'Expected departure must be after expected arrival.' }
);

const publicApplicationSchema = z.object({ body: publicApplicationBody });

const applicationReferenceSchema = z.object({
  params: z.object({ reference: applicationReference })
});

const applicationDecisionSchema = z.object({
  params: z.object({ reference: applicationReference }),
  body: z.object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    notes: z.string().trim().min(3).max(2000).optional()
  }).strict().refine(
    (body) => body.decision !== 'REJECTED' || Boolean(body.notes),
    { path: ['notes'], message: 'Rejection notes are required.' }
  )
});

const applicationCheckInSchema = z.object({
  params: z.object({ reference: applicationReference }),
  body: z.object({ gate: z.string().trim().min(1).max(100).optional() }).strict()
});

const applicationCheckOutSchema = z.object({
  params: z.object({ reference: applicationReference }),
  body: z.object({}).strict()
});

const externalApiKeyCreateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(3).max(100),
    purpose: z.string().trim().min(10).max(500),
    role: z.enum(['VISITOR_APPLICATION']),
    expires_at: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional()
  }).strict().refine(
    (body) => !body.expires_at || body.expires_at > new Date(),
    { path: ['expires_at'], message: 'Expiry must be in the future.' }
  )
});

const externalApiKeyIdSchema = z.object({
  params: z.object({ id: uuid })
});

const userStatusSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({ is_active: z.boolean() }).strict()
});

const userRoleSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({ role: z.enum(ROLES) }).strict()
});

const userIdSchema = z.object({
  params: z.object({ id: uuid })
});

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });

  if (!result.success) {
    return res.status(400).json({
      error: 'Validation failed.',
      details: result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message
      }))
    });
  }

  if (result.data.body) req.body = result.data.body;
  if (result.data.params) req.params = result.data.params;
  if (result.data.query) req.query = result.data.query;
  return next();
};

module.exports = {
  validate,
  schemas: {
    register: registerSchema,
    login: loginSchema,
    visitor: visitorSchema,
    publicApplication: publicApplicationSchema,
    applicationReference: applicationReferenceSchema,
    applicationDecision: applicationDecisionSchema,
    applicationCheckIn: applicationCheckInSchema,
    applicationCheckOut: applicationCheckOutSchema,
    externalApiKeyCreate: externalApiKeyCreateSchema,
    externalApiKeyId: externalApiKeyIdSchema,
    userStatus: userStatusSchema,
    userRole: userRoleSchema,
    userId: userIdSchema
  }
};
