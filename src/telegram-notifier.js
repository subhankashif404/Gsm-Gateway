/**
 * telegram-notifier.js
 * Forwards incoming SMS to your Telegram chat in real-time.
 * Also provides basic bot commands to check inbox/status.
 */

const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const db = require('./database');
const simRotation = require('./sim-rotation');

class TelegramNotifier {
  constructor() {
    this.bot = null;
    this.enabled = config.telegram.enabled;
    
    // Load from database if available
    this.loadDatabaseConfig();
  }

  loadDatabaseConfig() {
    try {
      const db = require('./database');
      const settings = db.db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?)').all(
        'telegram_bot_token',
        'telegram_chat_id', 
        'telegram_enabled'
      );
      
      if (settings && settings.length > 0) {
        const configMap = {};
        settings.forEach(s => configMap[s.key] = s.value);
        
        if (configMap.telegram_bot_token) {
          config.telegram.botToken = configMap.telegram_bot_token;
        }
        if (configMap.telegram_chat_id) {
          config.telegram.chatId = configMap.telegram_chat_id;
        }
        if (configMap.telegram_enabled === 'true') {
          config.telegram.enabled = true;
          this.enabled = true;
        }
      }
    } catch (err) {
      // Database not ready yet, use env config
    }
  }

  init() {
    if (!this.enabled) {
      console.log('[Telegram] Disabled (no token/chat_id configured)');
      return;
    }

    try {
      this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
      console.log('[Telegram] Bot started');
      this._setupCommands();
    } catch (err) {
      console.error(`[Telegram] Failed to start bot: ${err.message}`);
      this.enabled = false;
    }
  }

  _setupCommands() {
    const chatId = config.telegram.chatId;

    // /start
    this.bot.onText(/\/start/, (msg) => {
      this.bot.sendMessage(msg.chat.id,
        `👋 *GSM Gateway Bot*\n\nAvailable commands:\n` +
        `/inbox - Last 10 received messages\n` +
        `/status - SIM card status\n` +
        `/stats  - Today's statistics\n` +
        `/queue  - Pending messages count`,
        { parse_mode: 'Markdown' }
      );
    });

    // /inbox
    this.bot.onText(/\/inbox/, (msg) => {
      const messages = db.getMessages('inbound', 10, 0);
      if (messages.length === 0) {
        this.bot.sendMessage(msg.chat.id, '📭 No messages in inbox yet.');
        return;
      }
      const text = messages.slice(0, 10).map(m => {
        const time = new Date(m.created_at * 1000).toLocaleString();
        return `📩 *From:* ${m.phone}\n*Port:* ${m.sim_port || 'N/A'}\n*Time:* ${time}\n*Msg:* ${m.body}`;
      }).join('\n\n─────────────\n\n');
      this.bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });

    // /status
    this.bot.onText(/\/status/, (msg) => {
      const sims = simRotation.getStatus();
      if (sims.length === 0) {
        this.bot.sendMessage(msg.chat.id, '⚠️ No SIM cards configured.');
        return;
      }
      
      // Show blocked SIMs first
      const blockedSims = sims.filter(s => s.isBlocked);
      let text = '';
      
      if (blockedSims.length > 0) {
        text += '🚨 *BLOCKED SIMs (Need Replacement)*\n\n';
        text += blockedSims.map(s => {
          return `🚫 *${s.port}* - ${s.blockedReason || 'Unknown'}`;
        }).join('\n');
        text += '\n\n─────────────\n\n';
      }
      
      text += '📱 *SIM Card Status*\n\n' + sims.map(s => {
        let icon = s.isAvailable ? '🟢' : '🔴';
        if (s.isBlocked) icon = '🚫';
        else if (s.percentUsed >= 100) icon = '⚠️';
        else if (s.percentUsed >= 80) icon = '⚡';
        
        return `${icon} *${s.port}*\nNumber: ${s.phoneNumber}\nSent today: ${s.dailyCount}/${s.maxPerDay} (${s.percentUsed}%)\nSignal: ${s.signal}/31`;
      }).join('\n\n');
      
      this.bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });

    // /stats
    this.bot.onText(/\/stats/, (msg) => {
      const stats = db.getTodayStats();
      const text =
        `📊 *Today's Statistics*\n\n` +
        `✅ Sent: ${stats?.sent || 0}\n` +
        `📥 Received: ${stats?.received || 0}\n` +
        `❌ Failed: ${stats?.failed || 0}\n` +
        `⏳ Pending: ${stats?.pending || 0}`;
      this.bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });

    // /queue
    this.bot.onText(/\/queue/, async (msg) => {
      const smsQueue = require('./sms-queue');
      const depth = smsQueue.getQueueDepth();
      this.bot.sendMessage(msg.chat.id, `⏳ *Queue depth:* ${depth} pending messages`, { parse_mode: 'Markdown' });
    });
  }

  /**
   * Notify Telegram when an inbound SMS arrives.
   */
  notifyInbound(msg) {
    if (!this.enabled || !this.bot) return;

    const time = new Date(msg.created_at * 1000).toLocaleTimeString();
    const text =
      `📩 *New SMS Received!*\n\n` +
      `👤 *From:* \`${msg.phone}\`\n` +
      `📡 *Port:* ${msg.sim_port || 'N/A'}\n` +
      `🕐 *Time:* ${time}\n\n` +
      `💬 *Message:*\n${msg.body}`;

    this.bot.sendMessage(config.telegram.chatId, text, { parse_mode: 'Markdown' })
      .catch(err => console.error(`[Telegram] Notify failed: ${err.message}`));
  }

  /**
   * Send a custom alert (e.g., SIM banned, queue empty)
   */
  sendAlert(text) {
    if (!this.enabled || !this.bot) return;
    this.bot.sendMessage(config.telegram.chatId, `⚠️ *Gateway Alert:*\n${text}`, { parse_mode: 'Markdown' })
      .catch(() => {});
  }

  /**
   * Notify when a SIM is blocked due to failures
   */
  notifySimBlocked(port, errorType, errorMessage, maxFailures) {
    if (!this.enabled || !this.bot) return;
    
    const text =
      `🚨 *SIM BLOCKED - Physical Replacement Required*\n\n` +
      `📡 *Port:* \`${port}\`\n` +
      `❌ *Reason:* ${errorType}\n` +
      `🔢 *Failures:* ${maxFailures} consecutive\n` +
      `💬 *Last Error:* ${errorMessage}\n\n` +
      `⚠️ *Action:* Please replace this SIM card physically, then click "Reactivate" in the dashboard.`;
    
    this.bot.sendMessage(config.telegram.chatId, text, { parse_mode: 'Markdown' })
      .catch(err => console.error(`[Telegram] Notify blocked failed: ${err.message}`));
  }

  /**
   * Notify when SIM is approaching daily limit
   */
  notifySimApproachingLimit(port, threshold, dailyCount, maxPerDay) {
    if (!this.enabled || !this.bot) return;
    
    const emoji = threshold === 100 ? '🚫' : threshold === 90 ? '⚠️' : '⚡';
    const text =
      `${emoji} *SIM ${threshold}% Capacity Alert*\n\n` +
      `📡 *Port:* \`${port}\`\n` +
      `📊 *Usage:* ${dailyCount}/${maxPerDay} (${threshold}%)\n\n` +
      (threshold === 100 
        ? `🚫 *SIM EXHAUSTED* - Will reset at midnight` 
        : `⏳ SIM still active, approaching daily limit`);
    
    this.bot.sendMessage(config.telegram.chatId, text, { parse_mode: 'Markdown' })
      .catch(err => console.error(`[Telegram] Notify threshold failed: ${err.message}`));
  }

  /**
   * Notify when SIM is fully exhausted
   */
  notifySimExhausted(port, dailyCount, maxPerDay) {
    // This is handled by notifySimApproachingLimit with threshold=100
    // Keeping for backward compatibility
    this.notifySimApproachingLimit(port, 100, dailyCount, maxPerDay);
  }

  /**
   * Notify when SIM is reactivated after replacement
   */
  notifySimReactivated(port) {
    if (!this.enabled || !this.bot) return;
    
    const text =
      `✅ *SIM Reactivated*\n\n` +
      `📡 *Port:* \`${port}\`\n` +
      `🟢 SIM is back in rotation and ready to send messages.`;
    
    this.bot.sendMessage(config.telegram.chatId, text, { parse_mode: 'Markdown' })
      .catch(err => console.error(`[Telegram] Notify reactivated failed: ${err.message}`));
  }
}

module.exports = new TelegramNotifier();
