//! Pure synchronisation semantics.
#![forbid(unsafe_code)]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectionMode {
    TwoWay,
    DeviceAToB,
    DeviceBToA,
    Paused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictPolicy {
    AutomaticPreserveLoser,
    KeepBoth,
    Ask,
    PauseEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DeviceId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RevisionId(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionClock {
    pub device: DeviceId,
    pub sequence: u64,
    pub parents: Vec<RevisionId>,
}

/// Selects a stable winner for concurrent revisions without trusting wall clocks.
/// The losing revision must still be retained in version history by the caller.
#[must_use]
pub fn deterministic_conflict_winner<'a>(
    left: &'a RevisionClock,
    right: &'a RevisionClock,
) -> &'a RevisionClock {
    match left.sequence.cmp(&right.sequence) {
        std::cmp::Ordering::Greater => left,
        std::cmp::Ordering::Less => right,
        std::cmp::Ordering::Equal => {
            if left.device >= right.device {
                left
            } else {
                right
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{DeviceId, RevisionClock, deterministic_conflict_winner};

    fn revision(device: &str, sequence: u64) -> RevisionClock {
        RevisionClock {
            device: DeviceId(device.to_owned()),
            sequence,
            parents: Vec::new(),
        }
    }

    #[test]
    fn larger_sequence_wins() {
        let older = revision("linux", 2);
        let newer = revision("windows", 3);
        assert_eq!(deterministic_conflict_winner(&older, &newer), &newer);
    }

    #[test]
    fn device_id_breaks_concurrent_ties_stably() {
        let linux = revision("linux", 4);
        let windows = revision("windows", 4);
        assert_eq!(deterministic_conflict_winner(&linux, &windows), &windows);
        assert_eq!(deterministic_conflict_winner(&windows, &linux), &windows);
    }
}
