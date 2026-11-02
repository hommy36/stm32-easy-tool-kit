import { ToolInstallation } from '../core/types';
import { mergeToolPath, toolBinDirectories } from '../core/paths';

export function buildToolEnvironment(parent: NodeJS.ProcessEnv, tools: ToolInstallation[]): NodeJS.ProcessEnv {
  const selected = tools.filter(tool => tool.id === 'armGnu' || tool.id === 'cmake' || tool.id === 'ninja');
  return mergeToolPath(parent, toolBinDirectories(selected));
}
