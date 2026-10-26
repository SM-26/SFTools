// MCP server for Satisfactory Tools desktop plans: list, read, edit and solve them without the app's UI.
// Plans are the desktop app's own files (sftools-data/plans/<versionId>.json); solving runs the app's solver headless.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import {Data} from '@src/Model/Data/Data';
import {Plan} from '@src/Model/Planner/Plan';
import {RecipeNode} from '@src/Model/Planner/Solver/Response/RecipeNode';
import {GeneratorNode} from '@src/Model/Planner/Solver/Response/GeneratorNode';
import {ItemAmountNode} from '@src/Model/Planner/Solver/Response/ItemAmountNode';
import {applyMod, solve} from '../headless/solve';

const API_URL = 'https://api.new.satisfactorytools.com';
const APPDATA = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
const DATA_DIR = process.env['SFTOOLS_DATA_DIR'] ?? join(APPDATA, 'com.satisfactorytools.desktop', 'sftools-data');
// Outside sftools-data: the app loads every .json in there (one folder deep).
const BACKUP_DIR = process.env['SFTOOLS_BACKUP_DIR'] ?? join(LOCALAPPDATA, 'sftools-mcp', 'backups');
const CACHE_DIR = join(LOCALAPPDATA, 'sftools-mcp', 'cache');
/** Extra mod JSON files (same shape as the app's mod editor), applied to every version - for trying a mod before uploading it. */
const MOD_FILES = (process.env['SFTOOLS_MOD_FILES'] ?? '').split(';').filter(file => file !== '');

interface PlanFile
{
	folders: unknown[];
	plans: Plan[];
}

interface Located
{
	file: string;
	versionId: string;
	content: PlanFile;
	plan: Plan;
}

const PLANS_DIR = join(DATA_DIR, 'plans');

function planFiles(): string[]
{
	return existsSync(PLANS_DIR) ? readdirSync(PLANS_DIR).filter(name => name.endsWith('.json')).map(name => join(PLANS_DIR, name)) : [];
}

function readPlanFile(file: string): PlanFile
{
	return JSON.parse(readFileSync(file, 'utf8')) as PlanFile;
}

function locate(planId: string): Located
{
	for (const file of planFiles()) {
		const content = readPlanFile(file);
		const plan = content.plans.find(candidate => candidate.id === planId);
		if (plan) {
			return {file, versionId: basename(file, '.json'), content, plan};
		}
	}
	throw new Error(`No plan with id ${planId}. Use list_plans.`);
}

function appRunning(): boolean
{
	try {
		return execFileSync('tasklist', ['/FI', 'IMAGENAME eq satisfactory-tools.exe', '/NH'], {encoding: 'utf8'}).includes('satisfactory-tools.exe');
	} catch {
		return false;
	}
}

