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
    phone: phone.optional(),
    full_name: z.string().trim().min(2).max(255).optional(),
    department: z.string().trim().min(2).max(255).optional(),
    role: z.enum(ROLES).default('security_assistant'),
    is_active: z.boolean().default(true)
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
  'UNDER_REVIEW',
  'NEEDS_CORRECTION',
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

const cardTaxonomyCode = z.string().trim().toUpperCase()
  .min(2).max(50).regex(/^[A-Z0-9_]+$/);
const cardAccessLevel = cardTaxonomyCode;
const cardCategory = cardTaxonomyCode;

const cardListSchema = z.object({
  query: z.object({
    access_level: cardAccessLevel.optional(),
    category: cardCategory.optional(),
    status: z.enum(['AVAILABLE', 'ASSIGNED', 'DAMAGED', 'LOST', 'UNAVAILABLE']).optional(),
    search: z.string().trim().max(100).default(''),
    include_inactive: z.enum(['true', 'false', '1', '0']).default('false').transform(
      (value) => value === 'true' || value === '1'
    )
  }).strict()
});

const cardCreateSchema = z.object({
  body: z.object({
    number: z.string().trim().toUpperCase().min(2).max(100).regex(/^[A-Z0-9/_-]+$/),
    access_level: cardAccessLevel,
    category: cardCategory.default('VISITOR')
  }).strict()
});

const cardBulkCreateSchema = z.object({
  body: z.object({
    cards: z.array(cardCreateSchema.shape.body).min(1).max(500)
  }).strict().refine(
    (body) => new Set(body.cards.map((card) => card.number)).size === body.cards.length,
    { path: ['cards'], message: 'Card numbers must be unique within the request.' }
  )
});

const cardUpdateSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    number: z.string().trim().toUpperCase().min(2).max(100)
      .regex(/^[A-Z0-9/_-]+$/).optional(),
    access_level: cardAccessLevel.optional(),
    category: cardCategory.optional()
  }).strict().refine(
    (body) => Object.keys(body).length > 0,
    'At least one card field is required.'
  )
});

const cardActivationSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({ is_active: z.boolean() }).strict()
});

const taxonomyListSchema = z.object({
  query: z.object({
    include_inactive: z.enum(['true', 'false', '1', '0']).default('false').transform(
      (value) => value === 'true' || value === '1'
    )
  }).strict()
});

const taxonomyCreateSchema = z.object({
  body: z.object({
    code: cardTaxonomyCode,
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).optional(),
    sort_order: z.number().int().min(0).max(10000).default(0)
  }).strict()
});

const cardCategoryCreateSchema = z.object({
  body: z.object({
    code: cardTaxonomyCode,
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).optional(),
    sort_order: z.number().int().min(0).max(10000).default(0),
    can_assign_to_visitors: z.boolean().default(false)
  }).strict()
});

const taxonomyUpdateSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    is_active: z.boolean().optional()
  }).strict().refine(
    (body) => Object.keys(body).length > 0,
    'At least one taxonomy field is required.'
  )
});

const cardCategoryUpdateSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    is_active: z.boolean().optional(),
    can_assign_to_visitors: z.boolean().optional()
  }).strict().refine(
    (body) => Object.keys(body).length > 0,
    'At least one category field is required.'
  )
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

const cardAssignmentListSchema = z.object({
  params: z.object({ id: uuid }),
  query: z.object({ ...paginationQuery }).strict()
});

const auditEventListSchema = z.object({
  query: z.object({
    actor_id: uuid.optional(),
    action: z.string().trim().min(1).max(100).regex(/^[A-Z0-9_]+$/).optional(),
    resource_type: z.string().trim().min(1).max(100).regex(/^[a-z0-9_]+$/).optional(),
    resource_id: z.string().trim().min(1).max(100).optional(),
    from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
    to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
    page: paginationQuery.page,
    page_size: z.coerce.number().int().min(1).max(100).default(100)
  }).strict().refine(
    (query) => !query.from || !query.to || query.to >= query.from,
    { path: ['to'], message: 'Audit end time must not be before the start time.' }
  )
});

