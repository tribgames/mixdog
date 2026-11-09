// A fixed clock for the recording child: `Date.now()` and `new Date()` answer FOOTER_T0.
const T0 = Number(process.env.FOOTER_T0);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(T0);
    else super(...args);
  }

  static now() {
    return T0;
  }
}
globalThis.Date = FixedDate;
Object.defineProperty(process.stdout, 'columns', { value: Number(process.env.FOOTER_COLS), configurable: true });