/** Every write keeps the previous file, so a bad edit is one copy away from undone. */
function writePlanFile(file: string, content: PlanFile): string
{
	mkdirSync(BACKUP_DIR, {recursive: true});
	const backup = join(BACKUP_DIR, `${basename(file, '.json')}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
	copyFileSync(file, backup);
	// Same atomic temp+rename as the app's own storage writer.
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(content));
	renameSync(temp, file);
	return backup;
}

const versions = new Map<string, Promise<Data>>();

async function fetchJson(url: string, init?: RequestInit): Promise<any>
{
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`${url}: HTTP ${response.status}`);
	}
	return response.json();
}

/** A data file's URL is immutable, so it is cached by its path forever. */
async function loadVersionData(versionId: string): Promise<Data>
{
	const version = await fetchJson(`${API_URL}/v1/versions/${versionId}`);
	const cache = join(CACHE_DIR, basename(version.dataPath));
	let file: any;
	if (existsSync(cache)) {
		file = JSON.parse(readFileSync(cache, 'utf8'));
	} else {
		let dataPath = version.dataPath;
		try {
			file = await fetchJson(`${API_URL}/${dataPath}`);
		} catch {
			// Pruned files are re-materialized on request, as the app does.
			dataPath = (await fetchJson(`${API_URL}/v1/versions/${versionId}/data`, {method: 'POST'})).dataPath;
			file = await fetchJson(`${API_URL}/${dataPath}`);
		}
		mkdirSync(CACHE_DIR, {recursive: true});
		writeFileSync(join(CACHE_DIR, basename(dataPath)), JSON.stringify(file));
	}
	const data = MOD_FILES.reduce((merged, modFile) => applyMod(merged, JSON.parse(readFileSync(modFile, 'utf8'))), file.data);
	return new Data(data as any, file.metadata, version.worldData?.limits ?? null);
}

function versionData(versionId: string): Promise<Data>
{
	let data = versions.get(versionId);
	if (!data) {
		data = loadVersionData(versionId);
		data.catch(() => versions.delete(versionId));
		versions.set(versionId, data);
	}
	return data;
}

function named(data: Data, className: string): string
{
	return data.searchItemByClassName(className)?.name
		?? data.recipes.find(recipe => recipe.className === className)?.name
		?? data.buildings.find(building => building.className === className)?.name
		?? className;
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

async function solveSummary(plan: Plan, versionId: string): Promise<object>
{
	const data = await versionData(versionId);
	const result = await solve(plan, data);
	if (result.status !== 'Optimal') {
		return {status: result.status, hint: 'Infeasible usually means a request needs more of a resource than its limit, or a needed recipe/machine is disabled.'};
	}
	const nodes = result.nodes as any[];
	const limits = plan.settings.resourceLimits ?? {};

	const buildings = nodes.filter((node): node is RecipeNode => node instanceof RecipeNode).map(node => ({
		recipe: node.recipe.name,
		recipeClassName: node.recipe.className,
		machine: node.machine.name,
		machines: node.groups.reduce((sum, group) => sum + group.machines, 0),
		groups: node.groups.map(group => `${group.machines}× ${round(group.clockSpeed, 4)}%${group.sloops ? ` +${group.sloops} sloops` : ''}`).join(', '),
		powerMW: round(node.averagePowerUsage()),
	})).sort((a, b) => a.machine.localeCompare(b.machine) || a.recipe.localeCompare(b.recipe));

	const generators = nodes.filter((node): node is GeneratorNode => node instanceof GeneratorNode).map(node => ({
		generator: node.generator.name,
		fuel: node.fuel.item.name,
		count: round(node.amount, 3),
		wholeGenerators: node.wholeGenerators(),
		powerMW: round(node.powerProduction()),
	}));

	const amounts = (type: string) => nodes.filter(node => node.type === type && node instanceof ItemAmountNode).map(node => ({
		item: node.item.name,
		className: node.item.className,
		perMinute: round(node.amount),
		...(type === 'mine' && limits[node.item.className] !== undefined ? {limit: limits[node.item.className]} : {}),
	}));

	const machineTotals: Record<string, number> = {};
	buildings.forEach(row => machineTotals[row.machine] = (machineTotals[row.machine] ?? 0) + row.machines);
	generators.forEach(row => machineTotals[row.generator] = (machineTotals[row.generator] ?? 0) + row.wholeGenerators);

	const costs: Record<string, number> = {};
	for (const [column, cost] of result.costs) {
		const key = column.endsWith('@Mine') ? `mining ${named(data, column.split('@')[0])}` : 'machine power/count terms';
		costs[key] = round((costs[key] ?? 0) + cost);
	}

	return {
		status: result.status,
		totals: {
			buildings: Object.values(machineTotals).reduce((sum, count) => sum + count, 0),
			powerUsedMW: round(buildings.reduce((sum, row) => sum + row.powerMW, 0)),
			powerProducedMW: round(generators.reduce((sum, row) => sum + row.powerMW, 0)),
			byMachine: machineTotals,
		},
		products: amounts('product'),
		rawResources: amounts('mine'),
		inputs: amounts('input'),
		byproducts: amounts('byproduct'),
		sinks: amounts('sink'),
		buildings,
		generators,
		objective: {total: round(result.objective), breakdown: costs},
	};
}

const text = (value: unknown) => ({content: [{type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1)}]});

const requestSchema = z.object({
	itemClassName: z.string().describe('Item className, e.g. Desc_ModularFrame_C (find_game_data finds it)'),
	ratePerMinute: z.number(),
}).passthrough();

const server = new McpServer({name: 'sftools', version: '0.1.0'}, {
	instructions: 'Plans of the Satisfactory Tools desktop app. Item, recipe and building references are classNames - look them up with find_game_data. '
		+ 'The app reads its files only at startup: after update_plan the user must reload the app (Ctrl+R) and press Calculate, and must not edit that plan in the app in between, or the app overwrites the change.',
});

server.registerTool('list_plans', {
	description: 'List all plans with their id, name, game version id, requests and folder.',
}, async () => text(planFiles().flatMap(file => readPlanFile(file).plans.map(plan => ({
	id: plan.id,
	name: plan.name,
	versionId: basename(file, '.json'),
	folderId: plan.folderId,
	parentPlanId: plan.parentPlanId,
	requests: plan.requests.map(request => `${request.ratePerMinute}/min ${request.itemClassName}`),
})))));

server.registerTool('get_plan', {
	description: 'Read one plan: settings (enabled recipes, limits, fuels, weights...), requests and inputs. The saved graph is left out; use solve_plan for results.',
	inputSchema: {planId: z.string()},
}, async ({planId}) => {
	const {plan, versionId} = locate(planId);
	const {graph, ...rest} = plan;
	return text({...rest, versionId, graphNodes: graph?.nodes.length ?? 0});
});

server.registerTool('find_game_data', {
	description: 'Search items, recipes and buildings of a plan\'s game version by name or className. Recipes include ingredients, products, machines and whether they are alternates.',
	inputSchema: {
		planId: z.string().describe('Any plan of the version to search'),
		query: z.string(),
		kind: z.enum(['item', 'recipe', 'building']).optional(),
	},
}, async ({planId, query, kind}) => {
	const data = await versionData(locate(planId).versionId);
	const q = query.toLowerCase();
	const matches = (entry: {name: string; className: string}) => entry.name.toLowerCase().includes(q) || entry.className.toLowerCase().includes(q);
	const result: Record<string, unknown[]> = {};
	if (!kind || kind === 'item') {
		result['items'] = data.items.filter(matches).slice(0, 30).map(item => ({className: item.className, name: item.name}));
	}
	if (!kind || kind === 'recipe') {
		result['recipes'] = data.recipes.filter(recipe => recipe.producedIn.length > 0 && matches(recipe)).slice(0, 30).map(recipe => ({
			className: recipe.className,
			name: recipe.name,
			alternate: recipe.alternate,
			time: recipe.time,
			ingredients: recipe.ingredients.map(io => `${io.amount} ${io.item.name}`),
			products: recipe.products.map(io => `${io.amount} ${io.item.name}`),
			machines: recipe.producedIn.map(building => building.className),
		}));
	}
	if (!kind || kind === 'building') {
		result['buildings'] = data.buildings.filter(matches).slice(0, 30).map(building => ({className: building.className, name: building.name}));
	}
	return text(result);
});

server.registerTool('solve_plan', {
	description: 'Run the app\'s solver on a plan and return buildings, raw resources, power and the objective breakdown. '
		+ 'settings/requests here are a what-if: they override the saved plan for this solve only and are not written.',
	inputSchema: {
		planId: z.string(),
		settings: z.record(z.string(), z.any()).optional().describe('Settings keys to override, merged over the saved settings'),
		requests: z.array(requestSchema).optional().describe('Replaces the saved requests'),
	},
}, async ({planId, settings, requests}) => {
	const {plan, versionId} = locate(planId);
	return text(await solveSummary({
		...plan,
		settings: {...plan.settings, ...settings},
		requests: (requests ?? plan.requests) as Plan['requests'],
	}, versionId));
});

server.registerTool('update_plan', {
	description: 'Write changes to a saved plan. settings is merged key by key over the saved settings (a null value removes the key); '
		+ 'requests replaces the whole list. The previous file is backed up first. Afterwards the user must reload the app and press Calculate.',
	inputSchema: {
		planId: z.string(),
		name: z.string().optional(),
		settings: z.record(z.string(), z.any()).optional(),
		requests: z.array(requestSchema).optional(),
	},
	annotations: {destructiveHint: true},
}, async ({planId, name, settings, requests}) => {
	const {file, content, plan} = locate(planId);
	const merged: Record<string, unknown> = {...plan.settings};
	Object.entries(settings ?? {}).forEach(([key, value]) => value === null ? delete merged[key] : merged[key] = value);
	const updated: Plan = {
		...plan,
		...(name !== undefined ? {name, autoName: false} : {}),
		settings: merged as unknown as Plan['settings'],
		requests: (requests ?? plan.requests) as Plan['requests'],
	};
	const backup = writePlanFile(file, {...content, plans: content.plans.map(candidate => candidate.id === planId ? updated : candidate)});
	return text({
		written: file,
		backup,
		appRunning: appRunning(),
		next: 'In the app: reload (Ctrl+R) or restart, open the plan and press Calculate. Do not edit this plan in the app before reloading - it would overwrite this change.',
	});
});

await server.connect(new StdioServerTransport());
