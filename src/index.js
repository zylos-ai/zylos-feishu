#!/usr/bin/env node
/**
 * zylos-feishu - Feishu Bot Service
 *
 * Supports two connection modes (configured via config.json connection_mode):
 *   - websocket: Feishu SDK WSClient for persistent long connection
 *   - webhook: Express HTTP server for receiving webhook events
 */

import dotenv from 'dotenv';
import express from 'express';
import crypto from 'crypto';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';

// Load .env from ~/zylos/.env (absolute path, not cwd-dependent)
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, saveConfig, DATA_DIR, getCredentials } from './lib/config.js';
import { downloadImage, downloadFile, sendMessage } from './lib/message.js';
import { getUserInfo } from './lib/contact.js';

// C4 receive interface path
const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

// Bot identity (fetched at startup)
let botOpenId = '';

// WSClient instance for graceful shutdown (websocket mode only)
let wsClient = null;

// Initialize
let config = getConfig();
const connectionMode = config.connection_mode || 'websocket';
console.log(`[feishu] Starting (${connectionMode} mode)...`);
console.log(`[feishu] Data directory: ${DATA_DIR}`);

// Ensure directories exist
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// State files
const CURSORS_PATH = path.join(DATA_DIR, 'group-cursors.json');
const USER_CACHE_PATH = path.join(DATA_DIR, 'user-cache.json');

console.log(`[feishu] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[feishu] Component disabled in config, exiting.`);
  process.exit(0);
}

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[feishu] Config reloaded`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[feishu] Component disabled, stopping...`);
    shutdown();
  }
});

