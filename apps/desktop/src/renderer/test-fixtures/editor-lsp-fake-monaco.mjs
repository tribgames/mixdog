// A recording stand-in for the Monaco surface and i18n that editor-lsp-providers touches.
export const registered = [];
export const commands = new Map();

const names = new Proxy(
  {},
  {
    get: (_target, prop) => (prop === 'fromValue' ? (value) => value : String(prop)),
  }
);

const languages = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop === 'string' && prop.startsWith('register')) {
        return (languageId, provider, options) => {
          registered.push({ method: prop, languageId, provider, options });
          return { dispose() {} };
        };
      }
      return names;
    },
  }
);

class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    Object.assign(this, {
      startLineNumber,
      startColumn,
      endLineNumber,
      endColumn,
    });
  }
}

class Position {
  constructor(lineNumber, column) {
    Object.assign(this, { lineNumber, column });
  }
}

const Uri = {
  parse: (value) => ({
    fsPath: String(value).replace(/^file:\/\/\/?/, ''),
    toString: () => String(value),
  }),
  file: (value) => Uri.parse(`file:///${value}`),
};

export const monaco = {
  languages,
  Range,
  Position,
  Uri,
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  editor: {
    registerCommand(id, handler) {
      commands.set(id, handler);
      return { dispose() {} };
    },
  },
};

export const t = (key) => key;
