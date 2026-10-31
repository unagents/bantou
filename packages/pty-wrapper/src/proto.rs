use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

/// wrapper -> center (one JSON object per line on stdout).
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Out {
    Started { pid: Option<u32> },
    Output { data: String },
    Text { data: String },
    Exit { code: Option<i64>, signal: Option<String> },
}

impl Out {
    pub fn output(bytes: &[u8]) -> Out {
        Out::Output { data: STANDARD.encode(bytes) }
    }

    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("Out serializes")
    }
}

/// center -> wrapper (one JSON object per line on stdin).
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum In {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Stop,
}

pub fn parse_in(line: &str) -> Result<In, String> {
    serde_json::from_str::<In>(line).map_err(|e| e.to_string())
}

pub fn decode_b64(data: &str) -> Result<Vec<u8>, String> {
    STANDARD.decode(data).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn out_lines() {
        assert_eq!(Out::Started { pid: Some(42) }.to_line(), r#"{"t":"started","pid":42}"#);
        assert_eq!(Out::Started { pid: None }.to_line(), r#"{"t":"started","pid":null}"#);
        assert_eq!(Out::output(b"hi").to_line(), r#"{"t":"output","data":"aGk="}"#);
        assert_eq!(Out::Text { data: "a\nb".into() }.to_line(), r#"{"t":"text","data":"a\nb"}"#);
        assert_eq!(
            Out::Exit { code: Some(3), signal: None }.to_line(),
            r#"{"t":"exit","code":3,"signal":null}"#
        );
        assert_eq!(
            Out::Exit { code: None, signal: Some("Terminated".into()) }.to_line(),
            r#"{"t":"exit","code":null,"signal":"Terminated"}"#
        );
    }

    #[test]
    fn parse_in_messages() {
        assert_eq!(parse_in(r#"{"t":"input","data":"aGk="}"#), Ok(In::Input { data: "aGk=".into() }));
        assert_eq!(parse_in(r#"{"t":"resize","cols":100,"rows":30}"#), Ok(In::Resize { cols: 100, rows: 30 }));
        assert_eq!(parse_in(r#"{"t":"stop"}"#), Ok(In::Stop));
    }

    #[test]
    fn parse_in_rejects_bad() {
        assert!(parse_in("not json").is_err());
        assert!(parse_in(r#"{"t":"nope"}"#).is_err());
        assert!(parse_in(r#"{"t":"resize","cols":"x","rows":1}"#).is_err());
        assert!(parse_in(r#"{"t":"input"}"#).is_err());
    }

    #[test]
    fn b64() {
        assert_eq!(decode_b64("aGk=").unwrap(), b"hi");
        assert!(decode_b64("!!!").is_err());
    }
}
