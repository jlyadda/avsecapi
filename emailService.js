const nodemailer = require('nodemailer');
const config = require('./config');

const isEmailConfigured = Boolean(config.GMAIL_USER && config.GMAIL_APP_PASSWORD);

const transporter = isEmailConfigured
  ? nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: config.GMAIL_USER,
      pass: config.GMAIL_APP_PASSWORD
    }
  })
  : null;

const sendPasswordResetOtp = async ({ email, fullName, otp }) => {
  if (!transporter) throw new Error('Email delivery is not configured.');

  await transporter.sendMail({
    from: {
      name: config.EMAIL_FROM_NAME,
      address: config.GMAIL_USER
    },
    to: email,
    subject: 'AVSEC password reset code',
    text: [
      `Hello ${fullName || 'AVSEC user'},`,
      '',
      `Your AVSEC password reset code is ${otp}.`,
      `It expires in ${config.PASSWORD_RESET_OTP_TTL_MINUTES} minutes.`,
      '',
      'If you did not request this reset, ignore this email.'
    ].join('\n')
  });
};

module.exports = { isEmailConfigured, sendPasswordResetOtp };
