---
name: feishu
version: 0.2.3
description: >-
  Feishu (飞书, China domestic) communication channel. Supports WebSocket and webhook modes.
  Use when: (1) replying to Feishu messages (DM or group @mentions),
  (2) sending proactive messages or media (images, files) to Feishu users or groups,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom, smart/mention modes),
  (5) reading or creating Feishu documents, spreadsheets, or calendar events via CLI,
  (6) configuring the bot (admin CLI, markdown card settings, connection mode, verification token),
  (7) troubleshooting Feishu WebSocket connection or webhook issues.
  Config at ~/zylos/components/feishu/config.json. Service: pm2 zylos-feishu.
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

Depends on: comm-bridge (C4 message routing).

## Sending Messages

```bash
# Via C4 bridge (standard path)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "feishu" "<chat_id>" "Hello!"

# Send image
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "feishu" "<chat_id>" "[MEDIA:image]/path/to/image.png"

# Send file
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "feishu" "<chat_id>" "[MEDIA:file]/path/to/file.pdf"
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/feishu/scripts/send.js <chat_id> "Hello!"
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
ADM="node ~/zylos/.claude/skills/feishu/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>     # Set DM policy
$ADM list-dm-allow                            # Show DM policy + allowFrom list
$ADM add-dm-allow <user_id_or_open_id>        # Add user to dmAllowFrom
$ADM remove-dm-allow <user_id_or_open_id>     # Remove user from dmAllowFrom

# Group Management
$ADM list-groups                              # List all configured groups
$ADM add-group <chat_id> <name> [mode]        # Add group (mode: mention|smart)
$ADM remove-group <chat_id>                   # Remove a group
$ADM set-group-policy <disabled|allowlist|open>  # Set group policy
$ADM set-group-allowfrom <chat_id> <id1,id2>  # Set per-group allowed senders
$ADM set-group-history-limit <chat_id> <n>    # Set per-group context message limit
$ADM migrate-groups                           # Migrate legacy group config to new format

# Legacy aliases (backward-compatible, map to commands above)
# list-allowed-groups, add-allowed-group, remove-allowed-group → list-groups, add-group, remove-group
# list-smart-groups, add-smart-group, remove-smart-group → list-groups, add-group, remove-group
# enable-group-whitelist, disable-group-whitelist → set-group-policy allowlist|open
# list-whitelist, add-whitelist, remove-whitelist → list-dm-allow, add-dm-allow, remove-dm-allow
# enable-whitelist, disable-whitelist → set-dm-policy allowlist|open
```

After changes, restart: `pm2 restart zylos-feishu`

## Downloading Media by Resource Key

In smart group mode, images and files sent without @mention are logged with
metadata only (image_key/file_key). Use `download.js` to fetch them on demand:

```bash
# Download image
node ~/zylos/.claude/skills/feishu/scripts/download.js image <message_id> <image_key>

# Download file
node ~/zylos/.claude/skills/feishu/scripts/download.js file <message_id> <file_key> [filename]

# Examples:
node ~/zylos/.claude/skills/feishu/scripts/download.js image om_xxx img_v3_xxx
node ~/zylos/.claude/skills/feishu/scripts/download.js file om_xxx file_v3_xxx report.pdf
```

The keys come from context messages like `[image, image_key: xxx, msg_id: xxx]`
or `[file: name.pdf, file_key: xxx, msg_id: xxx]`.

Output: local file path on success, error message on failure.

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
Owner always bypasses all access checks (DM and group) regardless of policy settings.

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

## Access Control

### Permission Flow

DM and group access are controlled by **independent** top-level policies:

```json
{
  "dmPolicy": "owner",        // "open" | "allowlist" | "owner"
  "dmAllowFrom": ["ou_xxx"],  // used when dmPolicy = "allowlist"
  "groupPolicy": "allowlist", // "open" | "allowlist" | "disabled"
  "groups": { ... }           // per-group config (used when groupPolicy = "allowlist")
}
```

**Private DM (dmPolicy):**
1. Owner? → always allowed
2. `dmPolicy` = `open`? → anyone can DM
3. `dmPolicy` = `owner`? → only owner can DM
4. `dmPolicy` = `allowlist`? → check `dmAllowFrom` list; not in list → dropped

**Group message (groupPolicy):**
1. `groupPolicy` = `disabled`? → all group messages dropped
2. `groupPolicy` = `open`? → respond to @mentions from any group
3. `groupPolicy` = `allowlist`? → only configured groups; unlisted groups → only owner passes, others dropped silently
4. Per-group `allowFrom` set? → only listed senders pass (owner always bypasses)
5. Smart group (mode: `smart`)? → receive all messages, no @mention needed
6. Not smart? → only @mentions are processed, other messages are logged only

**Key points:**
- Owner always bypasses all access checks
- `dmPolicy` and `groupPolicy` are fully independent — changing one never affects the other
- Group access is controlled by `groupPolicy` + `groups` config + per-group `allowFrom`
- No user-level whitelist for groups; use per-group `allowFrom` if you need to restrict specific senders

### Groups Config Format

Groups are stored in a map keyed by `chat_id`:

```json
{
  "groupPolicy": "allowlist",
  "groups": {
    "oc_xxx": {
      "name": "研发群",
      "mode": "mention",
      "requireMention": true,
      "allowFrom": [],
      "historyLimit": 10,
      "added_at": "2026-01-01T00:00:00Z"
    },
    "oc_zzz": {
      "name": "核心群",
      "mode": "smart",
      "requireMention": false
    }
  }
}
```

- `mode`: `"mention"` (respond to @mentions only) or `"smart"` (receive all messages)
- `allowFrom`: Optional list of user_id/open_id. Empty = all group members allowed. `"*"` = wildcard.
- `historyLimit`: Optional per-group context message limit (overrides `message.context_messages`)

### Markdown Card

Outgoing messages can be rendered as interactive cards with proper markdown formatting (code blocks, tables, headers, etc.):

```json
{
  "message": {
    "useMarkdownCard": false
  }
}
```

Off by default due to mobile display limitations (cards cannot be long-pressed to copy on mobile). When enabled, messages containing markdown are auto-detected and sent as cards; plain text messages are sent normally. Falls back to plain text if card sending fails.

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
