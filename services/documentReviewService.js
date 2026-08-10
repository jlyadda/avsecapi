const parseJsonObject = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const getSubmittedDocuments = (supportingDocuments) => {
  const documents = parseJsonObject(supportingDocuments);
  const submitted = [];
  const addDocument = (documentKey, documentUrl, documentType) => {
    if (typeof documentUrl === 'string' && documentUrl.length > 0) {
      submitted.push({ document_key: documentKey, document_type: documentType, document_url: documentUrl });
    }
  };
  addDocument('IDENTITY_DOCUMENT', documents.identity_document_url, 'IDENTITY_DOCUMENT');
  addDocument(
    'AVSEC_ENDORSED_LETTER',
    documents.avsec_endorsed_letter_url,
    'AVSEC_ENDORSED_LETTER'
  );
  addDocument(
    'PASSPORT_PHOTOGRAPH',
    documents.passport_photograph_url,
    'PASSPORT_PHOTOGRAPH'
  );
  const otherDocuments = Array.isArray(documents.other_document_urls)
    ? documents.other_document_urls
    : [];
  otherDocuments.forEach((documentUrl, index) => {
    addDocument(`OTHER_DOCUMENT_${index + 1}`, documentUrl, 'OTHER_DOCUMENT');
  });
  return submitted;
};

const validateDocumentReviews = (supportingDocuments, reviews) => {
  const submitted = getSubmittedDocuments(supportingDocuments);
  const submittedKeys = new Set(submitted.map((document) => document.document_key));
  const reviewedKeys = new Set(reviews.map((review) => review.document_key));
  if (
    reviewedKeys.size !== reviews.length
    || submittedKeys.size !== reviewedKeys.size
    || [...submittedKeys].some((documentKey) => !reviewedKeys.has(documentKey))
  ) {
    const error = new Error('Every submitted document must be reviewed exactly once.');
    error.status = 422;
    error.code = 'DOCUMENT_REVIEWS_INCOMPLETE';
    error.expectedDocumentKeys = [...submittedKeys];
    throw error;
  }
  const reviewsByKey = new Map(reviews.map((review) => [review.document_key, review]));
  return submitted.map((document) => ({ ...document, ...reviewsByKey.get(document.document_key) }));
};

module.exports = { getSubmittedDocuments, parseJsonObject, validateDocumentReviews };
