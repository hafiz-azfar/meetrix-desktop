import { useEffect, useRef, useState } from 'react';

export const recapLimit = 72_000;
const chunkLimit = 1800;
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

export function recapChunks(entries) {
  const chunks = [];
  let text = '';
  let first;
  let last;
  for (const { line, speaker, at } of entries) {
    const piece = speaker ? speaker + ': ' + line : line;
    if (text && text.length + piece.length + 1 > chunkLimit) {
      chunks.push({ text, first, last });
      text = '';
    }
    if (!text) first = at;
    text += (text ? '\n' : '') + piece;
    last = at;
  }
  if (text) chunks.push({ text, first, last });
  return chunks;
}

export function useMeetingRecap() {
  const [status, setStatus] = useState('idle');
  const [count, setCount] = useState(0);
  const [limited, setLimited] = useState(false);
  const [progress, setProgress] = useState('');
  const [draft, setDraft] = useState('');
  const capture = useRef({ active: false, entries: [], length: 0, limited: false });
  const currentJob = useRef(null);

  function cancelJob() {
    const job = currentJob.current;
    currentJob.current = null;
    clearTimeout(job?.timeout);
    job?.worker.terminate();
  }
  useEffect(() => cancelJob, []);

  function append(entry) {
    const current = capture.current;
    if (!current.active || current.limited) return;
    const size = entry.line.length + entry.speaker.length + 3;
    if (current.length + size > recapLimit || current.entries.length >= 3500) {
      current.limited = true;
      setLimited(true);
      return;
    }
    current.entries.push(entry);
    current.length += size;
    setCount(current.entries.length);
  }

  function start() {
    cancelJob();
    capture.current = { active: true, entries: [], length: 0, limited: false };
    setDraft('');
    setProgress('');
    setCount(0);
    setLimited(false);
    setStatus('collecting');
  }

  function discard() {
    cancelJob();
    capture.current = { active: false, entries: [], length: 0, limited: false };
    setDraft('');
    setCount(0);
    setLimited(false);
    setProgress('');
    setStatus('idle');
  }

  function finish() {
    if (currentJob.current) return true;
    const source = capture.current;
    if (!source.active) return ['ready', 'error'].includes(status);
    source.active = false;
    const chunks = recapChunks(source.entries);
    if (!chunks.length) { discard(); return false; }
    try {
      const worker = new Worker(new URL('./caption-translation-worker.js', import.meta.url), { type: 'module' });
      const job = { worker, next: 0, parts: [], id: crypto.randomUUID() };
      currentJob.current = job;
      setStatus('generating');

      function fail() {
        if (currentJob.current !== job) return;
        cancelJob();
        setDraft(job.parts.join('\n\n'));
        setStatus('error');
        setProgress('A section could not be summarized. Any completed sections are below.');
      }

      function next() {
        const chunk = chunks[job.next];
        if (!chunk) {
          cancelJob();
          setDraft(job.parts.join('\n\n') + (source.limited ? '\n\nCollection reached the local transcript limit.' : ''));
          setProgress('');
          setStatus('ready');
          return;
        }
        setProgress('Summarizing section ' + (job.next + 1) + ' of ' + chunks.length + '…');
        job.timeout = setTimeout(fail, 90_000);
        worker.postMessage({ id: job.id + ':' + job.next, text: chunk.text, action: 'summarize' });
      }
      worker.onmessage = ({ data }) => {
        if (currentJob.current !== job || data?.id !== job.id + ':' + job.next) return;
        clearTimeout(job.timeout);
        if (!data.text) { fail(); return; }
        const { first, last } = chunks[job.next];
        const heading = chunks.length > 1 ? time.format(first) + ' – ' + time.format(last) + '\n' : '';
        job.parts.push(heading + data.text);
        job.next += 1;
        next();
      };
      worker.onerror = fail;
      next();
    } catch {
      cancelJob();
      setStatus('error');
      setProgress('The recap model could not start.');
    }
    return true;
  }

  function sourceText() {
    return capture.current.entries.map(({ at, speaker, line }) =>
      time.format(at) + '  ' + (speaker ? speaker + ': ' : '') + line).join('\n');
  }

  return { status, count, limited, progress, draft, setDraft, append, start, finish, discard, sourceText };
}