const reconciliationSchema = z.object({
  query: z.object({
    date: isoDate,
    status: z.enum(['AVAILABLE', 'ASSIGNED', 'UNAVAILABLE', 'DAMAGED', 'LOST']).optional(),
    page: paginationQuery.page,
    page_size: z.coerce.number().int().min(1).max(100).default(100)
  }).strict()
});

const reconciliationReportCreateSchema = z.object({
  body: z.object({
    date: isoDate,
    notes: z.string().trim().min(1).max(2000).optional()
  }).strict()
});

const reconciliationReportListSchema = z.object({
  query: z.object({
    date: isoDate.optional(),
    page: paginationQuery.page,
    page_size: z.coerce.number().int().min(1).max(100).default(50)
  }).strict()
});

const reconciliationReportIdSchema = z.object({
  params: z.object({ id: uuid }),
  query: z.object({
    page: paginationQuery.page,
    page_size: z.coerce.number().int().min(1).max(500).default(100)
  }).strict()
});

const notificationTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ALL') }).strict(),
  z.object({ type: z.literal('ROLE'), value: z.enum(ROLES) }).strict(),
  z.object({
    type: z.literal('DEPARTMENT'),
    value: z.string().trim().min(2).max(255)
  }).strict(),
  z.object({ type: z.literal('GROUP'), value: uuid }).strict(),
  z.object({ type: z.literal('USER'), value: uuid }).strict()
]);

const notificationCreateSchema = z.object({
  body: z.object({
    type: z.string().trim().toUpperCase().min(2).max(100).regex(/^[A-Z0-9_]+$/)
      .default('ANNOUNCEMENT'),
    title: z.string().trim().min(2).max(255),
    body: z.string().trim().min(2).max(5000),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).default('NORMAL'),
    channels: z.array(z.enum(['IN_APP', 'EMAIL'])).min(1).max(2)
      .transform((channels) => [...new Set(channels)]),
    targets: z.array(notificationTarget).min(1).max(20),
    scheduled_at: z.iso.datetime({ offset: true }).transform((value) => new Date(value))
      .optional(),
    expires_at: z.iso.datetime({ offset: true }).transform((value) => new Date(value))
      .optional()
  }).strict().superRefine((body, context) => {
    if (body.scheduled_at && body.scheduled_at <= new Date()) {
      context.addIssue({
        code: 'custom',
        path: ['scheduled_at'],
        message: 'Scheduled time must be in the future.'
      });
    }
    if (
      body.expires_at
      && body.expires_at <= (body.scheduled_at || new Date())
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expires_at'],
        message: 'Expiry must be after delivery time.'
      });
    }
  })
});

const notificationListSchema = z.object({
  query: z.object({
    unread: z.enum(['true', 'false', '1', '0']).transform(
      (value) => value === 'true' || value === '1'
    ).optional(),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
    page: paginationQuery.page,
    page_size: z.coerce.number().int().min(1).max(100).default(50)
  }).strict()
});

const notificationIdSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({}).strict().optional()
});

const smsDeliveryReportSchema = z.object({
  params: z.object({
    message_id: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._:-]+$/)
  }).strict()
});

const notificationReadAllSchema = z.object({
  body: z.object({}).strict()
});

const notificationDeliveryListSchema = z.object({
  params: z.object({ id: uuid }),
  query: z.object({
    page: paginationQuery.page,
    page_size: z.coerce.number().int().min(1).max(100).default(50)
  }).strict()
});

const notificationSentListSchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).default(''),
    page: paginationQuery.page,
    page_size: z.coerce.number().int().min(1).max(100).default(50)
  }).strict()
});

const notificationGroupCreateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(150),
    description: z.string().trim().max(500).optional(),
    user_ids: z.array(uuid).max(500).default([])
  }).strict()
});

const notificationGroupUpdateSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    name: z.string().trim().min(2).max(150).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    is_active: z.boolean().optional()
  }).strict().refine(
    (body) => Object.keys(body).length > 0,
    'At least one group field is required.'
  )
});

const notificationGroupMembersSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    user_ids: z.array(uuid).max(500)
  }).strict()
});

const notificationGroupIdSchema = z.object({
  params: z.object({ id: uuid })
});

const passAssignmentStatisticsSchema = z.object({
  query: z.object({
    from: isoDate,
    to: isoDate,
    interval: z.enum(['day', 'week', 'month']).default('day')
  }).strict().superRefine((query, context) => {
    const from = new Date(`${query.from}T00:00:00Z`);
    const to = new Date(`${query.to}T00:00:00Z`);
    const days = Math.floor((to - from) / 86400000);
    if (days < 0) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'End date must not be before start date.'
      });
    } else if (days > 366) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'Statistics range cannot exceed 366 days.'
      });
    }
  })
});

const cardAssignmentSchema = z.object({
  params: z.object({ reference: applicationReference }),
  body: z.object({
    card_number: z.string().trim().toUpperCase().min(2).max(100).regex(/^[A-Z0-9/_-]+$/),
    identity_document_retained: z.literal(true)
  }).strict()
});

const cardReturnSchema = z.object({
  params: z.object({ reference: applicationReference }),
  body: z.object({
    identity_document_returned: z.literal(true),
    return_condition: z.enum(['GOOD', 'DAMAGED']).default('GOOD')
  }).strict()
});

const activeCardAssignmentLookupSchema = z.object({
  query: z.object({
    card_number: z.string().trim().toUpperCase().min(2).max(100)
      .regex(/^[A-Z0-9/_-]+$/)
  }).strict()
});

const activeCardAssignmentReturnSchema = z.object({
  body: z.object({
    card_number: z.string().trim().toUpperCase().min(2).max(100)
      .regex(/^[A-Z0-9/_-]+$/),
    identity_document_returned: z.literal(true),
    return_condition: z.enum(['GOOD', 'DAMAGED']).default('GOOD')
  }).strict()
});

const passReturnSettingsUpdateSchema = z.object({
  body: z.object({
    max_hold_hours: z.number().int().min(1).max(168)
  }).strict()
});

const accountUpdateSchema = z.object({
  body: z.object({
    full_name: z.string().trim().min(2).max(255).optional(),
    email: email.optional(),
    phone: phone.nullable().optional()
  }).strict().refine(
    (body) => body.full_name !== undefined || body.email !== undefined || body.phone !== undefined,
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

const vehicleApplicationStatus = z.enum([
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'USED'
]);

const vehicleApplicationListSchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).default(''),
    status: vehicleApplicationStatus.optional(),
    visit_from: isoDate.optional(),
    visit_to: isoDate.optional(),
    ...paginationQuery
  }).strict().refine(
    (query) => !query.visit_from || !query.visit_to || query.visit_to >= query.visit_from,
    { path: ['visit_to'], message: 'Visit end filter must not be before the start filter.' }
  )
});

const vehicleApplicationReferenceSchema = z.object({
  params: z.object({ reference: applicationReference })
});

const vehicleApplicationDecisionSchema = z.object({
  params: z.object({ reference: applicationReference }),
  body: z.object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    notes: z.string().trim().min(3).max(2000).optional()
  }).strict().refine(
    (body) => body.decision !== 'REJECTED' || Boolean(body.notes),
    { path: ['notes'], message: 'Rejection notes are required.' }
  )
});

const vehicleApplicationMarkUsedSchema = z.object({
  params: z.object({ reference: applicationReference }),
  body: z.object({}).strict()
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

const workflowCode = z.string().trim().toUpperCase()
  .min(2).max(80).regex(/^[A-Z][A-Z0-9_]*$/);

const workflowGroupCreateSchema = z.object({
  body: z.object({
    code: workflowCode,
    name: z.string().trim().min(2).max(150),
    description: z.string().trim().max(500).optional(),
    user_ids: z.array(uuid).max(200).default([])
  }).strict()
});

const workflowGroupUpdateSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    name: z.string().trim().min(2).max(150).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    is_active: z.boolean().optional()
  }).strict().refine(
    (body) => Object.keys(body).length > 0,
    'At least one field is required.'
  )
});

const workflowGroupMembersSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({ user_ids: z.array(uuid).max(200) }).strict()
});

const applicationWorkflowCreateSchema = z.object({
  body: z.object({
    code: workflowCode,
    name: z.string().trim().min(2).max(150),
    description: z.string().trim().max(500).optional()
  }).strict()
});

const applicationWorkflowUpdateSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    name: z.string().trim().min(2).max(150).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    is_active: z.boolean().optional()
  }).strict().refine(
    (body) => Object.keys(body).length > 0,
    'At least one field is required.'
  )
});

const workflowAssignee = z.object({
  type: z.enum(['ROLE', 'GROUP', 'USER']),
  value: z.string().trim().min(1).max(100)
}).strict().superRefine((assignee, context) => {
  if (assignee.type === 'ROLE' && !ROLES.includes(assignee.value)) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'Unknown system role.'
    });
  }
  if (['GROUP', 'USER'].includes(assignee.type) && !z.uuid().safeParse(assignee.value).success) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: `${assignee.type.toLowerCase()} assignee must be a UUID.`
    });
  }
});

const workflowStage = z.object({
  code: workflowCode,
  name: z.string().trim().min(2).max(150),
  description: z.string().trim().max(500).optional(),
  allow_submitter_action: z.boolean().default(false),
  require_different_actor: z.boolean().default(true),
  sla_hours: z.number().int().min(1).max(8760).nullable().optional(),
  captures_access_approval: z.boolean().default(false),
  assignees: z.array(workflowAssignee).min(1).max(20)
}).strict();

const applicationWorkflowVersionCreateSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    stages: z.array(workflowStage).min(1).max(20)
  }).strict().superRefine((body, context) => {
    const codes = body.stages.map((stage) => stage.code);
    if (new Set(codes).size !== codes.length) {
      context.addIssue({
        code: 'custom',
        path: ['stages'],
        message: 'Stage codes must be unique.'
      });
    }
    const accessGrantStages = body.stages.filter((stage) => stage.captures_access_approval);
    if (
      accessGrantStages.length !== 1
      || accessGrantStages[0].code !== 'SENIOR_SECURITY_REVIEW'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['stages'],
        message: 'SENIOR_SECURITY_REVIEW must be the only stage that approves the access grant.'
      });
    }
    const finalStage = body.stages.at(-1);
    if (finalStage?.code !== 'FACILITATION_DESK') {
      context.addIssue({
        code: 'custom',
        path: ['stages', body.stages.length - 1, 'code'],
        message: 'The final workflow stage must use the FACILITATION_DESK code.'
      });
    } else if (!finalStage.assignees.some((assignee) => (
      assignee.type === 'GROUP'
      || (assignee.type === 'ROLE' && assignee.value === 'security_assistant')
    ))) {
      context.addIssue({
        code: 'custom',
        path: ['stages', body.stages.length - 1, 'assignees'],
        message: 'Facilitation Desk must be assigned to a group or security_assistant role.'
      });
    }
  })
});

const applicationWorkflowVersionIdSchema = z.object({
  params: z.object({ id: uuid, versionId: uuid })
});

const workflowTaskListSchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).default(''),
    ...paginationQuery
  }).strict()
});

