//! Bounded substitution for notification titles and bodies.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

pub const MAX_TITLE_BYTES: usize = 4096;
pub const MAX_BODY_BYTES: usize = 262_144;

const MAX_SOURCE_BODY_BYTES: usize = 32_768;
const MAX_VARIABLES: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    Text,
    Markdown,
}

impl Format {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Markdown => "markdown",
        }
    }

    pub const fn message_format(self) -> crate::MessageFormat {
        match self {
            Self::Text => crate::MessageFormat::Text,
            Self::Markdown => crate::MessageFormat::Markdown,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid template name, content length or placeholder")]
    Definition,
    #[error("Template variables must match the placeholders in the template")]
    Variables,
    #[error("Rendered title and body must fit the message limits and cannot both be blank")]
    Content,
}

pub enum Reference {
    Id(String),
    Name(String),
}

pub struct Usage {
    pub reference: Reference,
    pub variables: BTreeMap<String, String>,
}

pub struct Source<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub format: Format,
}

impl Source<'_> {
    /// Extracts a stable sorted list of variable names and validates the definition.
    pub fn variables(&self) -> Result<Vec<String>, Error> {
        let mut names = BTreeSet::new();
        if self.title.len() > MAX_TITLE_BYTES
            || self.body.len() > MAX_SOURCE_BODY_BYTES
            || (self.title.trim().is_empty() && self.body.trim().is_empty())
        {
            return Err(Error::Definition);
        }
        for content in [self.title, self.body] {
            visit(content, |fragment| {
                if let Fragment::Variable(name) = fragment {
                    names.insert(name);
                    if names.len() > MAX_VARIABLES {
                        return Err(Error::Definition);
                    }
                }
                Ok(())
            })?;
        }
        Ok(names.into_iter().map(str::to_owned).collect())
    }

    /// Substitutes variable values once. Placeholders in values remain literal.
    pub fn render(&self, variables: &BTreeMap<String, String>) -> Result<(String, String), Error> {
        let expected = self.variables()?;
        if variables.len() != expected.len()
            || !expected.iter().all(|name| variables.contains_key(name))
        {
            return Err(Error::Variables);
        }
        let title = render_part(self.title, variables, Format::Text, MAX_TITLE_BYTES)?;
        let body = render_part(self.body, variables, self.format, MAX_BODY_BYTES)?;
        if title.trim().is_empty() && body.trim().is_empty() {
            return Err(Error::Content);
        }
        Ok((title, body))
    }
}

pub fn valid_name(value: &str) -> bool {
    (1..=80).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        && value != "."
        && value != ".."
}

enum Fragment<'a> {
    Text(&'a str),
    Variable(&'a str),
}

fn visit<'a>(
    mut input: &'a str,
    mut append: impl FnMut(Fragment<'a>) -> Result<(), Error>,
) -> Result<(), Error> {
    while let Some((literal, rest)) = input.split_once("{{") {
        append(Fragment::Text(literal))?;
        let (raw_name, remaining) = rest.split_once("}}").ok_or(Error::Definition)?;
        let name = raw_name.trim();
        let mut bytes = name.bytes();
        if name.len() > 64
            || !bytes
                .next()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
            || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(Error::Definition);
        }
        append(Fragment::Variable(name))?;
        input = remaining;
    }
    append(Fragment::Text(input))
}

fn render_part(
    content: &str,
    variables: &BTreeMap<String, String>,
    format: Format,
    limit: usize,
) -> Result<String, Error> {
    let mut output = String::with_capacity(content.len());
    visit(content, |fragment| {
        match fragment {
            Fragment::Text(text) => push(&mut output, text, limit)?,
            Fragment::Variable(name) => {
                let value = variables.get(name).ok_or(Error::Variables)?;
                if format == Format::Text {
                    push(&mut output, value, limit)?;
                } else {
                    for character in value.chars() {
                        if character.is_ascii_punctuation() {
                            push(&mut output, "\\", limit)?;
                        }
                        let character = if character.is_control() {
                            ' '
                        } else {
                            character
                        };
                        push(&mut output, character.encode_utf8(&mut [0; 4]), limit)?;
                    }
                }
            }
        }
        Ok(())
    })?;
    Ok(output)
}

fn push(output: &mut String, next: &str, limit: usize) -> Result<(), Error> {
    if next.len() > limit - output.len() {
        return Err(Error::Content);
    }
    output.push_str(next);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_variables_and_renders_unicode_and_values_once() {
        let source = Source {
            title: "{{ service }}: {{state}}",
            body: "{{state}} at {{service}}",
            format: Format::Text,
        };
        assert_eq!(source.variables().unwrap(), ["service", "state"]);
        let variables = BTreeMap::from([
            ("service".into(), "雁字".into()),
            ("state".into(), "{{do_not_expand}}".into()),
        ]);
        assert_eq!(
            source.render(&variables).unwrap(),
            (
                "雁字: {{do_not_expand}}".into(),
                "{{do_not_expand}} at 雁字".into()
            )
        );
        assert!(matches!(
            source.render(&BTreeMap::new()),
            Err(Error::Variables)
        ));
    }

    #[test]
    fn bounds_rendered_content_and_escapes_markdown_values() {
        let source = Source {
            title: "{{value}}",
            body: "**Notice** {{value}}",
            format: Format::Markdown,
        };
        let input = "<b>\n# heading";
        let variables = BTreeMap::from([("value".into(), input.into())]);
        assert_eq!(
            source.render(&variables).unwrap(),
            (input.into(), "**Notice** \\<b\\> \\# heading".into())
        );
        assert!(matches!(
            source.render(&BTreeMap::from([("value".into(), "雁".repeat(4096))])),
            Err(Error::Content)
        ));
        let malformed = Source {
            title: "{{foo.bar}}",
            ..source
        };
        assert!(matches!(malformed.variables(), Err(Error::Definition)));
    }
}
