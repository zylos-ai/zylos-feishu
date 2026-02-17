---
name: feishu
version: 0.2.1
description: Feishu communication channel
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-feishu
    entry: src/index.js
  data_dir: ~/zylos/components/feishu
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - .env
    - data/

upgrade:
  repo: zylos-ai/zylos-feishu
  branch: main

config:
  required:
    - name: FEISHU_APP_ID
      description: "App ID (open.feishu.cn/app -> Credentials)"
    - name: FEISHU_APP_SECRET
      description: "App Secret (same page as App ID)"
      sensitive: true

next-steps: "BEFORE starting the service: 1) Ask user which connection mode to use: 'websocket' (Feishu SDK long connection, simpler setup) or 'webhook' (HTTP webhook, requires public URL). Write choice to connection_mode in ~/zylos/components/feishu/config.json. 2) If WEBHOOK mode: a) verification_token is REQUIRED — ask user to get it from open.feishu.cn/app Event Subscriptions page, write to config.bot.verification_token. b) encrypt_key is optional — if user provides it, write to config.bot.encrypt_key. c) Read domain from ~/zylos/.zylos/config.json and tell user to set Request URL: https://{domain}/feishu/webhook in Event Subscriptions. 3) If WEBSOCKET mode: tell user to go to open.feishu.cn/app Event Subscriptions and select long connection (长连接) mode. No webhook URL or verification token needed. 4) Both modes: user must enable Bot capability and subscribe to im.message.receive_v1 event. 5) Start the service (pm2 restart zylos-feishu)."

http_routes:
  - path: /feishu/webhook
    type: reverse_proxy
    target: localhost:3458
    strip_prefix: /feishu

dependencies:
  - comm-bridge
---

# Feishu

Feishu communication channel for zylos.

## Dependencies

- comm-bridge (for C4 message routing)

## When to Use

- Receiving messages from Feishu (private chat or @mention in groups)
- Sending messages via Feishu
- Accessing Feishu documents, spreadsheets, calendar
- Managing Feishu groups and users

## How to Use

### Sending Messages

```bash
# Via C4 send interface
~/zylos/.claude/skills/feishu/scripts/send.js <chat_id> "Hello!"

# Send image
~/zylos/.claude/skills/feishu/scripts/send.js <chat_id> "[MEDIA:image]/path/to/image.png"

# Send file
~/zylos/.claude/skills/feishu/scripts/send.js <chat_id> "[MEDIA:file]/path/to/file.pdf"
```

### CLI Commands

```bash
# Test authentication
npm run cli test

# Send messages
npm run cli send-group oc_xxx "Hello"

# Documents
npm run cli doc <doc_id>
npm run cli sheet-read <token> <range>

# Calendar
npm run cli calendar --days 7

# Groups
npm run cli chats
```

## Admin CLI

Manage bot configuration via `admin.js`:

```bash
# Show full config
node ~/zylos/.claude/skills/feishu/src/admin.js show

# Allowed Groups (respond to @mentions)
node ~/zylos/.claude/skills/feishu/src/admin.js list-allowed-groups
node ~/zylos/.claude/skills/feishu/src/admin.js add-allowed-group <chat_id> <name>
node ~/zylos/.claude/skills/feishu/src/admin.js remove-allowed-group <chat_id>

# Smart Groups (receive all messages, no @mention needed)
node ~/zylos/.claude/skills/feishu/src/admin.js list-smart-groups
node ~/zylos/.claude/skills/feishu/src/admin.js add-smart-group <chat_id> <name>
node ~/zylos/.claude/skills/feishu/src/admin.js remove-smart-group <chat_id>

# Group Whitelist (enabled by default)
node ~/zylos/.claude/skills/feishu/src/admin.js enable-group-whitelist
node ~/zylos/.claude/skills/feishu/src/admin.js disable-group-whitelist

# Whitelist
node ~/zylos/.claude/skills/feishu/src/admin.js list-whitelist
node ~/zylos/.claude/skills/feishu/src/admin.js add-whitelist <user_id_or_open_id>
node ~/zylos/.claude/skills/feishu/src/admin.js remove-whitelist <user_id_or_open_id>
node ~/zylos/.claude/skills/feishu/src/admin.js enable-whitelist
node ~/zylos/.claude/skills/feishu/src/admin.js disable-whitelist

# Owner info
node ~/zylos/.claude/skills/feishu/src/admin.js show-owner

# Help
node ~/zylos/.claude/skills/feishu/src/admin.js help
```

