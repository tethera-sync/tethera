export const defaultIgnorePatterns = [".DS_Store", "Thumbs.db", "desktop.ini", "*.tmp", "~$*", "node_modules/", ".venv/"]

const javascriptPatterns = ["node_modules/", ".next/", ".nuxt/", ".turbo/"]
const pythonPatterns = [".venv/", "venv/", "__pycache__/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/"]

export const folderIgnorePresets = [
  { id: "common", label: "Common defaults", patterns: defaultIgnorePatterns },
  { id: "coding", label: "Coding — JavaScript and Python", patterns: [...javascriptPatterns, ...pythonPatterns] },
  { id: "javascript", label: "JavaScript / TypeScript", patterns: javascriptPatterns },
  { id: "python", label: "Python", patterns: pythonPatterns },
  { id: "rust", label: "Rust build output", patterns: ["target/"] },
  { id: "dotnet", label: ".NET build output", patterns: ["bin/", "obj/"] },
] as const

/** Presets add suggestions without replacing custom rules or reordering the user's list. */
export function appendIgnorePreset(current: string, patterns: readonly string[]): string {
  const existing = new Set(current.split("\n").map((pattern) => pattern.trim()))
  const additions = patterns.filter((pattern) => !existing.has(pattern))
  if (additions.length === 0) return current
  return [current.trimEnd(), ...additions].filter(Boolean).join("\n")
}
