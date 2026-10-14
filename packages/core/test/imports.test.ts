import { describe, expect, it } from "vitest";
import { countUsageLines, findImports, languageOf } from "../src/imports";

describe("languageOf", () => {
  it("knows JS/TS and Python files", () => {
    expect(languageOf("a/b.tsx")).toBe("js");
    expect(languageOf("a/b.mjs")).toBe("js");
    expect(languageOf("a/b.py")).toBe("py");
    expect(languageOf("a/b.md")).toBeNull();
  });
});

describe("findImports (JS/TS)", () => {
  it("reads default, named, aliased, type, dynamic and require imports; skips builtins, relative and alias paths", () => {
    const src = [
      'import React, { useState, useEffect as ue } from "react";',
      'import * as path from "node:path";',
      'import fs from "fs";',
      'import type { Foo } from "@scope/types/sub";',
      'import "./styles.css";',
      'import client from "react-dom/client";',
      'import x from "@/components/x";',
      "const { z } = require('zod');",
      'const lazy = await import("lodash");',
    ].join("\n");
    expect(findImports("app.tsx", src)).toEqual([
      { ecosystem: "npm", name: "react", localNames: ["useState", "ue", "React"] },
      { ecosystem: "npm", name: "@scope/types", localNames: ["Foo"] },
      { ecosystem: "npm", name: "react-dom", localNames: ["client"] },
      { ecosystem: "npm", name: "lodash", localNames: [] },
      { ecosystem: "npm", name: "zod", localNames: ["z"] },
    ]);
  });
});

describe("findImports (Python)", () => {
  it("handles aliases, import-name mapping, google namespaces, relative imports and parentheses", () => {
    const src = [
      "import os, numpy as np",
      "import yaml",
      "from sklearn.model_selection import train_test_split",
      "from google import genai",
      "from google.cloud import storage",
      "from . import local",
      "from fastapi import (",
      "    FastAPI,",
      "    Depends as D,",
      ")",
    ].join("\n");
    expect(findImports("m.py", src)).toEqual([
      { ecosystem: "pypi", name: "numpy", localNames: ["np"] },
      { ecosystem: "pypi", name: "pyyaml", localNames: ["yaml"] },
      { ecosystem: "pypi", name: "scikit-learn", localNames: ["train_test_split"] },
      { ecosystem: "pypi", name: "google-genai", localNames: ["genai"] },
      { ecosystem: "pypi", name: "google-cloud-storage", localNames: ["storage"] },
      { ecosystem: "pypi", name: "fastapi", localNames: ["FastAPI", "D"] },
    ]);
  });
});

describe("countUsageLines", () => {
  it("counts lines that use a local name, ignoring import lines and property access", () => {
    const src = ['import { z } from "zod";', "const A = z.object({});", "const B = other.z;", "export const C = z.string();"].join("\n");
    expect(countUsageLines(src, ["z"], "js")).toBe(2);
  });

  it("returns 0 when there are no local names", () => {
    expect(countUsageLines("anything", [], "py")).toBe(0);
  });
});
