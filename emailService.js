const nodemailer = require('nodemailer');
require('dotenv').config({ quiet: true });
const config = require('./config');

const gmailUser = (process.env.gmailUser || process.env.GMAIL_USER || '').trim();
const gmailAppPassword = (
  process.env.gmailAppSpecificPassword
  || process.env.GMAIL_APP_PASSWORD
  || ''
).replace(/\s/g, '');
const gmailSmtpHost = (
  process.env.gmailSendserver
  || process.env.GMAIL_SMTP_HOST
  || 'smtp.gmail.com'
).trim();
const gmailSmtpPort = Number(
  process.env.gmailPort
  || process.env.GMAIL_SMTP_PORT
  || 587
);

const isEmailConfigured = Boolean(
  gmailUser
  && gmailSmtpHost
  && Number.isInteger(gmailSmtpPort)
  && gmailAppPassword.length >= 16
);

const transporter = isEmailConfigured
  ? nodemailer.createTransport({
    host: gmailSmtpHost,
    port: gmailSmtpPort,
    secure: gmailSmtpPort === 465,
    requireTLS: gmailSmtpPort === 587,
    auth: {
      user: gmailUser,
      pass: gmailAppPassword
    }
  })
  : null;

const sendPasswordResetOtp = async ({ email, fullName, otp }) => {
  if (!transporter) throw new Error('Email delivery is not configured.');

  await transporter.sendMail({
    from: {
      name: config.EMAIL_FROM_NAME,
      address: gmailUser
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

const sendNotificationEmail = async ({ email, title, body }) => {
  if (!transporter) throw new Error('Email delivery is not configured.');
  await transporter.sendMail({
    from: {
      name: config.EMAIL_FROM_NAME,
      address: gmailUser
    },
    to: email,
    subject: title,
    text: body
  });
};

const verifyEmailTransport = async () => {
  if (!transporter) throw new Error('Email delivery is not configured.');
  return transporter.verify();
};

module.exports = {
  isEmailConfigured,
  sendPasswordResetOtp,
  sendNotificationEmail,
  verifyEmailTransport
};
