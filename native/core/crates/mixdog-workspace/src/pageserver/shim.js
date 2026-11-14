(function () {
  function broken(name) {
    try { window[name].getItem('__mixdog_probe__'); return false; } catch (error) { return true; }
  }
  function create() {
    var data = Object.create(null);
    var keys = [];
    function need(given, wanted, method) {
      if (given < wanted) {
        throw new TypeError("Failed to execute '" + method + "' on 'Storage': " + wanted + ' argument(s) required, but only ' + given + ' present.');
      }
    }
    function text(value) {
      if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
      return String(value);
    }
    var api = {
      getItem: function (key) {
        need(arguments.length, 1, 'getItem');
        key = text(key);
        return key in data ? data[key] : null;
      },
      setItem: function (key, value) {
        need(arguments.length, 2, 'setItem');
        // Both conversions happen before any state changes: a throwing
        // toString leaves no phantom key.
        key = text(key);
        value = text(value);
        if (!(key in data)) keys.push(key);
        data[key] = value;
      },
      removeItem: function (key) {
        need(arguments.length, 1, 'removeItem');
        key = text(key);
        if (key in data) { delete data[key]; keys.splice(keys.indexOf(key), 1); }
      },
      clear: function () { data = Object.create(null); keys = []; },
      key: function (index) {
        need(arguments.length, 1, 'key');
        var found = keys[index >>> 0];
        return found === undefined ? null : found;
      }
    };
    Object.defineProperty(api, 'length', { get: function () { return keys.length; }, configurable: true });
    if (typeof Proxy !== 'function') return api;
    return new Proxy(api, {
      get: function (target, prop) {
        if (typeof prop === 'string' && !(prop in target)) return prop in data ? data[prop] : undefined;
        return target[prop];
      },
      set: function (target, prop, value) {
        if (typeof prop === 'string') api.setItem(prop, value);
        return true;
      },
      deleteProperty: function (target, prop) {
        if (typeof prop === 'string') api.removeItem(prop);
        return true;
      },
      has: function (target, prop) { return prop in target || (typeof prop === 'string' && prop in data); },
      ownKeys: function () { return keys.slice(); },
      getOwnPropertyDescriptor: function (target, prop) {
        if (typeof prop === 'string' && prop in data) {
          return { value: data[prop], writable: true, enumerable: true, configurable: true };
        }
        return undefined;
      }
    });
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    if (!broken(name)) return;
    var store = create();
    try {
      Object.defineProperty(window, name, { get: function () { return store; }, configurable: true, enumerable: true });
    } catch (error) {}
  });
})();