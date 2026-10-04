// Resolve only the task API imported by taskWorkspace to its real, dependency-free source.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@rcai/conversation-core') {
    return {url: new URL('../packages/conversation-core/src/tasks.ts', import.meta.url).href, shortCircuit: true};
  }
  return nextResolve(specifier, context);
}
