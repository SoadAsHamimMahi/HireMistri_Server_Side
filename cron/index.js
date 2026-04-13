// cron/index.js — Scheduled background tasks (node-cron)
const cron = require('node-cron');
const { exec } = require('child_process');
const { ObjectId } = require('mongodb');
const { collections } = require('../config/db');
const { createNotification } = require('../utils/notifications');
const { findOrCreateConversationId, sendSystemMessage } = require('../utils/messaging');
const { sendJobStatusEmail } = require('../utils/emailService');

function setupCronJobs() {
  // ---- Hourly: expire jobs and run due monitor ----
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('🕐 Running scheduled job expiration task...');
      const now = new Date();

      const expiredJobs = await collections.browseJobs.find({
        expiresAt: { $lte: now },
        status: { $nin: ['completed', 'cancelled'] },
        autoCloseEnabled: true,
      }).toArray();

      if (expiredJobs.length > 0) {
        console.log(`📅 Found ${expiredJobs.length} expired job(s) to close`);

        for (const job of expiredJobs) {
          const updateFields = { status: 'expired', updatedAt: now };
          if (job.isPrivate && job.offerStatus === 'pending') {
            updateFields.offerStatus = 'expired';
          }
          await collections.browseJobs.updateOne({ _id: job._id }, { $set: updateFields });

          // Notify targeted worker (private job offers)
          if (job.isPrivate && job.targetWorkerId) {
            await createNotification(
              String(job.targetWorkerId),
              'Job offer expired',
              `The job offer "${job.title || 'Untitled'}" has expired.`,
              'info',
              job._id.toString(),
              '/job-offers'
            );
          }

          // Notify job owner
          if (job.clientId) {
            await createNotification(
              job.clientId,
              'Job Expired',
              `Your job "${job.title || 'Untitled Job'}" has expired and been automatically closed.`,
              'info',
              job._id.toString(),
              `/My-Posted-Job-Details/${job._id}`
            );

            try {
              const clientUser = await collections.users.findOne({ uid: job.clientId });
              if (clientUser?.email) {
                await sendJobStatusEmail(
                  clientUser.email,
                  clientUser.displayName || 'Client',
                  job.title || 'Your Job',
                  'expired',
                  'expired'
                );
              }
            } catch (emailErr) {
              console.error('Failed to send expiration email:', emailErr);
            }
          }

          // Send system messages to workers with active applications
          try {
            const applications = await collections.applications.find({
              jobId: String(job._id),
              status: { $in: ['pending', 'accepted'] },
            }).toArray();

            for (const app of applications) {
              if (app.workerId && job.clientId) {
                const conversationId = await findOrCreateConversationId(
                  String(job._id),
                  String(job.clientId),
                  app.workerId
                );
                if (conversationId) {
                  await sendSystemMessage(
                    conversationId,
                    String(job.clientId),
                    app.workerId,
                    String(job._id),
                    `⏰ Job expired: ${job.title || 'Untitled Job'}\n\nThe job has expired and been automatically closed.`
                  );
                }
              }
            }
          } catch (msgErr) {
            console.error('Error sending system messages for expired job:', msgErr);
          }

          console.log(`✅ Expired job "${job.title || job._id}" has been closed`);
        }
      } else {
        console.log('✅ No expired jobs found');
      }

      // Run Due Monitor script
      console.log('🕐 Running Due Monitor...');
      exec('node scripts/dueMonitor.js', (error, stdout) => {
        if (error) {
          console.error('❌ Due Monitor execution failed:', error);
        } else {
          console.log('✅ Due Monitor stdout:', stdout);
        }
      });
    } catch (err) {
      console.error('❌ Error in job expiration task:', err);
    }
  });
}

module.exports = setupCronJobs;
