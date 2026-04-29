/**
 * server.js  –  GSM Gateway Main Entry Point
 * ─────────────────────────────────────────────────────────────────────────────
 * Boots Express API, WebSocket, modem pool, SMS queue, cron jobs & Telegram bot.
 */

require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const morgan    = require('morgan');
const cron      = require('node-cron');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const config       = require('./config');
const db           = require('./src/database');
const modemManager = require('./src/modem-manager');
const simRotation  = require('./src/sim-rotation');
const smsQueue     = require('./src/sms-queue');
const telegram     = require('./src/telegram-notifier');
const simHealthMonitor = require('./src/sim-health-monitor');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting for API endpoints
const limiter = rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  max: config.security.rateLimitMaxRequests,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Simple password auth for API
const requireAuth = (req, res, next) => {
  const token = req.headers['x-gateway-password'] || req.query.pass;
  if (token !== config.dashboard.password) {
    return res.status(401).json({ error: 'Unauthorized – wrong password' });
  }
  next();
};

// ─── WebSocket broadcast ──────────────────────────────────────────────────────
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'welcome', data: { version: '1.0.0' } }));
  // Push current stats immediately
  ws.send(JSON.stringify({ type: 'stats', data: db.getTodayStats() }));
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === config.dashboard.password) {
    res.json({ ok: true, message: 'Authenticated' });
  } else {
    res.status(401).json({ ok: false, error: 'Wrong password' });
  }
});

// ─── Stats & Dashboard ────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const today   = db.getTodayStats();
  const weekly  = db.getDailyStats();
  const sims    = simRotation.getStatus();
  const modems  = modemManager.getStatus();
  const queueDepth = smsQueue.getQueueDepth();
  const blockedSims = db.getBlockedSims();
  res.json({ today, weekly, sims, modems, queueDepth, blockedCount: blockedSims.length });
});

// ─── Inbox (inbound messages) ─────────────────────────────────────────────────
app.get('/api/inbox', requireAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 50,  200);
  const offset = parseInt(req.query.offset) || 0;
  const q      = req.query.q;

  const messages = q
    ? db.searchMessages('inbound', q)
    : db.getMessages('inbound', limit, offset);
  const total = db.countMessages('inbound');
  res.json({ messages, total, limit, offset });
});

// ─── Outbox (outbound messages) ───────────────────────────────────────────────
app.get('/api/outbox', requireAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const q      = req.query.q;

  const messages = q
    ? db.searchMessages('outbound', q)
    : db.getMessages('outbound', limit, offset);
  const total = db.countMessages('outbound');
  res.json({ messages, total, limit, offset });
});

