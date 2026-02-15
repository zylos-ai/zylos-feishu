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
import { downloadImage, downloadFile, sendMessage, extractPermissionError } from './lib/message.js';
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

// ============================================================
// Message deduplication (shared by websocket and webhook modes)
// ============================================================
const DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
const processedMessages = new Map();

function isDuplicate(messageId) {
  if (!messageId) return false;
  if (processedMessages.has(messageId)) {
    console.log(`[feishu] Duplicate message_id ${messageId}, skipping`);
    return true;
  }
  processedMessages.set(messageId, Date.now());
  // Cleanup old entries
  if (processedMessages.size > 200) {
    const now = Date.now();
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL) processedMessages.delete(id);
    }
  }
  return false;
}

console.log(`[feishu] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[feishu] Component disabled in config, exiting.`);
  process.exit(0);
}

if (connectionMode === 'webhook' && !config.bot?.verification_token) {
  console.error(`[feishu] ERROR: bot.verification_token is not configured (required for webhook mode).`);
  console.error(`[feishu] Set it in ~/zylos/components/feishu/config.json (get from developer console → Event Subscriptions).`);
  process.exit(1);
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

// ============================================================
// Permission error tracking (cooldown to avoid spam)
// ============================================================
const PERMISSION_ERROR_COOLDOWN = 5 * 60 * 1000; // 5 minutes
let lastPermissionErrorNotified = 0;

/**
 * Handle a detected Feishu API permission error.
 * Sends a notification to the owner via C4 (with cooldown).
 */
function handlePermissionError(permErr) {
  const now = Date.now();
  if (now - lastPermissionErrorNotified < PERMISSION_ERROR_COOLDOWN) return;
  lastPermissionErrorNotified = now;

  const grantUrl = permErr.grantUrl || '';
  const msg = `[System] Feishu API permission error (code ${permErr.code}): ${permErr.message}`;
  const detail = grantUrl
    ? `${msg}\nGrant permissions at: ${grantUrl}`
    : msg;

  console.error(`[feishu] ${detail}`);

  // Notify owner if bound
  if (config.owner?.bound && config.owner?.open_id) {
    const ownerEndpoint = config.owner.open_id;
    sendToC4('feishu', ownerEndpoint,
      `[Feishu SYSTEM] Permission error detected: ${permErr.message}${grantUrl ? '\nAdmin grant URL: ' + grantUrl : ''}`
    );
  }
}

// ============================================================
// User name cache with TTL (in-memory primary, file for cold start)
// ============================================================
const SENDER_NAME_TTL = 10 * 60 * 1000; // 10 minutes

// In-memory cache: Map<userId, { name: string, expireAt: number }>
const userCacheMemory = new Map();

/**
 * Load file cache on cold start to seed the in-memory cache.
 * File entries are loaded with a fresh TTL since they were recently valid.
 */
function loadUserCacheFromFile() {
  try {
    if (fs.existsSync(USER_CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(USER_CACHE_PATH, 'utf-8'));
      const now = Date.now();
      for (const [userId, name] of Object.entries(data)) {
        if (typeof name === 'string') {
          userCacheMemory.set(userId, { name, expireAt: now + SENDER_NAME_TTL });
        }
      }
      console.log(`[feishu] Loaded ${userCacheMemory.size} names from file cache`);
    }
  } catch (err) {
    console.log(`[feishu] Failed to load user cache file: ${err.message}`);
  }
}

/**
 * Persist in-memory cache to file (for cold start acceleration).
 * Called periodically when new names are resolved.
 */
let _userCacheDirty = false;
function persistUserCache() {
  if (!_userCacheDirty) return;
  _userCacheDirty = false;
  const obj = {};
  for (const [userId, entry] of userCacheMemory) {
    obj[userId] = entry.name;
  }
  try {
    fs.writeFileSync(USER_CACHE_PATH, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.log(`[feishu] Failed to persist user cache: ${err.message}`);
  }
}

// Persist cache every 5 minutes
setInterval(persistUserCache, 5 * 60 * 1000);

// Load file cache on startup
loadUserCacheFromFile();

// Keep backward-compatible reference
let userCache = null; // unused, kept for compat
let groupCursors = loadCursors();

// ============================================================
// In-memory chat history (replaces file-based context building)
// File logs are kept for audit; this Map is used for fast context.
// ============================================================
const DEFAULT_HISTORY_LIMIT = 20;
const chatHistories = new Map(); // Map<chatId, Array<{ message_id, user_name, user_id, text, timestamp }>>

/**
 * Record a message entry into in-memory chat history.
 * Caps entries at the configured limit per chat.
 */
function recordHistoryEntry(chatId, entry) {
  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, []);
  }
  const history = chatHistories.get(chatId);
  history.push(entry);
  const limit = config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
  // Cap at 2x limit to avoid unbounded growth; trim to limit when reading
  if (history.length > limit * 2) {
    chatHistories.set(chatId, history.slice(-limit));
  }
}

