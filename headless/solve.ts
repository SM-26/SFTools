// Headless solve: runs the app's own ProductionSolverService under Node against a saved plan file.
// Usage: node headless/dist/solve.mjs <plans.json> <planId> <versionFile.json> [settingsPatch.json]
// versionFile.json = the version record's data file (GET <apiUrl>/<dataPath>) with "worldLimits" added from version.worldData.limits.
import '@angular/compiler';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {firstValueFrom, of} from 'rxjs';
import {Data} from '@src/Model/Data/Data';
import {Plan} from '@src/Model/Planner/Plan';
import {ProductionSolverService} from '@src/Model/Planner/ProductionSolverService';
import {MachineGroupNormalizer} from '@src/Model/Planner/MachineGroupNormalizer';
import {EnabledRecipesResolver} from '@src/Model/Planner/EnabledRecipesResolver';
import {GroupingModeResolver} from '@src/Model/Planner/GroupingModeResolver';
import {SloopBudgetService} from '@src/Model/Planner/SloopBudgetService';
import {ResourcePoolService} from '@src/Model/Planner/Pool/ResourcePoolService';
import {ResourceWeightResolver} from '@src/Model/Planner/ResourceWeightResolver';
import {ExtraPowerResolver} from '@src/Model/Planner/ExtraPowerResolver';
import {SettingsDefaults} from '@src/Model/Settings/SettingsDefaults';
import {HighsSolution} from '@src/Model/Planner/Solver/HighsSolution';
import {highsOptions, patchSolutionPrecision, restoreFullPrecisionPrimals, SolutionWithRaw} from '@src/Model/Planner/Solver/Worker/Highs';

type Highs = {solve: (problem: string, opts?: object) => HighsSolution};

export interface HeadlessResult
{
	status: string;
	objective: number;
	lp: string;
	columns: Map<string, number>;
	/** Objective contribution per term, keyed by column name. */
	costs: Map<string, number>;
	nodes: unknown[];
}

async function loadHighs(): Promise<Highs>
{
	const require = createRequire(import.meta.url);
	const path = require.resolve('highs');
	const module = {exports: {} as any};
	// ponytail: same text patch the worker applies, evaluated as CJS instead of a Blob import.
	new Function('module', 'exports', 'require', '__filename', '__dirname', patchSolutionPrecision(readFileSync(path, 'utf8')))(
		module, module.exports, require, path, dirname(path));
	return module.exports({locateFile: (file: string) => join(dirname(path), file), print: () => undefined, printErr: () => undefined});
}

export function loadData(versionFile: string): Data
{
	const file = JSON.parse(readFileSync(versionFile, 'utf8'));
	return new Data(file.data, file.metadata, file.worldLimits ?? null);
}

export async function solve(plan: Plan, data: Data): Promise<HeadlessResult>
{
	const highs = await loadHighs();
	let last: {lp: string; solution: HighsSolution} | null = null;
	const solver = {
		solve: (lp: string, options: {workerOptions?: {mipRelGap?: number}}) => {
			const solution = highs.solve(lp, highsOptions(options.workerOptions?.mipRelGap));
			restoreFullPrecisionPrimals(solution as SolutionWithRaw);
			last = {lp, solution};
			return of(solution);
		},
	};
	// Only what a single-plan solve touches: no folders, pools or subplans.
	const versionManager = {activeVersionData: () => data};
	const planManager = {poolFolderOf: () => null};
	const settings = {planDefaults: () => SettingsDefaults.SETTINGS.planDefaults};
	const breakdown = {subplanPower: () => { throw new Error('Subplans are not supported headless'); }};

	const service = new ProductionSolverService(
		solver as any,
		versionManager as any,
		new MachineGroupNormalizer(),
		new EnabledRecipesResolver(settings as any, {resolve: () => []} as any),
		new GroupingModeResolver(settings as any),
		breakdown as any,
		new SloopBudgetService(),
		new ResourcePoolService(planManager as any, versionManager as any, null as any),
		new ResourceWeightResolver(),
		new ExtraPowerResolver(),
	);
	// The service logs the objective itself; stdout belongs to the caller.
	const log = console.log;
	console.log = () => undefined;
	const response = await firstValueFrom(service.solve(plan)).finally(() => console.log = log);
	const {lp, solution} = last!;
	const columns = new Map(Object.entries(solution.Columns ?? {}).map(([name, column]) => [name, (column as any).Primal ?? 0]));
	return {
		status: response.status,
		objective: (solution as any).ObjectiveValue,
		lp,
		columns,
		costs: objectiveCosts(lp, columns),
		nodes: response.nodes,
	};
}

/** Splits the objective into coefficient × primal per column, so a result can say where its cost comes from. */
function objectiveCosts(lp: string, columns: Map<string, number>): Map<string, number>
{
	const objective = lp.slice(lp.indexOf('Minimize') + 'Minimize'.length, lp.indexOf('Subject To'));
	const costs = new Map<string, number>();
	for (const match of objective.matchAll(/(-?\d[\d.]*(?:e[+-]?\d+)?) (\S+)/g)) {
		const value = parseFloat(match[1]) * (columns.get(match[2]) ?? 0);
		if (value !== 0) {
			costs.set(match[2], (costs.get(match[2]) ?? 0) + value);
		}
	}
	return costs;
}

async function main(): Promise<void>
{
	const [plansFile, planId, versionFile, patchFile] = process.argv.slice(2);
	const plans = JSON.parse(readFileSync(plansFile, 'utf8')).plans as Plan[];
	const plan = plans.find(p => p.id === planId);
	if (!plan) {
		throw new Error(`No plan ${planId} in ${plansFile}`);
	}
	const patch = patchFile ? JSON.parse(readFileSync(patchFile, 'utf8')) : {};
	const result = await solve({...plan, settings: {...plan.settings, ...patch}}, loadData(versionFile));
	console.log(JSON.stringify({
		status: result.status,
		objective: result.objective,
		columns: Object.fromEntries([...result.columns].filter(([, v]) => Math.abs(v) > 1e-9)),
		costs: Object.fromEntries(result.costs),
	}, null, 1));
}

if (process.argv[1]?.endsWith('solve.mjs')) {
	main().catch(e => { console.error(e); process.exit(1); });
}
