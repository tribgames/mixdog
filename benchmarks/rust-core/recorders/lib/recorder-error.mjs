// A failure of the recorder itself (a recorder-side wait that passed its deadline, a stand-in that could not start): it stops the
// recording and is never stored as a case's answer.
export class RecorderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecorderError';
  }
}
