import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { z } from 'zod';

const id = /^[A-Za-z0-9_-]{16}$/;
const invite = /^[A-Za-z0-9_-]{43}$/;
const display = z.string().trim().min(1).max(60);
const hash = value => createHash('sha256').update(value).digest('hex');
const uploadType = 'application/vnd.meetrix.attachment+json';
const fileLimit = 1024 * 1024;
const invalidFile = res => res.status(400).json({ error: 'Choose a PDF, PNG, JPEG, or UTF-8 text file up to 1 MiB.' });
const messageId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const textMessage = z.object({ text: z.string().trim().min(1).max(2000), replyTo: messageId.optional() }).strict();
const attachmentMessage = textMessage.extend({
  text: z.string().trim().max(2000),
  name: z.string().trim().min(1).max(120),
  data: z.string().min(4).max(4 * Math.ceil(fileLimit / 3)),
}).strict();

export function isTeamUpload(req) {
  return req.method === 'POST' && /^\/workspace\/channels\/[A-Za-z0-9_-]{16}\/attachments\/?$/i.test(req.path) && req.is(uploadType);
}

function allowedFile(name, data) {
  if (/[\p{C}\p{Zl}\p{Zp}<>:"/\\|?*]/u.test(name) || name.startsWith('.') ||
      /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])\s*\./i.test(name)) return null;
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > fileLimit || bytes.toString('base64') !== data) return null;
  switch (/\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase()) {
    case 'pdf': return bytes.subarray(0, 5).toString('ascii') === '%PDF-' ? bytes : null;
    case 'png': return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? bytes : null;
    case 'jpg':
    case 'jpeg': return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? bytes : null;
    case 'txt':
    case 'md':
    case 'csv':
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : bytes;
      } catch { return null; }
    default: return null;
  }
}

