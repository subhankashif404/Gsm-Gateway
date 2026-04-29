/**
 * modem-manager.js
 * Handles communication with GSM modems via AT commands over serial port.
 * Supports 8-port and 16-port modem pools (OSTENT, Wavecom, etc.)
 */

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const EventEmitter = require('events');
const config = require('../config');
const db = require('./database');

// ─── Single Modem Instance ────────────────────────────────────────────────────

class Modem extends EventEmitter {
  constructor(portPath) {
    super();
    this.portPath = portPath;
    this.port = null;
    this.parser = null;
    this.isReady = false;
    this.isBusy = false;
    this.commandQueue = [];
    this.currentCommand = null;
    this.responseBuffer = [];
    this.phoneNumber = null;
    this.imsi = null;
    this.signal = 0;
    this.status = 'offline';
    this._reconnectTimer = null;
    this._pollTimer = null;
  }

  // ── Connect to serial port ──────────────────────────────────────────────────
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.port = new SerialPort({
          path: this.portPath,
          baudRate: config.modem.baudRate,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          autoOpen: false,
        });

        this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

        this.port.open((err) => {
          if (err) {
            this.status = 'offline';
            db.updateSimStatus(this.portPath, 'offline');
            return reject(err);
          }
          console.log(`[Modem ${this.portPath}] Port opened`);
          this._setupListeners();
          // Give modem a moment to wake up, then initialize
          setTimeout(() => this._initialize().then(resolve).catch(reject), 1500);
        });

        this.port.on('error', (err) => {
          console.error(`[Modem ${this.portPath}] Error: ${err.message}`);
          this._scheduleReconnect();
        });

        this.port.on('close', () => {
          console.log(`[Modem ${this.portPath}] Port closed`);
          this.isReady = false;
          this.status = 'offline';
          db.updateSimStatus(this.portPath, 'offline');
          this._scheduleReconnect();
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  // ── Parse incoming data from modem ─────────────────────────────────────────
  _setupListeners() {
    this.parser.on('data', (line) => {
      line = line.trim();
      if (!line) return;

      // Unsolicited new SMS notification: +CMTI: "SM",3
      if (line.startsWith('+CMTI:')) {
        const match = line.match(/\+CMTI:\s*"[^"]+",(\d+)/);
        if (match) {
          const index = parseInt(match[1]);
          setTimeout(() => this._readSmsAtIndex(index), 500);
        }
        return;
      }

      // Unsolicited incoming SMS in text mode: +CMT: "+number","","date"
      if (line.startsWith('+CMT:')) {
        this._pendingCmt = line;
        return;
      }
      if (this._pendingCmt) {
        this._handleIncomingSms(this._pendingCmt, line);
        this._pendingCmt = null;
        return;
      }

      // Feed into current command response
      if (this.currentCommand) {
        this.responseBuffer.push(line);

        // Check for terminal responses
        if (line === 'OK' || line === 'ERROR' || line.startsWith('+CMS ERROR') || line.startsWith('+CME ERROR')) {
          const response = [...this.responseBuffer];
          this.responseBuffer = [];
          const cmd = this.currentCommand;
          this.currentCommand = null;
          this.isBusy = false;
          cmd.resolve({ ok: line === 'OK' || !line.includes('ERROR'), lines: response });
          this._processQueue();
        }

        // CMGS response for send confirmation
        if (line.startsWith('+CMGS:')) {
          const response = [...this.responseBuffer];
          this.responseBuffer = [];
          const cmd = this.currentCommand;
          this.currentCommand = null;
          this.isBusy = false;
          cmd.resolve({ ok: true, lines: response });
          this._processQueue();
        }
      }
    });
  }

  // ── Queue an AT command ─────────────────────────────────────────────────────
  sendCommand(cmd, timeout = config.modem.commandTimeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.currentCommand && this.currentCommand.resolve === resolve) {
          this.currentCommand = null;
          this.isBusy = false;
          this.responseBuffer = [];
          this._processQueue();
        }
        reject(new Error(`Command timeout: ${cmd}`));
      }, timeout);

