# 🚀 GSM Gateway

GSM Gateway is an advanced SMS routing and management system designed to handle high-volume SMS dispatch through multiple GSM modems. It features intelligent SIM rotation, health monitoring, automatic blocking, and real-time Telegram notifications — helping businesses and developers manage large-scale SMS operations with ease.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsubhankashif404%2FGsm-Gateway)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🌟 Features

### 📡 Multi-Modem Management

🔌 **Auto-Detection**: Automatically discovers connected GSM modems on your system  
📊 **Real-Time Status**: Monitor signal strength, SIM info, and connection state  
🔄 **Auto-Reconnect**: Modems automatically reconnect on connection loss  
📱 **Multi-Port Support**: Manage 8, 16, or more modems simultaneously  
🔍 **Port Scanning**: List and test available serial ports with one click  

### 🔄 Intelligent SIM Rotation

⚖️ **Load Balancing**: Distributes SMS across SIM cards to maximize throughput  
📈 **High Capacity**: 16 SIMs × 625 SMS = 10,000 SMS/day total capacity  
🎯 **Rotation Strategies**: Round-robin or least-used SIM selection  
⚡ **Daily Limits**: Configurable per-SIM daily SMS limits to avoid carrier detection  
🌙 **Auto-Reset**: Daily counts automatically reset at midnight  

### 💚 SIM Health Monitoring

📊 **Real-Time Tracking**: Monitor SIM performance and failure rates  
🚫 **Auto-Blocking**: Automatically blocks SIMs after consecutive failures  
🔔 **Threshold Alerts**: Notifications at 80%, 90%, and 100% capacity  
📉 **Failure Analysis**: Classifies errors (network, SMS center, timeout, etc.)  
✅ **Quick Reactivation**: One-click SIM reactivation after physical replacement  

### 📊 Real-Time Dashboard

🎨 **Modern UI**: Beautiful dark theme with live statistics  
📈 **Live Updates**: WebSocket-powered real-time data streaming  
📱 **Responsive Design**: Works on desktop, tablet, and mobile  
🔍 **Search & Filter**: Quickly find messages by number or content  
📋 **Pagination**: Efficient handling of large message databases  

### 📤 SMS Management

✉️ **Single SMS**: Send individual messages with instant queuing  
📦 **Bulk SMS**: Upload CSV or paste numbers for mass messaging  
👤 **Personalization**: Use {name} placeholders for custom messages  
⏸️ **Queue Control**: Pause, resume, and manage SMS queue  
🗑️ **Message Management**: Delete pending messages from queue  
📊 **Job Tracking**: Monitor bulk SMS job progress and status  

### 📥 Inbox & Outbox

📬 **Inbound SMS**: Receive and store incoming messages  
📤 **Outbound Tracking**: Complete history of sent messages  
🔍 **Smart Search**: Search by phone number or message content  
📊 **Status Tracking**: Monitor sent, failed, and pending messages  
⏰ **Timestamps**: Complete audit trail with date/time stamps  

### 🔔 Telegram Notifications

📩 **Inbound Alerts**: Instant notification when SMS received  
🚨 **SIM Blocked**: Alerts when SIM auto-blocked due to failures  
⚠️ **Capacity Warnings**: Notifications as SIMs approach daily limits  
📊 **Status Commands**: Check stats, inbox, and queue via Telegram  
🔄 **Daily Reports**: Midnight reset confirmation notifications  

### 🛡️ Security & Performance

🔐 **Password Protection**: Secure dashboard access  
⏱️ **Rate Limiting**: Built-in API protection (100 req/15min)  
💾 **Persistent Storage**: SQLite database for reliable message tracking  
🔒 **CORS Support**: Secure cross-origin resource sharing  
📝 **Request Logging**: Morgan HTTP request logging  

### ⚙️ Advanced Features

🔌 **Hot Swapping**: Add/remove modems without restarting  
📡 **Signal Monitoring**: Track GSM signal strength (0-31)  
🆔 **IMSI Tracking**: SIM identification and management  
📞 **Number Detection**: Auto-detect SIM phone numbers  
🔄 **Graceful Shutdown**: Clean modem disconnection on exit  
💬 **AT Commands**: Full GSM modem AT command support  

### 🔒 Privacy & Performance

🔐 **Local Processing**: All data stays on your server  
⚡ **Fast Processing**: SMS queue processes every 2 seconds  
🌐 **Cloud Ready**: Deploy on Vercel (dashboard), VPS, or dedicated server  
📦 **No External Dependencies**: Works offline after setup  
🆓 **Open Source**: MIT license, free to use and modify

