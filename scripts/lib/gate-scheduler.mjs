import { availableParallelism } from 'node:os';
import { testConcurrencyArg } from './run-node-tests.mjs';

// A local gate has one budget, not a full machine's worth of workers per lane.
// Six is the interactive-desktop default; an explicit budget still wins.
export function gateTestBudget(env = process.env, parallelism = availableParallelism()) {
  const argument = testConcurrencyArg([], env);
  return argument ? Number(argument.split('=')[1]) : Math.min(6, parallelism);
}

// Splits the budget across legs in proportion to leg.weight (default 1), at least
// one worker each. Spare workers go one at a time to the leg with the highest
// weight per worker, so longer legs get more. Needs budget >= legs.length.
export function allocateWorkers(legs, budget) {
  const shares = legs.map(() => 1);
  for (let spare = budget - legs.length; spare > 0; spare--) {
    let best = 0;
    for (let i = 1; i < legs.length; i++) {
      if ((legs[i].weight ?? 1) / shares[i] > (legs[best].weight ?? 1) / shares[best]) best = i;
    }
    shares[best]++;
  }
  return shares;
}

// The test runners read their worker count when spawned, so it cannot grow
// mid-run: shares are static. With fewer workers than legs, each worker runs
// legs one after another.
export async function runGateLegs(legs, budget, runLeg) {
  if (!Number.isInteger(budget) || budget < 1) throw new Error('gate test budget must be a positive integer');
  if (budget < legs.length) {
    let next = 0;
    await Promise.all(
      Array.from({ length: budget }, async () => {
        while (next < legs.length) await runLeg(legs[next++], 1);
      })
    );
    return;
  }
  const shares = allocateWorkers(legs, budget);
  await Promise.all(legs.map((leg, index) => runLeg(leg, shares[index])));
}
