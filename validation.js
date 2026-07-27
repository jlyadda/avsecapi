const { z } = require('zod');
const { ROLES } = require('./permissions');

const email = z.string().trim().toLowerCase().email().max(255);
const uuid = z.uuid();
const applicationReference = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9-]+$/);
const isoDate = z.iso.date();
const phone = z.string().trim().min(7).max(30).regex(/^[+0-9().\-\s]+$/);
const httpsUrl = z.url().max(2048).refine(
  (value) => value.startsWith('https://'),
  'Document URL must use HTTPS.'
);

const supportingDocuments = z.object({
  identity_document_url: httpsUrl,
  avsec_endorsed_letter_url: httpsUrl,
  passport_photograph_url: httpsUrl,
  other_document_urls: z.array(httpsUrl).max(10).default([])
}).strict();

const normalizePortalDate = (value) => {
  const [day, month, year] = value.split('-');
  return `${year}-${month}-${day}`;
};

const portalDate = z.string().trim()
  .regex(/^\d{2}-\d{2}-\d{4}$/, 'Date must use DD-MM-YYYY format.')
  .transform(normalizePortalDate)
  .refine((value) => z.iso.date().safeParse(value).success, 'Invalid calendar date.');

const identityType = z.string().trim().transform((value) => ({
  passport: 'PASSPORT',
  'national id': 'NATIONAL_ID',
  'drivers license': 'DRIVERS_LICENSE',
  'drivers licence': 'DRIVERS_LICENSE',
  "driver's license": 'DRIVERS_LICENSE',
  "driver's licence": 'DRIVERS_LICENSE'
}[value.toLowerCase()])).pipe(z.enum(['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENSE']));

const issuingCountry = z.string().trim().min(2).max(100)
  .transform((value) => value.toUpperCase() === 'UG' ? 'UGANDA' : value.toUpperCase());

const booleanGender = z.union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => typeof value === 'boolean' ? value : value === 'true');

const stringList = z.array(z.string().trim().max(500)).min(1).max(20)
  .transform((values) => [...new Set(values.filter(Boolean))])
  .refine((values) => values.length > 0, 'At least one non-empty value is required.');

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

const nestedApplicationBody = z.object({
  personal_data: z.object({
    identity_expiry_date: portalDate,
    first_name: z.string().trim().min(2).max(255),
    last_name: z.string().trim().min(2).max(255),
    other_names: z.string().trim().max(255).optional(),
    identity_type: identityType,
    identity_number: z.string().trim().toUpperCase().min(6).max(100).regex(/^[A-Z0-9/-]+$/),
    issuing_country: issuingCountry,
    date_of_birth: portalDate,
    personal_phone: z.string().trim().min(7).max(30).regex(/^[+0-9().\-\s]+$/),
    alternative_personal_phone: z.string().trim().min(7).max(30).regex(/^[+0-9().\-\s]+$/).optional(),
    personal_email: email,
    gender: booleanGender
  }).strict().superRefine((data, context) => {
    if (data.issuing_country !== 'UGANDA' && data.identity_type !== 'PASSPORT') {
      context.addIssue({
        code: 'custom',
        path: ['identity_type'],
        message: 'Non-Ugandan applicants must use a passport.'
      });
    }
  }),
  company_details: z.object({
    company_name: z.string().trim().min(2).max(255),
    company_position: z.string().trim().min(2).max(255),
    company_address: z.string().trim().min(3).max(500),
    company_phone: z.string().trim().min(7).max(30).regex(/^[+0-9().\-\s]+$/),
    company_email: email
  }).strict(),
  visit_data: z.object({
    visit_reason: stringList,
    areas_of_access: stringList,
    visit_starts: portalDate,
    visit_ends: portalDate
  }).strict().refine(
    (data) => data.visit_ends >= data.visit_starts,
    { path: ['visit_ends'], message: 'Visit end date must not be before its start date.' }
  ),
  supporting_documents: supportingDocuments
}).strict().refine(
  (body) => body.personal_data.identity_expiry_date > new Date().toISOString().slice(0, 10),
  { path: ['personal_data', 'identity_expiry_date'], message: 'Identity document must not be expired.' }
).transform((body) => ({
  first_name: body.personal_data.first_name,
  last_name: body.personal_data.last_name,
  other_names: body.personal_data.other_names || null,
  identity_type: body.personal_data.identity_type,
  identity_number: body.personal_data.identity_number,
  issuing_country: body.personal_data.issuing_country,
  date_of_birth: body.personal_data.date_of_birth,
  identity_expiry_date: body.personal_data.identity_expiry_date,
  gender: body.personal_data.gender,
  personal_email: body.personal_data.personal_email,
  personal_phone: body.personal_data.personal_phone,
  alternative_personal_phone: body.personal_data.alternative_personal_phone || null,
  image_url: body.supporting_documents.passport_photograph_url,
  company: body.company_details.company_name,
  company_position: body.company_details.company_position,
  company_address: body.company_details.company_address,
  company_phone: body.company_details.company_phone,
  company_email: body.company_details.company_email,
  visit_reasons: body.visit_data.visit_reason,
  areas_of_access: body.visit_data.areas_of_access,
  visit_starts: body.visit_data.visit_starts,
  visit_ends: body.visit_data.visit_ends,
  supporting_documents: body.supporting_documents
}));

