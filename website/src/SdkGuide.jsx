import React from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";

const version = "0.2.0";
const org = "https://github.com/lib-x";
const sdks = [
  {
    name: "Rust",
    slug: "rust",
    install: `cargo add anser-sdk@${version}\ncargo add tokio --features macros,rt-multi-thread`,
    packages: "https://crates.io/crates/anser-sdk",
    snippet: `let receipt = client.publish_template(
    "alerts",
    &TemplatePublish::new(
        TemplateRef::TemplateId("builtin.deployment".into()),
        [
            ("service".into(), "api".into()),
            ("version".into(), "1.2.3".into()),
            ("environment".into(), "production".into()),
        ].into(),
    ),
    &SendOptions::default(),
).await?;
let detail = client.message(&receipt.message_id).await?;`,
    example: "examples/template.rs",
  },
  {
    name: "Go",
    slug: "go",
    install: `go get github.com/lib-x/anser-sdk-go@v${version}`,
    snippet: `receipt, err := client.Publish(ctx, "alerts", anser.Publish{
    TemplateID: "builtin.deployment",
    Variables: map[string]string{
        "service": "api", "version": "1.2.3", "environment": "production",
    },
}, anser.SendOptions{})
if err != nil {
    log.Fatal(err)
}
detail, err := client.Message(ctx, receipt.MessageID)`,
    example: "examples/template/main.go",
  },
  {
    name: "TypeScript",
    slug: "ts",
    install: `npm install ${org}/anser-sdk-ts/releases/download/v${version}/lib-x-anser-sdk-${version}.tgz`,
    snippet: `const receipt = await client.publish("alerts", {
  template_id: "builtin.deployment",
  variables: { service: "api", version: "1.2.3", environment: "production" },
});
const detail = await client.message(receipt.message_id);`,
    example: "examples/template.mjs",
  },
];

const httpExample = [
  'curl --fail-with-body "$ANSER_URL/v1/topics/alerts/publish" \\',
  '  -H "Authorization: Bearer $ANSER_API_KEY" \\',
  "  -H 'Content-Type: application/json' \\",
  "  -H 'Idempotency-Key: api-1.2.3-production' \\",
  "  --data '{\"template_id\":\"builtin.deployment\",\"variables\":{\"service\":\"api\",\"version\":\"1.2.3\",\"environment\":\"production\"}}'",
].join("\n");

function ExternalLink({ url, children }) {
  return <a href={url}>{children} <ArrowSquareOut size={15} aria-hidden="true" /></a>;
}

export function SdkGuide({ t }) {
  return <section className="sdk-band" id="sdk">
    <div className="wrap section">
      <h2>{t.sdkTitle}</h2>
      <div className="sdk-guide">
        <div className="sdk-intro">
          <h3>{t.sdkAuth}</h3>
          <ol>
            <li>{t.sdkKey}</li>
            <li>{t.sdkEnv}</li>
            <li>{t.sdkTopic}</li>
          </ol>
          <p>{t.sdkReceipt}</p>
          <p>{t.sdkTemplate}</p>
        </div>
        <div className="sdk-examples">
          <details className="sdk-example">
            <summary>HTTP API</summary>
            <pre tabIndex="0"><code>{httpExample}</code></pre>
          </details>
          {sdks.map(({ name, slug, install, packages, snippet, example }) => {
            const url = `${org}/anser-sdk-${slug}`;
            return <details className="sdk-example" key={slug}>
              <summary>{name}</summary>
              <div className="sdk-details">
                <pre tabIndex="0"><code>{install}</code></pre>
                <pre tabIndex="0"><code>{snippet}</code></pre>
                <div className="sdk-links">
                  <ExternalLink url={`${url}/blob/v${version}/${example}`}>{t.sdkExample}</ExternalLink>
                  <ExternalLink url={url}>GitHub</ExternalLink>
                  {packages && <ExternalLink url={packages}>crates.io</ExternalLink>}
                </div>
              </div>
            </details>;
          })}
        </div>
      </div>
    </div>
  </section>;
}
