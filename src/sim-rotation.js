/**
 * sim-rotation.js
 * Manages which SIM card to use next for outbound SMS.
 * Ensures no single SIM exceeds the daily limit to avoid carrier bans.
 */

const config = require('../config');
const db = require('./database');

class SimRotation {
  constructor() {
    this.lastUsedIndex = -1;
    this.rotationStrategy = config.sim.rotationStrategy;
    this.maxPerDay = config.sim.maxSmsPerDay;
  }

  /**
   * Get the next available SIM port for sending.
   * Returns null if no SIM is available.
   */
  getNextSim() {
    // Reset daily counts if needed
    db.resetDailyCounts();

    // Get all active SIMs under the daily limit
    const available = db.getActiveSims(this.maxPerDay);

    if (available.length === 0) {
      console.warn('[SimRotation] No SIMs available (all hit daily limit or offline)');
      return null;
    }

    if (this.rotationStrategy === 'least-used') {
      // Pick the SIM with lowest daily count (already sorted by daily_count ASC)
      return available[0];
    }

    // Round-robin: cycle through available SIMs
    this.lastUsedIndex = (this.lastUsedIndex + 1) % available.length;
    return available[this.lastUsedIndex];
  }

  /**
   * Pick best SIM for a specific outbound message.
   * Also filters by modem ready status.
   */
  getNextReadySim(modemManager) {
    db.resetDailyCounts();
    const available = db.getActiveSims(this.maxPerDay);
    const readyPorts = new Set(modemManager.getReadyModems().map(m => m.portPath));

    // Intersect available SIMs with ready modems
    const candidates = available.filter(sim => readyPorts.has(sim.port));

    if (candidates.length === 0) return null;

    if (this.rotationStrategy === 'least-used') {
      return candidates[0]; // already sorted by daily_count
    }

    // Round-robin
    this.lastUsedIndex = (this.lastUsedIndex + 1) % candidates.length;
    return candidates[this.lastUsedIndex];
  }

  /**
   * Get rotation status - useful for dashboard
   */
  getStatus() {
    const sims = db.getSimCards();
    return sims.map(sim => ({
      port: sim.port,
      phoneNumber: sim.phone_number || 'Unknown',
      dailyCount: sim.daily_count,
      maxPerDay: this.maxPerDay,
      percentUsed: Math.round((sim.daily_count / this.maxPerDay) * 100),
      isAvailable: sim.is_active && sim.status === 'ready' && sim.daily_count < this.maxPerDay && !sim.blocked_at,
      isBlocked: sim.blocked_at !== null,
      blockedReason: sim.blocked_reason,
      blockedAt: sim.blocked_at,
      failureCount: sim.failure_count,
      status: sim.status,
      signal: sim.signal,
      lastReset: sim.last_reset,
    }));
  }
}

module.exports = new SimRotation();
