import React, { useEffect, useRef } from 'react';
import { Orbit, X } from 'lucide-react';

export function Logo() {
  return <div className="brand"><span className="brand-mark"><Orbit size={22} strokeWidth={2.2} /></span> Meetrix</div>;
}

export function Dialog({ title, children, close }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="dialog" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-head"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={20} /></button></div>
    {children}
  </dialog>;
}
