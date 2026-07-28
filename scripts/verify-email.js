const { isEmailConfigured, verifyEmailTransport } = require('../emailService');

const verify = async () => {
  if (!isEmailConfigured) {
    throw new Error('Gmail SMTP configuration is incomplete.');
  }
  await verifyEmailTransport();
  console.log('Gmail SMTP authentication verified.');
};

verify().catch((error) => {
  const message = error.code === 'EAUTH'
    ? 'Gmail rejected the configured username or app password.'
    : error.message;
  console.error(`Email verification failed: ${message}`);
  process.exit(1);
});
