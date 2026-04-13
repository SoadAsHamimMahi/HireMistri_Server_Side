// index.js — Slim entry point (refactored)
// All business logic has been moved to routes/, config/, middleware/, utils/, sockets/, cron/
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');

// ---- Infrastructure ----
const { connectDB, collections } = require('./config/db');
require('./config/firebase'); // runs Firebase init on require (exports admin object, not a function)

// ---- Middleware ----
const { requestLogger, trackLastActive } = require('./middleware/logger');

// ---- Utils with shared state ----
const { setIo: setNotificationsIo } = require('./utils/notifications');
const { setIo: setMessagingIo } = require('./utils/messaging');

// ---- Sockets & Crons ----
const setupSockets = require('./sockets/index');
const setupCronJobs = require('./cron/index');

// ---- Route modules ----
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

// Admin routers will be required linearly inside startServer()
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    // 1. Firebase Admin is initialized at require() time via config/firebase.js

    // 2. Connect to MongoDB (sets up all collections on the global `collections` object)
    await connectDB();
    console.log('✅ Database connected');

    // 3. Express app + HTTP server + Socket.IO
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
    });

    // 4. Share `io` with utility modules that need to emit events
    setNotificationsIo(io);
    setMessagingIo(io);

    // 5. Global middleware
    app.use(cors());
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
    app.use(requestLogger);
    app.use(trackLastActive);

    // 6. Mount routes — order matters (specific before generic)
    app.use('/api/auth', authRouter);
    app.use('/api/users', usersRouter);
    app.use('/api/workers', workersRouter);
    app.use('/api', browseRouter);
    // Jobs (includes /api/browse-jobs, /api/jobs, /api/job-offers, /api/job-applications, /api/my-applications, /api/client-applications, /api/worker-job-requests, /api/services, /api/reviews, /health)
    app.use('/api', jobsRouter);
    app.use('/api/applications', applicationsRouter);
    app.use('/api/messages', messagesRouter);
    app.use('/api/notifications', notificationsRouter);
    app.use('/api/saved-jobs', savedJobsRouter);
    app.use('/api/support', supportRouter);     // support.js has /tickets, /tickets/:id/messages → /api/support/tickets, etc.
    app.use('/api', paymentsRouter);            // fees, dues, wallet, additional-charges

    // Admin routes
    app.use('/api/admin', require('./routes/admin/dashboard'));
    app.use('/api/admin/providers', require('./routes/admin/providers'));
    app.use('/api/admin/workers', require('./routes/admin/workers'));
    app.use('/api/admin', require('./routes/admin/finance'));
    app.use('/api/admin/support/tickets', require('./routes/admin/support'));
    app.use('/api/admin', require('./routes/admin/cms'));

    // Recently ported Admin Routes
    app.use('/api/admin/bookings', require('./routes/admin/bookings'));
    app.use('/api/admin/categories', require('./routes/admin/categories'));
    app.use('/api/admin/services', require('./routes/admin/services'));
    app.use('/api/admin/customers', require('./routes/admin/customers'));
    app.use('/api/admin/audit-logs', require('./routes/admin/auditLogs'));

    // 7. WebSocket handlers
    setupSockets(io);

    // 8. Cron jobs
    setupCronJobs();

    // 9. Error handlers (must be after routes)
    app.use((req, res) => res.status(404).json({ error: `Endpoint ${req.url} not found` }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
      console.error('Server Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    // 10. Start listening
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`⚡ WebSocket server running on ws://localhost:${PORT}`);
      console.log(`⏰ Scheduled tasks (job expiration, due monitor) running hourly`);
    });
  } catch (err) {
    console.error('❌ Server startup failed:', err);
    process.exit(1);
  }
}

startServer();