## 🛠️ Technology Stack

### Backend

**Runtime**: Node.js 18+  
**Framework**: Express.js 4.x  
**Database**: SQLite (better-sqlite3)  
**Modem Communication**: SerialPort API v13.x  
**WebSocket**: ws v8.x for real-time updates  
**Task Scheduling**: node-cron v3.x  
**Notifications**: node-telegram-bot-api v0.65.x  
**Environment**: dotenv v16.x  
**Logging**: Morgan HTTP logger  
**Security**: express-rate-limit v7.x, CORS  
**Utilities**: uuid v9.x, moment v2.x  

### Frontend

**Core**: Pure HTML5, CSS3, JavaScript (ES6+)  
**Icons**: Inline SVG icons  
**Fonts**: Space Grotesk, JetBrains Mono (Google Fonts)  
**UI Design**: Custom dark theme with modern glassmorphism  
**Real-Time**: WebSocket API for live data  
**State Management**: Vanilla JavaScript with async/await  
**Styling**: CSS3 with custom properties, animations, transitions  

### Database

**Engine**: SQLite 3.x (better-sqlite3)  
**Mode**: WAL (Write-Ahead Logging) for performance  
**Schema**: Messages, SIM cards, bulk jobs, settings  
**Indexes**: Optimized queries for messages and SIMs  
**Migrations**: Auto-schema migration on startup  

### Deployment

**Server**: Node.js HTTP server  
**Cloud**: Vercel (dashboard demo), AWS, DigitalOcean  
**Production**: PM2 process manager, systemd  
**Hosting**: Any Node.js-compatible platform  
**Drivers**: FTDI/CH340 for USB GSM modems  

## 🚀 Getting Started

### Prerequisites

- **Node.js 18+** installed
- **Windows 10/11** or **Ubuntu 20.04+**
- **FTDI or CH340 Drivers** for USB GSM modems
- One or more GSM modems with active SIM cards
- **Modern Web Browser** (Chrome, Edge, Firefox, Safari)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/subhankashif404/Gsm-Gateway.git
   cd Gsm-Gateway
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   # Copy the example file
   cp .env.example .env  # Linux/Mac
   copy .env.example .env  # Windows
   
   # Edit with your settings
   nano .env  # Linux/Mac
   notepad .env  # Windows
   ```

4. **Configure modem ports (optional):**
   ```env
   # Auto-detect (recommended)
   MODEM_AUTO_DETECT=true
   MODEM_PORTS=
   
   # OR manual configuration
   MODEM_PORTS=COM3,COM4,COM5  # Windows
   MODEM_PORTS=/dev/ttyUSB0,/dev/ttyUSB1  # Linux
   ```

5. **Run the application:**
   ```bash
   # Production mode
   npm start
   
   # Development mode with auto-reload
   npm run dev
   ```

6. **Access dashboard:**
   - Open **http://localhost:3000** in your browser
   - Login with password: `admin123` (or your custom password)

---

## 📤 Push to GitHub

The project is already optimized for GitHub! Here's how to upload it:

### Windows (PowerShell)

```powershell
# Run the cleanup script to remove node_modules and large files
.\cleanup-github.bat

# Initialize git and push
git init
git add .
git commit -m "Initial commit - GSM Gateway"
git branch -M main
git remote add origin https://github.com/subhankashif404/Gsm-Gateway.git
git push -u origin main
```

### Linux/Mac

```bash
# Run the cleanup script
chmod +x setup-github.sh
./setup-github.sh

