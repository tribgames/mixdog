'use strict';

/** Catastrophic delete targets (shared rm / Remove-Item / del guards). */
export function isDangerousDeleteTarget(rawTarget) {
  if (rawTarget == null) return false;
  const t = String(rawTarget).trim().replace(/^['"]|['"]$/g, '').trim();
  if (t === '') return false;
  if (t === '*' || t === '.' || t === './' || t === '.\\' || t === '.*') return true;
  const low = t.toLowerCase();
  if (/^\$home(\b|[\\/])/.test(low)) return true;
  if (/^\$env:(userprofile|homepath|home|homedrive|systemroot|windir|programfiles|programdata|systemdrive|allusersprofile|public|appdata|localappdata)\b/.test(low)) return true;
  if (/^%(userprofile|homepath|home|homedrive|systemroot|windir|programfiles|programdata|systemdrive|allusersprofile|public|appdata|localappdata)%/i.test(t)) return true;
  if (/^\$\{(home|userprofile|homepath|homedrive|systemroot|windir|programfiles|programdata|systemdrive)\}/i.test(t)) return true;
  if (/^\$\(home\)/i.test(t)) return true;
  if (/^\\\\[^\\]+\\[^\\]+\\\*?$/.test(t) || /^\\\\[^\\]+\\[^\\]*$/.test(t)) return true;
  if (t.startsWith('$') || t.includes('$(') || /^%[^%]*%/.test(t)) return false;
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) return true;
  if (t === '/' || t === '\\') return true;
  if (t === '/*' || t === '\\*' || t === '/.' || t === '/*.*') return true;
  const unix = t.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (/^\/(etc|usr|bin|sbin|lib|lib64|boot|sys|proc|dev|root|var|home|opt|srv|system|library|applications|users|private|volumes)(\/\*)?$/.test(unix)) return true;
  const win = t.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  if (/^[a-z]:$/.test(win)) return true;
  if (/^[a-z]:\\\*/.test(win)) return true;
  if (/^[a-z]:\\(windows|program files( \(x86\))?|programdata|users)$/.test(win)) return true;
  return false;
}