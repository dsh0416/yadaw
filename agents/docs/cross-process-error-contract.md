# Renderer/main resource and error contract

The only application-owned cross-process boundary is renderer/preload to
Electron main. Native audio calls from main are in-process N-API calls.

Renderer RPC uses serializable success/error unions, explicit resource refs,
expected revisions, and correlation IDs. Stateful mutations have one commit
point, prepare/abort cleanup where needed, and reconciliation for ambiguous
renderer/main delivery outcomes. Do not use rejected promises, ambient current
resources, Rust panics, or free-form strings as protocol semantics.

The embedded audio protocol keeps typed Rust control results. Main translates
native request failures into the existing RPC error union before crossing back
to the renderer. Native request serialization must not introduce helper
process epochs, attachment leases, OS handles, or restart status.

Resource epochs remain useful even without an audio helper: they distinguish a
renderer command created for an older project/native session from the current
one. On application relaunch all renderer state is rebuilt through bootstrap;
there is no in-process audio-host recovery transaction.
