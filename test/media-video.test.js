import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sendFileMediaThreadAware,
} from '../src/lib/file-media.js';
import { buildFileMessagePayload } from '../src/lib/message.js';

function mediaSpies({ replyResults = [] } = {}) {
  const calls = { upload: [], reply: [], send: [] };
  let replyIndex = 0;
  return {
    calls,
    deps: {
      uploadFile: async (...args) => {
        calls.upload.push(args);
        return { success: true, fileKey: 'file_key_1' };
      },
      replyToMessage: async (...args) => {
        calls.reply.push(args);
        return replyResults[replyIndex++] ?? { success: true };
      },
      sendFile: async (...args) => {
        calls.send.push(args);
        return { success: true };
      },
    },
  };
}

test('MEDIA:video uploads as mp4 and sends a visible media message in p2p DMs', async () => {
  const { calls, deps } = mediaSpies();

  const result = await sendFileMediaThreadAware(
    { endpoint: { chatId: 'oc_dm', type: 'p2p', msg: 'om_trigger' }, type: 'video', filePath: '/tmp/clip.mp4' },
    deps,
  );

  assert.deepEqual(calls.upload, [['/tmp/clip.mp4', 'mp4']]);
  assert.deepEqual(calls.reply, [], 'p2p media must never use reply-to');
  assert.deepEqual(calls.send, [['oc_dm', 'file_key_1', 'chat_id', 'media']]);
  assert.equal(result.recordLabel, '[sent video]');
});

test('MEDIA:file with an mp4 uses the same mp4/media behavior and video label', async () => {
  const { calls, deps } = mediaSpies();

  const result = await sendFileMediaThreadAware(
    { endpoint: { chatId: 'oc_group', type: 'group' }, type: 'file', filePath: '/tmp/CLIP.MP4' },
    deps,
  );

  assert.deepEqual(calls.upload, [['/tmp/CLIP.MP4', 'mp4']]);
  assert.deepEqual(calls.send, [['oc_group', 'file_key_1', 'chat_id', 'media']]);
  assert.equal(result.recordLabel, '[sent video]');
});

test('ordinary MEDIA:file keeps inferred upload type and file message type', async () => {
  const { calls, deps } = mediaSpies();

  const result = await sendFileMediaThreadAware(
    { endpoint: { chatId: 'oc_group', type: 'group' }, type: 'file', filePath: ' /tmp/report.pdf ' },
    deps,
  );

  assert.deepEqual(calls.upload, [['/tmp/report.pdf']]);
  assert.deepEqual(calls.send, [['oc_group', 'file_key_1', 'chat_id', 'file']]);
  assert.equal(result.recordLabel, '[sent file]');
});

test('group thread video replies to parent as media', async () => {
  const { calls, deps } = mediaSpies();

  await sendFileMediaThreadAware(
    {
      endpoint: { chatId: 'oc_group', type: 'group', root: 'om_root', parent: 'om_parent' },
      type: 'video',
      filePath: '/tmp/clip.mp4',
    },
    deps,
  );

  assert.deepEqual(calls.reply, [[
    'om_parent',
    JSON.stringify({ file_key: 'file_key_1' }),
    'media',
  ]]);
  assert.deepEqual(calls.send, []);
});

test('group @mention video replies to the triggering message as media', async () => {
  const { calls, deps } = mediaSpies();

  await sendFileMediaThreadAware(
    { endpoint: { chatId: 'oc_group', type: 'group', msg: 'om_trigger' }, type: 'video', filePath: '/tmp/clip.mp4' },
    deps,
  );

  assert.equal(calls.reply[0][0], 'om_trigger');
  assert.equal(calls.reply[0][2], 'media');
  assert.deepEqual(calls.send, []);
});

test('failed parent video reply falls back to root and then chat send', async () => {
  const { calls, deps } = mediaSpies({
    replyResults: [
      { success: false, message: 'parent failed' },
      { success: false, message: 'root failed' },
    ],
  });

  await sendFileMediaThreadAware(
    {
      endpoint: { chatId: 'oc_group', type: 'group', root: 'om_root', parent: 'om_parent' },
      type: 'video',
      filePath: '/tmp/clip.mp4',
    },
    deps,
  );

  assert.deepEqual(calls.reply.map(([target, , msgType]) => [target, msgType]), [
    ['om_parent', 'media'],
    ['om_root', 'media'],
  ]);
  assert.deepEqual(calls.send, [['oc_group', 'file_key_1', 'chat_id', 'media']]);
});

test('unsupported file media type fails before upload', async () => {
  const { calls, deps } = mediaSpies();

  await assert.rejects(
    () => sendFileMediaThreadAware(
      { endpoint: { chatId: 'oc_group', type: 'group' }, type: 'audio', filePath: '/tmp/sound.opus' },
      deps,
    ),
    /Unsupported file media type: audio/,
  );
  assert.deepEqual(calls.upload, []);
});

test('video upload failure is surfaced so send.js exits non-zero', async () => {
  const { calls, deps } = mediaSpies();
  deps.uploadFile = async (...args) => {
    calls.upload.push(args);
    return { success: false, message: 'upload failed' };
  };

  await assert.rejects(
    () => sendFileMediaThreadAware(
      { endpoint: { chatId: 'oc_dm', type: 'p2p' }, type: 'video', filePath: '/tmp/clip.mp4' },
      deps,
    ),
    /Failed to upload video: upload failed/,
  );
  assert.deepEqual(calls.send, []);
});

test('video send failure is surfaced so send.js exits non-zero', async () => {
  const { deps } = mediaSpies();
  deps.sendFile = async () => ({ success: false, message: 'send failed' });

  await assert.rejects(
    () => sendFileMediaThreadAware(
      { endpoint: { chatId: 'oc_dm', type: 'p2p' }, type: 'video', filePath: '/tmp/clip.mp4' },
      deps,
    ),
    /Failed to send video: send failed/,
  );
});

test('file message payload selects media only when requested', () => {
  assert.deepEqual(buildFileMessagePayload('oc_chat', 'file_key_1', 'media'), {
    receive_id: 'oc_chat',
    msg_type: 'media',
    content: JSON.stringify({ file_key: 'file_key_1' }),
  });
  assert.deepEqual(buildFileMessagePayload('oc_chat', 'file_key_1'), {
    receive_id: 'oc_chat',
    msg_type: 'file',
    content: JSON.stringify({ file_key: 'file_key_1' }),
  });
});
