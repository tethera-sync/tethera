import { expect, test } from "bun:test"
import { folderMappingApprovalKey } from "../src/shared/folder-scan-issues"
import type { IncomingMappingRequest } from "../src/shared/contracts"
import { compareManifests } from "../src/main/folder-manifest"
import { manifest } from "./helpers"

function approvalRequest(): IncomingMappingRequest {
  return {
    id: "request-1", fromDeviceId: "linux", fromDeviceName: "Linux laptop", status: "pending", selectedDestinationPath: "D:\\coding", message: "Review the comparison.",
    proposal: {
      id: "request-1", name: "Coding", initiatorDeviceId: "linux", initiatorDeviceName: "Linux laptop", responderDeviceId: "windows",
      initiatorPath: "/synthetic/coding", responderPath: "D:\\coding", mode: "two-way", ignorePatterns: [], historyDays: 30, historyMaxBytes: 1024 ** 3, maxFileBytes: null,
      preview: compareManifests(manifest([], [{ path: "linux-locked", reason: "Permission denied", kind: "directory" }]), manifest([]), { mode: "two-way", localPlatform: "linux", remotePlatform: "windows" }),
      createdAt: "2026-09-13T12:00:00Z",
    },
  }
}

test("approval acknowledgement survives cloned snapshots and unrelated status text", () => {
  const request = approvalRequest()
  const original = folderMappingApprovalKey(request, request.proposal.responderPath)
  const next = structuredClone(request)
  next.message = "Peer still online"
  expect(folderMappingApprovalKey(next, next.proposal.responderPath)).toBe(original)
})

test("approval acknowledgement resets for changed destinations, requests, rules or scan issues", () => {
  const request = approvalRequest()
  const original = folderMappingApprovalKey(request, request.proposal.responderPath)
  expect(folderMappingApprovalKey(request, "E:\\coding")).not.toBe(original)
  const variants: [IncomingMappingRequest, IncomingMappingRequest, IncomingMappingRequest] = [structuredClone(request), structuredClone(request), structuredClone(request)]
  variants[0].id = "another-request"
  variants[1].proposal.ignorePatterns = ["*.tmp"]
  variants[2].proposal.preview.unreadableLocal = [{ path: "new-locked", reason: "Locked", kind: "file" }]
  for (const changed of variants) expect(folderMappingApprovalKey(changed, changed.proposal.responderPath)).not.toBe(original)
})