After changes, restart: `pm2 restart zylos-feishu`

## Config Location

- Config: `~/zylos/components/feishu/config.json`
- Logs: `~/zylos/components/feishu/logs/`
- Media: `~/zylos/components/feishu/media/`

## Feishu Setup

### 1. Credentials

Add to `~/zylos/.env`:

```bash
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
```

Get App ID and App Secret from your app's Credentials page:
- Feishu: [open.feishu.cn/app](https://open.feishu.cn/app)

### 2. Connection Mode

Choose a connection mode in `~/zylos/components/feishu/config.json`:

```json
{
  "connection_mode": "websocket"
}
```

| Mode | How it works | Pros | Cons |
|------|-------------|------|------|
| `websocket` | SDK WSClient long connection to Feishu servers | No public URL needed, simpler setup | Requires SDK support |
| `webhook` | HTTP server receives POST events from Feishu | Standard HTTP, works everywhere | Requires public URL + Caddy route |

### 3. Console Configuration

In the Feishu developer console ([open.feishu.cn/app](https://open.feishu.cn/app)):

**Both modes:**
1. Enable **Bot** capability (添加应用能力 -> 机器人)
2. Subscribe to event: `im.message.receive_v1`

**WebSocket mode:**
3. In Event Subscriptions, select **长连接** (long connection) mode
4. No Request URL or verification token needed

**Webhook mode:**
3. In Event Subscriptions, select **webhook** mode
4. Set Request URL: `https://<your-domain>/feishu/webhook`
5. Copy the **Verification Token** (required) and save to config:
   ```json
   {
     "bot": {
       "verification_token": "your_token_from_console"
     }
   }
   ```
6. Optionally copy the **Encrypt Key** for payload encryption:
   ```json
   {
     "bot": {
       "verification_token": "your_token",
       "encrypt_key": "your_encrypt_key"
     }
   }
   ```

### Cloudflare Users (Webhook mode)

If your domain is behind Cloudflare proxy with Flexible SSL mode, Caddy's automatic HTTPS will cause a redirect loop. Options:

1. **Change Cloudflare SSL to Full**: In Cloudflare dashboard -> SSL/TLS -> set mode to "Full" (recommended)
2. **Use HTTP mode**: Run `zylos config set protocol http` (automatically updates Caddyfile and reloads Caddy)

## Owner

First user to send a private message becomes the owner (primary partner).
Owner is automatically whitelisted and can always communicate with the bot.

Owner info stored in config.json:
```json
{
  "owner": {
    "bound": true,
    "user_id": "xxx",
    "open_id": "ou_xxx",
    "name": "Howard"
  }
}
```

## Group Settings

### Allowed Groups (respond to @mentions)

Groups where the bot responds when @mentioned.
Owner can @mention bot in any group, even if not in allowed_groups.

```json
{
  "allowed_groups": [
    {"chat_id": "oc_xxx", "name": "Group", "added_at": "2026-01-01T00:00:00Z"}
  ]
}
```

### Smart Groups (receive all messages)

Groups where the bot receives ALL messages without needing @mention:

```json
{
  "smart_groups": [
    {"chat_id": "oc_zzz", "name": "Core", "added_at": "2026-01-01T00:00:00Z"}
  ]
}
```

## Group Context

When responding to @mentions in groups, the bot includes recent message context
so Claude understands the conversation. Context is retrieved from logged messages
since the last response.

Configuration in `config.json`:
```json
{
  "message": {
    "context_messages": 10
  }
}
```

Message logs are stored in `~/zylos/components/feishu/logs/<chat_id>.log`.

## Service Management

```bash
pm2 status zylos-feishu
pm2 logs zylos-feishu
pm2 restart zylos-feishu
```
