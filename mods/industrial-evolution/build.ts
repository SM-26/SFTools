// Builds a Satisfactory Tools mod file for Industrial Evolution (ficsit.app MkPlus + MkPlusLite):
// faster machine tiers added next to every vanilla machine, and every recipe made in them.
// Usage: node dist/build.mjs <base version data file> <out.json>
//
// The multipliers are MkPlus "Mod Savegame Settings" and can differ per save - edit TIERS to match yours.
// Defaults read from the mod's setting tooltips and checked against a save's live power draw:
// full Mk2 at 100% draws 12 MW (3 × Constructor's 4), Lite Assembler Mk2 30 MW (2 × 15), and draw is linear in clock speed.
import '@angular/compiler';
import {readFileSync, writeFileSync} from 'node:fs';
import {ModDataValidator} from '@src/Model/ModEditor/ModDataValidator';

interface Tier
{
	/** Planner className infix: Lite and full MkPlus reuse the same short class names (Desc_Constructor_Mk2_C), so the planner needs its own. */
	id: string;
	label: string;
	machineMultiplier: number;
	generatorMultiplier: number;
}

const TIERS: Tier[] = [
	{id: 'MkPlusLite_Mk2', label: 'Mk.2 (IE Lite)', machineMultiplier: 2, generatorMultiplier: 2},
	{id: 'MkPlus_Mk2', label: 'Mk.2 (IE)', machineMultiplier: 3, generatorMultiplier: 4},
	{id: 'MkPlus_Mk3', label: 'Mk.3 (IE)', machineMultiplier: 5, generatorMultiplier: 8},
];

// ponytail: Converter, Particle Accelerator and Quantum Encoder are left out - their power comes from per-recipe variable draw, which the mod rescales with its own curves.
const MACHINES = ['Desc_ConstructorMk1_C', 'Desc_SmelterMk1_C', 'Desc_AssemblerMk1_C', 'Desc_FoundryMk1_C', 'Desc_ManufacturerMk1_C', 'Desc_OilRefinery_C', 'Desc_Packager_C', 'Desc_Blender_C'];
// Geothermal is a plan setting in the planner, not a building with fuel, so it is not here.
const GENERATORS = ['Desc_GeneratorCoal_C', 'Desc_GeneratorFuel_C', 'Desc_GeneratorNuclear_C', 'Desc_GeneratorBiomass_Automated_C'];

const tierClass = (base: string, tier: Tier) => `Desc_${tier.id}_${base.replace(/^Desc_/, '')}`;

const [baseFile, outFile] = process.argv.slice(2);
const base = JSON.parse(readFileSync(baseFile, 'utf8')).data;
const buildings: Record<string, any> = {};
const recipes: Record<string, any> = {};

for (const tier of TIERS) {
	for (const className of MACHINES) {
		const vanilla = base.buildings[className];
		buildings[tierClass(className, tier)] = {
			...vanilla,
			className: tierClass(className, tier),
			name: `${vanilla.name.replace(/ Mk\.1$/, '')} ${tier.label}`,
			description: `Industrial Evolution: ${tier.machineMultiplier}× the speed and power of the ${vanilla.name}.`,
			manufacturingSpeed: vanilla.manufacturingSpeed * tier.machineMultiplier,
			powerUsage: vanilla.powerUsage * tier.machineMultiplier,
			// MkPlus "Overclock mode" defaults to Linear.
			powerUsageExponent: 1,
		};
	}
	for (const className of GENERATORS) {
		const vanilla = base.buildings[className];
		buildings[tierClass(className, tier)] = {
			...vanilla,
			className: tierClass(className, tier),
			name: `${vanilla.name} ${tier.label}`,
			description: `Industrial Evolution: ${tier.generatorMultiplier}× the power (and fuel) of the ${vanilla.name}.`,
			powerProduction: vanilla.powerProduction * tier.generatorMultiplier,
		};
	}
}

for (const recipe of Object.values<any>(base.recipes)) {
	const added = TIERS.flatMap(tier => recipe.producedIn.filter((m: string) => MACHINES.includes(m)).map((m: string) => tierClass(m, tier)));
	if (added.length > 0) {
		recipes[recipe.className] = {...recipe, producedIn: [...recipe.producedIn, ...added]};
	}
}

const mod = {data: {buildings, recipes}, metadata: {}};
const errors = new ModDataValidator().validate(mod.data);
if (errors.length > 0) {
	console.error(errors.join('\n'));
	process.exit(1);
}
writeFileSync(outFile, JSON.stringify(mod, null, '\t') + '\n');
console.log(`${Object.keys(buildings).length} buildings, ${Object.keys(recipes).length} recipes -> ${outFile}`);
