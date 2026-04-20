import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bundlePath = resolve(process.cwd(), 'dist/main.js');
const bundle = await readFile(bundlePath, 'utf8');

const checks = [
  {
    name: 'dynamic obsidian import',
    pattern: /import\((['"])obsidian\1\)/,
    message: 'Bundle contains dynamic import(\'obsidian\'), which will fail at runtime in Obsidian.',
  },
  {
    name: 'dynamic electron import',
    pattern: /import\((['"])electron\1\)/,
    message: 'Bundle contains dynamic import(\'electron\'), which should stay external.',
  },
  {
    name: 'embedded node_modules codemirror state',
    pattern: /node_modules\/[^\n]*@codemirror\/state/,
    message: 'Bundle appears to embed node_modules/@codemirror/state content.',
  },
  {
    name: 'embedded node_modules codemirror view',
    pattern: /node_modules\/[^\n]*@codemirror\/view/,
    message: 'Bundle appears to embed node_modules/@codemirror/view content.',
  },
  {
    name: 'embedded node_modules lezer common',
    pattern: /node_modules\/[^\n]*@lezer\/common/,
    message: 'Bundle appears to embed node_modules/@lezer/common content.',
  },
  {
    name: 'embedded node_modules lezer highlight',
    pattern: /node_modules\/[^\n]*@lezer\/highlight/,
    message: 'Bundle appears to embed node_modules/@lezer/highlight content.',
  },
  {
    name: 'embedded node_modules lezer lr',
    pattern: /node_modules\/[^\n]*@lezer\/lr/,
    message: 'Bundle appears to embed node_modules/@lezer/lr content.',
  },
];

const warnings = [
  {
    name: 'external codemirror state reference',
    pattern: /[@"]@codemirror\/state[@"]/,
    message: 'Bundle references @codemirror/state. This is expected only when the package is externalized.',
  },
  {
    name: 'external codemirror view reference',
    pattern: /[@"]@codemirror\/view[@"]/,
    message: 'Bundle references @codemirror/view. This is expected only when the package is externalized.',
  },
  {
    name: 'bundled y-codemirror payload',
    pattern: /y-codemirror\.next/,
    message: 'Bundle contains y-codemirror.next payload. Ensure CM6 packages stay externalized.',
  },
];

const failures = checks.filter((check) => check.pattern.test(bundle));

if (failures.length > 0) {
  console.error('Bundle safety check failed for dist/main.js');
  for (const failure of failures) {
    console.error(`- ${failure.name}: ${failure.message}`);
  }
  process.exit(1);
}

const matchedWarnings = warnings.filter((warning) => warning.pattern.test(bundle));
for (const warning of matchedWarnings) {
  console.warn(`Bundle safety warning: ${warning.name}: ${warning.message}`);
}

console.log('Bundle safety check passed');
