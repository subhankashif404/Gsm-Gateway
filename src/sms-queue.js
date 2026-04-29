/**
 * sms-queue.js
 * Processes the outbound SMS queue with SIM rotation and rate limiting.
 * Reads pending messages from SQLite and dispatches them via available modems.
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const db = require('./database');
const simRotation = require('./sim-rotation');
const simHealthMonitor = require('./sim-health-monitor');

class SmsQueue extends EventEmitter {
  constructor() {
    super();
    this.modemManager = null; // Set after init
    this.isProcessing = false;
    this.processTimer = null;
    this.isPaused = false;
  }

  setModemManager(mm) {
    this.modemManager = mm;
  }

  start() {
    console.log('[SmsQueue] Started - processing every 2 seconds');
    this.processTimer = setInterval(() => this._processNext(), 2000);
  }

  stop() {
    if (this.processTimer) clearInterval(this.processTimer);
  }

  pause()  { this.isPaused = true;  console.log('[SmsQueue] Paused');  }
  resume() { this.isPaused = false; console.log('[SmsQueue] Resumed'); }

  // ── Enqueue a single SMS ──────────────────────────────────────────────────

  async enqueue(phone, body, bulkJobId = null) {
    const id = uuidv4();
    db.insertMessage({
      id,
      direction: 'outbound',
      phone: phone.trim(),
      body: body.trim(),
      sim_port: null,
      sim_number: null,
      status: 'pending',
      created_at: Math.floor(Date.now() / 1000),
    });
    return id;
  }

  // ── Enqueue bulk SMS ──────────────────────────────────────────────────────

  async enqueueBulk(recipients, messageTemplate, jobName = 'Bulk Job') {
    const jobId = uuidv4();
    const total = recipients.length;

    // Insert bulk job record
    db.db.prepare(`
      INSERT INTO bulk_jobs (id, name, total, status) VALUES (?, ?, ?, 'pending')
    `).run(jobId, jobName, total);

    // Insert all messages
    const insertAll = db.db.transaction(() => {
      for (const rec of recipients) {
        const phone = typeof rec === 'string' ? rec : rec.phone;
        // Support per-recipient message templates: use {name} placeholder
        const body = typeof rec === 'object' && rec.name
          ? messageTemplate.replace('{name}', rec.name)
          : messageTemplate;

        db.insertMessage({
          id: uuidv4(),
          direction: 'outbound',
          phone: phone.trim(),
          body: body.trim(),
          sim_port: null,
          sim_number: null,
          status: 'pending',
          created_at: Math.floor(Date.now() / 1000),
        });
      }
    });

    insertAll();
    console.log(`[SmsQueue] Bulk job ${jobId} queued: ${total} messages`);
    return jobId;
  }

  // ── Process next pending message ──────────────────────────────────────────

  async _processNext() {
    if (this.isProcessing || this.isPaused || !this.modemManager) return;

    const pending = db.getPendingMessages();
    if (pending.length === 0) return;

    this.isProcessing = true;
    const msg = pending[0];

    try {
      // Pick a SIM
      const sim = simRotation.getNextReadySim(this.modemManager);

      if (!sim) {
        // No SIM available - don't mark as failed, just wait
        this.isProcessing = false;
        return;
      }

      // Mark as "processing" by temporarily setting a flag
      // (we set status to 'sending' if we add that, else just proceed)

      const modem = this.modemManager.getModem(sim.port);
      if (!modem || !modem.isReady) {
        this.isProcessing = false;
        return;
      }

      console.log(`[SmsQueue] Sending to ${msg.phone} via ${sim.port}`);

      await modem.sendSms(msg.phone, msg.body);

      // Success
      db.updateMessageStatus({
        id: msg.id,
        status: 'sent',
        error: null,
        sent_at: Math.floor(Date.now() / 1000),
      });

      // Update message with SIM info
      db.db.prepare(`
        UPDATE messages SET sim_port=?, sim_number=? WHERE id=?
      `).run(sim.port, sim.phone_number, msg.id);

      // Record successful send in health monitor
      simHealthMonitor.recordSuccess(sim.port);

      this.emit('message:sent', { ...msg, sim_port: sim.port });
      console.log(`[SmsQueue] ✓ Sent to ${msg.phone} via ${sim.port} (${sim.phone_number || 'N/A'})`);

      // Get updated SIM count for threshold check
      const updatedSim = db.db.prepare('SELECT daily_count FROM sim_cards WHERE port = ?').get(sim.port);
      const newDailyCount = updatedSim ? updatedSim.daily_count : 0;

      // Check alert thresholds
      await simHealthMonitor.checkAlertThresholds(sim.port, newDailyCount, simRotation.maxPerDay);

      // Delay between sends to avoid carrier detection
      await this._delay(config.sim.sendDelayMs);

    } catch (err) {
      console.error(`[SmsQueue] Failed to send ${msg.id}: ${err.message}`);
      
      // Record failure in health monitor
      await simHealthMonitor.recordFailure(sim ? sim.port : 'unknown', err.message);
      
      db.updateMessageStatus({
        id: msg.id,
        status: 'failed',
        error: err.message,
        sent_at: Math.floor(Date.now() / 1000),
      });
      this.emit('message:failed', msg);
    } finally {
      this.isProcessing = false;
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getQueueDepth() {
    return db.db.prepare(`SELECT COUNT(*) as c FROM messages WHERE status='pending' AND direction='outbound'`).get().c;
  }

  // ── Delete a message from queue ─────────────────────────────────────────────

  async deleteMessage(messageId) {
    const msg = db.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId);
    if (!msg) {
      throw new Error('Message not found');
    }
    if (msg.status !== 'pending') {
      throw new Error('Can only delete pending messages');
    }
    db.deleteMessage(messageId);
    console.log(`[SmsQueue] Deleted message ${messageId} from queue`);
    this.emit('queue:updated', { queueDepth: this.getQueueDepth() });
    return { ok: true, messageId };
  }
}

module.exports = new SmsQueue();
