export type SolutionWithRaw = {Columns?: Record<string, {Primal?: number}>; raw?: string};

/**
 * highs.js parses HiGHS's pretty text output, which carries only 6 significant digits - on large flows that
 * unbalances items and raises phantom supply warnings. The patch also writes the raw full-precision solution.
 */
export function patchSolutionPrecision(source: string): string
{
    const anchorRead = 'const solution=FS.readFile(SOLUTION_FILENAME,{encoding:"utf8"});';
    const anchorParse = 'const output=parseResult(solution.split(/\\r?\\n/),status);';
    if (!source.includes(anchorRead) || !source.includes(anchorParse)) {
        console.warn('highs.js precision patch anchors not found - solver primals stay at 6 significant digits');
        return source;
    }
    return source
        .replace(anchorRead,
            'Module["cwrap"]("Highs_writeSolution","number",["number","string"])(highs,"raw_"+SOLUTION_FILENAME);'
            + 'const rawSolution=FS.readFile("raw_"+SOLUTION_FILENAME,{encoding:"utf8"});'
            + 'FS.unlink("raw_"+SOLUTION_FILENAME);'
            + anchorRead)
        .replace(anchorParse, anchorParse + 'output.raw=rawSolution;');
}

export function restoreFullPrecisionPrimals(solution: SolutionWithRaw): void
{
    const raw = solution.raw;
    delete solution.raw;
    if (!raw || !solution.Columns) {
        return;
    }

    const lines = raw.split(/\r?\n/);
    const primalStart = lines.findIndex(line => line.startsWith('# Primal solution values'));
    if (primalStart === -1) {
        return;
    }
    const header = lines.findIndex((line, index) => index > primalStart && line.startsWith('# Columns'));
    if (header === -1) {
        return;
    }

    const count = parseInt(lines[header].slice('# Columns'.length), 10);
    for (let i = header + 1; i <= header + count && i < lines.length; i++) {
        const parts = lines[i].split(/\s+/);
        if (parts.length !== 2) {
            continue;
        }
        const column = solution.Columns[parts[0]];
        const value = parseFloat(parts[1]);
        if (column && isFinite(value)) {
            column.Primal = value;
        }
    }
}

export function highsOptions(mipRelGap = 0.05): object
{
    return {
        presolve: 'on',
        mip_heuristic_effort: 0.3,
        mip_detect_symmetry: true,
        mip_rel_gap: mipRelGap,
        small_matrix_value: 1e-7,
        primal_feasibility_tolerance: 1e-9,
        dual_feasibility_tolerance: 1e-9,
    };
}
