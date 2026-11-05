//! Authorized control lanes of a transport session: the relay and at most a current and a
//! pending direct connection. Replay is checked per FIFO lane against its high-water mark.

use super::E2eeError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlLane {
    Relay,
    Direct { epoch: u64, connection_id: String },
}

impl ControlLane {
    /// The lane label bound into the AAD.
    pub(crate) fn label(&self) -> String {
        match self {
            ControlLane::Relay => "relay".to_owned(),
            ControlLane::Direct { epoch, connection_id } => format!("direct\0{epoch}\0{connection_id}"),
        }
    }

    pub fn direct(epoch: u64, connection_id: &str) -> Result<Self, E2eeError> {
        let valid = (1..=64).contains(&connection_id.len())
            && connection_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if epoch < 1 || !valid {
            return Err(E2eeError::Invalid("Expected a control lane."));
        }
        Ok(ControlLane::Direct { epoch, connection_id: connection_id.to_owned() })
    }
}

#[derive(Clone, Debug)]
struct DirectState {
    epoch: u64,
    connection_id: String,
    high_water: u64,
}

impl DirectState {
    fn is(&self, epoch: u64, connection_id: &str) -> bool {
        self.epoch == epoch && self.connection_id == connection_id
    }
}

/// Which high-water mark a lane resolves to.
pub(crate) enum LaneSlot {
    Relay,
    Current,
    Pending,
    Retired,
}

#[derive(Default)]
pub(crate) struct ControlLanes {
    relay_high_water: u64,
    current: Option<DirectState>,
    pending: Option<DirectState>,
    epoch_floor: u64,
}

impl ControlLanes {
    pub fn slot(&self, lane: &ControlLane) -> Result<LaneSlot, E2eeError> {
        match lane {
            ControlLane::Relay => Ok(LaneSlot::Relay),
            ControlLane::Direct { epoch, connection_id } => {
                if self.current.as_ref().is_some_and(|s| s.is(*epoch, connection_id)) {
                    Ok(LaneSlot::Current)
                } else if self.pending.as_ref().is_some_and(|s| s.is(*epoch, connection_id)) {
                    Ok(LaneSlot::Pending)
                } else if *epoch <= self.epoch_floor {
                    Ok(LaneSlot::Retired)
                } else {
                    Err(E2eeError::Invalid("Control lane is not registered."))
                }
            }
        }
    }

    pub fn high_water(&self, slot: &LaneSlot) -> Option<u64> {
        match slot {
            LaneSlot::Relay => Some(self.relay_high_water),
            LaneSlot::Current => self.current.as_ref().map(|s| s.high_water),
            LaneSlot::Pending => self.pending.as_ref().map(|s| s.high_water),
            LaneSlot::Retired => None,
        }
    }

    pub fn set_high_water(&mut self, slot: &LaneSlot, value: u64) {
        match slot {
            LaneSlot::Relay => self.relay_high_water = value,
            LaneSlot::Current => {
                if let Some(s) = self.current.as_mut() {
                    s.high_water = value;
                }
            }
            LaneSlot::Pending => {
                if let Some(s) = self.pending.as_mut() {
                    s.high_water = value;
                }
            }
            LaneSlot::Retired => {}
        }
    }

    pub fn register(&mut self, lane: &ControlLane) -> Result<(), E2eeError> {
        let ControlLane::Direct { epoch, connection_id } = lane else {
            return Err(E2eeError::Invalid("Only a direct control lane is registered."));
        };
        if self.current.as_ref().is_some_and(|s| s.is(*epoch, connection_id))
            || self.pending.as_ref().is_some_and(|s| s.is(*epoch, connection_id))
        {
            return Ok(());
        }
        if *epoch <= self.epoch_floor {
            return Err(E2eeError::Invalid("Control lane epoch is retired."));
        }
        self.pending = Some(DirectState { epoch: *epoch, connection_id: connection_id.clone(), high_water: 0 });
        self.epoch_floor = *epoch;
        Ok(())
    }

    pub fn activate(&mut self, lane: &ControlLane) -> Result<(), E2eeError> {
        let ControlLane::Direct { epoch, connection_id } = lane else {
            return Err(E2eeError::Invalid("Only a direct control lane is activated."));
        };
        if self.current.as_ref().is_some_and(|s| s.is(*epoch, connection_id)) {
            return Ok(());
        }
        if !self.pending.as_ref().is_some_and(|s| s.is(*epoch, connection_id)) {
            return Err(E2eeError::Invalid("Control lane is not pending."));
        }
        self.current = self.pending.take();
        Ok(())
    }

    pub fn retire(&mut self, lane: &ControlLane) -> Result<(), E2eeError> {
        let ControlLane::Direct { epoch, connection_id } = lane else {
            return Err(E2eeError::Invalid("The relay control lane is never retired."));
        };
        if self.current.as_ref().is_some_and(|s| s.is(*epoch, connection_id)) {
            self.current = None;
        }
        if self.pending.as_ref().is_some_and(|s| s.is(*epoch, connection_id)) {
            self.pending = None;
        }
        Ok(())
    }

    /// `(lanes retained, epoch floor)`.
    pub fn state(&self) -> (usize, u64) {
        (1 + usize::from(self.current.is_some()) + usize::from(self.pending.is_some()), self.epoch_floor)
    }
}
