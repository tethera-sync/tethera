# Electron-to-engine RPC contract

## Envelope

```ts
interface RpcRequest<T> { protocolVersion: number; requestId: string; method: string; params: T }
interface RpcResponse<T> {
  requestId: string
  ok: boolean
  result?: T
  error?: { code: string; messageKey: string; details?: unknown; retryable: boolean }
}
```

## Methods

- Application: `app.getSnapshot`, `app.getSettings`, `app.updateSettings`, `app.prepareForUpdate`, `app.shutdown`, `app.exportDiagnostics`.
- Devices: list, discover, begin/submit/approve/cancel pairing, rename, revoke.
- Folders: list/get/create draft, choose remote destination, scan/get/confirm initial plan, update policy, pause/resume/sync now, remove preview/confirm.
- Ignore: list rules, test path, preview/apply changes, search items.
- History: search, versions, restore preview/confirm, pin, delete preview/confirm.
- Activity: search, acknowledge.

## Events

Monotonic sequence numbers for app/device/pairing/folder/progress/issues/activity/history/settings/shutdown. On a gap, request a fresh snapshot.

Electron validates renderer input before forwarding; engine validates again. Native directory choices should become opaque capabilities where practical rather than arbitrary renderer paths.
