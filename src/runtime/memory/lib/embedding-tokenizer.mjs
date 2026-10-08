// Compact encoder for Unigram tokenizer.json files (the XLM-R family used by
// multilingual-e5 and bge-m3). The generic tokenizer library turns a
// 250k-piece vocabulary into JavaScript objects (~200 MB resident); this keeps
// the pieces in one string pool with typed-array scores and an open-addressing
// index (~20 MB). Behaviour mirrors @huggingface/tokenizers, which produced
// every stored vector: the Precompiled normalizer approximation, Metaspace,
// Viterbi tie-breaking, fuse_unk, added-token splitting and the single-sequence
// template, then truncation to the model window.
import { readFileSync } from 'node:fs';

export class UnsupportedTokenizerError extends Error {}

const META = '\u2581';

// The library's stand-in for SentencePiece's precompiled charsmap.
function precompiledNormalize(text) {
  text = text.replace(/[\u0001-\u0008\u000B\u000E-\u001F\u007F\u008F\u009F]/gm, '');
  text = text.replace(/[\u0009\u000A\u000C\u000D\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u2581\u3000\uFEFF\uFFFD]/gm, ' ');
  return text.includes('\uFF5E')
    ? text
        .split('\uFF5E')
        .map((part) => part.normalize('NFKC'))
        .join('\uFF5E')
    : text.normalize('NFKC');
}

function buildNormalizer(spec) {
  const steps = spec?.type === 'Sequence' ? spec.normalizers : spec ? [spec] : [];
  const fns = steps.map((step) => {
    if (step.type === 'Precompiled') return precompiledNormalize;
    if (step.type === 'Replace' && step.pattern?.Regex != null) {
      const re = new RegExp(step.pattern.Regex, 'gu');
      return (text) => text.replace(re, step.content);
    }
    if (step.type === 'Replace' && step.pattern?.String != null) return (text) => text.replaceAll(step.pattern.String, step.content);
    throw new UnsupportedTokenizerError(`unsupported normalizer ${step.type}`);
  });
  return (text) => fns.reduce((acc, fn) => fn(acc), text);
}