// Load/save group cursors
function loadCursors() {
  try {
    if (fs.existsSync(CURSORS_PATH)) {
      return JSON.parse(fs.readFileSync(CURSORS_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveCursors(cursors) {
  fs.writeFileSync(CURSORS_PATH, JSON.stringify(cursors, null, 2));
}

// User name cache
function loadUserCache() {
  try {
    if (fs.existsSync(USER_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(USER_CACHE_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveUserCache(cache) {
  fs.writeFileSync(USER_CACHE_PATH, JSON.stringify(cache, null, 2));
}

let userCache = loadUserCache();
let groupCursors = loadCursors();

// Resolve user_id to name
async function resolveUserName(userId) {
  if (!userId) return 'unknown';
  if (userCache[userId]) return userCache[userId];

  try {
    const result = await getUserInfo(userId);
    if (result.success && result.user?.name) {
      userCache[userId] = result.user.name;
      saveUserCache(userCache);
      return result.user.name;
    }
  } catch (err) {
    console.log(`[feishu] Failed to lookup user ${userId}: ${err.message}`);
  }
  return userId;
}

// Decrypt message if encrypt_key is set (webhook mode only)
function decrypt(encrypt, encryptKey) {
  if (!encryptKey) return null;
  const encryptBuffer = Buffer.from(encrypt, 'base64');
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const iv = encryptBuffer.slice(0, 16);
  const encrypted = encryptBuffer.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// Log message (mentions resolved to real names for readable context)
async function logMessage(chatType, chatId, userId, openId, text, messageId, timestamp, mentions) {
  const userName = await resolveUserName(userId);
  const resolvedText = resolveMentions(text, mentions);
  const logEntry = {
    timestamp: timestamp || new Date().toISOString(),
    message_id: messageId,
    user_id: userId,
    open_id: openId,
    user_name: userName,
    text: resolvedText
  };
  const logLine = JSON.stringify(logEntry) + '\n';

  const logId = chatType === 'p2p' ? userId : chatId;
  const logFile = path.join(LOGS_DIR, `${logId}.log`);
  fs.appendFileSync(logFile, logLine);
  console.log(`[feishu] Logged: [${userName}] ${(resolvedText || '').substring(0, 30)}...`);
}

// Get group context messages
function getGroupContext(chatId, currentMessageId) {
  const logFile = path.join(LOGS_DIR, `${chatId}.log`);
  if (!fs.existsSync(logFile)) return [];

  const MIN_CONTEXT = 5;
  const MAX_CONTEXT = config.message?.context_messages || 10;
  const cursor = groupCursors[chatId] || null;
  const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(l => l);

  const messages = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(m => m);

  let cursorIndex = -1;
  let currentIndex = messages.length - 1;

  if (cursor) {
    cursorIndex = messages.findIndex(m => m.message_id === cursor);
  }

  let contextMessages = messages.slice(cursorIndex + 1, currentIndex);

  if (contextMessages.length < MIN_CONTEXT && currentIndex > 0) {
    const startIndex = Math.max(0, currentIndex - MIN_CONTEXT);
    contextMessages = messages.slice(startIndex, currentIndex);
  }

  return contextMessages.slice(-MAX_CONTEXT);
}

function updateCursor(chatId, messageId) {
  groupCursors[chatId] = messageId;
  saveCursors(groupCursors);
}

// Check if bot is mentioned
function isBotMentioned(mentions, botId) {
  if (!mentions || !Array.isArray(mentions)) return false;
  return mentions.some(m => {
    const mentionId = m.id?.open_id || m.id?.user_id || m.id?.app_id || '';
    return mentionId === botId || m.key === '@_all';
  });
}

/**
 * Resolve @_user_N placeholders in message text to real names.
 * Feishu replaces @mentions with @_user_1, @_user_2, etc. in the raw text.
 * The mentions array contains the mapping: { key: "@_user_1", name: "Name", id: { ... } }
 */
function resolveMentions(text, mentions, { stripBot = false, botOpenId: botId } = {}) {
  if (!text || !mentions || !Array.isArray(mentions) || mentions.length === 0) return text;

  let resolved = text;
  for (const m of mentions) {
    if (!m.key) continue;
    const isBotMention = botId && (m.id?.open_id === botId || m.id?.app_id === botId);
    if (stripBot && isBotMention) {
      resolved = resolved.replace(new RegExp(m.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'g'), '');
    } else if (m.name) {
      resolved = resolved.replace(m.key, `@${m.name}`);
    }
  }
  return resolved.trim();
}

/**
 * Parse c4-receive JSON response from stdout.
 */
function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Send message to Claude via C4 (with 1 retry on unexpected failure)
 */
function sendToC4(source, endpoint, content, onReject) {
  if (!content) {
    console.error('[feishu] sendToC4 called with empty content');
    return;
  }
  const safeContent = content.replace(/'/g, "'\\''");
  const cmd = `node "${C4_RECEIVE}" --channel "${source}" --endpoint "${endpoint}" --json --content '${safeContent}'`;

  exec(cmd, { encoding: 'utf8' }, (error, stdout) => {
    if (!error) {
      console.log(`[feishu] Sent to C4: ${content.substring(0, 50)}...`);
      return;
    }
    const response = parseC4Response(error.stdout || stdout);
    if (response && response.ok === false && response.error?.message) {
      console.warn(`[feishu] C4 rejected (${response.error.code}): ${response.error.message}`);
      if (onReject) onReject(response.error.message);
      return;
    }
    console.warn(`[feishu] C4 send failed, retrying in 2s: ${error.message}`);
    setTimeout(() => {
      exec(cmd, { encoding: 'utf8' }, (retryError, retryStdout) => {
        if (!retryError) {
          console.log(`[feishu] Sent to C4 (retry): ${content.substring(0, 50)}...`);
          return;
        }
        const retryResponse = parseC4Response(retryError.stdout || retryStdout);
        if (retryResponse && retryResponse.ok === false && retryResponse.error?.message) {
          console.error(`[feishu] C4 rejected after retry (${retryResponse.error.code}): ${retryResponse.error.message}`);
          if (onReject) onReject(retryResponse.error.message);
        } else {
          console.error(`[feishu] C4 send failed after retry: ${retryError.message}`);
        }
      });
    }, 2000);
  });
}

/**
 * Format message for C4
 */
function formatMessage(chatType, userName, text, contextMessages = [], mediaPath = null) {
  let prefix = chatType === 'p2p' ? '[Feishu DM]' : '[Feishu GROUP]';

  let contextPrefix = '';
  if (contextMessages.length > 0) {
    const contextLines = contextMessages.map(m => `[${m.user_name || m.user_id}]: ${m.text}`).join('\n');
    contextPrefix = `[Group context - recent messages before this @mention:]\n${contextLines}\n\n[Current message:] `;
  }

  let message = `${prefix} ${userName} said: ${contextPrefix}${text}`;

  if (mediaPath) {
    message += ` ---- file: ${mediaPath}`;
  }

  return message;
}

/**
 * Extract text from a Feishu post (rich text) message.
 * Post messages have nested arrays: paragraphs > elements.
 * Each element has a tag (text, at, a, img, media, emotion).
 *
 * @param {Array} paragraphs - content.content array from post message
 * @param {string} messageId - message ID for lazy media references
 * @returns {{ text: string, imageKeys: string[] }} Extracted text and image keys
 */
function extractPostText(paragraphs, messageId) {
  const imageKeys = [];
  const lines = [];

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    const parts = [];

    for (const el of paragraph) {
      switch (el.tag) {
        case 'text':
          parts.push(el.text || '');
          break;
        case 'at':
          parts.push(`@${el.user_name || el.user_id || 'unknown'}`);
          break;
        case 'a':
          if (el.href) {
            parts.push(`${el.text || ''}(${el.href})`);
          } else {
            parts.push(el.text || '');
          }
          break;
        case 'img':
          if (el.image_key) {
            imageKeys.push(el.image_key);
            parts.push(`[image, image_key: ${el.image_key}, msg_id: ${messageId}]`);
          }
          break;
        case 'media':
          parts.push(`[media, file_key: ${el.file_key || 'unknown'}, msg_id: ${messageId}]`);
          break;
        case 'emotion':
          parts.push(el.emoji_type ? `[${el.emoji_type}]` : '');
          break;
        default:
          if (el.text) parts.push(el.text);
          break;
      }
    }

    lines.push(parts.join(''));
  }

  return { text: lines.join('\n'), imageKeys };
}

// Extract content from Feishu message
function extractMessageContent(message) {
  const msgType = message.message_type;
  const content = JSON.parse(message.content || '{}');

  switch (msgType) {
    case 'text':
      return { text: content.text || '', imageKey: null, fileKey: null, fileName: null };
    case 'post': {
      if (content.content) {
        const { text, imageKeys } = extractPostText(content.content, message.message_id);
        const fullText = content.title ? `[${content.title}] ${text}` : text;
        return { text: fullText, imageKey: imageKeys[0] || null, fileKey: null, fileName: null };
      }
      return { text: '', imageKey: null, fileKey: null, fileName: null };
    }
    case 'image':
      return { text: '', imageKey: content.image_key, fileKey: null, fileName: null };
    case 'file':
      return { text: '', imageKey: null, fileKey: content.file_key, fileName: content.file_name || 'unknown' };
    default:
      return { text: `[${msgType} message]`, imageKey: null, fileKey: null, fileName: null };
  }
}

// Bind owner (first private chat user)
async function bindOwner(userId, openId) {
  const userName = await resolveUserName(userId);
  config.owner = {
    bound: true,
    user_id: userId,
    open_id: openId,
    name: userName
  };
  saveConfig(config);
  console.log(`[feishu] Owner bound: ${userName} (${userId})`);
  return userName;
}

// Check if user is owner
function isOwner(userId, openId) {
  if (!config.owner?.bound) return false;
  return config.owner.user_id === userId || config.owner.open_id === openId;
}

// Check whitelist (supports both user_id and open_id)
// Owner is always allowed
function isWhitelisted(userId, openId) {
  if (isOwner(userId, openId)) return true;
  if (!config.whitelist?.enabled) return true;
  const allowedUsers = [...(config.whitelist.private_users || []), ...(config.whitelist.group_users || [])];
  return allowedUsers.includes(userId) || (openId && allowedUsers.includes(openId));
}

/**
 * Handle im.message.receive_v1 event.
 * Shared by both websocket and webhook modes.
 *
 * @param {object} data - { message, sender } from the event
 */
async function handleMessage(data) {
  const message = data.message;
  const sender = data.sender;
  const mentions = message.mentions;

  const senderUserId = sender.sender_id?.user_id;
  const senderOpenId = sender.sender_id?.open_id;
  const chatId = message.chat_id;
  const messageId = message.message_id;
  const chatType = message.chat_type;

  const { text, imageKey, fileKey, fileName } = extractMessageContent(message);
  console.log(`[feishu] ${chatType} message from ${senderUserId}: ${(text || '').substring(0, 50) || '[media]'}...`);

  // Build log text with file/image metadata
  let logText = text;
  if (imageKey) {
    const imageInfo = `[image, image_key: ${imageKey}, msg_id: ${messageId}]`;
    logText = logText ? `${logText}\n${imageInfo}` : imageInfo;
  }
  if (fileKey) {
    const fileInfo = `[file: ${fileName}, file_key: ${fileKey}, msg_id: ${messageId}]`;
    logText = logText ? `${logText}\n${fileInfo}` : fileInfo;
  }

  logMessage(chatType, chatId, senderUserId, senderOpenId, logText, messageId, data._timestamp || null, mentions);

  // Private chat handling
  if (chatType === 'p2p') {
    if (!config.owner?.bound) {
      await bindOwner(senderUserId, senderOpenId);
    }

    if (!isWhitelisted(senderUserId, senderOpenId)) {
      console.log(`[feishu] Private message from non-whitelisted user ${senderUserId}, ignoring`);
      return;
    }

    const senderName = await resolveUserName(senderUserId);
    const rejectReply = (errMsg) => {
      sendMessage(chatId, errMsg).catch(e => console.error('[feishu] reject reply failed:', e.message));
    };

    if (imageKey) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const localPath = path.join(MEDIA_DIR, `feishu-${timestamp}.png`);
      const result = await downloadImage(messageId, imageKey, localPath);
      if (result.success) {
        const msg = formatMessage('p2p', senderName, `[image]${text ? ' ' + text : ''}`, [], localPath);
        sendToC4('feishu', chatId, msg, rejectReply);
      } else {
        const msg = formatMessage('p2p', senderName, '[image download failed]');
        sendToC4('feishu', chatId, msg, rejectReply);
      }
      return;
    }

    if (fileKey) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const localPath = path.join(MEDIA_DIR, `feishu-${timestamp}-${fileName}`);
      const result = await downloadFile(messageId, fileKey, localPath);
      if (result.success) {
        const msg = formatMessage('p2p', senderName, `[file: ${fileName}]`, [], localPath);
        sendToC4('feishu', chatId, msg, rejectReply);
      } else {
        const msg = formatMessage('p2p', senderName, `[file download failed: ${fileName}]`);
        sendToC4('feishu', chatId, msg, rejectReply);
      }
      return;
    }

    const msg = formatMessage('p2p', senderName, text);
    sendToC4('feishu', chatId, msg, rejectReply);
    return;
  }

  // Group chat handling
  if (chatType === 'group') {
    const mentioned = isBotMentioned(mentions, botOpenId);
    const isSmartGroup = (config.smart_groups || []).some(g => g.chat_id === chatId);
    const allowedGroups = config.allowed_groups || [];
    const whitelistEnabled = config.group_whitelist?.enabled !== false;
    const isAllowedGroup = whitelistEnabled
      ? allowedGroups.some(g => g.chat_id === chatId)
      : true;

    if (!isSmartGroup && !mentioned) {
      console.log(`[feishu] Group message without @mention, logged only`);
      return;
    }

    if (!isSmartGroup) {
      const senderIsOwner = isOwner(senderUserId, senderOpenId);

      if (!isAllowedGroup && !senderIsOwner) {
        console.log(`[feishu] @mention in non-allowed group ${chatId}, ignoring`);
        return;
      }
      if (!senderIsOwner && !isWhitelisted(senderUserId, senderOpenId)) {
        console.log(`[feishu] @mention from non-whitelisted user ${senderUserId} in group, ignoring`);
        return;
      }
    }

    console.log(`[feishu] ${isSmartGroup ? 'Smart group' : 'Bot @mentioned in'} group ${chatId}`);
    const contextMessages = getGroupContext(chatId, messageId);
    updateCursor(chatId, messageId);

    const senderName = await resolveUserName(senderUserId);
    const cleanText = resolveMentions(text, mentions, { stripBot: true, botOpenId });
    const groupRejectReply = (errMsg) => {
      sendMessage(chatId, errMsg).catch(e => console.error('[feishu] reject reply failed:', e.message));
    };

    if (imageKey) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const localPath = path.join(MEDIA_DIR, `feishu-group-${timestamp}.png`);
      const result = await downloadImage(messageId, imageKey, localPath);
      if (result.success) {
        const msg = formatMessage('group', senderName, `[image]${cleanText ? ' ' + cleanText : ''}`, contextMessages, localPath);
        sendToC4('feishu', chatId, msg, groupRejectReply);
      }
      return;
    }

    if (fileKey) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const localPath = path.join(MEDIA_DIR, `feishu-group-${timestamp}-${fileName}`);
      const result = await downloadFile(messageId, fileKey, localPath);
      if (result.success) {
        const msg = formatMessage('group', senderName, `[file: ${fileName}]${cleanText ? ' ' + cleanText : ''}`, contextMessages, localPath);
        sendToC4('feishu', chatId, msg, groupRejectReply);
      }
      return;
    }

    const msg = formatMessage('group', senderName, cleanText || text, contextMessages);
    sendToC4('feishu', chatId, msg, groupRejectReply);
  }
}

// ============================================================
// Transport: WebSocket mode (Feishu SDK WSClient)
// ============================================================

function startWebSocket(creds) {
  wsClient = new Lark.WSClient({
    appId: creds.app_id,
    appSecret: creds.app_secret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
    autoReconnect: true
  });

  console.log('[feishu] Connecting to Feishu via WebSocket...');

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await handleMessage(data);
        } catch (err) {
          console.error(`[feishu] Error handling message: ${err.message}`);
        }
      }
    })
  });
}

// ============================================================
// Transport: Webhook mode (Express HTTP server)
// ============================================================

function startWebhook(creds) {
  const PORT = config.webhook_port || 3458;

  const app = express();
  app.use(express.json());

  app.post('/webhook', async (req, res) => {
    console.log('[feishu] Received webhook request');

    let event = req.body;

    // Handle encrypted events
    if (event.encrypt && config.bot?.encrypt_key) {
      try {
        event = decrypt(event.encrypt, config.bot.encrypt_key);
      } catch (err) {
        console.error('[feishu] Decryption failed:', err.message);
        return res.status(400).json({ error: 'Decryption failed' });
      }
    }

    // Verify token (required for webhook mode)
    const verificationToken = config.bot?.verification_token;
    if (verificationToken) {
      const eventToken = event.token || event.header?.token;
      if (eventToken !== verificationToken) {
        console.warn(`[feishu] Verification token mismatch, rejecting request`);
        return res.status(403).json({ error: 'Token verification failed' });
      }
    }

    // URL Verification Challenge
    if (event.type === 'url_verification') {
      console.log('[feishu] URL verification challenge received');
      return res.json({ challenge: event.challenge });
    }

    // Handle message event
    if (event.header?.event_type === 'im.message.receive_v1') {
      try {
        // Normalize data shape to match WSClient format for shared handleMessage
        const data = {
          message: event.event.message,
          sender: event.event.sender,
          _timestamp: event.header.create_time
        };
        await handleMessage(data);
      } catch (err) {
        console.error(`[feishu] Error handling message: ${err.message}`);
      }
    }

    res.json({ code: 0 });
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'zylos-feishu',
      mode: 'webhook',
      cursors: Object.keys(groupCursors).length
    });
  });

  app.listen(PORT, () => {
    console.log(`[feishu] Webhook server running on port ${PORT}`);
  });
}

// ============================================================
// Startup
// ============================================================

// Graceful shutdown
function shutdown() {
  console.log(`[feishu] Shutting down...`);
  if (wsClient) {
    wsClient.close({ force: false });
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Validate credentials
const creds = getCredentials();

if (!creds.app_id || !creds.app_secret) {
  console.error('[feishu] FEISHU_APP_ID and FEISHU_APP_SECRET must be set in ~/zylos/.env');
  process.exit(1);
}

// Fetch bot identity, then start the selected transport
(async () => {
  try {
    const client = new Lark.Client({
      appId: creds.app_id,
      appSecret: creds.app_secret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu
    });

    const res = await client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });

    if (res.code === 0 && res.bot) {
      botOpenId = res.bot.open_id;
      console.log(`[feishu] Bot identity: ${res.bot.app_name} (${botOpenId})`);
    } else {
      console.error(`[feishu] Warning: Could not fetch bot info: ${res.msg}`);
    }
  } catch (err) {
    console.error(`[feishu] Warning: getBotInfo failed: ${err.message}`);
  }

  // Start selected transport
  if (connectionMode === 'webhook') {
    startWebhook(creds);
  } else {
    startWebSocket(creds);
  }
})();
