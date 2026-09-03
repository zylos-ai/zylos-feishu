/**
 * Thread-aware outbound file/video routing for the C4 send bridge.
 *
 * Feishu uses the same uploaded file key for ordinary files and MP4 video, but
 * the message type must be `media` for video to render inline. Everything is
 * injectable so routing and payload behavior can be tested without API calls.
 */

import path from 'path';
import { chooseReplyTarget } from './reply-target.js';
import {
  uploadFile as defaultUploadFile,
  sendFile as defaultSendFile,
  replyToMessage as defaultReplyToMessage,
} from './message.js';

function describeFileMedia(type, filePath) {
  if (type !== 'file' && type !== 'video') {
    throw new Error(`Unsupported file media type: ${type}`);
  }

  const isVideo = type === 'video' || path.extname(filePath).toLowerCase() === '.mp4';
  return {
    uploadType: isVideo ? 'mp4' : undefined,
    messageType: isVideo ? 'media' : 'file',
    recordLabel: isVideo ? '[sent video]' : '[sent file]',
    displayName: isVideo ? 'video' : 'file',
  };
}

/**
 * Upload and send an ordinary file or MP4 video, preserving the existing
 * p2p/group/thread routing and parent -> root -> chat fallback chain.
 */
export async function sendFileMediaThreadAware(
  { endpoint, type, filePath },
  deps = {},
) {
  const uploadFile = deps.uploadFile ?? defaultUploadFile;
  const sendFile = deps.sendFile ?? defaultSendFile;
  const replyToMessage = deps.replyToMessage ?? defaultReplyToMessage;
  const trimmedPath = filePath.trim();
  const media = describeFileMedia(type, trimmedPath);
  const { chatId, root, parent } = endpoint;
  const replyTarget = chooseReplyTarget(endpoint);

  const uploadResult = media.uploadType
    ? await uploadFile(trimmedPath, media.uploadType)
    : await uploadFile(trimmedPath);
  if (!uploadResult.success) {
    throw new Error(`Failed to upload ${media.displayName}: ${uploadResult.message}`);
  }

  const content = JSON.stringify({ file_key: uploadResult.fileKey });
  const successfulResult = result => ({ ...result, recordLabel: media.recordLabel });

  if (replyTarget) {
    try {
      const result = await replyToMessage(replyTarget, content, media.messageType);
      if (result.success) return successfulResult(result);
      console.log(`[feishu] ${media.displayName} reply failed, falling back to sendFile:`, result.message);
      if (parent && root && parent !== root) {
        const rootReply = await replyToMessage(root, content, media.messageType);
        if (rootReply.success) return successfulResult(rootReply);
        console.log(`[feishu] ${media.displayName} root reply fallback failed, falling back to sendFile:`, rootReply.message);
      }
    } catch (err) {
      console.log(`[feishu] ${media.displayName} reply threw, falling back:`, err.message);
      if (parent && root && parent !== root) {
        try {
          const rootReply = await replyToMessage(root, content, media.messageType);
          if (rootReply.success) return successfulResult(rootReply);
        } catch {}
      }
    }
  }

  const sendResult = await sendFile(chatId, uploadResult.fileKey, 'chat_id', media.messageType);
  if (!sendResult.success) {
    throw new Error(`Failed to send ${media.displayName}: ${sendResult.message}`);
  }
  return successfulResult(sendResult);
}
