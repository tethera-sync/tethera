import { z } from "zod"

export const DIRECTORY_MAPPING_CAPABILITY = "directory-case-mapping-v1"

const relativeDirectory = z.string().min(1).max(4096).refine((value) =>
  !value.includes("\\") && !value.includes("\0") && !value.includes(":") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith(".tethera-")),
)

export const directoryMappingSchema = z.object({
  path: relativeDirectory,
  localPath: relativeDirectory,
  remotePath: relativeDirectory,
  olderLocalPaths: z.array(relativeDirectory).max(100),
  olderRemotePaths: z.array(relativeDirectory).max(100),
}).strict().refine((mapping) =>
  [mapping.localPath, mapping.remotePath, ...mapping.olderLocalPaths, ...mapping.olderRemotePaths]
    .every((path) => path.toLowerCase() === mapping.path.toLowerCase()) &&
  !mapping.olderLocalPaths.includes(mapping.localPath) && !mapping.olderRemotePaths.includes(mapping.remotePath),
)

export const directoryMappingsSchema = z.array(directoryMappingSchema).max(100).refine((mappings) =>
  new Set(mappings.map((mapping) => mapping.path.toLowerCase())).size === mappings.length &&
  mappings.every((mapping) => mappings.every((parent) => {
    if (!mapping.path.toLowerCase().startsWith(`${parent.path.toLowerCase()}/`)) return true
    return mapping.path.startsWith(`${parent.path}/`) &&
      [mapping.localPath, ...mapping.olderLocalPaths].every((path) => path.startsWith(`${parent.localPath}/`)) &&
      [mapping.remotePath, ...mapping.olderRemotePaths].every((path) => path.startsWith(`${parent.remotePath}/`))
  })),
)

/** Paths are relative to the two approved roots, in proposal (initiator/responder) order. */
export type DirectoryMapping = z.infer<typeof directoryMappingSchema>
