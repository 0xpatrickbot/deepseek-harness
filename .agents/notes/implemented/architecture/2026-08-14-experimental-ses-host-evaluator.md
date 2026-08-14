# Agent Note: Experimental SES Host evaluator

Status: implemented

English | [中文](2026-08-14-experimental-ses-host-evaluator.zh.md)

## Problem

The dynamic Cordis Host runner evaluates model-authored plain JavaScript in `node:vm`. Its small global set and Context façade reduce accidental access, but Host-realm helpers permit constructor escapes and shared-process authority remains reachable. The evaluator therefore cannot demonstrate that a Host half lacks ambient access to Node globals or that separate components cannot communicate through mutable globals and intrinsics.

The experiment needs a comparable evaluator without changing Cordis core, the dynamic Package format, the Guard, or the fiber lifecycle. It must also retain `node:vm` as the default because SES lockdown mutates the process irreversibly and may be incompatible with Plugins or dependencies outside the Host runner.

## Decision

`@deepseek-ai/dsh-cordis-host-runner` has an experimental `experimentalHostEvaluator: "ses"` setting alongside the default `"vm"`. The SES module is imported and `lockdown()` runs once immediately before the first SES component is evaluated. Selecting `vm` does not initialize SES.

Each SES Package evaluation receives a fresh named `Compartment`. Its only Host endowments are a Plugin-tagged console, `harness.defineTool`, `harness.registerTool`, `harness.handle`, `btoa`, `atob`, `TextEncoder`, and `TextDecoder`; the complete endowment graph is hardened before evaluation. The evaluator runs the existing async-function-body wrapper and does not add module imports or a loader.

The Compartment name and source URL use the Package id so evaluation diagnostics distinguish revisions. The tagged console uses the stable Plugin id, matching the VM evaluator across updates and evaluator selection.

The Host runner applies its existing function-or-object Plugin validation to the Compartment result and then hardens the validated Plugin surface. The Plugin enters the existing Context Guard and `cordis-dynamic` fiber, so dependency parking and reactivation, Tool and handler ownership, timers, effects, activation rollback, stop, and undefine retain one lifecycle implementation.

SES restricts ambient reachability only for source evaluated through this path. The guarded Context façade still permits optional undeclared Service lookup through `ctx.get(name)`, and a Service return can convey nested authority that is not enumerated by the top-level Guard. Static Plugins, Client code, and other JavaScript in the Host process are outside the experiment.

## Verification

Isolated subprocess cases run after process-global lockdown and verify absent non-endowed Host globals, blocked function-constructor and prototype-constructor escapes, frozen shared intrinsics and endowments, distinct Compartment globals, and Compartment-local dynamic functions and indirect evaluation. They pin the stable Plugin console tag and Package-specific source identity. The same cases verify the direct foreign-Context return rejection and that evaluation or activation failure leaves no active Run, Tool, handler, timer, or effect.

Compatibility cases cover object-form and function-form Plugins, dependency parking and reactivation, Tool and Host handler registration and disposal, timer and effect cleanup, supported cross-realm JSON and encoding data, and actionable evaluation, syntax, and activation messages. They also pin SES 2.3.0 source censoring, secure-mode Date and Math failures, and the absence of VM teaching redirects. The build-dependent artifact lane runs a keyless assembled `dsh --profile headless` process that defines, activates, calls, and stops one SES Host Package. This assembled profile completes after lockdown, so the experiment does not require a Cordis callback compatibility layer.

The emitted Host runner JavaScript grows from 126,601 to 129,812 bytes and its declarations grow from 53,278 to 55,373 bytes. The exact `ses@2.3.0` npm artifact is 1,128,009 compressed bytes and 4,717,114 unpacked bytes; its three transitive runtime dependencies remain external package files. SES and its runtime closure use Apache-2.0 and are included in the generated third-party notices.

## Alternatives considered

**Replace `node:vm`.** A mandatory replacement would lock down every Host process and remove the comparison baseline. An explicit experimental selector keeps the existing behavior and dependency compatibility as the default.

**Run SES in a Worker or subprocess.** That would require an RPC protocol for Cordis Services, callbacks, lifecycle ownership, errors, and cross-realm values. It is a separate availability and process-isolation design, not a prerequisite for measuring Host-only SES compatibility.

**Emulate `vmTimeoutMs`.** `Compartment.evaluate` has no synchronous timeout equivalent. A timer cannot interrupt synchronous evaluation on the same thread, and moving only evaluation to another execution agent would require the excluded RPC layer. The SES path therefore ignores `vmTimeoutMs` instead of promising an ineffective deadline.

**Add dynamic module imports.** Package source remains an async JavaScript function body with no import hook. Module loading would expand authority and require a separate resolution and policy design.

**Use Package identity for every SES diagnostic.** Revision-specific Compartment and source identities are useful for evaluation failures, but Package-tagged console output would differ from the VM path and change on every update. The console therefore uses the Plugin id while Compartment and source identities retain the Package id.

## Consequences

SES lockdown is process-global and irreversible. Deployments selecting the experimental evaluator must test every Plugin and dependency loaded in that process; the repository keeps SES integration in isolated subprocesses so ordinary tests are not order-dependent.

Hardening the endowment graph freezes the Host `TextEncoder` and `TextDecoder` constructors and prototypes process-wide. The cached lockdown promise also preserves a rejection because a failed lockdown may have partially mutated the process; retrying cannot recover a known pre-lockdown state.

The define-time VM compilation rejects invalid JavaScript syntax before an id exists. SES 2.3.0 then conservatively scans raw Host source during activation and rejects apparent `import(...)` expressions and HTML-comment tokens even inside strings or comments. The Host evaluator preserves the SES error code and source location, names the later activation check, and tells the author which token to remove; it does not add a parser, source rewrite, or module loader.

SES shared intrinsics make `Date.now()`, `new Date()`, and `Math.random()` throw secure-mode `TypeError`s. Non-endowed `require`, `fetch`, and timer globals are also absent instead of using the VM evaluator's teaching redirects. These measured differences remain limitations rather than new endowments or a compatibility layer.

SES error taming preserves error messages but can omit or redact stacks. The existing `node:vm` syntax precheck remains actionable after lockdown, although a TypeScript-specific hint can fall back to the generic async-function-body and bracket-balance diagnostic when the tamed stack omits the offending source line.

The SES path has no synchronous execution bound, shares the Host thread and heap, and exposes live Service authority through the Context façade. It is a Host-only proof of concept for ambient reachability and lifecycle compatibility, not production containment, denial-of-service protection, or a claim that every untrusted JavaScript surface is confined.
