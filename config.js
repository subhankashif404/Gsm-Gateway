require('dotenv').config();

module.exports = {
  version: '1.0.0',
  port: parseInt(process.env.PORT) || 3000,
  env: process.env.NODE_ENV || 'development',

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  },

  modem: {
    // Parse comma-separated port list
    ports: (process.env.MODEM_PORTS || '').split(',').map(p => p.trim()),
    baudRate: parseInt(process.env.MODEM_BAUD_RATE) || 115200,
    commandTimeout: 10000, // 10 seconds
    pollInterval: 15000,   // Check for new SMS every 15 seconds
    autoDetect: process.env.MODEM_AUTO_DETECT !== 'false', // Auto-detect by default
  },

  sim: {
    maxSmsPerDay: parseInt(process.env.MAX_SMS_PER_SIM_PER_DAY) || 200,
    sendDelayMs: parseInt(process.env.SMS_SEND_DELAY_MS) || 3000,
    rotationStrategy: 'round-robin', // round-robin | least-used
    
    // SIM Health & Auto-Blocking
    maxConsecutiveFailures: parseInt(process.env.MAX_CONSECUTIVE_FAILURES) || 5,
    alertThresholds: process.env.SIM_ALERT_THRESHOLDS ? 
      process.env.SIM_ALERT_THRESHOLDS.split(',').map(Number) : [80, 90, 100],
    autoBlockEnabled: process.env.AUTO_BLOCK_ENABLED !== 'false', // default true
  },

  db: {
    path: process.env.DB_PATH || './data/gateway.db',
  },

  dashboard: {
    password: process.env.DASHBOARD_PASSWORD || 'admin123',
  },

  security: {
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000, // Increased for dashboard usage
  },
};
