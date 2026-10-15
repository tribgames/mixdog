# File recovery and managed worktrees

File recovery is for interrupted or failed **closed-file workspace edits**. It
is not the editor-buffer backup, a turn's Undo/Reapply snapshot, or an undo of a
successful save. None of these sources is combined into an automatic restore.

## Finding and inspecting records

The Files explorer requests bounded recovery metadata when the project is
opened, when the window regains focus, and after relevant folder-change events.
A collapsed File recovery section shows its retained count and a review notice.
Discovery does not read backup payloads or restore files. Opening the section
loads a fresh list; Inspect checks the targets and backup hashes.

A workspace-edit failure that retained a journal carries a bounded record ID.
The editor's **Inspect file recovery** action opens that record. The ID and the
machine error code are navigation/presentation hints only: the host still
resolves the registered project, validates the record and rechecks the inspected
revision before every confirmed mutation. Changing projects or hosts invalidates
old observations and pending approvals. An unsuccessful refresh is unavailable,
not an empty inventory.

Automatic refresh also invalidates the open panel's inspected revision and
pending approval. The panel reloads the visible records after discovery; a
failed refresh removes its old action controls and offers an explicit retry.

Only unchanged after-images can be restored. External edits, missing/replaced
files and directories, and unsaved editor buffers are left untouched. Disk
restoration does not replace a dirty buffer or grant permission to save it.

## Storage and actionable failures

The inventory reports used/max record slots, unresolved/resolved phase counts,
**declared** before/after payload bytes in valid manifests, and the number of
records with unknown size. This is not a disk-usage measurement. A resolved phase
is historical metadata, not permission to remove a record without inspection.

Limits remain 20 retained records per project scope and 100 files / 16 MiB of
combined before/after payload per edit. Capacity refusal happens before target
mutation. No old record is evicted to admit an edit. Users inspect and explicitly
confirm deletion of backups, including resolved records; project files are not
deleted by that action. Oversized edits must be split rather than bypassing the
journal. Coded errors distinguish a changed observation, active ownership,
capacity/batch limits, unavailable records and storage/permission failures.

Unrecognized entries in a project recovery store produce a manual-inspection
notice, never an empty list. This includes valid-looking record names whose
entries are files or links instead of directories. They block new journal admission and worktree
removal. Inspect the file host's private user-data `editor-recovery/<root-hash>`
directory (the linked path is also recorded in the core worktree ledger), and
identify unexpected entries before moving or deleting them manually. The app
does not assume that an unknown file is expendable.

A missing registered folder keeps its recovery-only lookup. It does not become
a usable file root: normal project file operations still require a live approved
folder. The inventory and inspected backup disposal remain accessible when a
registered project or managed checkout is missing; restoration remains guarded
by the original root/parent identities and byte comparisons.

## Worktree lifecycle

The file host registers each private journal scope in the managed-worktree
ledger **before** preparing a journal. Host profiles need not share the core
runtime's data directory. Multiple profiles and nested project scopes are kept
separate. These descriptors are private ledger metadata, not client-selected
backup locations and not restoration authority.

Journaled host edits, search/replace, recovery inspection/restoration/disposal,
and managed-worktree deletion use the same repository lock. The lock is acquired
outside the editor's file-mutation claims. A deletion therefore cannot race
between a journal check and an admitted host batch. Scope descriptors survive
process exit, so daemon startup can protect records without a desktop callback.

If a checkout is removed after project authorization but before journal
admission, its path remains inside the manager's reserved storage namespace.
Recovery operations reject that missing managed entry instead of treating it
as an ordinary project, including a replacement folder or link at the old path.

Any retained entry blocks removal, including forced removal, prune, automatic
cleanup and resuming a decided deletion. This deliberately includes resolved or
invalid entries until explicit inspection/disposal; unknown/unreadable storage
is not treated as empty. The manager does not delete recovery storage itself.
Normal successful saves already retire and remove their own completed journals.

The ledger holds at most 64 distinct root/profile scope descriptors per
worktree. Before rejecting a new scope at that limit, it drops descriptors for
verifiably empty or missing stores under the repository lock. Retained,
unreadable or malformed stores keep their descriptors. No backup data is
removed by this bookkeeping, and explicit discard can free a scope slot.

Legacy journals written before this linkage are registered when their project
scope is accessed by the updated file host. An old profile that has never been
attached cannot be inferred by the core daemon. Before pruning after upgrading
from that older recovery implementation, open File recovery for its worktree
scopes from the hosting profile. External deletion, an older uncooperative host,
and manually edited registry/storage files are not covered by the shared-lock
guarantee. This is process-exit recovery, not a universal power-loss guarantee.

## Verification boundaries

The regression suites exercise real Git removal/prune/startup, a new child
process with no desktop adapter, journal admission versus concurrent removal,
multiple host profiles/nested roots, real host batch failure followed by missing
checkout inspection/disposal, storage exhaustion and temp-file failures. DOM
tests cover discovery, capacity/availability, stale project/host responses,
explicit record navigation and approval invalidation. Existing byte-integrity,
external-change, dirty-buffer and remote capability contracts remain applicable.
