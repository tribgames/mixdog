// A set clock for the recording child: `Date.now()` and `new Date()` answer FOOTER_T0 until `__footerSetNow` moves it.
let current = Number(process.env.FOOTER_T0);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(current);
    else super(...args);
  }

  static now() {
    return current;
  }
}
globalThis.Date = FixedDate;
globalThis.__footerSetNow = (ms) => {
  current = ms;
};
Object.defineProperty(process.stdout, 'columns', { value: Number(process.env.FOOTER_COLS), configurable: true });