// Longest dictionary word at each position, like the library's DictionarySplitter.
function splitOn(words, text) {
  if (words.length === 0) return [text];
  const out = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    let match = null;
    for (const w of words) if (text.startsWith(w, i) && (!match || w.length > match.length)) match = w;
    if (match) {
      if (i > start) out.push(text.slice(start, i));
      out.push(match);
      i += match.length;
      start = i;
    } else i++;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Loads tokenizer.json; throws UnsupportedTokenizerError for any other layout. */
export function loadUnigramTokenizer(tokenizerJsonPath, { maxLength = 512 } = {}) {
  const json = JSON.parse(readFileSync(tokenizerJsonPath, 'utf8'));
  const model = json.model;
  const pre = json.pre_tokenizer;
  const template = json.post_processor;
  if (model?.type !== 'Unigram') throw new UnsupportedTokenizerError(`unsupported model ${model?.type}`);
  if (pre?.type !== 'Metaspace') throw new UnsupportedTokenizerError(`unsupported pre-tokenizer ${pre?.type}`);
  if (template?.type !== 'TemplateProcessing') throw new UnsupportedTokenizerError(`unsupported post-processor ${template?.type}`);
  const normalize = buildNormalizer(json.normalizer);

  const n = model.vocab.length;
  const scores = new Float64Array(n);
  const offsets = new Int32Array(n + 1);
  const pieces = [];
  let length = 0;
  let maxChars = 1;
  let minScore = Infinity;
  for (let i = 0; i < n; i++) {
    const [piece, score] = model.vocab[i];
    scores[i] = score;
    if (score < minScore) minScore = score;
    offsets[i] = length;
    pieces.push(piece);
    length += piece.length;
    maxChars = Math.max(maxChars, Array.from(piece).length);
  }
  offsets[n] = length;
  const pool = pieces.join('');
  pieces.length = 0;

  let size = 1;
  while (size < n * 2) size <<= 1;
  const mask = size - 1;
  const slots = new Int32Array(size); // id + 1; 0 = empty
  const hash = (str, a, b) => {
    let h = 0x811c9dc5;
    for (let k = a; k < b; k++) h = Math.imul(h ^ str.charCodeAt(k), 0x01000193);
    return h >>> 0;
  };
  const same = (id, str, a, b) => {
    const s = offsets[id];
    if (offsets[id + 1] - s !== b - a) return false;
    for (let k = 0; k < b - a; k++) if (pool.charCodeAt(s + k) !== str.charCodeAt(a + k)) return false;
    return true;
  };
  // A duplicated piece resolves to its last id, like the library's Map.
  for (let i = 0; i < n; i++) {
    let slot = hash(pool, offsets[i], offsets[i + 1]) & mask;
    while (slots[slot] !== 0 && !same(slots[slot] - 1, pool, offsets[i], offsets[i + 1])) slot = (slot + 1) & mask;
    slots[slot] = i + 1;
  }
  const lookup = (str, a, b) => {
    let slot = hash(str, a, b) & mask;
    for (;;) {
      const v = slots[slot];
      if (v === 0) return -1;
      if (same(v - 1, str, a, b)) return v - 1;
      slot = (slot + 1) & mask;
    }
  };
  const unkId = model.unk_id;
  const unkScore = minScore - 10;
  scores[unkId] = unkScore;
  const pieceIdOrUnk = (t) => {
    const id = lookup(t, 0, t.length);
    return id < 0 ? unkId : id;
  };

  const added = new Map();
  const rawAdded = [];
  const normalizedAdded = [];
  for (const t of json.added_tokens || []) {
    added.set(t.content, t);
    if (t.normalized) {
      const content = normalize(t.content);
      normalizedAdded.push(content);
      added.set(content, t);
    } else rawAdded.push(t.content);
  }
  const stripAround = (sections) => {
    sections.forEach((s, i) => {
      const t = added.get(s);
      if (!t) return;
      if (t.lstrip && i > 0) sections[i - 1] = sections[i - 1].trimEnd();
      if (t.rstrip && i < sections.length - 1) sections[i + 1] = sections[i + 1].trimStart();
    });
    return sections;
  };
  const replacement = pre.replacement ?? META;
  const strRep = pre.str_rep || replacement;
  const prependScheme = pre.prepend_scheme ?? 'always';

  function viterbi(sentence) {
    const chars = Array.from(sentence);
    const L = chars.length;
    const unit = new Int32Array(L + 1);
    for (let i = 0; i < L; i++) unit[i + 1] = unit[i] + chars[i].length;
    const pos = [0, L];
    const len = [0, 0];
    const score = [0, 0];
    const begins = Array.from({ length: L + 1 }, () => []);
    const ends = Array.from({ length: L + 1 }, () => []);
    begins[L].push(1);
    ends[0].push(0);
    const insert = (p, l, s) => {
      const k = pos.length;
      pos.push(p);
      len.push(l);
      score.push(s);
      begins[p].push(k);
      ends[p + l].push(k);
    };
    for (let b = 0; b < L; b++) {
      let single = false;
      const last = Math.min(L, b + maxChars);
      for (let e = b + 1; e <= last; e++) {
        const id = lookup(sentence, unit[b], unit[e]);
        if (id < 0) continue;
        insert(b, e - b, scores[id]);
        if (e - b === 1) single = true;
      }
      if (!single) insert(b, 1, unkScore);
    }
    const best = new Float64Array(pos.length);
    const prev = new Int32Array(pos.length).fill(-1);
    for (let p = 0; p <= L; p++) {
      for (const r of begins[p]) {
        let from = -1;
        let top = 0;
        for (const l of ends[p]) {
          const s = best[l] + score[r];
          if (from === -1 || s > top) {
            from = l;
            top = s;
          }
        }
        prev[r] = from;
        best[r] = top;
      }
    }
    const out = [];
    for (let k = prev[begins[L][0]]; k > 0; k = prev[k]) out.push(chars.slice(pos[k], pos[k] + len[k]).join(''));
    return out.reverse();
  }

  function fuseUnk(tokens) {
    const fused = [];
    let i = 0;
    while (i < tokens.length) {
      fused.push(tokens[i]);
      if (pieceIdOrUnk(tokens[i]) !== unkId) {
        ++i;
        continue;
      }
      while (++i < tokens.length && pieceIdOrUnk(tokens[i]) === unkId) {
        if (pieceIdOrUnk(fused.at(-1)) !== unkId) fused[fused.length - 1] += tokens[i];
      }
    }
    return fused;
  }

  function tokens(text) {
    return stripAround(splitOn(rawAdded, text)).flatMap((section, sectionIndex) => {
      if (section.length === 0) return [];
      if (added.has(section)) return [section];
      const normalized = normalize(section);
      if (normalized.length === 0) return [];
      return stripAround(splitOn(normalizedAdded, normalized)).flatMap((sub) => {
        if (sub.length === 0) return [];
        if (added.has(sub)) return [sub];
        let piece = sub.replaceAll(' ', strRep);
        if (!piece.startsWith(replacement) && (prependScheme === 'always' || (prependScheme === 'first' && sectionIndex === 0))) {
          piece = strRep + piece;
        }
        return fuseUnk(viterbi(piece));
      });
    });
  }

  const specialIds = (entry) => template.special_tokens[entry.SpecialToken.id].ids;
  const seqAt = template.single.findIndex((entry) => entry.Sequence);
  const prefix = template.single.slice(0, seqAt).flatMap(specialIds);
  const suffix = template.single.slice(seqAt + 1).flatMap(specialIds);
  return {
    /** Token ids with the template's special tokens, cut to maxLength. */
    encode(text) {
      const body = tokens(text).map((t) => added.get(t)?.id ?? pieceIdOrUnk(t));
      const ids = [...prefix, ...body, ...suffix];
      return ids.length > maxLength ? ids.slice(0, maxLength) : ids;
    },
  };
}
