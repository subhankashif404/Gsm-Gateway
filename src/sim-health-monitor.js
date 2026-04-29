/**
 * sim-health-monitor.js
 * Monitors SIM health in real-time, tracks failures, and auto-blocks problematic SIMs.
 * Sends Telegram alerts for critical events.
 */

const config = require('../config');
const db = require('./database');

class SimHealthMonitor {
  constructor() {
    this.maxConsecutiveFailures = config.sim.maxConsecutiveFailures || 5;
    this.alertThresholds = config.sim.alertThresholds || [80, 90, 100];
    this.autoBlockEnabled = config.sim.autoBlockEnabled !== false;
    this.telegram = null; // Set after init
  }

  setTelegramNotifier(telegram) {
    this.telegram = telegram;
  }

  /**
   * Record a successful send - resets failure count
   */
  recordSuccess(port) {
    try {
      db.resetSimFailureCount(port);
      console.log(`[SimHealth] ✓ ${port} - Success, failure count reset`);
    } catch (err) {
      console.error(`[SimHealth] Error recording success for ${port}:`, err.message);
    }
  }

  /**
   * Record a failed send - increments failure count and auto-blocks if threshold reached
   */
  async recordFailure(port, errorMessage) {
    try {
      const errorType = this.classifyError(errorMessage);
      
      // Increment failure count
      db.incrementSimFailureCount(port);
      
      // Get current failure count
      const sim = db.db.prepare('SELECT failure_count, blocked_at FROM sim_cards WHERE port = ?').get(port);
      
      if (!sim) return;
      
      console.log(`[SimHealth] ⚠ ${port} - Failure #${sim.failure_count}: ${errorType} (${errorMessage})`);
      
      // Auto-block if threshold reached
      if (this.autoBlockEnabled && sim.failure_count >= this.maxConsecutiveFailures && !sim.blocked_at) {
        await this.blockSim(port, errorType, errorMessage);
      }
    } catch (err) {
      console.error(`[SimHealth] Error recording failure for ${port}:`, err.message);
    }
  }

  /**
   * Block a SIM and send Telegram alert
   */
  async blockSim(port, errorType, errorMessage) {
    const reason = `consecutive_failures (${errorType})`;
    
    db.blockSim(port, reason);
    console.log(`[SimHealth] 🚫 ${port} BLOCKED - Reason: ${reason}`);
    
    // Send Telegram alert
    if (this.telegram) {
      this.telegram.notifySimBlocked(port, errorType, errorMessage, this.maxConsecutiveFailures);
    }
  }

  /**
   * Check alert thresholds and send notifications
   */
  async checkAlertThresholds(port, dailyCount, maxPerDay) {
    try {
      const percentUsed = Math.round((dailyCount / maxPerDay) * 100);
      const sim = db.db.prepare('SELECT alert_sent_80, alert_sent_90 FROM sim_cards WHERE port = ?').get(port);
      
      if (!sim) return;
      
      // 80% threshold
      if (percentUsed >= 80 && !sim.alert_sent_80) {
        if (this.telegram) {
          this.telegram.notifySimApproachingLimit(port, 80, dailyCount, maxPerDay);
        }
        db.markAlertSent(port, 1, sim.alert_sent_90);
        console.log(`[SimHealth] ⚠ ${port} - 80% alert sent (${dailyCount}/${maxPerDay})`);
      }
      
      // 90% threshold
      if (percentUsed >= 90 && !sim.alert_sent_90) {
        if (this.telegram) {
          this.telegram.notifySimApproachingLimit(port, 90, dailyCount, maxPerDay);
        }
        db.markAlertSent(port, 1, 1);
        console.log(`[SimHealth] ⚠ ${port} - 90% alert sent (${dailyCount}/${maxPerDay})`);
      }
      
      // 100% - exhausted
      if (percentUsed >= 100) {
        if (this.telegram) {
          this.telegram.notifySimExhausted(port, dailyCount, maxPerDay);
        }
        console.log(`[SimHealth] 🚫 ${port} - EXHAUSTED (${dailyCount}/${maxPerDay})`);
      }
    } catch (err) {
      console.error(`[SimHealth] Error checking thresholds for ${port}:`, err.message);
    }
  }

  /**
   * Classify error type from error message
   */
  classifyError(errorMessage) {
    if (!errorMessage) return 'unknown';
    
    const msg = errorMessage.toUpperCase();
    
    // Network service errors
    if (msg.includes('CME ERROR') && msg.includes('30')) {
      return 'no_network_service';
    }
    
    // SIM blocked or carrier rejection
    if (msg.includes('CMS ERROR') && (msg.includes('305') || msg.includes('500'))) {
      return 'sim_blocked_by_carrier';
    }
    
    // SMS center errors
    if (msg.includes('CMS ERROR') && (msg.includes('300') || msg.includes('301'))) {
      return 'smsc_error';
    }
    
    // Memory full
    if (msg.includes('CMS ERROR') && msg.includes('322')) {
      return 'memory_full';
    }
    
    // Timeout
    if (msg.includes('TIMEOUT')) {
      return 'timeout';
    }
    
    // Not ready
    if (msg.includes('NOT READY')) {
      return 'modem_not_ready';
    }
    
    return 'send_failure';
  }

  /**
   * Unblock a SIM (called after physical replacement)
   */
  unblockSim(port) {
    try {
      db.unblockSim(port);
      console.log(`[SimHealth] ✅ ${port} - SIM unblocked and reactivated`);
      
      if (this.telegram) {
        this.telegram.notifySimReactivated(port);
      }
      
      return { success: true };
    } catch (err) {
      console.error(`[SimHealth] Error unblocking ${port}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Get health status for all SIMs
   */
  getHealthStatus() {
    try {
      const sims = db.getSimCards();
      return sims.map(sim => ({
        port: sim.port,
        phoneNumber: sim.phone_number,
        failureCount: sim.failure_count,
        lastFailureAt: sim.last_failure_at,
        isBlocked: sim.blocked_at !== null,
        blockedAt: sim.blocked_at,
        blockedReason: sim.blocked_reason,
        status: sim.status,
        dailyCount: sim.daily_count,
        signal: sim.signal,
      }));
    } catch (err) {
      console.error('[SimHealth] Error getting health status:', err.message);
      return [];
    }
  }

  /**
   * Reset failure count when modem reconnects
   */
  onModemReconnect(port) {
    try {
      db.resetSimFailureCount(port);
      console.log(`[SimHealth] 🔄 ${port} - Modem reconnected, failure count reset`);
    } catch (err) {
      console.error(`[SimHealth] Error on modem reconnect for ${port}:`, err.message);
    }
  }
}

module.exports = new SimHealthMonitor();
