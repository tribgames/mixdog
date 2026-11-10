//! Which lanes may do file I/O, and the proofs the functions of this crate take.

use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_rt::SpawnIo;

/// Lanes that may read files.
pub trait IoLane: LaneToken {}
/// Resolving a command to start looks at the files on its search path and a script's first line.
impl IoLane for SpawnIo {}
impl IoLane for InteractiveIo {}
impl IoLane for DurabilityIo {}
impl IoLane for MaintenanceIo {}

/// Lanes that may write files and take their locks.
pub trait WriteLane: IoLane {}
impl WriteLane for DurabilityIo {}
impl WriteLane for MaintenanceIo {}

mod sealed {
    pub trait Sealed {}
}

/// Evidence that blocking reads may run here: an [`InLane`] of a read lane.
pub trait ReadProof: sealed::Sealed {}

/// Evidence that blocking writes may run here: an [`InLane`] of a write lane.
pub trait WriteProof: ReadProof {}

impl<L: IoLane> sealed::Sealed for InLane<L> {}
impl<L: IoLane> ReadProof for InLane<L> {}
impl<L: WriteLane> WriteProof for InLane<L> {}

/// No proof: for a caller that runs outside the lane contract, on a thread of its own (the
/// migration driver, the remote relay). It is the transitional route of code that does not
/// have a lane proof yet; every use names a call site still to move into a lane job, and the
/// type goes away with the last one.
#[derive(Clone, Copy, Debug)]
pub struct Unlaned;

impl sealed::Sealed for Unlaned {}
impl ReadProof for Unlaned {}
impl WriteProof for Unlaned {}
