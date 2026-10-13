# Optional HTTP integrations

These main-process adapters are opt-in and perform no network I/O during
construction. The application continues to use its existing reviewer and
no-op memory defaults unless a caller explicitly injects these adapters.
There are no default endpoints, credentials, tool names or vendor presets.
No settings UI or credential-store integration is included.

## Transport configuration

`HttpTransportOptions` accepts `endpoint`, optional `timeoutMs` (20 seconds by
default, integer values from 15 to 30 seconds), and optional `secretRef` with an
injected `resolveToken(secretRef)` function. The resolver runs only in the main
process at request time. It may return a token or a promise; a missing token or
resolver failure fails the request. Keep resolver implementations and secret
values outside renderer configuration and model prompts. Authentication uses
only the `Authorization: Bearer ...` header.

HTTPS is required. Plain HTTP is permitted only when `allowLoopbackHttp: true`
is explicitly set and the address is numeric IPv4 loopback or IPv6 loopback.
URL credentials, query strings and fragments are rejected. Redirects are never
followed, including redirects to another secure endpoint. No request is retried.
The deadline includes credential lookup and reading the entire response; MCP's
whole initialize/notification/tool sequence shares the same deadline. An
`AbortSignal` cancels lookup waiting and the active request, and late resolver
completion cannot start another request. Resolver implementations should avoid
unbounded background work of their own.

Responses are capped at 64 KiB of bytes, both for advertised lengths and streamed
chunks. JSON responses must have `application/json` content type. SSE is
rejected in this version. Status 401/403, other non-success statuses, transport
failures, invalid JSON and invalid protocol payloads fail with fixed Chinese
error messages and non-sensitive codes. Response bodies, endpoints, resolver
exceptions and tokens are never included in errors or logs. Exact token echoes
in response strings (including nested JSON text blocks) are replaced with
`[已隐藏]` before returning data to consumers. This is a backstop, not protection
against a hostile service encoding or transforming a credential; use a trusted
service and narrowly scoped tokens.

## approval-review/v0 wire

Inject an `HttpReviewer` into the existing `ReviewerChainOptions.reviewers`.
Its options add `name` (a user-visible Chinese label) and `getEpoch()`, a
main-process function returning the current nonnegative safe integer authority
epoch. Advance that epoch whenever earlier reviews should no longer be valid.
The caller must also propagate task cancellation through the review signal.
The chain's existing timeout can shorten the adapter deadline; configure the
chain timeout explicitly if a longer review is intended.

Each review posts this JSON object:

```json
{
  "protocol": "approval-review/v0",
  "request_id": "00000000-0000-4000-8000-000000000001",
  "action_digest": "<64 lowercase hexadecimal characters>",
  "epoch": 1,
  "context": {
    "decision": {
      "level": "ask",
      "summary": "运行命令",
      "reasons": ["需要确认"],
      "reasonCodes": ["not_allowlisted"]
    },
    "operation": { "kind": "shell", "command": "echo test" },
    "tier": "T1"
  }
}
```

`request_id` is a new UUID for each invocation. `action_digest` is SHA-256 over
UTF-8 canonical JSON of the complete `context`, including decision, operation
and tier: recursively sort object keys by JavaScript string comparison, omit
undefined object properties, preserve array order, use `JSON.stringify` for
keys and primitive values, and emit no whitespace. `approvalActionDigest`
exports the reference implementation. The request uses a snapshot of context.

The endpoint returns exactly:

```json
{
  "protocol": "approval-review/v0",
  "request_id": "00000000-0000-4000-8000-000000000001",
  "action_digest": "<the request digest>",
  "epoch": 1,
  "verdict": "annotate",
  "text": "请人工确认命令。"
}
```

Unknown fields are rejected. The protocol, request identifier, digest and epoch
must match the request, and the current authority epoch must still match when
the response arrives. Verdicts are `deny`, `annotate`, `request_information` or
`escalate`; `text` must be nonempty and satisfy the existing review text bound.
There is no remote `allow` verdict. Valid results feed the existing advisory
chain and its human approval behavior; failures use its configured
`onUnavailable` policy. The HTTP adapter cannot grant tool execution permission.

## MCP HTTP memory tool map

`McpHttpMemoryProvider` implements the read-only `MemoryProvider` port. Its
`tools` map contains optional `search` and `get` tool names; no names are
assumed. An omitted mapping advertises that capability as false and returns an
empty result without I/O. Configure only read-only tools. The remote search
tool must enforce the supplied project scope; get identifiers must be scoped
by the service's authorization policy.

| Port method | JSON-RPC tool arguments | Tool's JSON result |
| --- | --- | --- |
| `search({ projectId, query, limit, signal })` | `{ "projectId": "project", "query": "query", "limit": 5 }` | `{ "entries": [{ "id": "record", "title": "参考", "content": "资料" }] }` |
| `get(id, { signal })` | `{ "id": "record" }` | `{ "entry": { "id": "record", "content": "资料" } }` or `{ "entry": null }` |

Entries contain a nonempty `id` (up to 256 characters), optional `title` (up to
1,000 characters), and nonempty `content` (up to 64 Ki characters, additionally
subject to the transport byte cap). Search limits must be integers from 1 to
100; at most 100 entries are accepted and results are truncated to the requested
limit. A get response must match the requested identifier. Payload schemas are
strict; unexpected record fields are rejected. Provider results still pass
through the existing bounded, untrusted-context formatter before use in a
model prompt.

The transport supports the JSON-only subset of MCP Streamable HTTP protocol
version `2025-03-26`. Each invocation initializes an independent interaction
with `initialize`, verifies the negotiated version and tool capability, sends
`notifications/initialized`, then calls `tools/call`. It uses fresh string UUID
JSON-RPC IDs and requires each response to match its ID and `jsonrpc: "2.0"`.
An HTTP `Mcp-Session-Id` from initialization is forwarded on subsequent requests
along with `MCP-Protocol-Version`. Session identifiers must be printable ASCII
and no longer than 256 characters. No persistent session, background listener,
server request handling or session resumption is implemented; services issuing
sessions should expire inactive sessions.

Tools must return MCP `content` with either one text block containing the JSON
result above, or a `structuredContent` JSON object (with `content` present).
JSON-RPC errors, MCP `isError: true`, unsupported content, missing results,
identifier mismatches, and malformed memory records fail the read. Initialized
notifications may return an empty 202/204 response. SSE and streaming tool
content are unsupported. Tool discovery, protocol-version fallback, OAuth,
plugin discovery, vendor defaults and branding are out of scope.
