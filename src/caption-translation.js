import { useEffect, useRef, useState } from 'react';

export const captionLanguages = { original: 'Original', hi: 'Hindi', es: 'Spanish' };

export function useCaptionTranslation(entries, enabled) {
  const [language, setLanguage] = useState('original');
  const [results, setResults] = useState({});
  const [status, setStatus] = useState('');
  const queue = useRef([]);
  const enqueue = useRef(null);

  useEffect(() => {
    if (!enabled || language === 'original') return;
    let worker;
    let pending = null;
    let timeout;
    let ready = false;
    let closed = false;
    const requested = new Set();
    setResults({});
    setStatus('');

    function fail() {
      closed = true;
      clearTimeout(timeout);
      worker?.terminate();
      setStatus('Translation is unavailable. Original captions are still visible.');
    }

    function next() {
      if (!worker || pending || closed) return;
      const entry = queue.current.find(item => !requested.has(item.id));
      if (!entry) return;
      requested.add(entry.id);
      if (requested.size > 1000) requested.delete(requested.values().next().value);
      pending = entry.id;
      setStatus(ready ? '' : 'Loading caption translation…');
      timeout = setTimeout(fail, ready ? 15000 : 65000);
      worker.postMessage({ language, id: entry.id, text: entry.line });
    }

    try {
      worker = new Worker(new URL('./caption-translation-worker.js', import.meta.url), { type: 'module' });
      worker.onerror = fail;
      worker.onmessage = ({ data }) => {
        if (closed || data?.id !== pending) return;
        clearTimeout(timeout);
        pending = null;
        if (data.error) { fail(); return; }
        ready = true;
        setStatus('');
        setResults(previous => {
          const latest = Object.entries(previous).slice(-999);
          return { ...Object.fromEntries(latest), [data.id]: data.text };
        });
        next();
      };
      enqueue.current = next;
      next();
    } catch { fail(); }

    return () => {
      closed = true;
      clearTimeout(timeout);
      enqueue.current = null;
      worker?.terminate();
    };
  }, [enabled, language]);

  useEffect(() => {
    queue.current = entries.slice(-8).filter(entry => entry.speaker);
    enqueue.current?.();
  }, [entries]);

  function choose(next) {
    if (!Object.hasOwn(captionLanguages, next)) return;
    setResults({});
    setStatus('');
    setLanguage(next);
  }

  return { language, choose, results: language === 'original' ? {} : results, status };
}