# Commit and push
git commit -m "Initial commit - GSM Gateway"
git branch -M main
git remote add origin https://github.com/subhankashif404/Gsm-Gateway.git
git push -u origin main
```

### ⚠️ Important: What NOT to Commit

The `.gitignore` file already excludes:
- ❌ `node_modules/` - 100MB+ (run `npm install` after cloning)
- ❌ `.env` - Contains passwords
- ❌ `data/*.db` - Database files
- ❌ `*.log` - Log files
- ✅ **DO commit:** `package.json`, `package-lock.json` (dependencies list)

### After Cloning from GitHub

```bash
# Clone your repository
git clone https://github.com/subhankashif404/Gsm-Gateway.git
cd Gsm-Gateway

# Install dependencies
npm install

# Run setup
npm run setup

# Start the app
npm start
```

---

## 🌐 Quick Deploy to Vercel

Want to try the dashboard without setting up locally?

**Option 1: One-Click Deploy**

Click the button at the top of this README and follow the prompts.

**Option 2: Deploy via CLI**
```bash
npm install -g vercel
vercel login
vercel --prod
```

⚠️ **Note:** Vercel deployment is for dashboard/API demo only. Physical GSM modems require a local server with USB access.

📖 **Full Deployment Guide:** See [DEPLOYMENT.md](DEPLOYMENT.md)

## 📖 Configuration

### Environment Variables (.env)

| Variable | Description | Default |
|----------|-------------|---------|  
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment mode | `production` |
| `MODEM_AUTO_DETECT` | Auto-detect modems | `true` |
| `MODEM_PORTS` | Manual modem ports | `(empty)` |
| `MODEM_BAUD_RATE` | Modem communication speed | `115200` |
| `MAX_SMS_PER_SIM_PER_DAY` | Daily SMS limit per SIM | `625` |
| `SMS_SEND_DELAY_MS` | Delay between SMS (ms) | `2000` |
| `MAX_CONSECUTIVE_FAILURES` | Auto-block threshold | `5` |
| `SIM_ALERT_THRESHOLDS` | Alert percentages | `80,90,100` |
| `AUTO_BLOCK_ENABLED` | Enable auto-blocking | `true` |
| `DASHBOARD_PASSWORD` | Dashboard login password | `admin123` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | `(empty)` |
| `TELEGRAM_CHAT_ID` | Telegram chat ID | `(empty)` |
| `DB_PATH` | SQLite database path | `./data/gateway.db` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window | `900000` |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | `100` |

### Telegram Bot Setup

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` command
3. Follow instructions to create your bot
4. Copy the **bot token** to `TELEGRAM_BOT_TOKEN`
5. Send a message to your bot
6. Get your **chat ID** and set `TELEGRAM_CHAT_ID`

### Modem Configuration

**Auto-Detect (Recommended):**
```env
MODEM_AUTO_DETECT=true
MODEM_PORTS=
```

**Manual Configuration:**
```env
# Windows
MODEM_PORTS=COM3,COM4,COM5,COM6

# Linux
MODEM_PORTS=/dev/ttyUSB0,/dev/ttyUSB1,/dev/ttyUSB2
```

## 📖 How to Use

### Basic Usage

1. **Access Dashboard**: Open http://localhost:3000
2. **Login**: Enter your dashboard password
3. **View Overview**: Check SIM status and statistics
4. **Send SMS**: Go to Compose page and send messages
5. **Monitor**: Watch real-time updates on dashboard

### Sending SMS

**Single SMS:**
1. Go to **Compose** page
2. Enter phone number (with country code)
3. Type your message
4. Click **Send SMS**
5. Message queued and sent automatically

**Bulk SMS:**
1. Go to **Compose** page
2. Enter job name (optional)
3. Type message template (use `{name}` for personalization)
4. Upload CSV file or paste phone numbers
5. Click **Send Bulk**
6. Monitor progress in Outbox

### Managing SIM Cards

1. Go to **SIM Cards** page
2. View status of all SIMs
3. **Enable/Disable**: Toggle SIM cards on/off
4. **Reactivate**: Click "Reactivate" after replacing blocked SIM
5. **Monitor**: Check daily usage and signal strength

### Monitoring & Alerts

**Dashboard:**
- Real-time statistics in top bar
- SIM card status cards
- Recent activity table
- Queue depth indicator

**Telegram Commands:**
- `/start` - Bot introduction
- `/inbox` - Last 10 received messages
- `/status` - SIM card status
- `/stats` - Today's statistics
- `/queue` - Pending messages count

## 📊 SIM Capacity

With optimal configuration:
- **Per SIM:** 625 SMS/day (safe limit to avoid carrier detection)
- **16 SIMs:** 10,000 SMS/day total capacity
- **Scalable:** Add more modems to increase throughput
- **Conservative:** Set to 500 SMS/day for extra safety

## 🎯 Use Cases

### For Businesses

📢 **Marketing Campaigns**: Send promotional messages to customers  
🔔 **Notifications**: Order updates, appointment reminders  
🔐 **OTP Services**: Two-factor authentication via SMS  
📊 **Bulk Messaging**: Reach thousands of contacts efficiently  
🏫 **Schools**: Send alerts to parents and students  
🏥 **Healthcare**: Appointment reminders, test results  
🏢 **Corporate**: Internal communications  
🎪 **Events**: Event updates and notifications  

```
## 📦 Testing

> 🧪 **Live Demo**: https://gsm.gateway.vercel.app
---

## 👨‍💻 Developed By

**Developed with ❤️ by Subhan Kashif**