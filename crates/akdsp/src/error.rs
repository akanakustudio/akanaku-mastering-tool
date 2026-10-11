use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum DspError {
    /// E-IN-001: the file could not be read.
    Decode(String),
    /// E-IN-002 / E-IN-004: unsupported format or channel layout.
    Unsupported(String),
    /// E-OUT-001: writing the output failed.
    Encode(String),
}

impl DspError {
    pub fn code(&self) -> &'static str {
        match self {
            DspError::Decode(_) => "E-IN-001",
            DspError::Unsupported(_) => "E-IN-002",
            DspError::Encode(_) => "E-OUT-001",
        }
    }
}

impl fmt::Display for DspError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DspError::Decode(m) | DspError::Unsupported(m) | DspError::Encode(m) => {
                write!(f, "{}: {m}", self.code())
            }
        }
    }
}

impl std::error::Error for DspError {}
