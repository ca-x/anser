//! Declarative, plain-text controls for one human response.

use std::collections::{BTreeMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const MAX_OPTIONS: usize = 12;
const MAX_TEXT: usize = 4096;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Invalid or unsupported MCD interaction")]
pub struct InvalidMcd;

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Form {
    pub buttons: Vec<Button>,
    pub input: Option<Input>,
    pub select: Option<Select>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Button {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub name: String,
    pub label: String,
    pub submit: String,
    pub placeholder: Option<String>,
    #[serde(default = "default_multiline")]
    pub multiline: bool,
    #[serde(default = "default_text_limit")]
    pub max_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Select {
    pub name: String,
    pub label: String,
    pub submit: String,
    pub options: Vec<Button>,
}

/// Exactly one control can complete a form. Values are data, never navigable links.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Action { value: String },
    Text { text: String },
    Choice { value: String },
}

impl Form {
    pub fn parse(source: &str) -> Result<Self, InvalidMcd> {
        if source.len() > 8 * 1024 {
            return Err(InvalidMcd);
        }
        let mut form = Self::default();
        let mut lines = source
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty());
        while let Some(line) = lines.next() {
            if line == ":::buttons" {
                form.buttons.extend(read_options(&mut lines)?);
            } else if let Some(attributes) = line.strip_prefix(":::input ") {
                if form.input.is_some() || lines.next() != Some(":::") {
                    return Err(InvalidMcd);
                }
                form.input = Some(read_input(attributes)?);
            } else if let Some(attributes) = line.strip_prefix(":::select ") {
                if form.select.is_some() {
                    return Err(InvalidMcd);
                }
                let mut attributes = read_attributes(attributes)?;
                let (name, label, submit) = common_attributes(&mut attributes)?;
                if !attributes.is_empty() {
                    return Err(InvalidMcd);
                }
                form.select = Some(Select {
                    name,
                    label,
                    submit,
                    options: read_options(&mut lines)?,
                });
            } else if line.starts_with(":::") {
                return Err(InvalidMcd);
            }
        }
        form.validate()?;
        Ok(form)
    }

    pub fn validate(&self) -> Result<(), InvalidMcd> {
        if self.buttons.is_empty() && self.input.is_none() && self.select.is_none() {
            return Err(InvalidMcd);
        }
        validate_options(&self.buttons)?;
        if let Some(input) = &self.input {
            validate_field(&input.name, &input.label, &input.submit)?;
            if !(1..=MAX_TEXT).contains(&input.max_length)
                || input
                    .placeholder
                    .as_deref()
                    .is_some_and(|value| !plain(value))
            {
                return Err(InvalidMcd);
            }
        }
        if let Some(select) = &self.select {
            validate_field(&select.name, &select.label, &select.submit)?;
            validate_options(&select.options)?;
            if select.options.is_empty() {
                return Err(InvalidMcd);
            }
        }
        Ok(())
    }

    pub fn accepts(&self, reply: &Reply) -> bool {
        match reply {
            Reply::Action { value } => self.buttons.iter().any(|button| button.value == *value),
            Reply::Choice { value } => self
                .select
                .as_ref()
                .is_some_and(|select| select.options.iter().any(|option| option.value == *value)),
            Reply::Text { text } => self.input.as_ref().is_some_and(|field| {
                text.len() <= field.max_length.saturating_mul(4)
                    && text.chars().count() <= field.max_length
                    && !text.trim().is_empty()
                    && !text.chars().any(|ch| {
                        ch.is_control() && !(field.multiline && matches!(ch, '\n' | '\r' | '\t'))
                    })
            }),
        }
    }
}

fn read_options<'a>(lines: &mut impl Iterator<Item = &'a str>) -> Result<Vec<Button>, InvalidMcd> {
    let mut options = Vec::new();
    loop {
        let line = lines.next().ok_or(InvalidMcd)?;
        if line == ":::" && !options.is_empty() {
            return Ok(options);
        }
        if options.len() >= MAX_OPTIONS {
            return Err(InvalidMcd);
        }
        let item = line.strip_prefix("- [").ok_or(InvalidMcd)?;
        let (label, value) = item.split_once("](").ok_or(InvalidMcd)?;
        let value = value.strip_suffix(')').ok_or(InvalidMcd)?;
        options.push(Button {
            label: label.trim().into(),
            value: value.trim().into(),
        });
    }
}

