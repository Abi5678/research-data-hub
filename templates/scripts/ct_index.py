"""IDEAL-CT (CT Index) for Fieldbook.

Adapted from the lab's `CT-Index Python.py`. Fieldbook writes each selected
dataset as a CSV plus inputs.json, then runs this file headless.

The script:
  1. Reads every table listed in inputs.json (or data*.csv).
  2. Finds specimens — a specimen-id column, or one specimen per sheet/file.
  3. Computes CT Index from Force/LVDT traces, or copies an already-calculated
     CT Index column from a results / Gmb workbook.
  4. Writes ct_index_results.csv, ct_index_results.xlsx, and plots.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

SPECIMEN_DEFAULTS = {
    "diameter_mm": 150.0,
    "thickness_mm": 62.0,
    "temperature_c": 25.0,
}

FORCE_ALIASES = ("force", "load", "load_kn", "load_n", "peak_load")
DISP_ALIASES = ("lvdt", "disp", "displacement", "stroke", "deformation")
NAME_ALIASES = (
    "specimen_name",
    "specimen_code",
    "specimen_id",
    "sample_id",
    "sample",
    "core_id",
    "name",
    "id",
    "specimen",
)
DIA_ALIASES = (
    "diameter_d_average",
    "diameter_d_avg",
    "diameter_avg",
    "avg",
    "diameter_mm",
    "dia",
    "diameter",
    "d_mm",
)
THK_ALIASES = (
    "thickness_t_avg",
    "thickness_t_average",
    "avg_2",
    "thickness_mm",
    "thick",
    "thickness",
    "height_mm",
    "height",
    "t_mm",
)
TEMP_ALIASES = ("testing_temperature", "temperature_c", "temp", "temperature")
CT_ALIASES = ("ct_index", "ctindex", "ct", "ideal_ct", "ct_idx")
GMB_ALIASES = ("gmb",)
AIR_ALIASES = ("air_voids", "air_voids_pct", "air_void")

trapz = getattr(np, "trapezoid", np.trapz)


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower()).strip("_")


def _find(columns, aliases):
    by_norm = {_norm(c): c for c in columns}
    for a in aliases:
        hit = by_norm.get(_norm(a))
        if hit:
            return hit
    return None


def _numeric(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def _safe_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower()).strip("_")
    return slug[:60] or "specimen"


def load_tables():
    manifest = Path("inputs.json")
    if manifest.exists():
        data = json.loads(manifest.read_text())
        tables = []
        for item in data.get("inputs") or []:
            path = Path(item["file"])
            if not path.exists():
                print(f"Skipping missing file {path}")
                continue
            tables.append((item.get("display_name") or path.stem, path))
        if tables:
            return tables
    return [(p.stem, p) for p in sorted(Path(".").glob("data*.csv"))]


def compute_ct_index(force: np.ndarray, disp: np.ndarray, diameter_mm: float, thickness_mm: float):
    negative_idx = np.where(force < 0)[0]
    if len(negative_idx) > 0:
        cut = int(negative_idx[0])
        force = force[:cut]
        disp = disp[:cut]
    if force.size < 4:
        raise ValueError("Not enough force–displacement points after trimming.")

    max_force_idx = int(np.argmax(force))
    max_force = float(force[max_force_idx])
    max_disp = float(disp[max_force_idx])

    rem_force = force[disp >= max_disp]
    rem_disp = disp[disp >= max_disp]
    if rem_force.size < 3:
        raise ValueError("Post-peak curve is too short to locate 85/75/65% load.")

    f85 = 0.85 * max_force
    f75 = 0.75 * max_force
    f65 = 0.65 * max_force
    idx85 = int(np.abs(rem_force - f85).argmin())
    idx75 = int(np.abs(rem_force - f75).argmin())
    idx65 = int(np.abs(rem_force - f65).argmin())
    l85 = float(rem_disp[idx85])
    l75 = float(rem_disp[idx75])
    l65 = float(rem_disp[idx65])
    if l85 == l65:
        raise ValueError("85% and 65% post-peak displacements are identical; cannot compute m75.")

    area = float(trapz(y=force, x=disp))
    m = (f85 - f65) / (l85 - l65)
    gf = area * 1e6 / (diameter_mm * thickness_mm)
    ct = (l75 / diameter_mm) * (gf / abs(m))
    tensile_strength = (2 * max_force) * 1e3 / (np.pi * diameter_mm * thickness_mm)
    return {
        "peak_load": max_force,
        "m75": m,
        "l75": l75,
        "failure_work": area,
        "fracture_energy_jm2": gf,
        "ct_index": ct,
        "tensile_strength_mpa": tensile_strength,
        "force": force,
        "disp": disp,
    }


def first_number(series: pd.Series, fallback: float) -> float:
    nums = _numeric(series).dropna()
    return float(nums.iloc[0]) if len(nums) else float(fallback)


def specimen_groups(df: pd.DataFrame, fallback_name: str):
    name_col = _find(df.columns, NAME_ALIASES)
    if not name_col:
        return [(fallback_name, df)]
    nunique = df[name_col].nunique(dropna=True)
    # A unique id on every row is a primary key, not a specimen grouping for a trace.
    if nunique <= 1 or nunique >= max(len(df) * 0.8, 2) and len(df) > 20:
        if nunique == 1:
            label = str(df[name_col].dropna().iloc[0]) if df[name_col].notna().any() else fallback_name
            return [(label, df)]
        if len(df) > 20:
            return [(fallback_name, df)]
    groups = []
    for name, g in df.groupby(name_col, dropna=False):
        label = fallback_name if pd.isna(name) else str(name)
        groups.append((label, g))
    return groups or [(fallback_name, df)]


def analyze_table(name: str, path: Path, plot_dir: Path) -> list[dict]:
    df = pd.read_csv(path)
    print(f"\n{name} ({path.name}): {len(df)} rows, columns {list(df.columns)}")

    force_col = _find(df.columns, FORCE_ALIASES)
    disp_col = _find(df.columns, DISP_ALIASES)
    ct_col = _find(df.columns, CT_ALIASES)
    dia_col = _find(df.columns, DIA_ALIASES)
    thk_col = _find(df.columns, THK_ALIASES)
    temp_col = _find(df.columns, TEMP_ALIASES)

    if ct_col and not (force_col and disp_col):
        rows = []
        for spec_name, g in specimen_groups(df, name):
            ct_vals = _numeric(g[ct_col]).dropna()
            if ct_vals.empty:
                continue
            rows.append(
                {
                    "specimen_name": spec_name,
                    "source": path.name,
                    "testing_temperature": first_number(g[temp_col], np.nan) if temp_col else np.nan,
                    "specimen_diameter": first_number(g[dia_col], np.nan) if dia_col else np.nan,
                    "specimen_thickness": first_number(g[thk_col], np.nan) if thk_col else np.nan,
                    "peak_load": np.nan,
                    "m75": np.nan,
                    "l75": np.nan,
                    "failure_work": np.nan,
                    "fracture_energy_jm2": np.nan,
                    "ct_index": float(ct_vals.mean()),
                    "tensile_strength_mpa": np.nan,
                }
            )
            print(f"  {spec_name}: CT Index (from table) = {ct_vals.mean():.3f}")
        return rows

    gmb_col = _find(df.columns, GMB_ALIASES)
    name_col = _find(df.columns, NAME_ALIASES)
    if gmb_col and name_col and not (force_col and disp_col):
        air_col = _find(df.columns, AIR_ALIASES)
        rows = []
        seen = set()
        for _, rec in df.iterrows():
            spec = str(rec[name_col]).strip()
            gmb = pd.to_numeric(rec[gmb_col], errors="coerce")
            if not spec or spec.lower() in {"nan", "none"} or not np.isfinite(gmb):
                continue
            if spec in seen:
                continue
            seen.add(spec)
            dia = first_number(pd.Series([rec[dia_col]]) if dia_col else pd.Series(dtype=float), np.nan)
            thick = first_number(pd.Series([rec[thk_col]]) if thk_col else pd.Series(dtype=float), np.nan)
            air = first_number(pd.Series([rec[air_col]]) if air_col else pd.Series(dtype=float), np.nan)
            rows.append(
                {
                    "specimen_name": spec,
                    "source": name,
                    "testing_temperature": np.nan,
                    "specimen_diameter": dia,
                    "specimen_thickness": thick,
                    "gmb": float(gmb),
                    "air_voids_pct": air,
                    "peak_load": np.nan,
                    "m75": np.nan,
                    "l75": np.nan,
                    "failure_work": np.nan,
                    "fracture_energy_jm2": np.nan,
                    "ct_index": np.nan,
                    "tensile_strength_mpa": np.nan,
                }
            )
            print(
                f"  {spec}: Gmb = {gmb:.3f}"
                + (f", Va = {air:.2f}%" if np.isfinite(air) else "")
                + (f", D = {dia:.2f} mm" if np.isfinite(dia) else "")
                + (f", t = {thick:.2f} mm" if np.isfinite(thick) else "")
            )
        return rows

    if not force_col or not disp_col:
        print("  Skipped — no Force/LVDT trace, CT Index, or Gmb specimen table.")
        return []

    rows = []
    for spec_name, g in specimen_groups(df, name):
        work = g.copy()
        work["_force"] = _numeric(work[force_col])
        work["_disp"] = _numeric(work[disp_col])
        work = work.dropna(subset=["_force", "_disp"])
        if work.empty:
            print(f"  {spec_name}: no numeric Force/LVDT rows")
            continue
        dia = first_number(work[dia_col], SPECIMEN_DEFAULTS["diameter_mm"]) if dia_col else SPECIMEN_DEFAULTS["diameter_mm"]
        thick = first_number(work[thk_col], SPECIMEN_DEFAULTS["thickness_mm"]) if thk_col else SPECIMEN_DEFAULTS["thickness_mm"]
        temp = first_number(work[temp_col], SPECIMEN_DEFAULTS["temperature_c"]) if temp_col else SPECIMEN_DEFAULTS["temperature_c"]
        try:
            result = compute_ct_index(
                work["_force"].to_numpy(dtype=float),
                work["_disp"].to_numpy(dtype=float),
                dia,
                thick,
            )
        except ValueError as err:
            print(f"  {spec_name}: {err}")
            continue
        plot_dir.mkdir(exist_ok=True)
        fig = plt.figure()
        plt.plot(result["disp"], result["force"])
        plt.xlabel("Displacement")
        plt.ylabel("Force")
        plt.title(spec_name)
        fig.tight_layout()
        fig.savefig(plot_dir / f"{_safe_name(spec_name)}.png")
        plt.close(fig)
        rows.append(
            {
                "specimen_name": spec_name,
                "source": path.name,
                "testing_temperature": temp,
                "specimen_diameter": dia,
                "specimen_thickness": thick,
                "peak_load": result["peak_load"],
                "m75": result["m75"],
                "l75": result["l75"],
                "failure_work": result["failure_work"],
                "fracture_energy_jm2": result["fracture_energy_jm2"],
                "ct_index": result["ct_index"],
                "tensile_strength_mpa": result["tensile_strength_mpa"],
            }
        )
        print(
            f"  {spec_name}: CT Index = {result['ct_index']:.3f}, "
            f"Gf = {result['fracture_energy_jm2']:.1f} J/m^2, "
            f"ITS = {result['tensile_strength_mpa']:.3f} MPa"
        )
    return rows


tables = load_tables()
if not tables:
    raise SystemExit("No datasets found. Select one or more tables in Fieldbook and run again.")

plot_dir = Path("plots")
all_rows: list[dict] = []
for display_name, path in tables:
    all_rows.extend(analyze_table(display_name, path, plot_dir))

if not all_rows:
    raise SystemExit(
        "No specimens found. Need Force + LVDT columns (raw IDEAL-CT), "
        "a CT Index column, or a Sample ID + Gmb table."
    )

out = pd.DataFrame(all_rows)
out.to_csv("ct_index_results.csv", index=False)
try:
    out.to_excel("ct_index_results.xlsx", index=False)
    xlsx_note = " and ct_index_results.xlsx"
except Exception as err:
    xlsx_note = f" (xlsx skipped: {err})"

fig = plt.figure()
if "ct_index" in out.columns and out["ct_index"].notna().any():
    plt.bar(out["specimen_name"].astype(str), out["ct_index"])
    plt.ylabel("CT Index")
    plt.title("IDEAL-CT by specimen")
elif "gmb" in out.columns and out["gmb"].notna().any():
    plt.bar(out["specimen_name"].astype(str), out["gmb"])
    plt.ylabel("Gmb")
    plt.title("Specimen Gmb")
else:
    plt.close(fig)
    fig = None
if fig is not None:
    plt.xticks(rotation=90, ha="right", fontsize=7)
    fig.tight_layout()
    fig.savefig("ct_index.png")
    plt.close(fig)

n_plots = len(list(plot_dir.glob("*.png"))) if plot_dir.exists() else 0
print(f"\nWrote ct_index_results.csv{xlsx_note}" + (", ct_index.png" if fig is not None else "") + (f", and {n_plots} specimen plots" if n_plots else ""))
print(f"{len(out)} specimens")
print(out.to_string(index=False))
