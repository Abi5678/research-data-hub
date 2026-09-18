% IDEAL-CT (CT Index) for Fieldbook.
% Same analysis as templates/scripts/ct_index.py. Fieldbook writes each
% selected dataset as CSV plus inputs.json, then runs this file with -batch.
%
% Finds specimens (one per Force/LVDT column pair, or one per id in a
% specimen column, or one per sheet), computes CT Index from Force/LVDT,
% and writes ct_index_results.csv plus plots.

files = {};
names = {};
if isfile('inputs.json')
    raw = jsondecode(fileread('inputs.json'));
    items = raw.inputs;
    if isempty(items)
        error('inputs.json has no datasets. Select tables in Fieldbook and run again.');
    end
    if iscell(items)
        for i = 1:numel(items)
            files{end+1} = items{i}.file; %#ok<AGROW>
            names{end+1} = items{i}.display_name; %#ok<AGROW>
        end
    else
        for i = 1:numel(items)
            files{end+1} = items(i).file; %#ok<AGROW>
            names{end+1} = items(i).display_name; %#ok<AGROW>
        end
    end
else
    listing = dir('data*.csv');
    for i = 1:numel(listing)
        files{end+1} = listing(i).name; %#ok<AGROW>
        names{end+1} = listing(i).name; %#ok<AGROW>
    end
end

if isempty(files)
    error('No datasets found. Select one or more tables in Fieldbook and run again.');
end

if ~exist('plots', 'dir')
    mkdir('plots');
end

% The raw trace sheet carries no geometry; it lives in a separate summary
% table the user uploads alongside, keyed by specimen id.
meta = specimen_metadata(files);

