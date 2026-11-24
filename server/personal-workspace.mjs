import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const input = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(12000).default(''),
  dueDate: z.iso.date().nullable().default(null),
  completed: z.boolean().default(false),
}).strict();
const update = input.extend({ version: z.number().int().positive() });
const recordId = /^[A-Za-z0-9_-]{16}$/;
const maxItems = 200;

export function registerPersonalWorkspace(api, db, byIdentity) {
  const columns = 'id, title, due_date AS dueDate, completed, updated_at AS updatedAt, version';
  const list = db.prepare('SELECT ' + columns + ' FROM workspace_items WHERE owner = ? AND kind = ? ORDER BY updated_at DESC, id');
  const find = db.prepare('SELECT ' + columns + ', body FROM workspace_items WHERE owner = ? AND kind = ? AND id = ?');
  const insert = db.prepare('INSERT INTO workspace_items(id, owner, kind, title, body, due_date, completed, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM workspace_items WHERE owner = ? AND kind = ?) < ?');
  const save = db.prepare('UPDATE workspace_items SET title = ?, body = ?, due_date = ?, completed = ?, updated_at = ?, version = version + 1 WHERE owner = ? AND kind = ? AND id = ? AND version = ?');
  const remove = db.prepare('DELETE FROM workspace_items WHERE owner = ? AND kind = ? AND id = ? AND version = ?');
  const format = row => ({ ...row, completed: Boolean(row.completed) });
  const missing = res => res.status(404).json({ error: 'Workspace item not found.' });

  for (const kind of ['tasks', 'canvases']) {
    const path = '/workspace/' + kind;
    const writeLimit = byIdentity(60);
    const properties = value => [value.title, value.body, kind === 'tasks' ? value.dueDate : null,
      Number(kind === 'tasks' && value.completed), Date.now()];
    api.get(path, (req, res) => res.json(list.all(req.identity, kind).map(format)));
    api.post(path, writeLimit, (req, res) => {
      const value = input.parse(req.body);
      const id = randomBytes(12).toString('base64url');
      const args = [req.identity, kind];
      if (!insert.run(id, ...args, ...properties(value), ...args, maxItems).changes) {
        return res.status(409).json({ error: 'This workspace already has 200 items of this type.' });
      }
      res.status(201).json(format(find.get(...args, id)));
    });
    api.get(path + '/:id', (req, res) => {
      if (!recordId.test(req.params.id)) return missing(res);
      const row = find.get(req.identity, kind, req.params.id);
      return row ? res.json(format(row)) : missing(res);
    });
    api.put(path + '/:id', writeLimit, (req, res) => {
      if (!recordId.test(req.params.id)) return missing(res);
      const value = update.parse(req.body);
      const args = [req.identity, kind, req.params.id];
      const changed = save.run(...properties(value), ...args, value.version).changes;
      const row = find.get(...args);
      if (!row) return missing(res);
      if (!changed) return res.status(409).json({ error: 'This item changed elsewhere. Reopen it to get the latest version.' });
      res.json(format(row));
    });
    api.delete(path + '/:id', writeLimit, (req, res) => {
      if (!recordId.test(req.params.id)) return missing(res);
      const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
      const args = [req.identity, kind, req.params.id];
      if (remove.run(...args, version).changes) return res.json({ ok: true });
      if (!find.get(...args)) return missing(res);
      res.status(409).json({ error: 'This item changed elsewhere. Reopen it before deleting.' });
    });
  }
}
