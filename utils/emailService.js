const sgMail = require('@sendgrid/mail');

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/**
 * Send email notification
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} html - HTML email content
 * @param {string} text - Plain text email content (optional)
 */
async function sendEmail(to, subject, html, text = null) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn('⚠️ SendGrid API key not configured. Email not sent.');
    return { success: false, error: 'SendGrid not configured' };
  }

  if (!process.env.SENDGRID_FROM_EMAIL) {
    console.warn('⚠️ SendGrid from email not configured. Email not sent.');
    return { success: false, error: 'From email not configured' };
  }

  try {
    const msg = {
      to,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject,
      html,
      ...(text && { text }),
    };

    await sgMail.send(msg);
    console.log(`✅ Email sent to ${to}`);
    return { success: true };
  } catch (error) {
    console.error('❌ Failed to send email:', error);
    if (error.response) {
      console.error('SendGrid error details:', error.response.body);
    }
    return { success: false, error: error.message };
  }
}

/**
 * Send application received email to client
 */
async function sendApplicationReceivedEmail(clientEmail, clientName, jobTitle, workerName) {
  const subject = `New Application for "${jobTitle}"`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">New Application Received</h2>
      <p>Hello ${clientName},</p>
      <p>You have received a new application for your job: <strong>${jobTitle}</strong></p>
      <p><strong>Applicant:</strong> ${workerName}</p>
      <p>Please review the application in your dashboard.</p>
      <p style="margin-top: 30px; color: #666; font-size: 12px;">This is an automated notification from Hire Mistri.</p>
    </div>
  `;
  return await sendEmail(clientEmail, subject, html);
}

/**
 * Send application status change email to worker
 */
async function sendApplicationStatusEmail(workerEmail, workerName, jobTitle, status) {
  const statusMessages = {
    accepted: 'Congratulations! Your application has been accepted.',
    rejected: 'Your application has been reviewed but not selected for this position.',
  };
  const message = statusMessages[status] || 'Your application status has been updated.';

  const subject = `Application Update: "${jobTitle}"`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Application Status Update</h2>
      <p>Hello ${workerName},</p>
      <p>${message}</p>
      <p><strong>Job:</strong> ${jobTitle}</p>
      <p><strong>Status:</strong> ${status.charAt(0).toUpperCase() + status.slice(1)}</p>
      <p style="margin-top: 30px; color: #666; font-size: 12px;">This is an automated notification from Hire Mistri.</p>
    </div>
  `;
  return await sendEmail(workerEmail, subject, html);
}

/**
 * Send job status change email
 */
async function sendJobStatusEmail(email, name, jobTitle, status) {
  const subject = `Job Status Update: "${jobTitle}"`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Job Status Update</h2>
      <p>Hello ${name},</p>
      <p>Your job <strong>${jobTitle}</strong> status has been updated to: <strong>${status.charAt(0).toUpperCase() + status.slice(1)}</strong></p>
      <p style="margin-top: 30px; color: #666; font-size: 12px;">This is an automated notification from Hire Mistri.</p>
    </div>
  `;
  return await sendEmail(email, subject, html);
}

/**
 * Send new message email notification
 */
async function sendNewMessageEmail(recipientEmail, recipientName, senderName, jobTitle) {
  const subject = `New Message from ${senderName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">New Message</h2>
      <p>Hello ${recipientName},</p>
      <p>You have received a new message from <strong>${senderName}</strong>${jobTitle ? ` regarding "${jobTitle}"` : ''}.</p>
      <p>Please check your messages in the Hire Mistri dashboard.</p>
      <p style="margin-top: 30px; color: #666; font-size: 12px;">This is an automated notification from Hire Mistri.</p>
    </div>
  `;
  return await sendEmail(recipientEmail, subject, html);
}

/**
 * Task 6.4: Send job offer notification email to worker
 */
async function sendJobOfferEmail(workerEmail, workerName, jobTitle, clientName, budget, currency, expiresAt) {
  const subject = `New Job Offer: "${jobTitle}"`;
  const expirationText = expiresAt 
    ? `<p><strong>Expires:</strong> ${new Date(expiresAt).toLocaleDateString()}</p>`
    : '';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">New Job Offer Received</h2>
      <p>Hello ${workerName},</p>
      <p>You have received a new job offer from <strong>${clientName}</strong>!</p>
      <p><strong>Job Title:</strong> ${jobTitle}</p>
      ${budget ? `<p><strong>Budget:</strong> ${budget} ${currency || 'BDT'}</p>` : ''}
      ${expirationText}
      <p>Please log in to your dashboard to view the full details and respond to this offer.</p>
      <p style="margin-top: 30px; color: #666; font-size: 12px;">This is an automated notification from Hire Mistri.</p>
    </div>
  `;
  return await sendEmail(workerEmail, subject, html);
}

/**
 * Task 6.4: Send job offer reminder email to worker
 */
async function sendJobOfferReminderEmail(workerEmail, workerName, jobTitle, hoursRemaining) {
  const subject = `Reminder: Job Offer Expiring Soon - "${jobTitle}"`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Job Offer Expiring Soon</h2>
      <p>Hello ${workerName},</p>
      <p>This is a reminder that you have a pending job offer that will expire soon.</p>
      <p><strong>Job Title:</strong> ${jobTitle}</p>
      <p><strong>Time Remaining:</strong> ${hoursRemaining} hours</p>
      <p>Please log in to your dashboard to review and respond to this offer before it expires.</p>
      <p style="margin-top: 30px; color: #666; font-size: 12px;">This is an automated notification from Hire Mistri.</p>
    </div>
  `;
  return await sendEmail(workerEmail, subject, html);
}

/**
 * Task 6.4: Send job offer expiration notification email to worker
 */
async function sendJobOfferExpiredEmail(workerEmail, workerName, jobTitle) {
  const subject = `Job Offer Expired - "${jobTitle}"`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Job Offer Expired</h2>
      <p>Hello ${workerName},</p>
      <p>Unfortunately, the job offer for <strong>${jobTitle}</strong> has expired.</p>
      <p>You can still browse other available jobs on the platform.</p>
      <p style="margin-top: 30px; color: #666; font-size: 12px;">This is an automated notification from Hire Mistri.</p>
    </div>
  `;
  return await sendEmail(workerEmail, subject, html);
}

module.exports = {
  sendEmail,
  sendApplicationReceivedEmail,
  sendApplicationStatusEmail,
  sendJobStatusEmail,
  sendNewMessageEmail,
  sendJobOfferEmail,
  sendJobOfferReminderEmail,
  sendJobOfferExpiredEmail,
};