const publicApplicationSchema = z.object({
  body: nestedApplicationBody
});

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

const applicationStatus = z.enum([
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CHECKED_IN',
  'CHECKED_OUT',
  'CANCELLED'
]);

const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50)
};

const applicationListSchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).default(''),
    status: applicationStatus.optional(),
    visit_from: isoDate.optional(),
    visit_to: isoDate.optional(),
    ...paginationQuery
  }).strict().refine(
    (query) => !query.visit_from || !query.visit_to || query.visit_to >= query.visit_from,
    { path: ['visit_to'], message: 'Visit end filter must not be before the start filter.' }
  )
});

const internalSupportingDocuments = supportingDocuments.partial().extend({
  other_document_urls: z.array(httpsUrl).max(10).default([])
}).strict();

const internalApplicationBody = z.object({
  first_name: z.string().trim().min(2).max(255),
  last_name: z.string().trim().min(2).max(255),
  other_names: z.string().trim().max(255).optional(),
  date_of_birth: isoDate,
  gender: z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(Boolean),
  identity_type: z.enum(['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENSE']),
  identity_number: z.string().trim().toUpperCase().min(6).max(100).regex(/^[A-Z0-9/-]+$/),
  issuing_country: issuingCountry.default('UGANDA'),
  identity_expiry_date: isoDate.optional(),
  personal_phone: phone,
  alternative_personal_phone: phone.optional(),
  personal_email: email,
  company_name: z.string().trim().min(2).max(255),
  company_position: z.string().trim().min(2).max(255).optional(),
  company_address: z.string().trim().min(3).max(500).optional(),
  company_phone: phone.optional(),
  company_email: email.optional(),
  image_url: httpsUrl.optional(),
  visit_reasons: stringList,
  areas_of_access: stringList.optional(),
  visit_starts: isoDate,
  visit_ends: isoDate,
  supporting_documents: internalSupportingDocuments.optional()
}).strict().superRefine((body, context) => {
  const today = new Date().toISOString().slice(0, 10);
  if (body.visit_ends < body.visit_starts) {
    context.addIssue({
      code: 'custom',
      path: ['visit_ends'],
      message: 'Visit end date must not be before its start date.'
    });
  }
  if (body.date_of_birth >= today) {
    context.addIssue({
      code: 'custom',
      path: ['date_of_birth'],
      message: 'Date of birth must be in the past.'
    });
  }
  if (body.identity_expiry_date && body.identity_expiry_date <= today) {
    context.addIssue({
      code: 'custom',
      path: ['identity_expiry_date'],
      message: 'Identity document must not be expired.'
    });
  }
  if (body.issuing_country !== 'UGANDA' && body.identity_type !== 'PASSPORT') {
    context.addIssue({
      code: 'custom',
      path: ['identity_type'],
      message: 'Non-Ugandan applicants must use a passport.'
    });
  }
});

const internalApplicationSchema = z.object({ body: internalApplicationBody });

const userListSchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).default(''),
    role: z.enum(ROLES).optional(),
    is_active: z.enum(['true', 'false', '1', '0']).transform(
      (value) => value === 'true' || value === '1'
    ).optional(),
    ...paginationQuery
  }).strict()
});

const cardAccessLevel = z.enum(['LEVEL_1', 'LEVEL_2', 'LEVEL_3', 'LEVEL_4', 'ALL']);
const cardCategory = z.enum(['VISITOR', 'STAFF', 'CONTRACTOR', 'ONE_DAY_DUTY', 'PUBLIC_AREAS']);