results = {};
for t = 1:numel(files)
    opts = csv_opts(files{t});
    T = readtable(files{t}, opts);
    vars = T.Properties.VariableNames;
    fprintf('\n%s (%s): %d rows, %d columns\n', names{t}, files{t}, height(T), numel(vars));

    pairs   = trace_pairs(vars, names{t});
    nameCol = find_alias(vars, alias_name());
    diaCol  = find_alias(vars, alias_dia());
    thkCol  = find_alias(vars, alias_thk());
    tempCol = find_alias(vars, alias_temp());
    ctCol   = find_alias(vars, alias_ct());
    gmbCol  = find_alias(vars, {'gmb'});

    if ~isempty(ctCol) && isempty(pairs)
        groups = split_specimens(T, nameCol, names{t});
        for g = 1:numel(groups)
            G = groups{g}.table;
            ct = mean(to_num(G.(ctCol)), 'omitnan');
            if isnan(ct), continue; end
            row = blank_row(groups{g}.name, files{t});
            row.testing_temperature = first_num(G, tempCol, NaN);
            row.specimen_diameter = first_num(G, diaCol, NaN);
            row.specimen_thickness = first_num(G, thkCol, NaN);
            row.ct_index = ct;
            results{end+1} = row; %#ok<AGROW>
            fprintf('  %s: CT Index (from table) = %.3f\n', groups{g}.name, ct);
        end
        continue
    end

    if ~isempty(gmbCol) && ~isempty(nameCol) && isempty(pairs)
        airCol = find_alias(vars, {'air_voids', 'air_voids_pct', 'air_void'});
        specVals = string(T.(nameCol));
        seen = {};
        for r = 1:height(T)
            spec = strtrim(char(specVals(r)));
            gmb = row_num(T, gmbCol, r);
            if isempty(spec) || any(strcmpi(spec, {'nan', 'none', '<missing>'})) || ~isfinite(gmb)
                continue
            end
            if any(strcmp(seen, spec)), continue; end
            seen{end+1} = spec; %#ok<AGROW>
            row = blank_row(spec, names{t});
            row.specimen_diameter = row_num(T, diaCol, r);
            row.specimen_thickness = row_num(T, thkCol, r);
            row.gmb = gmb;
            row.air_voids_pct = row_num(T, airCol, r);
            results{end+1} = row; %#ok<AGROW>
            msg = sprintf('  %s: Gmb = %.3f', spec, gmb);
            if isfinite(row.air_voids_pct)
                msg = [msg sprintf(', Va = %.2f%%', row.air_voids_pct)]; %#ok<AGROW>
            end
            if isfinite(row.specimen_diameter)
                msg = [msg sprintf(', D = %.2f mm', row.specimen_diameter)]; %#ok<AGROW>
            end
            if isfinite(row.specimen_thickness)
                msg = [msg sprintf(', t = %.2f mm', row.specimen_thickness)]; %#ok<AGROW>
            end
            fprintf('%s\n', msg);
        end
        continue
    end

    if isempty(pairs)
        if ~isempty(nameCol) && (~isempty(diaCol) || ~isempty(thkCol) || ~isempty(tempCol))
            % Not skipped at all — specimen_metadata() already read it, and the
            % trace tables get their diameter/thickness/temperature from here.
            fprintf('  Specimen details — supplied diameter/thickness/temperature.\n');
        else
            fprintf('  Skipped — no Force/LVDT trace, CT Index, or Gmb specimen table.\n');
        end
        continue
    end

    % One column pair means any specimens are stacked in rows and told apart by
    % an id column; several pairs mean one specimen per pair, named by prefix.
    specimens = {};
    if numel(pairs) == 1
        groups = split_specimens(T, nameCol, names{t});
        for g = 1:numel(groups)
            specimens{g} = struct('label', groups{g}.name, 'key', norm_name(groups{g}.name), ...
                'table', groups{g}.table, 'force', pairs{1}.force, 'disp', pairs{1}.disp); %#ok<AGROW>
        end
    else
        for g = 1:numel(pairs)
            specimens{g} = struct('label', pairs{g}.label, 'key', pairs{g}.key, ...
                'table', T, 'force', pairs{g}.force, 'disp', pairs{g}.disp); %#ok<AGROW>
        end
    end

    for s = 1:numel(specimens)
        S = specimens{s};
        G = S.table;
        force = to_num(G.(S.force));
        dsp = to_num(G.(S.disp));
        keep = isfinite(force) & isfinite(dsp);
        force = force(keep);
        dsp = dsp(keep);

        info = struct();
        if ~isempty(S.key) && isKey(meta, S.key)
            info = meta(S.key);
        end
        label = S.label;
        if isfield(info, 'display') && ~isempty(info.display)
            label = info.display;
        end

        if numel(force) < 4
            fprintf('  %s: no numeric Force/LVDT rows\n', label);
            continue
        end

        guessed = {};
        [dia, guessed]   = pick(G, diaCol, info, 'diameter_mm', guessed);
        [thick, guessed] = pick(G, thkCol, info, 'thickness_mm', guessed);
        [temp, guessed]  = pick(G, tempCol, info, 'temperature_c', guessed);
        try
            R = compute_ct_index(force, dsp, dia, thick);
        catch err
            fprintf('  %s: %s\n', label, err.message);
            continue
        end
        fig = figure('Visible', 'off');
        plot(R.disp, R.force);
        xlabel('Displacement'); ylabel('Force'); title(label);
        saveas(fig, fullfile('plots', [safe_name(label) '.png']));
        close(fig);

        row = blank_row(label, files{t});
        row.testing_temperature = temp;
        row.specimen_diameter = dia;
        row.specimen_thickness = thick;
        row.peak_load = R.peak;
        row.m75 = R.m75;
        row.l75 = R.l75;
        row.failure_work = R.area;
        row.fracture_energy_jm2 = R.gf;
        row.ct_index = R.ct;
        row.tensile_strength_mpa = R.ts;
        row.assumed_values = guess_summary(guessed, false);
        results{end+1} = row; %#ok<AGROW>
        fprintf('  %s: CT Index = %.3f, Gf = %.1f J/m^2, ITS = %.3f MPa\n', ...
            label, R.ct, R.gf, R.ts);
        if ~isempty(guessed)
            fprintf('    ! assumed %s — no value for %s in any selected table\n', ...
                guess_summary(guessed, true), label);
        end
    end
end

if isempty(results)
    error(['No specimens produced a CT Index. Need Force + LVDT columns ' ...
        '(raw IDEAL-CT), a CT Index column, or a Sample ID + Gmb table.']);
end

Out = struct2table(vertcat(results{:}));
if ~iscell(Out.assumed_values)
    Out.assumed_values = cellstr(Out.assumed_values);
