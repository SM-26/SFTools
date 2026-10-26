/// <reference lib="webworker" />
import type {HighsSolution} from '@src/Model/Planner/Solver/HighsSolution';
import type {SolverWorkerRequest} from './SolverWorkerRequest';
import type {SolverWorkerResponse} from './SolverWorkerResponse';
import {patchSolutionPrecision, highsOptions, restoreFullPrecisionPrimals, type SolutionWithRaw} from './Highs';

type HighsInstance = {solve: (problem: string, opts?: object) => HighsSolution};
type HighsFactory = (opts: {locateFile: (file: string) => string}) => Promise<HighsInstance>;

let highs: HighsInstance | null = null;

// highs.js is CJS and cannot be imported directly: fetched as text, given an ESM export and import()ed via a Blob URL,
// which bypasses Vite's @fs/ resolution in dev and avoids importScripts(), which module workers lack.
async function loadHighs(): Promise<HighsInstance>
{
    const base = `${self.location.origin}/assets`;
    const text = await fetch(`${base}/highs.js`).then(r => r.text());
    const blob = new Blob([patchSolutionPrecision(text), '\nexport default Module;'], {type: 'application/javascript'});
    const blobUrl = URL.createObjectURL(blob);
    try {
        const mod = await import(blobUrl) as {default: HighsFactory};
        return mod.default({locateFile: (file: string) => `${base}/${file}`});
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

addEventListener('message', async ({data}: MessageEvent<SolverWorkerRequest>) => {
    const {id, problem, options} = data;
    try {
        if (highs === null) {
            highs = await loadHighs();
        }
        const solution = highs.solve(problem, highsOptions(options?.mipRelGap));
        restoreFullPrecisionPrimals(solution as SolutionWithRaw);
        postMessage({id, solution, error: null} satisfies SolverWorkerResponse);
    } catch (e) {
        postMessage({id, solution: null, error: String(e)} satisfies SolverWorkerResponse);
    }
});
