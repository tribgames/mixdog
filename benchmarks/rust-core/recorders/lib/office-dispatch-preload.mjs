// `node --import` of the Office dispatch recorder's child: the loader hook and the recorder's fixed clock (the same as the recorder's
// own).
import { register } from 'node:module';

const config = JSON.parse(process.env.OFFICE_DISPATCH_CONFIG);
register('./office-dispatch-loader.mjs', { parentURL: import.meta.url, data: config });

const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate {
  constructor(...given) {
    if (given.length === 0) super(config.clock);
    else super(...given);
  }
  static now() {
    return config.clock;
  }
};
