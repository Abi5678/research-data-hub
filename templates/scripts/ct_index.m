% IDEAL-CT (CT Index) for Fieldbook.
% Same analysis as templates/scripts/ct_index.py. Fieldbook writes each
% selected dataset as CSV plus inputs.json, then runs this file with -batch.
%
% Finds specimens (id column, or one specimen per sheet), computes CT Index
% from Force/LVDT, and writes ct_index_results.csv plus plots.

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

results = {};
for t = 1:numel(files)
    T = readtable(files{t}, 'PreserveVariableNames', true);
    fprintf('\n%s (%s): %d rows\n', names{t}, files{t}, height(T));
    vars = T.Properties.VariableNames;
    forceCol = find_alias(vars, {'force','load','load_kn','load_n','peak_load'});
    dispCol  = find_alias(vars, {'lvdt','disp','displacement','stroke','deformation'});
    nameCol  = find_alias(vars, {'specimen_name','specimen_code','specimen_id','sample_id','sample','core_id','name','specimen'});
    diaCol   = find_alias(vars, {'diameter_mm','dia','diameter','d_mm'});
    thkCol   = find_alias(vars, {'thickness_mm','thick','thickness','height_mm','height','t_mm'});
    tempCol  = find_alias(vars, {'testing_temperature','temperature_c','temp','temperature'});
    ctCol    = find_alias(vars, {'ct_index','ctindex','ct','ideal_ct','ct_idx'});

    if ~isempty(ctCol) && (isempty(forceCol) || isempty(dispCol))
        groups = split_specimens(T, nameCol, names{t});
        for g = 1:numel(groups)
            ct = mean(to_num(groups{g}.table.(ctCol)), 'omitnan');
            if isnan(ct), continue; end
            results{end+1} = result_row(groups{g}.name, files{t}, groups{g}.table, ...
                diaCol, thkCol, tempCol, ct, NaN, NaN, NaN, NaN, NaN, NaN); %#ok<AGROW>
            fprintf('  %s: CT Index (from table) = %.3f\n', groups{g}.name, ct);
        end
        continue
    end

    if isempty(forceCol) || isempty(dispCol)
        fprintf('  Skipped — no Force/LVDT trace and no CT Index column.\n');
        continue
    end

    groups = split_specimens(T, nameCol, names{t});
    for g = 1:numel(groups)
        G = groups{g}.table;
        force = to_num(G.(forceCol));
        disp = to_num(G.(dispCol));
        keep = isfinite(force) & isfinite(disp);
        force = force(keep);
        disp = disp(keep);
        if numel(force) < 4
            fprintf('  %s: not enough numeric Force/LVDT rows\n', groups{g}.name);
            continue
        end
        dia = first_num(G, diaCol, 150);
        thick = first_num(G, thkCol, 62);
        temp = first_num(G, tempCol, 25);
        try
            R = compute_ct_index(force, disp, dia, thick);
        catch err
            fprintf('  %s: %s\n', groups{g}.name, err.message);
            continue
        end
        fig = figure('Visible', 'off');
        plot(R.disp, R.force);
        xlabel('Displacement'); ylabel('Force'); title(groups{g}.name);
        saveas(fig, fullfile('plots', [safe_name(groups{g}.name) '.png']));
        close(fig);
        results{end+1} = result_row(groups{g}.name, files{t}, G, ...
            diaCol, thkCol, tempCol, R.ct, R.peak, R.m75, R.l75, R.area, R.gf, R.ts); %#ok<AGROW>
        fprintf('  %s: CT Index = %.3f, Gf = %.1f J/m^2, ITS = %.3f MPa\n', ...
            groups{g}.name, R.ct, R.gf, R.ts);
    end
end

if isempty(results)
    error(['No specimens produced a CT Index. Need Force + LVDT columns ' ...
        '(raw IDEAL-CT) or a CT Index column (results workbook).']);
end

Out = struct2table(vertcat(results{:}));
writetable(Out, 'ct_index_results.csv');
try
    writetable(Out, 'ct_index_results.xlsx');
catch
end

fig = figure('Visible', 'off');
bar(categorical(Out.specimen_name), Out.ct_index);
ylabel('CT Index'); title('IDEAL-CT by specimen');
saveas(fig, 'ct_index.png');
close(fig);
fprintf('\nWrote ct_index_results.csv and ct_index.png\n');

function col = find_alias(vars, aliases)
col = '';
n = lower(regexprep(vars, '[^a-z0-9]+', '_'));
for i = 1:numel(aliases)
    hit = find(strcmp(n, aliases{i}), 1);
    if ~isempty(hit)
        col = vars{hit};
        return
    end
end
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

function s = safe_name(name)
s = regexprep(lower(char(string(name))), '[^a-z0-9]+', '_');
s = regexprep(s, '^_+|_+$', '');
if isempty(s), s = 'specimen'; end
if numel(s) > 60, s = s(1:60); end
end

function row = result_row(name, source, G, diaCol, thkCol, tempCol, ct, peak, m75, l75, area, gf, ts)
row = struct( ...
    'specimen_name', name, ...
    'source', source, ...
    'testing_temperature', first_num(G, tempCol, NaN), ...
    'specimen_diameter', first_num(G, diaCol, NaN), ...
    'specimen_thickness', first_num(G, thkCol, NaN), ...
    'peak_load', peak, ...
    'm75', m75, ...
    'l75', l75, ...
    'failure_work', area, ...
    'fracture_energy_jm2', gf, ...
    'ct_index', ct, ...
    'tensile_strength_mpa', ts);
end

function R = compute_ct_index(force, disp, diameter_mm, thickness_mm)
neg = find(force < 0, 1, 'first');
if ~isempty(neg)
    force = force(1:neg-1);
    disp = disp(1:neg-1);
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