const cardListSchema = z.object({
  query: z.object({
    access_level: cardAccessLevel.optional(),
    category: cardCategory.optional(),
    status: z.enum(['AVAILABLE', 'ASSIGNED', 'DAMAGED', 'LOST', 'UNAVAILABLE']).optional(),
    search: z.string().trim().max(100).default('')
  }).strict()
});

const cardCreateSchema = z.object({
  body: z.object({
    number: z.string().trim().toUpperCase().min(2).max(100).regex(/^[A-Z0-9/_-]+$/),
    access_level: cardAccessLevel,
    category: cardCategory.default('VISITOR')
  }).strict()
});

const cardIdSchema = z.object({
  params: z.object({ id: uuid })
});

const cardConditionSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    status: z.enum(['AVAILABLE', 'UNAVAILABLE', 'DAMAGED', 'LOST'])
  }).strict()
});

const cardAssignmentSchema = z.object({
  params: z.object({ reference: applicationReference }),
  body: z.object({
    card_number: z.string().trim().toUpperCase().min(2).max(100).regex(/^[A-Z0-9/_-]+$/)
  }).strict()
});

const cardReturnSchema = z.object({
  params: z.object({ reference: applicationReference }),
  body: z.object({}).strict()
});

const accountUpdateSchema = z.object({
  body: z.object({
    full_name: z.string().trim().min(2).max(255).optional(),
    email: email.optional()
  }).strict().refine(
    (body) => body.full_name !== undefined || body.email !== undefined,
    'At least one profile field is required.'
  )
});

const passwordChangeSchema = z.object({
  body: z.object({
    current_password: z.string().min(1).max(128),
    new_password: z.string().min(12).max(128)
  }).strict().refine(
    (body) => body.current_password !== body.new_password,
    { path: ['new_password'], message: 'New password must differ from the current password.' }
  )
});

const passwordResetRequestSchema = z.object({
  body: z.object({ email }).strict()
});

const passwordResetConfirmSchema = z.object({
  body: z.object({
    email,
    otp: z.string().trim().regex(/^\d{5}$/, 'OTP must contain exactly 5 digits.'),
    new_password: z.string().min(12).max(128)
  }).strict()
});

const externalApiKeyCreateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(3).max(100),
    purpose: z.string().trim().min(10).max(500),
    role: z.enum(['VISITOR_APPLICATION', 'VEHICLE_ACCESS_APPLICATION']),
    expires_at: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional()
  }).strict().refine(
    (body) => !body.expires_at || body.expires_at > new Date(),
    { path: ['expires_at'], message: 'Expiry must be in the future.' }
  )
});

const externalApiKeyIdSchema = z.object({
  params: z.object({ id: uuid })
});

const vehicleAccessApplicationSchema = z.object({
  body: z.object({
    driver_name: z.string().trim().min(3).max(255),
    driver_national_id_number: z.string().trim().toUpperCase()
      .min(6).max(100).regex(/^[A-Z0-9/-]+$/),
    vehicle_registration_number: z.string().trim().toUpperCase()
      .min(3).max(30).regex(/^[A-Z0-9 -]+$/),
    vehicle_type: z.string().trim().min(2).max(100),
    company: z.string().trim().min(2).max(255),
    reason_for_access: z.string().trim().min(5).max(2000),
    access_gate: z.string().trim().min(2).max(100),
    date_of_access: portalDate,
    time_of_access: z.string().trim()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Time must use 24-hour HH:mm format.'),
    duration_of_access_hours: z.number().int().min(1).max(168)
  }).strict()
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
  if (result.data.query) req.validatedQuery = result.data.query;
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
    applicationList: applicationListSchema,
    internalApplication: internalApplicationSchema,
    externalApiKeyCreate: externalApiKeyCreateSchema,
    externalApiKeyId: externalApiKeyIdSchema,
    vehicleAccessApplication: vehicleAccessApplicationSchema,
    userStatus: userStatusSchema,
    userRole: userRoleSchema,
    userId: userIdSchema,
    userList: userListSchema,
    cardList: cardListSchema,
    cardCreate: cardCreateSchema,
    cardId: cardIdSchema,
    cardCondition: cardConditionSchema,
    cardAssignment: cardAssignmentSchema,
    cardReturn: cardReturnSchema,
    accountUpdate: accountUpdateSchema,
    passwordChange: passwordChangeSchema,
    passwordResetRequest: passwordResetRequestSchema,
    passwordResetConfirm: passwordResetConfirmSchema
  }
};
