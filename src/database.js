const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');

// Ensure data directory exists
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`[Database] Created data directory: ${dbDir}`);
  } catch (err) {
    console.error(`[Database] Warning: Could not create data directory: ${err.message}`);
    console.error('[Database] Database operations may fail in serverless environments');
  }
}

const db = new Database(config.db.path);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema Migration (add new columns if they don't exist) ──────────────────

const columnsToAdd = [
  { name: 'failure_count', sql: 'ALTER TABLE sim_cards ADD COLUMN failure_count INTEGER DEFAULT 0' },
  { name: 'last_failure_at', sql: 'ALTER TABLE sim_cards ADD COLUMN last_failure_at INTEGER' },
  { name: 'blocked_at', sql: 'ALTER TABLE sim_cards ADD COLUMN blocked_at INTEGER' },
  { name: 'blocked_reason', sql: 'ALTER TABLE sim_cards ADD COLUMN blocked_reason TEXT' },
  { name: 'alert_sent_80', sql: 'ALTER TABLE sim_cards ADD COLUMN alert_sent_80 INTEGER DEFAULT 0' },
  { name: 'alert_sent_90', sql: 'ALTER TABLE sim_cards ADD COLUMN alert_sent_90 INTEGER DEFAULT 0' },
];

for (const col of columnsToAdd) {
  try {
    db.exec(col.sql);
  } catch (err) {
    // Column already exists, ignore error
  }
}

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    direction   TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    phone       TEXT NOT NULL,
    body        TEXT NOT NULL,
    sim_port    TEXT,
    sim_number  TEXT,
    status      TEXT DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','received')),
    error       TEXT,
    created_at  INTEGER DEFAULT (strftime('%s','now')),
    sent_at     INTEGER,
    received_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sim_cards (
    port         TEXT PRIMARY KEY,
    phone_number TEXT,
    imsi         TEXT,
    signal       INTEGER DEFAULT 0,
    daily_count  INTEGER DEFAULT 0,
    total_count  INTEGER DEFAULT 0,
    last_reset   TEXT DEFAULT (date('now')),
    is_active    INTEGER DEFAULT 1,
    last_seen    INTEGER,
    status       TEXT DEFAULT 'unknown' CHECK(status IN ('ready','busy','offline','unknown','banned')),
    failure_count INTEGER DEFAULT 0,
    last_failure_at INTEGER,
    blocked_at   INTEGER,
    blocked_reason TEXT,
    alert_sent_80 INTEGER DEFAULT 0,
    alert_sent_90 INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS bulk_jobs (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    total       INTEGER DEFAULT 0,
    sent        INTEGER DEFAULT 0,
    failed      INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','paused')),
    created_at  INTEGER DEFAULT (strftime('%s','now')),
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_direction   ON messages(direction);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at  ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_phone       ON messages(phone);
  CREATE INDEX IF NOT EXISTS idx_messages_status      ON messages(status);
`);

// ─── Message Operations ───────────────────────────────────────────────────────

const insertMessage = db.prepare(`
  INSERT INTO messages (id, direction, phone, body, sim_port, sim_number, status, created_at)
  VALUES (@id, @direction, @phone, @body, @sim_port, @sim_number, @status, @created_at)
`);

const updateMessageStatus = db.prepare(`
  UPDATE messages SET status=@status, error=@error, sent_at=@sent_at WHERE id=@id
`);

const getMessages = db.prepare(`
  SELECT * FROM messages
  WHERE direction=@direction
  ORDER BY created_at DESC
  LIMIT @limit OFFSET @offset
`);

const countMessages = db.prepare(`
  SELECT COUNT(*) as count FROM messages WHERE direction=@direction
`);

const searchMessages = db.prepare(`
  SELECT * FROM messages
  WHERE direction=@direction AND (phone LIKE @q OR body LIKE @q)
  ORDER BY created_at DESC LIMIT 100
`);

const getPendingMessages = db.prepare(`
  SELECT * FROM messages WHERE status='pending' AND direction='outbound'
  ORDER BY created_at ASC LIMIT 10
`);

const deleteMessage = db.prepare(`
  DELETE FROM messages WHERE id = ?
`);

// ─── SIM Card Operations ──────────────────────────────────────────────────────

const upsertSim = db.prepare(`
  INSERT INTO sim_cards (port, phone_number, imsi, signal, status, last_seen)
  VALUES (@port, @phone_number, @imsi, @signal, @status, @last_seen)
  ON CONFLICT(port) DO UPDATE SET
    phone_number = COALESCE(@phone_number, phone_number),
    imsi         = COALESCE(@imsi, imsi),
    signal       = @signal,
    status       = @status,
    last_seen    = @last_seen
`);

const getSimCards = db.prepare(`SELECT * FROM sim_cards ORDER BY port`);

const getActiveSims = db.prepare(`
  SELECT * FROM sim_cards
  WHERE is_active=1 AND status='ready' AND daily_count < @max_daily AND blocked_at IS NULL
  ORDER BY daily_count ASC, failure_count ASC
`);

const incrementSimCount = db.prepare(`
  UPDATE sim_cards SET daily_count=daily_count+1, total_count=total_count+1 WHERE port=@port
`);

const resetDailyCounts = db.prepare(`
  UPDATE sim_cards SET daily_count=0, last_reset=date('now')
  WHERE last_reset < date('now')
`);

const updateSimStatus = db.prepare(`
  UPDATE sim_cards SET status=@status WHERE port=@port
`);

const incrementSimFailureCount = db.prepare(`
  UPDATE sim_cards SET failure_count=failure_count+1, last_failure_at=strftime('%s','now') WHERE port=@port
`);

const resetSimFailureCount = db.prepare(`
  UPDATE sim_cards SET failure_count=0 WHERE port=@port
`);

const blockSim = db.prepare(`
  UPDATE sim_cards SET blocked_at=strftime('%s','now'), blocked_reason=@reason, status='banned' WHERE port=@port
`);

const unblockSim = db.prepare(`
  UPDATE sim_cards SET blocked_at=NULL, blocked_reason=NULL, failure_count=0, status='ready' WHERE port=@port
`);

const getBlockedSims = db.prepare(`
  SELECT * FROM sim_cards WHERE blocked_at IS NOT NULL ORDER BY blocked_at DESC
`);

const markAlertSent = db.prepare(`
  UPDATE sim_cards SET alert_sent_80=@alert80, alert_sent_90=@alert90 WHERE port=@port
`);

const resetAlertFlags = db.prepare(`
  UPDATE sim_cards SET alert_sent_80=0, alert_sent_90=0 WHERE last_reset < date('now')
`);

// ─── Stats ────────────────────────────────────────────────────────────────────

const getDailyStats = db.prepare(`
  SELECT
    date(created_at,'unixepoch') as day,
    SUM(CASE WHEN direction='outbound' AND status='sent' THEN 1 ELSE 0 END) as sent,
    SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) as received
  FROM messages
  WHERE created_at > strftime('%s','now','-7 days')
  GROUP BY day ORDER BY day DESC
`);

const getTodayStats = db.prepare(`
  SELECT
    SUM(CASE WHEN direction='outbound' AND status='sent' THEN 1 ELSE 0 END) as sent,
    SUM(CASE WHEN direction='outbound' AND status='failed' THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) as received,
    SUM(CASE WHEN direction='outbound' AND status='pending' THEN 1 ELSE 0 END) as pending
  FROM messages
  WHERE created_at > strftime('%s','now','start of day')
`);

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Messages
  insertMessage: (msg) => insertMessage.run(msg),
  updateMessageStatus: (data) => updateMessageStatus.run(data),
  getMessages: (direction, limit = 50, offset = 0) =>
    getMessages.all({ direction, limit, offset }),
  countMessages: (direction) => countMessages.get({ direction }).count,
  searchMessages: (direction, q) =>
    searchMessages.all({ direction, q: `%${q}%` }),
  getPendingMessages: () => getPendingMessages.all(),
  deleteMessage: (id) => deleteMessage.run(id),

  // SIM Cards
  upsertSim: (data) => upsertSim.run(data),
  getSimCards: () => getSimCards.all(),
  getActiveSims: (maxDaily) => getActiveSims.all({ max_daily: maxDaily }),
  incrementSimCount: (port) => incrementSimCount.run({ port }),
  resetDailyCounts: () => resetDailyCounts.run(),
  updateSimStatus: (port, status) => updateSimStatus.run({ port, status }),
  incrementSimFailureCount: (port) => incrementSimFailureCount.run({ port }),
  resetSimFailureCount: (port) => resetSimFailureCount.run({ port }),
  blockSim: (port, reason) => blockSim.run({ port, reason }),
  unblockSim: (port) => unblockSim.run({ port }),
  getBlockedSims: () => getBlockedSims.all(),
  markAlertSent: (port, alert80, alert90) => markAlertSent.run({ port, alert80, alert90 }),
  resetAlertFlags: () => resetAlertFlags.run(),

  // Stats
  getDailyStats: () => getDailyStats.all(),
  getTodayStats: () => getTodayStats.get(),

  // Raw db for transactions
  db,
};
