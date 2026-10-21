import assert from "node:assert/strict";
import path from "node:path";

import ts from "typescript";

const filename = path.resolve(
  "packages/excalidraw/semantic-result-consumer.ts",
);
const source = `
  import {
    prepareSemanticBatch, prepareSceneImport,
    type SemanticBatchResult, type SemanticOperation,
  } from "@excalidraw-yjs/excalidraw/headless";
  declare const doc: Parameters<typeof prepareSemanticBatch>[0];
  declare const options: Parameters<typeof prepareSemanticBatch>[2];
  declare const input: Parameters<typeof prepareSceneImport>[1];
  declare const previousConsumer: (op: SemanticOperation["op"]) => void;
  declare const importConsumer: (op: "importScene") => void;
  declare const result: SemanticBatchResult;
  if (result.ok) result.summary.forEach(item => previousConsumer(item.op));
  const batch = prepareSemanticBatch(doc, [{op: "addText", text: "natural"}], options);
  if (batch.ok) batch.summary.forEach(item => previousConsumer(item.op));
  const imported = prepareSceneImport(doc, input, options);
  if (imported.ok) imported.summary.forEach(item => importConsumer(item.op));
`;
const options = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
};
const host = ts.createCompilerHost(options);
const readFile = host.readFile.bind(host);
const fileExists = host.fileExists.bind(host);
host.readFile = (file) => (file === filename ? source : readFile(file));
host.fileExists = (file) => file === filename || fileExists(file);
const program = ts.createProgram([filename], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(
  diagnostics.length,
  0,
  ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (file) => file,
    getNewLine: () => "\n",
  }),
);
process.stdout.write(
  "PASS public built declarations preserve operation-only and import-only summaries\n",
);
