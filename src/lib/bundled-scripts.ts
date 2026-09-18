import type { ScriptLanguage } from "@/lib/api";
import ctIndexPy from "../../templates/scripts/ct_index.py?raw";
import ctIndexM from "../../templates/scripts/ct_index.m?raw";

export type BundledScript = {
  id: string;
  name: string;
  language: ScriptLanguage;
  code: string;
  summary: string;
};

/** Analysis files Fieldbook can copy into a project. The original on disk is
 *  never run; Scripts copies the text, same as “Add file”. */
export const BUNDLED_SCRIPTS: BundledScript[] = [
  {
    id: "ct-index-python",
    name: "IDEAL-CT Index.py",
    language: "python",
    code: ctIndexPy,
    summary: "Find specimens in Excel/CSV, compute CT Index, write results and plots.",
  },
  {
    id: "ct-index-matlab",
    name: "IDEAL-CT Index.m",
    language: "matlab",
    code: ctIndexM,
    summary: "Same IDEAL-CT analysis for MATLAB.",
  },
];