end
if ~any(isfinite(Out.gmb))
    Out.gmb = [];
    Out.air_voids_pct = [];
end
writetable(Out, 'ct_index_results.csv');
xlsxNote = '';
try
    writetable(Out, 'ct_index_results.xlsx');
    xlsxNote = ' and ct_index_results.xlsx';
catch err
    xlsxNote = sprintf(' (xlsx skipped: %s)', err.message);
end

fig = figure('Visible', 'off');
plotted = true;
if any(isfinite(Out.ct_index))
    bar(categorical(Out.specimen_name), Out.ct_index);
    ylabel('CT Index'); title('IDEAL-CT by specimen');
elseif ismember('gmb', Out.Properties.VariableNames) && any(isfinite(Out.gmb))
    bar(categorical(Out.specimen_name), Out.gmb);
    ylabel('Gmb'); title('Specimen Gmb');
else
    plotted = false;
end
if plotted
    saveas(fig, 'ct_index.png');
end
close(fig);

nPlots = numel(dir(fullfile('plots', '*.png')));
fprintf('\nWrote ct_index_results.csv%s', xlsxNote);
if plotted
    fprintf(', ct_index.png');
end
if nPlots > 0
    fprintf(', and %d specimen plots', nPlots);
end
fprintf('\n%d specimens\n', height(Out));
disp(Out);

nAssumed = sum(~strcmp(strtrim(Out.assumed_values), ''));
if nAssumed > 0
    fprintf(['\nWARNING: %d of %d specimens used assumed values — see the ' ...
        'assumed_values column. Select the table that lists Specimen, Dia, ' ...
        'Thickness and Temperature alongside the trace table to use the ' ...
        'measured ones.\n'], nAssumed, height(Out));
end

% ---------------------------------------------------------------- helpers

function opts = csv_opts(f)
opts = detectImportOptions(f);
opts.VariableNamingRule = 'preserve';
end

function s = norm_name(name)
v = string(name);
if isempty(v) || ismissing(v)
    s = '';
    return
end
s = lower(char(strtrim(v)));
s = regexprep(s, '[^a-z0-9]+', '_');
s = regexprep(s, '^_+|_+$', '');
end

function a = alias_name()
a = {'specimen_name', 'specimen_code', 'specimen_id', 'sample_id', 'sample', ...
    'core_id', 'name', 'id', 'specimen'};
end

function a = alias_dia()
a = {'diameter_d_average', 'diameter_d_avg', 'diameter_avg', 'avg', ...
    'diameter_mm', 'dia_mm', 'dia', 'diameter', 'd_mm'};
end

function a = alias_thk()
a = {'thickness_t_avg', 'thickness_t_average', 'avg_2', 'thickness_mm', ...
    'thick', 'thickness', 'height_mm', 'height', 't_mm'};
end

function a = alias_temp()
a = {'testing_temperature', 'temperature_c', 'temp', 'temperature'};
end

function a = alias_ct()
a = {'ct_index', 'ctindex', 'ct', 'ideal_ct', 'ct_idx'};
end

function col = find_alias(vars, aliases)
col = '';
n = cell(1, numel(vars));
for i = 1:numel(vars)
    n{i} = norm_name(vars{i});
end
for i = 1:numel(aliases)
    hit = find(strcmp(n, aliases{i}), 1);
    if ~isempty(hit)
        col = vars{hit};
        return
    end
end
end

function [key, role, token] = column_role(col)
% Split a trace column into (specimen key, role, matched token).
%
% Lab exports put one specimen per column *pair* and carry the specimen id
% only in the column name — "ABPL-RT-1 LVDT, mm" / "ABPL-RT-1 Force, kN" —
% so the id has to be read off the prefix. A plain "Force"/"LVDT" yields an
% empty prefix, which means the whole table is one specimen.
key = ''; role = ''; token = '';
units = {'mm', 'cm', 'm', 'um', 'in', 'kn', 'n', 'kgf', 'lbf', 's', 'sec'};
toks = strsplit(norm_name(col), '_');
toks = toks(~cellfun(@isempty, toks));
% Trailing units are ignored, so "Force, kN" and "LVDT, mm" reduce to the
% same role tokens as a bare "Force" / "LVDT".
while numel(toks) > 1 && any(strcmp(units, toks{end}))
    toks(end) = [];
