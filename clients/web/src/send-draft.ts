import type { Message, Receipt } from "./api";

export interface SendDraft {
  inbox: boolean;
  speech: boolean;
  recipient: string;
  topic: string;
  channel: string;
  account: string;
  message: Message;
  templateEnabled: boolean;
  templateId: string;
  templateVariables: Record<string, string>;
  tags: string;
  url: string;
  attachment: string;
  callback: string;
  extra: string;
}

function emptyDraft(): SendDraft {
  return {
    inbox: false, speech: false, recipient: "", topic: "", channel: "", account: "", message: { title: "", body: "", format: "text" },
    tags: "", url: "", attachment: "", callback: "", extra: "",
    templateEnabled: false, templateId: "", templateVariables: {},
  };
}

interface ComposeState {
  draft: SendDraft;
  busy: boolean;
  receipt?: Receipt;
  error?: unknown;
}

// This instance belongs to one signed-in session. Message content stays in memory.
export class SendSession {
  private state: ComposeState = { draft: emptyDraft(), busy: false };
  private listeners = new Set<() => void>();
  private attempt?: { content: string; key: string };

  snapshot = () => this.state;
  subscribe = (notify: () => void) => {
    this.listeners.add(notify);
    return () => { this.listeners.delete(notify); };
  };

  private update(next: ComposeState) {
    this.state = next;
    this.listeners.forEach((notify) => notify());
  }

  edit(patch: Partial<SendDraft>) {
    this.update({ ...this.state, error: undefined, draft: { ...this.state.draft, ...patch } });
  }

  acknowledgeReceipt() {
    this.update({ ...this.state, receipt: undefined });
  }

  async submit(content: string, send: (key: string) => Promise<Receipt>) {
    if (this.state.busy) return;
    const submitted = this.state.draft;
    if (this.attempt?.content !== content) {
      const bytes = crypto.getRandomValues(new Uint8Array(20));
      this.attempt = { content, key: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") };
    }
    this.update({ ...this.state, busy: true, receipt: undefined, error: undefined });
    try {
      const receipt = await send(this.attempt.key);
      this.attempt = undefined;
      const unchanged = submitted === this.state.draft;
      this.update({ draft: unchanged ? emptyDraft() : this.state.draft, busy: false, receipt });
      return unchanged ? receipt : undefined;
    } catch (error) {
      this.update({ ...this.state, busy: false, error });
      throw error;
    }
  }
}
