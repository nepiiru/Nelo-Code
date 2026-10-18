import type { Tool } from '../types.js';
import { editFileTool } from './edit-file.js';
import { grepTool } from './grep.js';
import { listFilesTool } from './list-files.js';
import { readFileTool } from './read-file.js';
import { runCommandTool } from './run-command.js';
import { writeFileTool } from './write-file.js';

export function createTools(): Tool[] {
  return [
    readFileTool,
    listFilesTool,
    grepTool,
    editFileTool,
    writeFileTool,
    runCommandTool,
  ];
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((tool) => tool.definition.name === name);
}

export {
  readFileTool,
  listFilesTool,
  grepTool,
  editFileTool,
  writeFileTool,
  runCommandTool,
};