end
if isempty(toks)
    return
end
last = toks{end};
if any(strcmp({'force', 'load'}, last))
    role = 'force';
elseif any(strcmp({'lvdt', 'disp', 'displacement', 'stroke', 'deformation'}, last))
    role = 'disp';
else
    return
end
token = last;
key = strjoin(toks(1:end-1), '_');
end

function s = pretty_prefix(col, token, fallback)
% The specimen id as the sheet wrote it, e.g. "ABPL-RT-1".
s = '';
at = regexpi(col, regexptranslate('escape', token), 'once');
if ~isempty(at)
    s = regexprep(col(1:at-1), '^[\s,;_-]+|[\s,;_-]+$', '');
end
if isempty(s)
    s = char(string(fallback));
end
end

function pairs = trace_pairs(vars, fallback)
% Every (specimen label, key, disp column, force column) in a table.
keys = {};
entries = {};
for i = 1:numel(vars)
    [key, role, token] = column_role(vars{i});
    if isempty(role)
        continue
    end
    at = find(strcmp(keys, key), 1);
    if isempty(at)
        keys{end+1} = key; %#ok<AGROW>
        entries{end+1} = struct('force', '', 'disp', '', ...
            'label', pretty_prefix(vars{i}, token, fallback)); %#ok<AGROW>
        at = numel(keys);
    end
    % First column of each role wins, so a stray duplicate cannot displace
    % the pair this specimen is actually named after.
    if isempty(entries{at}.(role))
        entries{at}.(role) = vars{i};
    end
end
pairs = {};
for i = 1:numel(keys)
    if ~isempty(entries{i}.force) && ~isempty(entries{i}.disp)
        pairs{end+1} = struct('label', entries{i}.label, 'key', keys{i}, ...
            'disp', entries{i}.disp, 'force', entries{i}.force); %#ok<AGROW>
    end
end
end

function meta = specimen_metadata(files)
% Specimen id -> diameter/thickness/temperature, gathered from any table
% that lists them per specimen.
meta = containers.Map('KeyType', 'char', 'ValueType', 'any');
fieldNames = {'diameter_mm', 'thickness_mm', 'temperature_c'};
for t = 1:numel(files)
    try
        opts = csv_opts(files{t});
    catch
        continue
    end
    vars = opts.VariableNames;
    nameCol = find_alias(vars, alias_name());
    cols = {find_alias(vars, alias_dia()), find_alias(vars, alias_thk()), ...
        find_alias(vars, alias_temp())};
    if isempty(nameCol) || all(cellfun(@isempty, cols))
        continue
    end
    T = readtable(files{t}, opts);
    nameVals = string(T.(nameCol));
    for r = 1:height(T)
        key = norm_name(nameVals(r));
        if isempty(key)
            continue
        end
        if isKey(meta, key)
            entry = meta(key);
        else
            entry = struct('display', strtrim(char(nameVals(r))));
        end
        for k = 1:numel(cols)
            if isempty(cols{k}) || isfield(entry, fieldNames{k})
                continue
            end
            v = row_num(T, cols{k}, r);
            if isfinite(v)
                entry.(fieldNames{k}) = v;
            end
        end
        meta(key) = entry;
    end
end
end

function [v, guessed] = pick(T, col, info, field, guessed)
% This table's own column, else the specimen summary table, else a default.
v = first_num(T, col, NaN);
if isfinite(v)
    return
end
if isfield(info, field)
    v = info.(field);
    return
end
% Recorded, not just returned. CT scales as 1/(D^2*t), so a guessed diameter
% or thickness moves the answer by a percent or so — small enough to look
% right in a report and wrong enough to matter.
guessed{end+1} = field;
[~, ~, v] = guess_info(field);
end

function [label, unit, default] = guess_info(field)
switch field
    case 'diameter_mm'
        label = 'diameter'; unit = 'mm'; default = 150;
    case 'thickness_mm'
        label = 'thickness'; unit = 'mm'; default = 62;
    otherwise
        label = 'temperature'; unit = 'C'; default = 25;
end
end

function s = guess_summary(guessed, withValues)
if isempty(guessed)
    s = '';
    return