// ─── Send Single SMS ──────────────────────────────────────────────────────────
app.post('/api/send', requireAuth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });
  if (message.length > 918) return res.status(400).json({ error: 'Message too long (max 918 chars)' });

  try {
    const id = await smsQueue.enqueue(phone, message);
    res.json({ ok: true, id, message: 'Queued for sending' });
    broadcast('queue:updated', { queueDepth: smsQueue.getQueueDepth() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk SMS ─────────────────────────────────────────────────────────────────
app.post('/api/bulk', requireAuth, async (req, res) => {
  const { recipients, message, jobName } = req.body;

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0)
    return res.status(400).json({ error: 'recipients array is required' });
  if (!message)
    return res.status(400).json({ error: 'message is required' });
  if (recipients.length > 5000)
    return res.status(400).json({ error: 'Max 5000 recipients per request' });

  try {
    const jobId = await smsQueue.enqueueBulk(recipients, message, jobName || 'Bulk Job');
    res.json({ ok: true, jobId, total: recipients.length, message: 'Bulk job queued' });
    broadcast('queue:updated', { queueDepth: smsQueue.getQueueDepth() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SIM Cards ────────────────────────────────────────────────────────────────
app.get('/api/sims', requireAuth, (req, res) => {
  res.json(simRotation.getStatus());
});

// Get blocked SIMs
app.get('/api/sims/blocked', requireAuth, (req, res) => {
  const blockedSims = db.getBlockedSims();
  res.json(blockedSims);
});

// Get SIM health status
app.get('/api/sims/health', requireAuth, (req, res) => {
  res.json(simHealthMonitor.getHealthStatus());
});

// Toggle a SIM on/off
app.patch('/api/sims/:port', requireAuth, (req, res) => {
  const port   = decodeURIComponent(req.params.port);
  const { active } = req.body;
  db.db.prepare('UPDATE sim_cards SET is_active=? WHERE port=?').run(active ? 1 : 0, port);
  res.json({ ok: true });
});

// Unblock a SIM after physical replacement
app.post('/api/sims/:port/unblock', requireAuth, (req, res) => {
  const port = decodeURIComponent(req.params.port);
  const result = simHealthMonitor.unblockSim(port);
  if (result.success) {
    broadcast('sim:unblocked', { port });
    res.json({ ok: true, message: `SIM ${port} has been reactivated` });
  } else {
    res.status(500).json({ ok: false, error: result.error });
  }
});

// ─── Modem Status ─────────────────────────────────────────────────────────────
app.get('/api/modems', requireAuth, (req, res) => {
  res.json(modemManager.getStatus());
});

// List available system serial ports
app.get('/api/modems/ports', requireAuth, async (req, res) => {
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    res.json(ports.filter(p => p.path));
  } catch (err) {
    console.error('[API] Error listing ports:', err.message);
    res.json([]);
  }
});

// Auto-detect modem ports (scan and test with AT commands)
app.get('/api/modems/detect', requireAuth, async (req, res) => {
  try {
    const { SerialPort } = require('serialport');
    const { ReadlineParser } = require('@serialport/parser-readline');
    
    const allPorts = await SerialPort.list();
    const detectedModems = [];
    
    for (const portInfo of allPorts) {
      const portPath = portInfo.path;
      
      // Skip COM1 and COM2 (usually system ports)
      if (portPath.toUpperCase() === 'COM1' || portPath.toUpperCase() === 'COM2') {
        continue;
      }
      
      try {
        const testPort = new SerialPort({
          path: portPath,
          baudRate: config.modem.baudRate || 115200,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          autoOpen: false,
        });
        
        const isModem = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            testPort.close(() => {});
            resolve(false);
          }, 2000);
          
          testPort.open((err) => {
            if (err) {
              clearTimeout(timeout);
              resolve(false);
              return;
            }
            
            testPort.write('AT\r', (writeErr) => {
              if (writeErr) {
                clearTimeout(timeout);
                testPort.close(() => {});
                resolve(false);
                return;
              }
            });
            
            const parser = testPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));
            
            parser.on('data', (data) => {
              if (data.toString().trim() === 'OK') {
                clearTimeout(timeout);
                testPort.close(() => {});
                resolve(true);
              }
            });
          });
        });
        
        if (isModem) {
          detectedModems.push({
            port: portPath,
            manufacturer: portInfo.manufacturer || 'Unknown',
            vid: portInfo.vendorId || 'Unknown',
            pid: portInfo.productId || 'Unknown',
          });
        }
      } catch (err) {
        // Port not accessible
      }
    }
    
    res.json({
      totalPorts: allPorts.length,
      detectedModems: detectedModems.length,
      modems: detectedModems,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-scan and add new modems
app.post('/api/modems/rescan', requireAuth, async (req, res) => {
  try {
    const { SerialPort } = require('serialport');
    const { ReadlineParser } = require('@serialport/parser-readline');
    
    const allPorts = await SerialPort.list();
    const currentPorts = new Set(modemManager.getAllModems().map(m => m.portPath));
    let addedCount = 0;
    
    for (const portInfo of allPorts) {
      const portPath = portInfo.path;
      
      if (currentPorts.has(portPath)) continue;
      if (portPath.toUpperCase() === 'COM1' || portPath.toUpperCase() === 'COM2') continue;
      
      try {
        const testPort = new SerialPort({
          path: portPath,
          baudRate: config.modem.baudRate || 115200,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          autoOpen: false,
        });
        
        const isModem = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            testPort.close(() => {});
            resolve(false);
          }, 2000);
          
          testPort.open((err) => {
            if (err) {
              clearTimeout(timeout);
              resolve(false);
              return;
            }
            
            testPort.write('AT\r', (writeErr) => {
              if (writeErr) {
                clearTimeout(timeout);
                testPort.close(() => {});
                resolve(false);
                return;
              }
            });
            
            const parser = testPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));
            
            parser.on('data', (data) => {
              if (data.toString().trim() === 'OK') {
                clearTimeout(timeout);
                testPort.close(() => {});
                resolve(true);
              }
            });
          });
        });
        
        if (isModem) {
          // Found a new modem - recommend restart
          addedCount++;
          console.log(`[API] Detected new modem on ${portPath}`);
        }
      } catch (err) {
        // Skip
      }
    }
    
    res.json({
      message: `Found ${addedCount} new modem(s). Please restart the gateway to use them.`,
      newModems: addedCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Queue control ────────────────────────────────────────────────────────────
app.post('/api/queue/pause',  requireAuth, (req, res) => { smsQueue.pause();  res.json({ ok: true }); });
app.post('/api/queue/resume', requireAuth, (req, res) => { smsQueue.resume(); res.json({ ok: true }); });

app.get('/api/queue/depth', requireAuth, (req, res) => {
  res.json({ depth: smsQueue.getQueueDepth() });
});

// Delete a message from queue
app.delete('/api/queue/:messageId', requireAuth, async (req, res) => {
  try {
    const result = await smsQueue.deleteMessage(req.params.messageId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Bulk Jobs ────────────────────────────────────────────────────────────────
app.get('/api/jobs', requireAuth, (req, res) => {
  const jobs = db.db.prepare('SELECT * FROM bulk_jobs ORDER BY created_at DESC LIMIT 50').all();
  res.json(jobs);
});

// ─── Settings ─────────────────────────────────────────────────────────────────
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({
    version: config.version,
    maxSmsPerDay:  config.sim.maxSmsPerDay,
    sendDelayMS:   config.sim.sendDelayMs,
    rotationStrategy: config.sim.rotationStrategy,
    telegramEnabled:  config.telegram.enabled,
    modemPorts:    config.modem.ports,
  });
});

// ─── System Info ──────────────────────────────────────────────────────────────
app.get('/api/system/info', requireAuth, (req, res) => {
  const os = require('os');
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    hostname: os.hostname(),
  });
});

// ─── Telegram Integration ─────────────────────────────────────────────────────
// Get current Telegram configuration
app.get('/api/telegram/config', requireAuth, (req, res) => {
  res.json({
    enabled: config.telegram.enabled,
    botToken: config.telegram.botToken ? 'configured' : null,
    chatId: config.telegram.chatId || null,
  });
});

// Verify Telegram bot token
app.post('/api/telegram/verify', requireAuth, async (req, res) => {
  const { botToken } = req.body;
  
  if (!botToken) {
    return res.status(400).json({ error: 'Bot token is required' });
  }
  
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const testBot = new TelegramBot(botToken, { polling: false });
    
    // Get bot info to verify token
    const botInfo = await testBot.getMe();
    
    res.json({
      success: true,
      botName: botInfo.first_name,
      botUsername: botInfo.username,
      message: 'Bot token is valid!',
    });
  } catch (err) {
    res.status(400).json({ 
      success: false, 
      error: 'Invalid bot token. Please check and try again.' 
    });
  }
});

// Save Telegram configuration
app.post('/api/telegram/configure', requireAuth, async (req, res) => {
  const { botToken, chatId } = req.body;
  
  if (!botToken || !chatId) {
    return res.status(400).json({ error: 'Bot token and chat ID are required' });
  }
  
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const testBot = new TelegramBot(botToken, { polling: false });
    
    // Verify bot token
    const botInfo = await testBot.getMe();
    
    // Save to settings table in database
    const settings = db.db.prepare(`
      INSERT OR REPLACE INTO settings (key, value)
      VALUES (?, ?)
    `);
    
    settings.run('telegram_bot_token', botToken);
    settings.run('telegram_chat_id', chatId);
    settings.run('telegram_enabled', 'true');
    
    // Update config object
    config.telegram.botToken = botToken;
    config.telegram.chatId = chatId;
    config.telegram.enabled = true;
    
    // Reinitialize telegram notifier
    telegram.init();
    
    // Send test message
    await telegram.sendAlert('✅ *GSM Gateway Connected!*\n\nYour GSM Gateway is now connected to this Telegram bot. You will receive notifications for:\n• Incoming SMS\n• SIM health alerts\n• System notifications\n\nUse /start to see available commands.');
    
    res.json({
      success: true,
      message: 'Telegram configured successfully! Test message sent.',
      botName: botInfo.first_name,
    });
  } catch (err) {
    console.error('[Telegram] Configuration error:', err.message);
    res.status(400).json({ 
      success: false, 
      error: err.message || 'Failed to configure Telegram' 
    });
  }
});

// Disable Telegram notifications
app.post('/api/telegram/disable', requireAuth, (req, res) => {
  try {
    // Update database
    db.db.prepare(`
      INSERT OR REPLACE INTO settings (key, value)
      VALUES (?, ?)
    `).run('telegram_enabled', 'false');
    
    // Update config
    config.telegram.enabled = false;
    
    // Stop telegram bot
    if (telegram.bot) {
      telegram.bot.stopPolling();
      telegram.bot = null;
    }
    telegram.enabled = false;
    
    res.json({ success: true, message: 'Telegram notifications disabled' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Test Telegram connection
app.post('/api/telegram/test', requireAuth, async (req, res) => {
  if (!config.telegram.enabled || !telegram.bot) {
    return res.status(400).json({ error: 'Telegram is not configured' });
  }
  
  try {
    await telegram.sendAlert('🧪 *Test Message*\n\nThis is a test message from GSM Gateway. Your Telegram integration is working correctly!');
    res.json({ success: true, message: 'Test message sent!' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Health Check (no auth required for monitoring) ───────────────────────────
app.get('/api/health', (req, res) => {
  const stats = db.getTodayStats();
  const modems = modemManager.getStatus();
  const modemArray = Object.values(modems);
  const readyModems = modemArray.filter(m => m.status === 'ready').length;
  
  res.json({
    status: 'ok',
    version: config.version,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: 'connected',
    modems: {
      total: modemArray.length,
      ready: readyModems,
      offline: modemArray.length - readyModems
    },
    queue: {
      depth: smsQueue.getQueueDepth(),
      paused: smsQueue.isPaused
    },
    today: stats
  });
});

// ─── SMS Queue Events → WebSocket broadcast ───────────────────────────────────
smsQueue.on('message:sent', (msg) => {
  broadcast('message:sent', msg);
  broadcast('stats', db.getTodayStats());
});

smsQueue.on('message:failed', (msg) => {
  broadcast('message:failed', msg);
});

// ─── Modem Events ─────────────────────────────────────────────────────────────
modemManager.on('sms:received', (msg) => {
  broadcast('sms:received', msg);
  broadcast('stats', db.getTodayStats());
  telegram.notifyInbound(msg);
  console.log(`[Gateway] 📩 Inbound SMS from ${msg.phone}`);
});

// ─── Startup Health Check & Auto-Recovery ────────────────────────────────────
async function performStartupHealthCheck() {
  console.log('[HealthCheck] Performing startup health check...');
  
  const sims = db.getSimCards();
  const modems = modemManager.getStatus();
  
  let readyCount = 0;
  let blockedCount = 0;
  let offlineCount = 0;
  
  for (const sim of sims) {
    const modem = modems[sim.port];
    
    if (sim.blocked_at) {
      blockedCount++;
      console.log(`[HealthCheck] ${sim.port} - BLOCKED (${sim.blocked_reason})`);
    } else if (modem && modem.status === 'ready') {
      readyCount++;
      // Reset failure count on successful reconnect
      if (sim.failure_count > 0) {
        db.resetSimFailureCount(sim.port);
        console.log(`[HealthCheck] ${sim.port} - Reconnected, failure count reset`);
      }
    } else {
      offlineCount++;
      console.log(`[HealthCheck] ${sim.port} - OFFLINE`);
    }
  }
  
  const summary = `🚀 *Gateway Started*\n\n` +
    `✅ Ready: ${readyCount}\n` +
    `🚫 Blocked: ${blockedCount} (need replacement)\n` +
    `🔴 Offline: ${offlineCount}\n\n` +
    (blockedCount > 0 ? `⚠️ Check dashboard for blocked SIM details.` : `🟢 All SIMs operational!`);
  
  telegram.sendAlert(summary);
  console.log(`[HealthCheck] Complete - Ready: ${readyCount}, Blocked: ${blockedCount}, Offline: ${offlineCount}`);
}

// ─── Periodic Health Sweep (every 5 minutes) ─────────────────────────────────
cron.schedule('*/5 * * * *', () => {
  console.log('[HealthSweep] Running periodic health check...');
  
  const sims = db.getSimCards();
  const modems = modemManager.getStatus();
  
  // Reset alert flags at midnight
  db.resetAlertFlags();
  
  // Check for modems that came back online
  for (const sim of sims) {
    const modem = modems[sim.port];
    
    if (modem && modem.status === 'ready' && sim.blocked_at) {
      // Modem is back online but still blocked - keep blocked (needs manual unblock)
      console.log(`[HealthSweep] ${sim.port} - Online but blocked, awaiting manual reactivation`);
    } else if (modem && modem.status === 'ready' && sim.failure_count > 0) {
      // Modem reconnected, reset failures
      db.resetSimFailureCount(sim.port);
      console.log(`[HealthSweep] ${sim.port} - Reconnected, failure count reset`);
    }
  }
  
  // Broadcast updated SIM status
  broadcast('sims:updated', simRotation.getStatus());
});

// ─── Modem reconnect event ───────────────────────────────────────────────────
modemManager.on('modem:ready', (port) => {
  broadcast('modem:ready', { port });
  simHealthMonitor.onModemReconnect(port);
});

// ─── Daily midnight reset ─────────────────────────────────────────────────────
cron.schedule('0 0 * * *', () => {
  db.resetDailyCounts();
  console.log('[Cron] Daily SIM counts reset');
  telegram.sendAlert('🔄 Daily SIM send counts have been reset (midnight).');
});

// ─── Hourly stats broadcast ───────────────────────────────────────────────────
cron.schedule('* * * * *', () => {
  broadcast('stats', db.getTodayStats());
});

// ─── Boot sequence ────────────────────────────────────────────────────────────
async function boot() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║          GSM SMS Gateway  v1.0.0                 ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // 1. Telegram bot
  telegram.init();

  // 2. Wire queue to modem manager
  smsQueue.setModemManager(modemManager);
  
  // 2.5. Wire health monitor to telegram
  simHealthMonitor.setTelegramNotifier(telegram);

  // 3. Connect to modem pool
  console.log('[Boot] Connecting to modem pool...');
  await modemManager.initialize();

  // 3.5. Startup health check
  await performStartupHealthCheck();

  // 4. Start SMS queue processor
  smsQueue.start();
  console.log('[Boot] SMS queue processor started');

  // 5. Start HTTP + WS server
  server.listen(config.port, () => {
    console.log(`\n✅ Dashboard: http://localhost:${config.port}`);
    console.log(`🔑 Password:  ${config.dashboard.password}`);
    console.log(`📱 Modems:    ${config.modem.ports.join(', ')}\n`);
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Gateway] Shutting down...');
  modemManager.shutdown();
  smsQueue.stop();
  server.close();
  process.exit(0);
});

boot().catch(err => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});