fn read_input(source: &str) -> Result<Input, InvalidMcd> {
    let mut attributes = read_attributes(source)?;
    let (name, label, submit) = common_attributes(&mut attributes)?;
    let placeholder = attributes.remove("placeholder").map(str::to_owned);
    let multiline = attributes
        .remove("multiline")
        .map(str::parse)
        .transpose()
        .map_err(|_| InvalidMcd)?
        .unwrap_or_else(default_multiline);
    let max_length = attributes
        .remove("max_length")
        .map(str::parse)
        .transpose()
        .map_err(|_| InvalidMcd)?
        .unwrap_or_else(default_text_limit);
    if !attributes.is_empty() {
        return Err(InvalidMcd);
    }
    Ok(Input {
        name,
        label,
        submit,
        placeholder,
        multiline,
        max_length,
    })
}

fn read_attributes(mut source: &str) -> Result<BTreeMap<&str, &str>, InvalidMcd> {
    let mut attributes = BTreeMap::new();
    while !source.trim_start().is_empty() {
        let (key, rest) = source.trim_start().split_once("=\"").ok_or(InvalidMcd)?;
        let (value, remainder) = rest.split_once('"').ok_or(InvalidMcd)?;
        if !plain(value)
            || (!remainder.is_empty() && !remainder.starts_with(char::is_whitespace))
            || attributes.insert(key, value).is_some()
        {
            return Err(InvalidMcd);
        }
        source = remainder;
    }
    Ok(attributes)
}

fn common_attributes(
    attributes: &mut BTreeMap<&str, &str>,
) -> Result<(String, String, String), InvalidMcd> {
    Ok((
        attributes.remove("name").ok_or(InvalidMcd)?.to_owned(),
        attributes.remove("label").ok_or(InvalidMcd)?.to_owned(),
        attributes.remove("submit").ok_or(InvalidMcd)?.to_owned(),
    ))
}

fn validate_options(options: &[Button]) -> Result<(), InvalidMcd> {
    let mut values = HashSet::new();
    if options.len() > MAX_OPTIONS
        || options.iter().any(|option| {
            !plain(&option.label) || !plain(&option.value) || !values.insert(&option.value)
        })
    {
        return Err(InvalidMcd);
    }
    Ok(())
}

fn validate_field(name: &str, label: &str, submit: &str) -> Result<(), InvalidMcd> {
    if ![name, label, submit].into_iter().all(plain) {
        return Err(InvalidMcd);
    }
    Ok(())
}

fn plain(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn default_multiline() -> bool {
    true
}
fn default_text_limit() -> usize {
    MAX_TEXT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_choices_and_unicode_text() {
        let form = Form::parse(concat!(
            ":::buttons\n- [同意](approve)\n- [稍后](later)\n:::\n",
            ":::input name=\"note\" label=\"附上原因\" submit=\"回复\" placeholder=\"原因\" multiline=\"false\" max_length=\"3\"\n:::\n",
            ":::select name=\"env\" label=\"环境\" submit=\"确定\"\n- [预览](preview)\n- [生产](production)\n:::",
        )).unwrap();
        assert_eq!(form.buttons[0].label, "同意");
        assert!(form.accepts(&Reply::Action {
            value: "approve".into()
        }));
        assert!(form.accepts(&Reply::Choice {
            value: "preview".into()
        }));
        assert!(form.accepts(&Reply::Text {
            text: "三文字".into()
        }));
        assert!(!form.accepts(&Reply::Text {
            text: "超过三个字".into()
        }));
        assert!(!form.accepts(&Reply::Text {
            text: "一\n二".into()
        }));
        assert!(!form.accepts(&Reply::Choice {
            value: "unknown".into()
        }));
    }

    #[test]
    fn rejects_ambiguous_empty_and_unterminated_controls() {
        for source in [
            ":::buttons\n- [A](x)\n- [B](x)\n:::",
            ":::buttons\n- [A](x)",
            ":::input name=\"x\" label=\"A\" label=\"B\" submit=\"Send\"\n:::",
            ":::buttons\n:::",
            "Only plain text",
        ] {
            assert_eq!(Form::parse(source), Err(InvalidMcd));
        }
    }
}