end
parts = cell(1, numel(guessed));
for i = 1:numel(guessed)
    [label, unit, default] = guess_info(guessed{i});
    if withValues
        parts{i} = sprintf('%s = %g %s', label, default, unit);
    else
        parts{i} = label;
    end
end
s = strjoin(parts, ', ');
end

function groups = split_specimens(T, nameCol, fallback)
groups = {};
if isempty(nameCol)
    groups{1} = struct('name', fallback, 'table', T);
    return
end
vals = T.(nameCol);
u = unique(vals, 'stable');
if numel(u) <= 1 || (height(T) > 20 && numel(u) >= 0.8 * height(T))
    label = fallback;
    if numel(u) == 1
        label = char(string(u(1)));
    end
    groups{1} = struct('name', label, 'table', T);
    return
end
for i = 1:numel(u)
    mask = ismember(vals, u(i));
    label = fallback;
    if ~isnumeric(u)
        label = char(string(u(i)));
    elseif isfinite(u(i))
        label = num2str(u(i));
    end
    groups{i} = struct('name', label, 'table', T(mask, :));
end
end

function x = to_num(v)
if isnumeric(v)
    x = double(v(:));
    return
end
x = str2double(string(v(:)));
end

function v = first_num(T, col, fallback)
v = fallback;
if isempty(col), return; end
nums = to_num(T.(col));
nums = nums(isfinite(nums));
if ~isempty(nums), v = nums(1); end
end

function v = row_num(T, col, r)
v = NaN;
if isempty(col), return; end
nums = to_num(T.(col));
if r <= numel(nums), v = nums(r); end
end

function s = safe_name(name)
s = norm_name(name);
if isempty(s), s = 'specimen'; end
if numel(s) > 60, s = s(1:60); end
end

function row = blank_row(name, source)
row = struct( ...
    'specimen_name', char(string(name)), ...
    'source', char(string(source)), ...
    'testing_temperature', NaN, ...
    'specimen_diameter', NaN, ...
    'specimen_thickness', NaN, ...
    'peak_load', NaN, ...
    'm75', NaN, ...
    'l75', NaN, ...
    'failure_work', NaN, ...
    'fracture_energy_jm2', NaN, ...
    'ct_index', NaN, ...
    'tensile_strength_mpa', NaN, ...
    'assumed_values', '', ...
    'gmb', NaN, ...
    'air_voids_pct', NaN);
end

function R = compute_ct_index(force, disp, diameter_mm, thickness_mm)
% Drop the tail after the specimen fails and the load crosses back through
% zero. Only negatives *after* the peak count: a trace typically opens with
% pre-load sensor noise straddling zero, and cutting at the first negative
% anywhere truncates the whole test to those few noise points.
[~, peak_idx] = max(force);
neg = find(force(peak_idx:end) < 0, 1, 'first');
if ~isempty(neg)
    cut = peak_idx + neg - 1;
    force = force(1:cut-1);
    disp = disp(1:cut-1);
end
if numel(force) < 4
    error('Not enough force-displacement points after trimming.');
end
[max_force, idx] = max(force);
max_disp = disp(idx);
rem_force = force(disp >= max_disp);
rem_disp = disp(disp >= max_disp);
if numel(rem_force) < 3
    error('Post-peak curve is too short to locate 85/75/65%% load.');
end
f85 = 0.85 * max_force;
f75 = 0.75 * max_force;
f65 = 0.65 * max_force;
[~, i85] = min(abs(rem_force - f85));
[~, i75] = min(abs(rem_force - f75));
[~, i65] = min(abs(rem_force - f65));
l85 = rem_disp(i85);
l75 = rem_disp(i75);
l65 = rem_disp(i65);
if l85 == l65
    error('85%% and 65%% post-peak displacements are identical; cannot compute m75.');
end
area = trapz(disp, force);
m = (f85 - f65) / (l85 - l65);
gf = area * 1e6 / (diameter_mm * thickness_mm);
ct = (l75 / diameter_mm) * (gf / abs(m));
ts = (2 * max_force) * 1e3 / (pi * diameter_mm * thickness_mm);
R = struct('peak', max_force, 'm75', m, 'l75', l75, 'area', area, ...
    'gf', gf, 'ct', ct, 'ts', ts, 'force', force, 'disp', disp);
end
