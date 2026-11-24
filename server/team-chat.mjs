import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

const id = /^[A-Za-z0-9_-]{16}$/;
const invite = /^[A-Za-z0-9_-]{43}$/;
const display = z.string().trim().min(1).max(60);
const hash = value => createHash('sha256').update(value).digest('hex');

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
  const messages = db.prepare('SELECT id, sender AS membership, name, text, sent_at AS sentAt FROM team_messages WHERE channel = ? ORDER BY id DESC LIMIT 100');
  const send = db.prepare('INSERT INTO team_messages(channel, sender, name, text, sent_at) VALUES(?, ?, ?, ?, ?)');
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
      messages: messages.all(channel).reverse(),
      members: current.owner === req.identity ? listMembers.all(channel).filter(row => row.id !== current.id) : [],
    });
  });
  api.post(route + '/:id/messages', byIdentity(60), (req, res) => {
    const channel = req.params.id;
    const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
    const result = transaction(() => {
      const current = id.test(channel) && member.get(channel, req.identity);
      if (!current) return null;
      const sentAt = Date.now();
      const added = send.run(channel, current.id, current.name, text, sentAt);
      prune.run(channel, channel);
      return { id: Number(added.lastInsertRowid), membership: current.id, name: current.name, text, sentAt };
    });
    return result ? res.status(201).json(result) : missing(res);
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