export function registerTeamChat(api, db, byIdentity) {
  const route = '/workspace/channels';
  const memberships = db.prepare(`
    SELECT c.id, c.title, c.owner = m.identity AS isOwner, m.id AS membership
    FROM team_channels c JOIN team_members m ON m.channel = c.id
    WHERE m.identity = ? ORDER BY c.title COLLATE NOCASE, c.id
  `);
  const member = db.prepare('SELECT m.*, c.owner FROM team_members m JOIN team_channels c ON c.id = m.channel WHERE m.channel = ? AND m.identity = ?');
  const add = db.prepare('INSERT INTO team_members(channel, identity, id, name) SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM team_members WHERE channel = ?) < 100 ON CONFLICT(channel, identity) DO NOTHING');
  const ownerCount = db.prepare('SELECT count(*) AS total FROM team_channels WHERE owner = ?');
  const deleteChannel = db.prepare('DELETE FROM team_channels WHERE id = ? AND owner = ?');
  const leaveChannel = db.prepare('DELETE FROM team_members WHERE channel = ? AND identity = ?');
  const create = db.prepare('INSERT INTO team_channels(id, owner, title) VALUES(?, ?, ?)');
  const findInvite = db.prepare('SELECT id FROM team_channels WHERE invite_hash = ? AND invite_until > ?');
  const rotate = db.prepare('UPDATE team_channels SET invite_hash = ?, invite_until = ? WHERE id = ? AND owner = ?');
  const listMembers = db.prepare('SELECT id, name FROM team_members WHERE channel = ? ORDER BY name COLLATE NOCASE, id');
  const revoke = db.prepare('DELETE FROM team_members WHERE channel = ? AND id = ? AND identity <> ?');
  const messageFields = `SELECT m.id, m.sender AS membership, m.name, m.text, m.sent_at AS sentAt, m.reply_to AS replyTo,
    a.name AS attachmentName, a.size AS attachmentSize,
    (SELECT count(*) FROM team_messages WHERE reply_to = m.id) AS replyCount
    FROM team_messages m LEFT JOIN team_attachments a ON a.message = m.id`;
  const root = db.prepare(messageFields + ' WHERE m.channel = ? AND m.id = ? AND m.reply_to IS NULL');
  const messages = db.prepare(messageFields + ' WHERE m.channel = ? AND m.reply_to IS ? ORDER BY m.id DESC LIMIT 100');
  const send = db.prepare('INSERT INTO team_messages(channel, sender, name, text, sent_at, reply_to) VALUES(?, ?, ?, ?, ?, ?)');
  const addAttachment = db.prepare('INSERT INTO team_attachments(message, channel, name, size, contents) VALUES(?, ?, ?, ?, ?)');
  const getAttachment = db.prepare('SELECT name, contents FROM team_attachments WHERE channel = ? AND message = ?');
  const removeAttachment = db.prepare(`DELETE FROM team_attachments WHERE channel = ? AND message = ? AND
    (? = 1 OR EXISTS (SELECT 1 FROM team_messages WHERE id = team_attachments.message AND sender = ?))`);
  const channelFiles = db.prepare('SELECT count(*) AS total, coalesce(sum(size), 0) AS bytes FROM team_attachments WHERE channel = ?');
  const allFiles = db.prepare('SELECT count(*) AS total, coalesce(sum(size), 0) AS bytes FROM team_attachments');
  const prune = db.prepare('DELETE FROM team_messages WHERE channel = ? AND id < COALESCE((SELECT id FROM team_messages WHERE channel = ? ORDER BY id DESC LIMIT 1 OFFSET 1999), 0)');
  const channels = identity => memberships.all(identity).map(value => ({ ...value, isOwner: Boolean(value.isOwner) }));
  const missing = res => res.status(404).json({ error: 'This channel is unavailable.' });

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function postMessage(req, res, input, contents) {
    const channel = req.params.id;
    const { text, replyTo = null } = input;
    const result = transaction(() => {
      const current = id.test(channel) && member.get(channel, req.identity);
      if (!current) return null;
      if (replyTo && !root.get(channel, replyTo)) return { status: 404, error: 'This thread is unavailable.' };
      if (contents) {
        const local = channelFiles.get(channel);
        const total = allFiles.get();
        if (local.total >= 80 || local.bytes + contents.length > 8 * fileLimit ||
            total.total >= 4000 || total.bytes + contents.length > 256 * fileLimit) {
          return { status: 409, error: 'This channel or workspace has reached its file storage limit.' };
        }
      }
      const sentAt = Date.now();
      const added = Number(send.run(channel, current.id, current.name, text, sentAt, replyTo).lastInsertRowid);
      if (contents) addAttachment.run(added, channel, input.name, contents.length, contents);
      prune.run(channel, channel);
      // A busy channel can prune the parent and its replies at the same time.
      if (replyTo && !root.get(channel, replyTo)) return { status: 409, error: 'This thread has aged out of channel history.' };
      return { id: added, membership: current.id, name: current.name, text, sentAt, replyTo, replyCount: 0,
        attachmentName: contents ? input.name : null, attachmentSize: contents?.length ?? null };
    });
    if (!result) return missing(res);
    if (result.status) return res.status(result.status).json({ error: result.error });
    return res.status(201).json(result);
  }

  api.get(route, (req, res) => res.json(channels(req.identity)));
  api.post(route, byIdentity(8), (req, res) => {
    const { title, name } = z.object({ title: z.string().trim().min(1).max(80), name: display }).strict().parse(req.body);
    const channel = randomBytes(12).toString('base64url');
    const created = transaction(() => {
      if (ownerCount.get(req.identity).total >= 20 || channels(req.identity).length >= 40) return false;
      create.run(channel, req.identity, title);
      add.run(channel, req.identity, randomBytes(12).toString('base64url'), name, channel);
      return true;
    });
    if (!created) return res.status(409).json({ error: 'You have reached the limit for team channels.' });
    res.status(201).json(channels(req.identity).find(row => row.id === channel));
  });
  api.post(route + '/join', byIdentity(10), (req, res) => {
    const { code, name } = z.object({ code: z.string().trim().regex(invite), name: display }).strict().parse(req.body);
    const result = transaction(() => {
      const channel = findInvite.get(hash(code), Date.now());
      if (!channel) return { status: 404 };
      if (member.get(channel.id, req.identity)) return { id: channel.id };
      if (channels(req.identity).length >= 40 ||
          !add.run(channel.id, req.identity, randomBytes(12).toString('base64url'), name, channel.id).changes) return { status: 409 };
      return { id: channel.id };
    });
    if (result.status === 404) return missing(res);
    if (result.status === 409) return res.status(409).json({ error: 'The channel or your workspace is at capacity.' });
    res.json(channels(req.identity).find(row => row.id === result.id));
  });
  api.delete(route + '/:id', byIdentity(15), (req, res) => {
    const channel = req.params.id;
    if (!id.test(channel)) return missing(res);
    const removed = transaction(() => {
      const current = member.get(channel, req.identity);
      if (!current) return false;
      if (current.owner === req.identity) return !!deleteChannel.run(channel, req.identity).changes;
      return !!leaveChannel.run(channel, req.identity).changes;
    });
    return removed ? res.json({ ok: true }) : missing(res);
  });
  api.get(route + '/:id/messages', (req, res) => {
    const channel = req.params.id;
    const current = id.test(channel) && member.get(channel, req.identity);
    if (!current) return missing(res);
    res.json({
      messages: messages.all(channel, null).reverse(),
      members: current.owner === req.identity ? listMembers.all(channel).filter(row => row.id !== current.id) : [],
    });
  });
  api.post(route + '/:id/messages', byIdentity(60), (req, res) => {
    return postMessage(req, res, textMessage.parse(req.body));
  });
  api.get(route + '/:id/messages/:message/replies', (req, res) => {
    const channel = req.params.id;
    const target = Number(req.params.message);
    if (!id.test(channel) || !member.get(channel, req.identity) || !messageId.safeParse(target).success) return missing(res);
    const parent = root.get(channel, target);
    if (!parent) return res.status(404).json({ error: 'This thread is unavailable.' });
    res.json({ parent, replies: messages.all(channel, target).reverse() });
  });
  api.post(route + '/:id/attachments', byIdentity(15), (req, res, next) => {
    if (!id.test(req.params.id) || !member.get(req.params.id, req.identity)) return missing(res);
    if (!isTeamUpload(req)) return res.status(415).json({ error: 'Send a chat attachment request.' });
    next();
  }, express.json({ type: uploadType, limit: '1400kb', inflate: false }), (req, res) => {
    const parsed = attachmentMessage.safeParse(req.body);
    if (!parsed.success) return invalidFile(res);
    const contents = allowedFile(parsed.data.name, parsed.data.data);
    return contents ? postMessage(req, res, parsed.data, contents) : invalidFile(res);
  });
  api.get(route + '/:id/attachments/:message', byIdentity(60), (req, res) => {
    const channel = req.params.id;
    const target = Number(req.params.message);
    if (!id.test(channel) || !member.get(channel, req.identity) || !messageId.safeParse(target).success) return missing(res);
    const file = getAttachment.get(channel, target);
    if (!file) return res.status(404).json({ error: 'This file is unavailable.' });
    res.attachment(file.name).type('application/octet-stream').send(Buffer.from(file.contents));
  });
  api.delete(route + '/:id/attachments/:message', byIdentity(20), (req, res) => {
    const channel = req.params.id;
    const target = Number(req.params.message);
    const current = id.test(channel) && member.get(channel, req.identity);
    if (!current || !messageId.safeParse(target).success ||
        !removeAttachment.run(channel, target, current.owner === req.identity ? 1 : 0, current.id).changes) return missing(res);
    res.json({ ok: true });
  });
  api.post(route + '/:id/invite', byIdentity(12), (req, res) => {
    const channel = req.params.id;
    const code = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    if (!id.test(channel) || !rotate.run(hash(code), expiresAt, channel, req.identity).changes) return missing(res);
    res.json({ code, expiresAt });
  });
  api.delete(route + '/:id/members/:member', byIdentity(25), (req, res) => {
    const channel = req.params.id;
    const target = req.params.member;
    if (!id.test(channel) || !id.test(target)) return missing(res);
    const removed = transaction(() => {
      const current = member.get(channel, req.identity);
      if (current?.owner !== req.identity || !revoke.run(channel, target, req.identity).changes) return false;
      rotate.run(null, null, channel, req.identity);
      return true;
    });
    return removed ? res.json({ ok: true }) : missing(res);
  });
}
