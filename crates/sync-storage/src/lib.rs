//! SQLite, journal and archive interfaces.
#![forbid(unsafe_code)]
#[derive(Debug,Clone,Copy,PartialEq,Eq)]pub enum OperationPhase{Planned,Receiving,Verified,ArchivedOld,Committed,Indexed,Acknowledged}