/**
 * Get recent context messages from in-memory history.
 * Excludes the current message itself.
 */
function getInMemoryContext(chatId, currentMessageId) {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return [];

  const limit = config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
  const MIN_CONTEXT = 5;

  // Filter out the current message and get recent entries
  const filtered = history.filter(m => m.message_id !== currentMessageId);
  const count = Math.max(MIN_CONTEXT, Math.min(limit, filtered.length));
  return filtered.slice(-count);
}

// Resolve user_id to name (with TTL-based in-memory cache)
async function resolveUserName(userId) {
  if (!userId) return 'unknown';

  const now = Date.now();
  const cached = userCacheMemory.get(userId);
  if (cached && cached.expireAt > now) {
    return cached.name;
  }

  try {
    const result = await getUserInfo(userId);
    if (result.success && result.user?.name) {
      userCacheMemory.set(userId, { name: result.user.name, expireAt: now + SENDER_NAME_TTL });
      _userCacheDirty = true;
      return result.user.name;
    }
    // Check for permission error in the result
    if (!result.success && result.code === 99991672) {
      handlePermissionError({ code: result.code, message: result.message || '' });
    }
  } catch (err) {
    // Check if this is a permission error
    const permErr = extractPermissionError(err);
    if (permErr) {
      handlePermissionError(permErr);
    } else {
      console.log(`[feishu] Failed to lookup user ${userId}: ${err.message}`);
    }
    // If we have an expired cached name, return it as fallback
    if (cached) return cached.name;
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
// Also records to in-memory chat history for fast context building.
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

  // File log for audit
  const logId = chatType === 'p2p' ? userId : chatId;
  const logFile = path.join(LOGS_DIR, `${logId}.log`);
  fs.appendFileSync(logFile, logLine);

  // In-memory history for context (group chats only)
  if (chatType === 'group') {
    recordHistoryEntry(chatId, logEntry);
  }

  console.log(`[feishu] Logged: [${userName}] ${(resolvedText || '').substring(0, 30)}...`);
}

// Get group context messages (delegates to in-memory history)
function getGroupContext(chatId, currentMessageId) {
  return getInMemoryContext(chatId, currentMessageId);
}

function updateCursor(chatId, messageId) {
  groupCursors[chatId] = messageId;
  saveCursors(groupCursors);
}

// ============================================================
// Group policy helpers (references OpenClaw policy.ts patterns)
// ============================================================

/**
 * Resolve per-group config from the groups map.
 * @param {string} chatId
 * @returns {object|undefined} Group config or undefined
 */
function resolveGroupConfig(chatId) {
  const groups = config.groups || {};
  return groups[chatId];
}

/**
 * Check if a group is allowed based on groupPolicy and config.
 * Also handles backward compat with legacy allowed_groups/smart_groups.
 */
function isGroupAllowed(chatId) {
  const groupPolicy = config.groupPolicy || 'allowlist';

  if (groupPolicy === 'disabled') return false;
  if (groupPolicy === 'open') return true;

  // allowlist mode: check groups map
  const groupConfig = resolveGroupConfig(chatId);
  if (groupConfig) return true;

  // Backward compat: check legacy arrays if groups map doesn't have this chat
  const legacyAllowed = (config.allowed_groups || []).some(g => g.chat_id === chatId);
  const legacySmart = (config.smart_groups || []).some(g => g.chat_id === chatId);
  if (legacyAllowed || legacySmart) return true;

  // Legacy group_whitelist logic
  if (config.group_whitelist?.enabled === false) return true;

  return false;
}

/**
 * Check if a group is in "smart" mode (receives all messages without @mention).
 */
function isSmartGroup(chatId) {
  const groupConfig = resolveGroupConfig(chatId);
  if (groupConfig) {
    return groupConfig.mode === 'smart' || groupConfig.requireMention === false;
  }
  // Legacy fallback
  return (config.smart_groups || []).some(g => g.chat_id === chatId);
}

/**
 * Check if a sender is allowed in a specific group.
 * If the group has an allowFrom list, check it; otherwise allow all.
 */
function isSenderAllowedInGroup(chatId, senderUserId, senderOpenId) {
  const groupConfig = resolveGroupConfig(chatId);
  if (!groupConfig?.allowFrom || groupConfig.allowFrom.length === 0) {
    return true; // No per-group sender restriction
  }
  const allowed = groupConfig.allowFrom.map(s => String(s).toLowerCase());
  if (allowed.includes('*')) return true;
  if (senderUserId && allowed.includes(senderUserId.toLowerCase())) return true;
  if (senderOpenId && allowed.includes(senderOpenId.toLowerCase())) return true;
  return false;
}

/**
 * Get the history limit for a specific group.
 */
function getGroupHistoryLimit(chatId) {
  const groupConfig = resolveGroupConfig(chatId);
  return groupConfig?.historyLimit || config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
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
 * Build structured endpoint string for C4.
 * Format: chatId|root:rootId|msg:messageId
 * C4 treats endpoint as opaque string; send.js parses it.
 */
function buildEndpoint(chatId, { rootId, messageId } = {}) {
  let endpoint = chatId;
  if (rootId) {
    endpoint += `|root:${rootId}`;
  }
  if (messageId) {
    endpoint += `|msg:${messageId}`;
  }
  return endpoint;
}

/**
 * Fetch content of a quoted/replied message (best-effort).
 * Used to provide context when user replies to a specific message.
 */
async function fetchQuotedMessage(messageId) {
  try {
    const { getClient } = await import('./lib/client.js');
    const client = getClient();
    const res = await client.im.message.get({
      path: { message_id: messageId },
    });
    if (res.code === 0 && res.data?.items?.[0]) {
      const msg = res.data.items[0];
      const content = JSON.parse(msg.body?.content || '{}');
      if (msg.msg_type === 'text') return content.text || '';
      if (msg.msg_type === 'post') {
        const { text } = extractPostText(JSON.parse(msg.body?.content || '{}').content || [], messageId);
        return text;
      }
      return `[${msg.msg_type} message]`;
    }
  } catch (err) {
    console.log(`[feishu] Failed to fetch quoted message ${messageId}: ${err.message}`);
  }
  return null;
}

/**
 * Format message for C4
 */
function formatMessage(chatType, userName, text, contextMessages = [], mediaPath = null, { quotedContent } = {}) {
  let prefix = chatType === 'p2p' ? '[Feishu DM]' : '[Feishu GROUP]';

  let contextPrefix = '';
  if (contextMessages.length > 0) {
    const contextLines = contextMessages.map(m => `[${m.user_name || m.user_id}]: ${m.text}`).join('\n');
    contextPrefix = `[Group context - recent messages before this @mention:]\n${contextLines}\n\n[Current message:] `;
  }

  // Include quoted message content if replying to a specific message
  let replyPrefix = '';
  if (quotedContent) {
    replyPrefix = `[Replying to: "${quotedContent}"] `;
  }

  let message = `${prefix} ${userName} said: ${contextPrefix}${replyPrefix}${text}`;

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
// Returns imageKeys as array (all images from post messages, or single image)
function extractMessageContent(message) {
  const msgType = message.message_type;
  const content = JSON.parse(message.content || '{}');

  switch (msgType) {
    case 'text':
      return { text: content.text || '', imageKeys: [], fileKey: null, fileName: null };
    case 'post': {
      if (content.content) {
        const { text, imageKeys } = extractPostText(content.content, message.message_id);
        const fullText = content.title ? `[${content.title}] ${text}` : text;
        return { text: fullText, imageKeys, fileKey: null, fileName: null };
      }
      return { text: '', imageKeys: [], fileKey: null, fileName: null };
    }
    case 'image':
      return { text: '', imageKeys: content.image_key ? [content.image_key] : [], fileKey: null, fileName: null };
    case 'file':
      return { text: '', imageKeys: [], fileKey: content.file_key, fileName: content.file_name || 'unknown' };
    default:
      return { text: `[${msgType} message]`, imageKeys: [], fileKey: null, fileName: null };
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
  const rootId = message.root_id || null;
  const parentId = message.parent_id || null;

  // Unified dedup check (both websocket and webhook modes)
  if (isDuplicate(messageId)) return;

  const { text, imageKeys, fileKey, fileName } = extractMessageContent(message);
  console.log(`[feishu] ${chatType} message from ${senderUserId}: ${(text || '').substring(0, 50) || '[media]'}...`);

  // Build log text with file/image metadata
  let logText = text;
  for (const imgKey of imageKeys) {
    const imageInfo = `[image, image_key: ${imgKey}, msg_id: ${messageId}]`;
    logText = logText ? `${logText}\n${imageInfo}` : imageInfo;
  }
  if (fileKey) {
    const fileInfo = `[file: ${fileName}, file_key: ${fileKey}, msg_id: ${messageId}]`;
    logText = logText ? `${logText}\n${fileInfo}` : fileInfo;
  }

  logMessage(chatType, chatId, senderUserId, senderOpenId, logText, messageId, data._timestamp || null, mentions);

  // Build structured endpoint with routing metadata
  const endpoint = buildEndpoint(chatId, { rootId, messageId });

  // Fetch quoted message content if replying to a specific message (best-effort)
  let quotedContent = null;
  if (parentId) {
    quotedContent = await fetchQuotedMessage(parentId);
  }

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

    // Handle images (lazy download: only when message is being sent to C4)
    if (imageKeys.length > 0) {
      const mediaPaths = [];
      for (const imgKey of imageKeys) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(MEDIA_DIR, `feishu-${timestamp}-${imgKey.slice(-8)}.png`);
        const result = await downloadImage(messageId, imgKey, localPath);
        if (result.success) {
          mediaPaths.push(localPath);
        }
      }
      if (mediaPaths.length > 0) {
        const mediaLabel = mediaPaths.length === 1 ? '[image]' : `[${mediaPaths.length} images]`;
        const msg = formatMessage('p2p', senderName, `${mediaLabel}${text ? ' ' + text : ''}`, [], mediaPaths[0], { quotedContent });
        sendToC4('feishu', endpoint, msg, rejectReply);
      } else {
        const msg = formatMessage('p2p', senderName, '[image download failed]', [], null, { quotedContent });
        sendToC4('feishu', endpoint, msg, rejectReply);
      }
      return;
    }

    if (fileKey) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const localPath = path.join(MEDIA_DIR, `feishu-${timestamp}-${fileName}`);
      const result = await downloadFile(messageId, fileKey, localPath);
      if (result.success) {
        const msg = formatMessage('p2p', senderName, `[file: ${fileName}]`, [], localPath, { quotedContent });
        sendToC4('feishu', endpoint, msg, rejectReply);
      } else {
        const msg = formatMessage('p2p', senderName, `[file download failed: ${fileName}]`, [], null, { quotedContent });
        sendToC4('feishu', endpoint, msg, rejectReply);
      }
      return;
    }

    const msg = formatMessage('p2p', senderName, text, [], null, { quotedContent });
    sendToC4('feishu', endpoint, msg, rejectReply);
    return;
  }

  // Group chat handling
  if (chatType === 'group') {
    const mentioned = isBotMentioned(mentions, botOpenId);
    const smart = isSmartGroup(chatId);

    // Check group policy
    if (!isGroupAllowed(chatId)) {
      const senderIsOwner = isOwner(senderUserId, senderOpenId);
      if (!senderIsOwner) {
        console.log(`[feishu] Group ${chatId} not allowed by policy, ignoring`);
        return;
      }
    }

    // In non-smart groups, require @mention
    if (!smart && !mentioned) {
      console.log(`[feishu] Group message without @mention, logged only`);
      return;
    }

    // Check per-group sender allowlist
    if (!isSenderAllowedInGroup(chatId, senderUserId, senderOpenId)) {
      const senderIsOwner = isOwner(senderUserId, senderOpenId);
      if (!senderIsOwner) {
        console.log(`[feishu] Sender ${senderUserId} not in group ${chatId} allowFrom, ignoring`);
        return;
      }
    }

    // For non-smart groups, also check global whitelist
    if (!smart) {
      const senderIsOwner = isOwner(senderUserId, senderOpenId);
      if (!senderIsOwner && !isWhitelisted(senderUserId, senderOpenId)) {
        console.log(`[feishu] @mention from non-whitelisted user ${senderUserId} in group, ignoring`);
        return;
      }
    }

    console.log(`[feishu] ${smart ? 'Smart group' : 'Bot @mentioned in'} group ${chatId}`);
    const contextMessages = getGroupContext(chatId, messageId);
    updateCursor(chatId, messageId);
    // Clear in-memory history after consuming context (will be rebuilt from subsequent messages)
    chatHistories.delete(chatId);

    const senderName = await resolveUserName(senderUserId);
    const cleanText = resolveMentions(text, mentions, { stripBot: true, botOpenId });
    const groupRejectReply = (errMsg) => {
      sendMessage(chatId, errMsg).catch(e => console.error('[feishu] reject reply failed:', e.message));
    };

    // Handle images (lazy download: only for messages being sent to C4)
    if (imageKeys.length > 0) {
      const mediaPaths = [];
      for (const imgKey of imageKeys) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(MEDIA_DIR, `feishu-group-${timestamp}-${imgKey.slice(-8)}.png`);
        const result = await downloadImage(messageId, imgKey, localPath);
        if (result.success) {
          mediaPaths.push(localPath);
        }
      }
      if (mediaPaths.length > 0) {
        const mediaLabel = mediaPaths.length === 1 ? '[image]' : `[${mediaPaths.length} images]`;
        const msg = formatMessage('group', senderName, `${mediaLabel}${cleanText ? ' ' + cleanText : ''}`, contextMessages, mediaPaths[0], { quotedContent });
        sendToC4('feishu', endpoint, msg, groupRejectReply);
      }
      return;
    }

    if (fileKey) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const localPath = path.join(MEDIA_DIR, `feishu-group-${timestamp}-${fileName}`);
      const result = await downloadFile(messageId, fileKey, localPath);
      if (result.success) {
        const msg = formatMessage('group', senderName, `[file: ${fileName}]${cleanText ? ' ' + cleanText : ''}`, contextMessages, localPath, { quotedContent });
        sendToC4('feishu', endpoint, msg, groupRejectReply);
      }
      return;
    }

    const msg = formatMessage('group', senderName, cleanText || text, contextMessages, null, { quotedContent });
    sendToC4('feishu', endpoint, msg, groupRejectReply);
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

  // Dedup is now handled at handleMessage() level (shared by both modes)

  const app = express();
  app.use(express.json());

  app.post('/webhook', (req, res) => {
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
    if (!verificationToken) {
      console.error('[feishu] verification_token not configured — rejecting request. Set bot.verification_token in config.json.');
      return res.status(500).json({ error: 'Server misconfigured: verification_token missing' });
    }
    const eventToken = event.token || event.header?.token;
    if (eventToken !== verificationToken) {
      console.warn(`[feishu] Verification token mismatch, rejecting request`);
      return res.status(403).json({ error: 'Token verification failed' });
    }

    // URL Verification Challenge
    if (event.type === 'url_verification') {
      console.log('[feishu] URL verification challenge received');
      return res.json({ challenge: event.challenge });
    }

    // Respond immediately to prevent Feishu retry (timeout ~15s)
    res.json({ code: 0 });

    // Handle message event asynchronously
    if (event.header?.event_type === 'im.message.receive_v1') {
      // Dedup is handled inside handleMessage() (unified for both modes)

      // Normalize data shape to match WSClient format for shared handleMessage
      const data = {
        message: event.event.message,
        sender: event.event.sender,
        _timestamp: event.header.create_time
      };
      handleMessage(data).catch(err => {
        console.error(`[feishu] Error handling message: ${err.message}`);
      });
    }
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
