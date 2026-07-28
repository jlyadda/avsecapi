const { v4: uuidv4, validate: isUuid } = require('uuid');

const requestContext = (req, res, next) => {
  const providedId = req.get('x-request-id');
  req.requestId = providedId && isUuid(providedId) ? providedId : uuidv4();
  res.set('X-Request-Id', req.requestId);
  return next();
};

module.exports = requestContext;