const visitorWorkflowActionSchema = z.object({
  params: z.object({ reference: applicationReference }),
  body: z.object({
    action: z.enum(['APPROVE', 'REJECT']),
    notes: z.string().trim().min(3).max(2000).optional(),
    approved_visit_starts: isoDate.optional(),
    approved_visit_ends: isoDate.optional(),
    approved_areas_of_access: z.array(workflowCode).min(1).max(50)
      .transform((areas) => [...new Set(areas)])
      .optional(),
    document_reviews: z.array(z.object({
      document_key: workflowCode,
      verdict: z.enum(['VALID', 'INVALID']),
      notes: z.string().trim().min(3).max(1000).optional()
    }).strict().refine(
      (review) => review.verdict !== 'INVALID' || Boolean(review.notes),
      { path: ['notes'], message: 'Invalid document reviews require notes.' }
    )).max(13).optional()
  }).strict().superRefine((body, context) => {
    if (body.action === 'REJECT' && !body.notes) {
      context.addIssue({
        code: 'custom',
        path: ['notes'],
        message: 'Rejection notes are required.'
      });
    }
    if (
      body.approved_visit_starts
      && body.approved_visit_ends
      && body.approved_visit_ends < body.approved_visit_starts
    ) {
      context.addIssue({
        code: 'custom',
        path: ['approved_visit_ends'],
        message: 'Approved visit end date must not be before its start date.'
      });
    }
  })
});

const notificationEmailCategoryUpdateSchema = z.object({
  params: z.object({ code: workflowCode }),
  body: z.object({
    email_enabled: z.boolean()
  }).strict()
});

const notificationSmsCategoryUpdateSchema = z.object({
  params: z.object({ code: workflowCode }),
  body: z.object({ sms_enabled: z.boolean() }).strict()
});

const notificationSmsRecipientUpdateSchema = z.object({
  params: z.object({ recipient_type: workflowCode }),
  body: z.object({ sms_enabled: z.boolean() }).strict()
});

const notificationSmsTemplateListSchema = z.object({
  query: z.object({
    category_code: workflowCode.optional(),
    is_active: z.enum(['true', 'false', '1', '0']).transform(
      (value) => value === 'true' || value === '1'
    ).optional(),
    ...paginationQuery
  }).strict()
});

const notificationSmsTemplateCreateSchema = z.object({
  body: z.object({
    code: workflowCode,
    category_code: workflowCode,
    recipient_type: workflowCode,
    name: z.string().trim().min(2).max(150),
    body_template: z.string().trim().min(2).max(918),
    is_active: z.boolean().default(true)
  }).strict()
});

const notificationSmsTemplateUpdateSchema = z.object({
  params: z.object({ code: workflowCode }),
  body: z.object({
    category_code: workflowCode.optional(),
    recipient_type: workflowCode.optional(),
    name: z.string().trim().min(2).max(150).optional(),
    body_template: z.string().trim().min(2).max(918).optional(),
    is_active: z.boolean().optional()
  }).strict().refine(
    (body) => Object.keys(body).length > 0,
    'At least one SMS template field is required.'
  )
});

const notificationTemplateListSchema = z.object({
  query: z.object({
    category_code: workflowCode.optional(),
    is_active: z.enum(['true', 'false', '1', '0']).transform(
      (value) => value === 'true' || value === '1'
    ).optional(),
    ...paginationQuery
  }).strict()
});

const notificationTemplateCreateSchema = z.object({
  body: z.object({
    code: workflowCode,
    category_code: workflowCode,
    name: z.string().trim().min(2).max(150),
    title_template: z.string().trim().min(2).max(255),
    body_template: z.string().trim().min(2).max(5000),
    default_priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).default('NORMAL'),
    is_active: z.boolean().default(true)
  }).strict()
});

const notificationTemplateUpdateSchema = z.object({
  params: z.object({ code: workflowCode }),
  body: z.object({
    category_code: workflowCode.optional(),
    name: z.string().trim().min(2).max(150).optional(),
    title_template: z.string().trim().min(2).max(255).optional(),
    body_template: z.string().trim().min(2).max(5000).optional(),
    default_priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
    is_active: z.boolean().optional()
  }).strict().refine(
    (body) => Object.keys(body).length > 0,
    'At least one template field is required.'
  )
});

const approvedVisitorListSchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).default(''),
    status: z.enum(['PENDING_VALIDITY', 'ELIGIBLE', 'CHECKED_IN', 'CHECKED_OUT'])
      .optional(),
    valid_on: isoDate.optional(),
    eligible_for_card_assignment: z.enum(['true', 'false', '1', '0']).transform(
      (value) => value === 'true' || value === '1'
    ).optional(),
    ...paginationQuery
  }).strict()
});

const allVisitorListSchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).default(''),
    security_status: z.enum(['ACTIVE', 'BLOCKED', 'FLAGGED']).optional(),
    page: paginationQuery.page,
    page_size: paginationQuery.page_size
  }).strict()
});

const allVisitorIdSchema = z.object({
  params: z.object({ id: z.string().regex(/^\d+$/).max(20) })
});

const approvedVisitorIdSchema = z.object({
  params: z.object({ id: uuid })
});

const approvedVisitorCardAssignmentSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    card_number: z.string().trim().toUpperCase()
      .min(2).max(100).regex(/^[A-Z0-9/_-]+$/),
    identity_document_retained: z.literal(true)
  }).strict()
});

const approvedVisitorCardReturnSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    identity_document_returned: z.literal(true),
    return_condition: z.enum(['GOOD', 'DAMAGED']).default('GOOD')
  }).strict()
});

const systemSessionListSchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).default(''),
    status: z.enum(['ACTIVE', 'REVOKED', 'EXPIRED', 'ALL']).default('ACTIVE'),
    role: z.enum(ROLES).optional(),
    user_id: uuid.optional(),
    ip_address: z.string().trim().max(45).optional(),
    ...paginationQuery
  }).strict()
});

const systemSessionRevokeSchema = z.object({
  params: z.object({ jti: uuid }),
  body: z.object({
    reason: z.string().trim().min(3).max(200).optional()
  }).strict()
});

const accessAreaListSchema = z.object({
  query: z.object({
    include_inactive: z.enum(['true', 'false', '1', '0']).default('false').transform(
      (value) => value === 'true' || value === '1'
    )
  }).strict()
});

const accessAreaCreateSchema = z.object({
  body: z.object({
    code: workflowCode,
    name: z.string().trim().min(2).max(150),
    description: z.string().trim().max(500).optional(),
    sort_order: z.number().int().min(0).max(10000).default(0)
  }).strict()
});

const accessAreaUpdateSchema = z.object({
  params: z.object({ code: workflowCode }),
  body: z.object({
    name: z.string().trim().min(2).max(150).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    is_active: z.boolean().optional()
  }).strict().refine((body) => Object.keys(body).length > 0, 'At least one field is required.')
});

const accessLevelAreaSchema = z.object({
  params: z.object({ code: workflowCode })
});

