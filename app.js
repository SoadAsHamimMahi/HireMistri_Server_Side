const express = require('express');
const cors = require('cors');
const path = require('path');

const { requestLogger, trackLastActive } = require('./middleware/logger');

const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const workersRouter = require('./routes/workers');
const browseRouter = require('./routes/browse');
const jobsRouter = require('./routes/jobs');
const applicationsRouter = require('./routes/applications');
const messagesRouter = require('./routes/messages');
const notificationsRouter = require('./routes/notifications');
const savedJobsRouter = require('./routes/savedJobs');
const supportRouter = require('./routes/support');
const { router: paymentsRouter } = require('./routes/payments');

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
  app.use(requestLogger);
  app.use(trackLastActive);

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/workers', workersRouter);
  app.use('/api', browseRouter);
  app.use('/api', jobsRouter);
  app.use('/api/applications', applicationsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/saved-jobs', savedJobsRouter);
  app.use('/api/support', supportRouter);
  app.use('/api', paymentsRouter);

  app.use('/api/admin', require('./routes/admin/dashboard'));
  app.use('/api/admin/providers', require('./routes/admin/providers'));
  app.use('/api/admin/workers', require('./routes/admin/workers'));
  app.use('/api/admin', require('./routes/admin/finance'));
  app.use('/api/admin/support/tickets', require('./routes/admin/support'));
  app.use('/api/admin', require('./routes/admin/cms'));
  app.use('/api/admin/bookings', require('./routes/admin/bookings'));
  app.use('/api/admin/categories', require('./routes/admin/categories'));
  app.use('/api/admin/services', require('./routes/admin/services'));
  app.use('/api/admin/customers', require('./routes/admin/customers'));
  app.use('/api/admin/audit-logs', require('./routes/admin/auditLogs'));

  app.use((req, res) => res.status(404).json({ error: `Endpoint ${req.url} not found` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('Server Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