      const wrappedResolve = (result) => {
        clearTimeout(timer);
        resolve(result);
      };

      this.commandQueue.push({ cmd, resolve: wrappedResolve, reject });
      if (!this.isBusy) this._processQueue();
    });
  }

  _processQueue() {
    if (this.isBusy || this.commandQueue.length === 0) return;
    this.currentCommand = this.commandQueue.shift();
    this.isBusy = true;
    this.responseBuffer = [];
    this.port.write(this.currentCommand.cmd + '\r');
  }

  // ── Initialize modem ────────────────────────────────────────────────────────
  async _initialize() {
    try {
      // Basic AT check
      await this.sendCommand('AT');
      // Disable echo
      await this.sendCommand('ATE0');
      // Set text mode for SMS
      await this.sendCommand('AT+CMGF=1');
      // Set new SMS notification to push directly
      await this.sendCommand('AT+CNMI=2,1,0,0,0');
      // Set char set
      await this.sendCommand('AT+CSCS="GSM"');

      // Get SIM info
      await this._refreshInfo();

      this.isReady = true;
      this.status = 'ready';
      db.updateSimStatus(this.portPath, 'ready');
      this.emit('ready', this.portPath);
      console.log(`[Modem ${this.portPath}] Ready | Number: ${this.phoneNumber || 'unknown'} | Signal: ${this.signal}`);

      // Start polling for SMS (as backup to push notifications)
      this._startPolling();
      return true;
    } catch (err) {
      console.error(`[Modem ${this.portPath}] Init failed: ${err.message}`);
      this.status = 'offline';
      throw err;
    }
  }

  async _refreshInfo() {
    try {
      // Get own number
      const cnumRes = await this.sendCommand('AT+CNUM');
      const cnumMatch = cnumRes.lines.join('').match(/\+CNUM:[^,]*,"([^"]+)"/);
      if (cnumMatch) this.phoneNumber = cnumMatch[1];

      // Get IMSI
      const imsiRes = await this.sendCommand('AT+CIMI');
      const imsiMatch = imsiRes.lines.find(l => /^\d{10,}$/.test(l));
      if (imsiMatch) this.imsi = imsiMatch;

      // Get signal
      const csqRes = await this.sendCommand('AT+CSQ');
      const csqMatch = csqRes.lines.join('').match(/\+CSQ:\s*(\d+)/);
      if (csqMatch) this.signal = parseInt(csqMatch[1]);

      // Update DB
      db.upsertSim({
        port: this.portPath,
        phone_number: this.phoneNumber,
        imsi: this.imsi,
        signal: this.signal,
        status: 'ready',
        last_seen: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      // Non-fatal
    }
  }

  // ── Send SMS ────────────────────────────────────────────────────────────────
  async sendSms(toNumber, message) {
    if (!this.isReady) throw new Error(`Modem ${this.portPath} not ready`);

    this.status = 'busy';
    db.updateSimStatus(this.portPath, 'busy');

    try {
      // Set recipient
      await this.sendCommand(`AT+CMGS="${toNumber}"`, 5000);

      // Send message body + Ctrl+Z (0x1A)
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SMS send timeout')), 30000);
        this.commandQueue.push({
          cmd: message + '\x1A',
          resolve: (res) => { clearTimeout(timer); resolve(res); },
          reject,
        });
        if (!this.isBusy) this._processQueue();
      });

      this.status = 'ready';
      db.updateSimStatus(this.portPath, 'ready');
      db.incrementSimCount(this.portPath);
      return { success: true };
    } catch (err) {
      this.status = 'ready';
      db.updateSimStatus(this.portPath, 'ready');
      throw err;
    }
  }

  // ── Read SMS at index ───────────────────────────────────────────────────────
  async _readSmsAtIndex(index) {
    try {
      const res = await this.sendCommand(`AT+CMGR=${index}`);
      const headerLine = res.lines.find(l => l.startsWith('+CMGR:'));
      const bodyLine = res.lines.find((l, i) => i > 0 && !l.startsWith('+CMGR:') && l !== 'OK');

      if (headerLine && bodyLine) {
        // Parse: +CMGR: "REC UNREAD","+923001234567",,"26/04/20,12:30:00+20"
        const phoneMatch = headerLine.match(/"([+\d]+)"/g);
        const fromNumber = phoneMatch && phoneMatch[1] ? phoneMatch[1].replace(/"/g, '') : 'Unknown';
        this._handleIncomingSms(null, bodyLine, fromNumber);
        // Delete from modem memory
        await this.sendCommand(`AT+CMGD=${index}`).catch(() => {});
      }
    } catch (err) {
      console.error(`[Modem ${this.portPath}] Read SMS error: ${err.message}`);
    }
  }

  _handleIncomingSms(headerLine, body, fromNumber = null) {
    if (!fromNumber && headerLine) {
      const match = headerLine.match(/"([+\d]+)"/g);
      fromNumber = match && match[1] ? match[1].replace(/"/g, '') : 'Unknown';
    }

    const msgData = {
      id: require('uuid').v4(),
      direction: 'inbound',
      phone: fromNumber,
      body: body,
      sim_port: this.portPath,
      sim_number: this.phoneNumber,
      status: 'received',
      created_at: Math.floor(Date.now() / 1000),
    };

    db.insertMessage(msgData);
    console.log(`[Modem ${this.portPath}] Inbound SMS from ${fromNumber}: ${body}`);
    this.emit('sms:received', msgData);
  }

  // ── Poll for SMS ────────────────────────────────────────────────────────────
  _startPolling() {
    this._pollTimer = setInterval(async () => {
      if (!this.isReady || this.isBusy) return;
      try {
        await this._refreshInfo();
        await this._pollUnreadSms();
      } catch (err) {
        // Non-fatal polling error
      }
    }, config.modem.pollInterval);
  }

  async _pollUnreadSms() {
    const res = await this.sendCommand('AT+CMGL="REC UNREAD"');
    const lines = res.lines.filter(l => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('+CMGL:')) {
        const idxMatch = lines[i].match(/\+CMGL:\s*(\d+)/);
        if (idxMatch) {
          await this._readSmsAtIndex(parseInt(idxMatch[1]));
        }
      }
    }
  }

  // ── Reconnect logic ─────────────────────────────────────────────────────────
  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    console.log(`[Modem ${this.portPath}] Scheduling reconnect in 15s...`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        console.error(`[Modem ${this.portPath}] Reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, 15000);
  }

  disconnect() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.port && this.port.isOpen) this.port.close();
  }

  getInfo() {
    return {
      port: this.portPath,
      phoneNumber: this.phoneNumber,
      imsi: this.imsi,
      signal: this.signal,
      status: this.status,
      isReady: this.isReady,
    };
  }
}

// ─── Modem Pool Manager ───────────────────────────────────────────────────────

class ModemManager extends EventEmitter {
  constructor() {
    super();
    this.modems = new Map(); // port -> Modem
  }

  async initialize() {
    // Auto-detect modem ports if not explicitly configured
    let portsToInitialize = config.modem.ports;
    
    if (config.modem.autoDetect || portsToInitialize.length === 0 || (portsToInitialize.length === 1 && portsToInitialize[0] === '')) {
      console.log('[ModemManager] Auto-detecting modem ports...');
      portsToInitialize = await this._detectModemPorts();
      
      if (portsToInitialize.length === 0) {
        console.warn('[ModemManager] No modem ports detected! Please connect modems and restart.');
        return;
      }
      
      console.log(`[ModemManager] Detected ${portsToInitialize.length} modem port(s): ${portsToInitialize.join(', ')}`);
    } else {
      console.log(`[ModemManager] Initializing ${portsToInitialize.length} configured port(s)...`);
    }
    
    for (const portPath of portsToInitialize) {
      const modem = new Modem(portPath);
      this.modems.set(portPath, modem);

      modem.on('ready', (port) => {
        console.log(`[ModemManager] Modem ready on ${port}`);
        this.emit('modem:ready', port);
      });

      modem.on('sms:received', (msg) => {
        this.emit('sms:received', msg);
      });

      try {
        await modem.connect();
      } catch (err) {
        console.error(`[ModemManager] Could not connect to ${portPath}: ${err.message}`);
        // Continue with other ports
      }
    }
    console.log(`[ModemManager] Initialization complete - ${this.modems.size} modem(s) loaded`);
  }

  getModem(port) {
    return this.modems.get(port);
  }

  getAllModems() {
    return Array.from(this.modems.values());
  }

  getReadyModems() {
    return Array.from(this.modems.values()).filter(m => m.isReady);
  }

  async sendSms(port, toNumber, message) {
    const modem = this.modems.get(port);
    if (!modem) throw new Error(`No modem on port ${port}`);
    return modem.sendSms(toNumber, message);
  }

  getStatus() {
    const status = {};
    for (const [port, modem] of this.modems) {
      status[port] = modem.getInfo();
    }
    return status;
  }

  // List available serial ports on the system
  static async listPorts() {
    const ports = await SerialPort.list();
    return ports.filter(p => p.path);
  }

  // Auto-detect modem ports by testing AT commands
  async _detectModemPorts() {
    try {
      const allPorts = await SerialPort.list();
      console.log(`[ModemManager] Found ${allPorts.length} serial port(s): ${allPorts.map(p => p.path).join(', ')}`);
      
      const modemPorts = [];
      
      // Test each port with AT command
      for (const portInfo of allPorts) {
        const portPath = portInfo.path;
        
        // Skip common non-modem ports (adjust for your system)
        if (this._shouldSkipPort(portPath)) {
          continue;
        }
        
        try {
          console.log(`[ModemManager] Testing ${portPath}...`);
          
          // Try to open port and send AT command
          const testPort = new SerialPort({
            path: portPath,
            baudRate: config.modem.baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            autoOpen: false,
          });
          
          const isModem = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              testPort.close(() => {});
              resolve(false);
            }, 2000); // 2 second timeout
            
            testPort.open(async (err) => {
              if (err) {
                clearTimeout(timeout);
                resolve(false);
                return;
              }
              
              // Send AT command
              testPort.write('AT\r', (writeErr) => {
                if (writeErr) {
                  clearTimeout(timeout);
                  testPort.close(() => {});
                  resolve(false);
                  return;
                }
              });
              
              // Listen for response
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
            console.log(`[ModemManager] ✓ ${portPath} - Modem detected!`);
            modemPorts.push(portPath);
          }
        } catch (err) {
          // Port not accessible or not a modem
        }
      }
      
      return modemPorts;
    } catch (err) {
      console.error('[ModemManager] Error detecting modem ports:', err.message);
      return [];
    }
  }
  
  // Check if port should be skipped (system ports, etc.)
  _shouldSkipPort(portPath) {
    const skipPatterns = [
      // Windows system ports
      'COM1', // Serial port (usually not modem)
      'COM2', // Serial port (usually not modem)
      
      // Add more patterns if needed
      // Example: 'Bluetooth', 'Virtual', etc.
    ];
    
    const upperPath = portPath.toUpperCase();
    return skipPatterns.some(pattern => upperPath.includes(pattern.toUpperCase()));
  }

  shutdown() {
    for (const modem of this.modems.values()) {
      modem.disconnect();
    }
  }
}

module.exports = new ModemManager();