const accessLevelAreaUpdateSchema = z.object({
  params: z.object({ code: workflowCode }),
  body: z.object({
    area_codes: z.array(workflowCode).min(1).max(50)
      .transform((areas) => [...new Set(areas)])
  }).strict()
});

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });

  if (!result.success) {
    return res.status(400).json({
      error: 'Validation failed, crosscheck input fields.',
      code: 'VALIDATION_FAILED',
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
    vehicleApplicationList: vehicleApplicationListSchema,
    vehicleApplicationReference: vehicleApplicationReferenceSchema,
    vehicleApplicationDecision: vehicleApplicationDecisionSchema,
    vehicleApplicationMarkUsed: vehicleApplicationMarkUsedSchema,
    userStatus: userStatusSchema,
    userRole: userRoleSchema,
    userId: userIdSchema,
    userList: userListSchema,
    cardList: cardListSchema,
    cardCreate: cardCreateSchema,
    cardBulkCreate: cardBulkCreateSchema,
    cardUpdate: cardUpdateSchema,
    cardActivation: cardActivationSchema,
    cardId: cardIdSchema,
    cardCondition: cardConditionSchema,
    cardAssignmentList: cardAssignmentListSchema,
    auditEventList: auditEventListSchema,
    reconciliation: reconciliationSchema,
    taxonomyList: taxonomyListSchema,
    taxonomyCreate: taxonomyCreateSchema,
    taxonomyUpdate: taxonomyUpdateSchema,
    cardCategoryCreate: cardCategoryCreateSchema,
    cardCategoryUpdate: cardCategoryUpdateSchema,
    reconciliationReportCreate: reconciliationReportCreateSchema,
    reconciliationReportList: reconciliationReportListSchema,
    reconciliationReportId: reconciliationReportIdSchema,
    notificationCreate: notificationCreateSchema,
    notificationList: notificationListSchema,
    notificationId: notificationIdSchema,
    notificationReadAll: notificationReadAllSchema,
    notificationDeliveryList: notificationDeliveryListSchema,
    notificationSentList: notificationSentListSchema,
    smsDeliveryReport: smsDeliveryReportSchema,
    notificationGroupCreate: notificationGroupCreateSchema,
    notificationGroupUpdate: notificationGroupUpdateSchema,
    notificationGroupMembers: notificationGroupMembersSchema,
    notificationGroupId: notificationGroupIdSchema,
    passAssignmentStatistics: passAssignmentStatisticsSchema,
    cardAssignment: cardAssignmentSchema,
    cardReturn: cardReturnSchema,
    activeCardAssignmentLookup: activeCardAssignmentLookupSchema,
    activeCardAssignmentReturn: activeCardAssignmentReturnSchema,
    passReturnSettingsUpdate: passReturnSettingsUpdateSchema,
    accountUpdate: accountUpdateSchema,
    passwordChange: passwordChangeSchema,
    passwordResetRequest: passwordResetRequestSchema,
    passwordResetConfirm: passwordResetConfirmSchema,
    workflowGroupCreate: workflowGroupCreateSchema,
    workflowGroupUpdate: workflowGroupUpdateSchema,
    workflowGroupMembers: workflowGroupMembersSchema,
    applicationWorkflowCreate: applicationWorkflowCreateSchema,
    applicationWorkflowUpdate: applicationWorkflowUpdateSchema,
    applicationWorkflowVersionCreate: applicationWorkflowVersionCreateSchema,
    applicationWorkflowVersionId: applicationWorkflowVersionIdSchema,
    workflowTaskList: workflowTaskListSchema,
    visitorWorkflowAction: visitorWorkflowActionSchema,
    notificationEmailCategoryUpdate: notificationEmailCategoryUpdateSchema,
    notificationSmsCategoryUpdate: notificationSmsCategoryUpdateSchema,
    notificationSmsRecipientUpdate: notificationSmsRecipientUpdateSchema,
    notificationSmsTemplateList: notificationSmsTemplateListSchema,
    notificationSmsTemplateCreate: notificationSmsTemplateCreateSchema,
    notificationSmsTemplateUpdate: notificationSmsTemplateUpdateSchema,
    notificationTemplateList: notificationTemplateListSchema,
    notificationTemplateCreate: notificationTemplateCreateSchema,
    notificationTemplateUpdate: notificationTemplateUpdateSchema,
    approvedVisitorList: approvedVisitorListSchema,
    allVisitorList: allVisitorListSchema,
    allVisitorId: allVisitorIdSchema,
    approvedVisitorId: approvedVisitorIdSchema,
    approvedVisitorCardAssignment: approvedVisitorCardAssignmentSchema,
    approvedVisitorCardReturn: approvedVisitorCardReturnSchema,
    systemSessionList: systemSessionListSchema,
    systemSessionRevoke: systemSessionRevokeSchema,
    accessAreaList: accessAreaListSchema,
    accessAreaCreate: accessAreaCreateSchema,
    accessAreaUpdate: accessAreaUpdateSchema,
    accessLevelArea: accessLevelAreaSchema,
    accessLevelAreaUpdate: accessLevelAreaUpdateSchema
  }
};
