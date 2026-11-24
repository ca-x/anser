use ferrum_email_components::{Body, Container, Heading, Html, Section};
use ferrum_email_core::{Color, Element, Node, Px, Spacing, Tag};
use ferrum_email_render::{RenderError, Renderer};

pub(super) fn render(title: &str, text: &str) -> Result<String, RenderError> {
    let content = Element::new(Tag::Div)
        .attr(
            "style",
            "color:#25201c;font-size:16px;line-height:1.6;overflow-wrap:anywhere",
        )
        .children(text.split('\n').enumerate().flat_map(|(index, line)| {
            (index > 0)
                .then(|| Node::Element(Element::new(Tag::Br)))
                .into_iter()
                .chain([Node::text(line.trim_end_matches('\r'))])
        }));
    let template = Html::new().lang("und").child(
        Body::new()
            .background(Color::hex("f5f1eb"))
            .padding(Spacing::xy(Px(24), Px(12)))
            .child(
                Container::new()
                    .background(Color::hex("fffdf9"))
                    .child(
                        Section::new()
                            .background(Color::hex("f5e9dd"))
                            .padding(Spacing::xy(Px(16), Px(24)))
                            .child(
                                Heading::h1(title)
                                    .color(Color::hex("6e3a1f"))
                                    .font_size(Px(24))
                                    .margin(Spacing::zero()),
                            ),
                    )
                    .child(
                        Section::new()
                            .padding(Spacing::all(Px(24)))
                            .child_node(Node::Element(content)),
                    ),
            ),
    );
    Renderer::new().render_html(&template)
}
