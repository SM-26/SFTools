// Smoke test: drives the built server over stdio against a throwaway copy of an sftools-data folder.
// Usage: node mcp/smoke.mjs <sftools-data folder> <planName>
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, readdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const [source, planName] = process.argv.slice(2);
const work = mkdtempSync(join(tmpdir(), 'sftools-mcp-smoke-'));
cpSync(source, join(work, 'data'), {recursive: true});

const client = new Client({name: 'smoke', version: '0'});
await client.connect(new StdioClientTransport({
	command: process.execPath,
	args: [join(dirname(fileURLToPath(import.meta.url)), 'dist', 'server.mjs')],
	env: {...process.env, SFTOOLS_DATA_DIR: join(work, 'data'), SFTOOLS_BACKUP_DIR: join(work, 'backups')},
}));
const call = async (name, args = {}) => {
	const result = await client.callTool({name, arguments: args});
	assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
	return JSON.parse(result.content[0].text);
};

const plans = await call('list_plans');
const plan = plans.find(p => p.name === planName);
assert.ok(plan, `no plan named ${planName}`);

const full = await call('get_plan', {planId: plan.id});
assert.ok(Array.isArray(full.settings.enabledRecipes));

const found = await call('find_game_data', {planId: plan.id, query: 'Rigor', kind: 'recipe'});
assert.ok(found.recipes.some(r => r.className === 'Recipe_Alternate_Motor_1_C'));

const solved = await call('solve_plan', {planId: plan.id});
assert.equal(solved.status, 'Optimal');
console.log('solve:', JSON.stringify(solved.totals), 'raw:', solved.rawResources.map(r => `${r.item} ${r.perMinute}/${r.limit ?? '∞'}`).join(', '));

const whatIf = await call('solve_plan', {planId: plan.id, settings: {resourceWeightMode: 'limits'}});
assert.equal(whatIf.status, 'Optimal');

const update = await call('update_plan', {planId: plan.id, settings: {resourceWeightMode: 'limits'}});
assert.equal(readdirSync(join(work, 'backups')).length, 1);
const written = JSON.parse(readFileSync(update.written, 'utf8')).plans.find(p => p.id === plan.id);
assert.equal(written.settings.resourceWeightMode, 'limits');
assert.deepEqual(written.requests, full.requests);
const plansIn = file => JSON.parse(readFileSync(file, 'utf8')).plans.length;
assert.equal(plansIn(update.written), plansIn(join(source, 'plans', `${plan.versionId}.json`)), 'other plans in the file must survive');

await client.close();
console.log('smoke OK in', work);
