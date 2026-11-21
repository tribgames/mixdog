import type { TurnOptions } from '../src/api.ts';

export const BUDGET = 8;
export const COST = 1;
/** The most units a turn can hold: the check that finds the budget spent comes one unit after it was. */
export const UNITS_PER_TURN = Math.floor(BUDGET / COST) + 1;

export class FakeTurn {
  private t = 0;
  /** Yields so far. */
  yields = 0;
  /** Work units (see `work()`) done in the turn now running. */
  private units = 0;
  /** The units of every turn that has ended. */
  readonly turns: number[] = [];

  readonly options: TurnOptions = {
    budgetMs: BUDGET,
    now: () => {
      this.t += COST;
      return this.t;
    },
    yieldTurn: () => {
      this.yields++;
      this.turns.push(this.units);
      this.units = 0;
      return new Promise<void>((r) => setImmediate(r));
    },
  };

  /** One unit of observable work (counted independently of the client's own budget checks). */
  work(): void {
    this.units++;
  }
  /** Units per turn, the running turn included. */
  all(): number[] {
    return [...this.turns, this.units];
  }
  /** Forget everything counted so far. */
  reset(): void {
    this.yields = 0;
    this.units = 0;
    this.turns.length = 0;
  }
}
