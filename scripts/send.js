#!/usr/bin/env node
/**
 * C4 Communication Bridge Interface for zylos-feishu
 *
 * Usage:
 *   ./send.js <endpoint_id> "message text"
 *   ./send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"
 *   ./send.js <endpoint_id> "[MEDIA:file]/path/to/document.pdf"
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig } from '../src/lib/config.js';
import { sendToGroup, sendMessage, uploadImage, sendImage, uploadFile, sendFile, replyToMessage, sendMarkdownCard, replyWithMarkdownCard } from '../src/lib/message.js';

const MAX_LENGTH = 2000;  // Feishu message max length

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <endpoint_id> <message>');
  console.error('       send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"');
  console.error('       send.js <endpoint_id> "[MEDIA:file]/path/to/file.pdf"');
  process.exit(1);
}

const rawEndpoint = args[0];
const message = args.slice(1).join(' ');

/**
 * Parse structured endpoint string.
 * Format: chatId|root:rootId|msg:messageId
 * Backward compatible: plain chatId without | works as before.
 */
function parseEndpoint(endpoint) {
  const parts = endpoint.split('|');
  const result = { chatId: parts[0] };
  for (const part of parts.slice(1)) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      const key = part.substring(0, colonIdx);
      const value = part.substring(colonIdx + 1);
      result[key] = value;
    }
  }
  return result;
}

const parsedEndpoint = parseEndpoint(rawEndpoint);
const endpointId = parsedEndpoint.chatId;

// Check if component is enabled
const config = getConfig();
if (!config.enabled) {
  console.error('Error: feishu is disabled in config');
  process.exit(1);
}

// Parse media prefix
const mediaMatch = message.match(/^\[MEDIA:(\w+)\](.+)$/);

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text) {
  // Code blocks (fenced with ```)
  if (/```[\s\S]*?```/.test(text)) return true;
  // Markdown tables (|...|  followed by |---|)
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Split long message into chunks (markdown-aware).
 * Ensures code blocks (```) are not split across chunks.
 */
function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakAt = maxLength;

    // Check if we're inside a code block at the break point
    const segment = remaining.substring(0, breakAt);
    const fenceMatches = segment.match(/```/g);
    const insideCodeBlock = fenceMatches && fenceMatches.length % 2 !== 0;

    if (insideCodeBlock) {
      // Find the start of this unclosed code block and break before it
      const lastFenceStart = segment.lastIndexOf('```');
      // Look for a newline before the code fence to break cleanly
      const lineBeforeFence = remaining.lastIndexOf('\n', lastFenceStart - 1);
      if (lineBeforeFence > maxLength * 0.2) {
        breakAt = lineBeforeFence;
      } else {
        // Code block is too large; find its end and include the whole block
        const fenceEnd = remaining.indexOf('```', lastFenceStart + 3);
        if (fenceEnd !== -1) {
          const blockEnd = remaining.indexOf('\n', fenceEnd + 3);
          breakAt = blockEnd !== -1 ? blockEnd + 1 : fenceEnd + 3;
        }
        // If block end is still beyond 2x maxLength, fall back to hard break
        if (breakAt > maxLength * 2) {
          breakAt = maxLength;
        }
      }
    } else {
      // Not inside code block: try to break at a clean boundary
      const chunk = remaining.substring(0, breakAt);

      // Prefer breaking at double newline (paragraph boundary)
      const lastParaBreak = chunk.lastIndexOf('\n\n');
      if (lastParaBreak > maxLength * 0.3) {
        breakAt = lastParaBreak + 1;
      } else {
        // Try to break at last newline
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline > maxLength * 0.3) {
          breakAt = lastNewline;
        } else {
          // Try to break at last space
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > maxLength * 0.3) {
            breakAt = lastSpace;
          }
        }
      }
    }

    chunks.push(remaining.substring(0, breakAt).trim());
    remaining = remaining.substring(breakAt).trim();
  }

  return chunks;
}

/**
 * Send text message with auto-chunking.
 * Uses reply API when rootId or msgId is available from structured endpoint.
 * Auto-detects content with code blocks or tables and sends as interactive card.
 */
async function sendText(endpoint, text) {
  const useCard = shouldUseCard(text);
  const chunks = splitMessage(text, MAX_LENGTH);
  const { root: rootId, msg: msgId } = parsedEndpoint;

  for (let i = 0; i < chunks.length; i++) {
    let result;
    const isFirstChunk = i === 0;
    const replyToId = rootId || msgId;

    if (useCard) {
      // Send as interactive card (markdown element) for rich content
      if (isFirstChunk && replyToId) {
        result = await replyMarkdownCard(replyToId, chunks[i]);
      } else {
        result = await sendMarkdownCard(endpoint, chunks[i]);
      }
    } else {
      // Send as plain text
      if (isFirstChunk && replyToId) {
        result = await replyToMessage(replyToId, chunks[i]);
      } else {
        result = await sendToGroup(endpoint, chunks[i]);
      }
    }

    if (!result.success) {
      throw new Error(result.message);
    }
    // Small delay between chunks
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (chunks.length > 1) {
    console.log(`Sent ${chunks.length} chunks`);
  }
}

/**
 * Send media (image or file)
 */
async function sendMedia(endpoint, type, filePath) {
  const trimmedPath = filePath.trim();

  if (type === 'image') {
    const uploadResult = await uploadImage(trimmedPath);
    if (!uploadResult.success) {
      throw new Error(`Failed to upload image: ${uploadResult.message}`);
    }
    const sendResult = await sendImage(endpoint, uploadResult.imageKey);
    if (!sendResult.success) {
      throw new Error(`Failed to send image: ${sendResult.message}`);
    }
  } else if (type === 'file') {
    const uploadResult = await uploadFile(trimmedPath);
    if (!uploadResult.success) {
      throw new Error(`Failed to upload file: ${uploadResult.message}`);
    }
    const sendResult = await sendFile(endpoint, uploadResult.fileKey);
    if (!sendResult.success) {
      throw new Error(`Failed to send file: ${sendResult.message}`);
    }
  } else {
    throw new Error(`Unsupported media type: ${type}`);
  }
}

/**
 * Write a typing-done marker file so index.js can remove the typing indicator.
 * The marker file name is the original trigger message ID.
 */
function markTypingDone(msgId) {
  if (!msgId) return;
  try {
    fs.mkdirSync(TYPING_DIR, { recursive: true });
    fs.writeFileSync(path.join(TYPING_DIR, `${msgId}.done`), String(Date.now()));
  } catch {
    // Non-critical
  }
}

async function send() {
  try {
    if (mediaMatch) {
      const [, mediaType, mediaPath] = mediaMatch;
      await sendMedia(endpointId, mediaType, mediaPath);
    } else {
      await sendText(endpointId, message);
    }
    // Mark the trigger message as replied (for typing indicator removal)
    markTypingDone(parsedEndpoint.msg);
    console.log('Message sent successfully');
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

send();
