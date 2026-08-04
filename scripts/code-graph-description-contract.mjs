const FILE_MODES = ['overview', 'imports', 'dependents', 'related', 'impact'];
const SYMBOL_MODES = ['find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'];
const EXACT_MODES = ['find_symbol', 'references', 'callers', 'callees'];
const KEYWORD_MODES = ['symbol_search', 'search'];
const NEGATION = /\b(?:no|not|never|without|cannot|won['’]t|ain['’]t|(?:is|are|was|were|do|does|did|has|have|had|can|could|would|should|must)(?:\s+not|n['’]t)|will\s+not|fail(?:s|ed|ing)?\s+to)\b/i;

const clauses = (text) => String(text || '').split(/[.;]\s*/).map((part) => part.trim()).filter(Boolean);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const includesTerm = (text, term) => {
  if (/^[a-z_][a-z0-9_]*$/i.test(term)) {
    return new RegExp(`(?<![a-z0-9_])${escapeRegExp(term)}(?![a-z0-9_])`, 'i').test(text);
  }
  return text.toLowerCase().includes(term.toLowerCase());
};
const includesAll = (text, terms) => terms.every((term) => includesTerm(text, term));
const hasPositiveClause = (text, terms) => clauses(text).some((clause) => !NEGATION.test(clause) && includesAll(clause, terms));
const hasModeClause = (text, label, modes, target = null) => (
  hasPositiveClause(text, [label, ...modes, ...(target ? [target] : [])])
);
const hasContradictoryTargetAssignment = (text) => (
  hasPositiveClause(text, [...FILE_MODES, 'symbols[]'])
  || hasPositiveClause(text, [...SYMBOL_MODES, 'files[]'])
);
const removeIdentifier = (text, identifier) => (
  text.replace(new RegExp(`(?<![a-z0-9_])${escapeRegExp(identifier)}(?![a-z0-9_])`, 'gi'), '')
);

const CODE_GRAPH_EQUIVALENT_DESCRIPTION_PROBES = [
  {
    description: [
      'Keywords use search/symbol_search while callers/callees/references/find_symbol use exact identifiers.',
      'symbols[] targets callees, search, references, symbol_search, callers, and find_symbol symbol modes.',
      'files[] targets impact, related, dependents, imports, and overview file modes.',
    ].join(' '),
    modeDescription: [
      'A file outline uses files[] for symbols with files.',
      'Impact, related, dependents, imports, and overview are file modes.',
      'Callees, callers, references, search, symbol_search, and find_symbol are symbol modes.',
      'Keywords from fileless symbols route to symbol_search.',
    ].join(' '),
    symbolsDescription: [
      'Keywords select search/symbol_search while callers/callees/references/find_symbol select exact identifiers.',
      'Pass multiple exact symbols in one symbols[] call.',
    ].join(' '),
  },
  {
    description: [
      'Exact identifiers route through callees, references, callers, or find_symbol.',
      'Keywords route through search or symbol_search.',
      'The overview, impact, imports, related, and dependents file modes accept files[].',
      'The search, callees, find_symbol, references, symbol_search, and callers symbol modes accept symbols[].',
    ].join(' '),
    modeDescription: [
      'Related, overview, impact, dependents, and imports are file modes.',
      'Symbols with files produce a file outline from files[].',
      'References, callers, callees, find_symbol, search, and symbol_search are symbol modes.',
      'Fileless symbols treat keywords as symbol_search input.',
    ].join(' '),
    symbolsDescription: [
      'Exact identifiers select references, callees, callers, or find_symbol.',
      'Keywords select symbol_search or search.',
      'Multiple exact symbols belong in one symbols[] call.',
    ].join(' '),
  },
];

const CODE_GRAPH_DESCRIPTION_MUTATION_CORPUS = [
  {
    name: 'contracted negated file assignment',
    mutate: (parts) => ({
      ...parts,
      description: parts.description.replace(/file modes take files\[\]/i, "file modes aren't assigned files[]"),
    }),
  },
  {
    name: 'contracted outline polarity inversion',
    allPositiveProbes: true,
    mutate: (parts) => ({
      ...parts,
      modeDescription: parts.modeDescription.replace(/file outline/i, "isn't a file outline"),
    }),
  },
  {
    name: 'keyword routing polarity inversion',
    allPositiveProbes: true,
    mutate: (parts) => ({
      ...parts,
      description: parts.description.replace(/keywords\s+(?:use|route through|select)/i, "keywords won't use"),
    }),
  },
  {
    name: 'symbols-with-files outline inversion',
    allPositiveProbes: true,
    mutate: (parts) => ({
      ...parts,
      modeDescription: parts.modeDescription.replace(/symbols with files/i, 'symbols without files'),
    }),
  },
  {
    name: 'exact-symbol one-call inversion',
    allPositiveProbes: true,
    mutate: (parts) => ({
      ...parts,
      symbolsDescription: parts.symbolsDescription.replace(/one symbols\[\] call/i, 'one files[] call'),
    }),
  },
  {
    name: 'contradictory file-mode assignment retained beside correct clause',
    allPositiveProbes: true,
    mutate: (parts) => ({
      ...parts,
      description: `${parts.description} Overview, imports, dependents, related, and impact take symbols[].`,
    }),
  },
  {
    name: 'contradictory symbol-mode assignment retained beside correct clause',
    allPositiveProbes: true,
    mutate: (parts) => ({
      ...parts,
      description: `${parts.description} Find_symbol, symbol_search, search, references, callers, and callees take files[].`,
    }),
  },
  {
    name: 'swapped file-mode/symbol-mode array assignments',
    allPositiveProbes: true,
    mutate: (parts) => ({
      ...parts,
      description: `${parts.description} Overview, imports, dependents, related, and impact take symbols[]. Find_symbol, symbol_search, search, references, callers, and callees take files[].`,
    }),
  },
  {
    name: 'standalone search removed from symbol modes and keyword routing',
    allPositiveProbes: true,
    mutate: (parts) => ({
      ...parts,
      description: removeIdentifier(parts.description, 'search'),
      modeDescription: removeIdentifier(parts.modeDescription, 'search'),
      symbolsDescription: removeIdentifier(parts.symbolsDescription, 'search'),
    }),
  },
];

function hasCodeGraphDescriptionContract({ description, modeDescription, symbolsDescription }) {
  return (
    hasPositiveClause(description, ['file modes', 'files[]'])
    && hasModeClause(description, 'symbol modes', SYMBOL_MODES, 'symbols[]')
    && hasPositiveClause(description, ['exact identifiers', ...EXACT_MODES])
    && hasPositiveClause(description, ['keywords', ...KEYWORD_MODES])
    && !hasContradictoryTargetAssignment(description)
    && hasModeClause(modeDescription, 'file modes', FILE_MODES)
    && hasPositiveClause(modeDescription, ['symbols with files', 'files[]', 'file outline'])
    && hasModeClause(modeDescription, 'symbol modes', SYMBOL_MODES)
    && hasPositiveClause(modeDescription, ['fileless symbols', 'symbol_search', 'keywords'])
    && !hasContradictoryTargetAssignment(modeDescription)
    && hasPositiveClause(symbolsDescription, ['exact identifiers', ...EXACT_MODES])
    && hasPositiveClause(symbolsDescription, ['keywords', ...KEYWORD_MODES])
    && hasPositiveClause(symbolsDescription, ['multiple exact symbols', 'one symbols[] call'])
    && !hasContradictoryTargetAssignment(symbolsDescription)
  );
}

export function assertCodeGraphDescriptionContract(parts) {
  if (!hasCodeGraphDescriptionContract(parts)) {
    throw new Error('code_graph descriptions must preserve per-mode files[]/symbols[] batching and exact-vs-keyword routing');
  }
  for (const probe of CODE_GRAPH_EQUIVALENT_DESCRIPTION_PROBES) {
    if (!hasCodeGraphDescriptionContract(probe)) {
      throw new Error('code_graph description contract must accept equivalent reordered compact prose');
    }
    for (const mutation of CODE_GRAPH_DESCRIPTION_MUTATION_CORPUS.filter((entry) => entry.allPositiveProbes)) {
      const mutated = mutation.mutate(probe);
      if (JSON.stringify(mutated) === JSON.stringify(probe)) {
        throw new Error(`code_graph description mutation did not apply to positive probe: ${mutation.name}`);
      }
      if (hasCodeGraphDescriptionContract(mutated)) {
        throw new Error(`code_graph description contract accepted positive-probe mutation: ${mutation.name}`);
      }
    }
  }
  for (const mutation of CODE_GRAPH_DESCRIPTION_MUTATION_CORPUS) {
    if (hasCodeGraphDescriptionContract(mutation.mutate(parts))) {
      throw new Error(`code_graph description contract accepted mutation: ${mutation.name}`);
    }
  }
}
