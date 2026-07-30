//! Deterministic failure-injection helpers.
#![forbid(unsafe_code)]
#[derive(Debug,Clone,Copy,PartialEq,Eq)]pub enum CrashPoint{AfterPlan,DuringReceive,AfterVerify,AfterArchive,AfterCommit,AfterIndex}
