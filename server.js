require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const auditRoutes     = require('./routes/audit');
const resumeRoutes    = require('./routes/resume');
const interviewRoutes = require('./routes/interview');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'devaudit',
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'connecting'
  });
});

app.use('/api/audit',     auditRoutes);
app.use('/api/resume',    resumeRoutes);
app.use('/api/interview', interviewRoutes);

mongoose
  .connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/devaudit')
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`DevAudit server listening on http://localhost:${PORT}`);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\nPort ${PORT} is already in use (another DevAudit or app is running).`);
        console.error('Fix one of these:');
        console.error(`  • Windows: netstat -ano | findstr :${PORT}  →  note the PID  →  taskkill /PID <pid> /F`);
        console.error(`  • Or set a different port: set PORT=3001&& node server.js  (PowerShell: $env:PORT=3001; node server.js)`);
        console.error('');
      } else {
        console.error('Server listen error:', err);
      }
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
